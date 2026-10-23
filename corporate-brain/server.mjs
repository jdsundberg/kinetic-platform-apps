/**
 * Kinetic Corporate Brain — custom API handler, auto-mounted by apps/base/server.mjs.
 *
 * Every request runs with the caller's own Kinetic credentials (Authorization header), so the
 * kapp's security policies decide what each person can see and change. Kinetic submissions are
 * the only persistent store. The browser never receives more than 25 submissions per list call;
 * aggregation and bounded scans happen here.
 *
 * Agents (e.g. Claude Code using MCP connectors) call the same API with an extra
 * `X-CB-Agent: <name>` header: their writes are recorded as agent actions and they can never verify.
 */
import { FORMS, FORM_BY_SLUG, KAPP, ENTITY_FORMS } from "./model.mjs";
import { createStore, kq, KineticError } from "./lib/store.mjs";
import { createServices } from "./lib/services.mjs";
import { createRetrieval, SEARCHABLE, providers } from "./lib/retrieval.mjs";
import { createIngestion } from "./lib/ingest.mjs";
import { createHistorian, activeProvider } from "./lib/historian.mjs";
import { CONNECTORS, connectorStatus } from "./lib/connectors/index.mjs";
import { REVIEW_ACTIONS, parseJson, nameKey } from "./lib/core.mjs";

export const appId = "corporate-brain";
export const apiPrefix = "/api/corporate-brain";
export const kapp = KAPP.slug;

const meCache = new Map();     // auth|server -> { at, me }
const statsCache = new Map();  // auth|server -> { at, data }
const inflight = new Map();
const TTL = 60 * 1000;
const tlCache = new Map();     // auth|server|year -> { at, data } — one year's events, light fields, for the timeline
const TL_TTL = 5 * 60 * 1000;

// Event Date → { date, level }: "2014" is year-level, "2014-07" month-level, "2014-07-17" day-level.
// Date Precision year/month coarsens a fuller date; anything unparseable is undated.
function eventWhen(e) {
  const m = String(e["Event Date"] || "").match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return { date: "", level: "none" };
  const prec = e["Date Precision"] || "";
  if (!m[2] || prec === "year") return { date: m[1], level: "year" };
  if (!m[3] || prec === "month") return { date: `${m[1]}-${m[2]}`, level: "month" };
  return { date: `${m[1]}-${m[2]}-${m[3]}`, level: "day" };
}

// Fields only the review workflow may change; fields that identify evidence never change.
const PROTECTED = {
  "knowledge-entries": ["Knowledge ID", "Review Status", "Verified By", "Verified At", "Review History", "Superseded By", "Last Reviewed At", "Created Via"],
  sources: ["Source ID", "Source System", "Original ID", "Content Hash", "Ingest Job ID", "Created Via"],
  "research-jobs": ["Job ID", "Items Discovered", "Items Processed", "Items Skipped", "Items Failed", "Checkpoint", "Created Via"],
};
const NO_CLIENT_CREATE = new Set(["audit-log", "sources"]); // sources come from ingestion / notes
const ADMIN_ONLY_WRITE = new Set(["products"]);

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { kineticRequest, jsonResp, readBody } = helpers;
  const url = new URL(req.url, "http://localhost");
  const qp = (k) => (url.searchParams.get(k) || "").trim();
  const route = pathname.slice(apiPrefix.length) || "/";
  const method = req.method;
  const send = (status, data) => { jsonResp(res, status, data); return true; };
  const body = async () => { const t = await readBody(req); try { return t ? JSON.parse(t) : {}; } catch { throw Object.assign(new Error("Invalid JSON body"), { status: 400 }); } };

  if (method === "OPTIONS") return send(204, {});
  if (route === "/health") return send(200, { ok: true, app: appId, kapp, forms: FORMS.length });
  if (!auth) return send(401, { error: "Sign in to Kinetic to use Corporate Brain" });

  const scopeKey = `${req.headers["x-kinetic-server"] || "default"}|${auth}`;
  const store = createStore(kineticRequest, auth);

  try {
    // identity & roles (cached briefly per login)
    let me = meCache.get(scopeKey);
    if (!me || Date.now() - me.at > TTL) { me = { at: Date.now(), me: await store.me() }; meCache.set(scopeKey, me); }
    me = me.me;
    // mirrors CB Restricted Source: non-reviewers only ever query the sources they may see
    if (!me.roles.reviewer) store.setScope("sources", `values[Access Scope] = "internal"`);
    const agentName = String(req.headers["x-cb-agent"] || "").replace(/[^\w .:@()-]/g, "").slice(0, 60);
    const actor = agentName
      ? { username: me.username, type: "agent", label: `${agentName} (for ${me.username})` }
      : { username: me.username, type: "user", label: me.username };
    const services = createServices(store, actor);
    const retrieval = createRetrieval(store);
    const ingestion = createIngestion(store, services, { kineticRequest, auth, actor });
    const historian = createHistorian(store, services, retrieval);
    const requireMember = () => { if (!me.roles.member) throw Object.assign(new Error("Corporate Brain is private. Ask an administrator to add you to Corporate Brain::Members."), { status: 403 }); };
    const requireReviewer = () => { if (!me.roles.reviewer) throw Object.assign(new Error("Only Corporate Brain reviewers can do this"), { status: 403 }); };
    const bust = () => { statsCache.delete(scopeKey); tlCache.clear(); };

    // One year's active events as light points, sorted by date: a single indexed range query on
    // [Record Status, Event Date] ("2014" … "2014~" covers year-, month- and day-level dates). Cached per login.
    const timelineYear = async (year) => {
      const key = `${scopeKey}|${year}`, hit = tlCache.get(key);
      if (hit && Date.now() - hit.at < TL_TTL && qp("fresh") !== "1") return hit.data;
      if (!inflight.has("tl|" + key)) inflight.set("tl|" + key, (async () => {
        const r = await store.collect("historical-events", `values[Record Status] = "active" AND values[Event Date] BETWEEN (${kq(year)}, ${kq(year + "~")})`,
          { maxPages: 120, orderBy: "values[Record Status],values[Event Date]", direction: "ASC" });
        const events = r.items.map(e => ({ id: e["Event ID"], ...eventWhen(e), approx: e["Date Precision"] === "approximate",
          type: e["Event Type"] || "other", status: e["Verification Status"] || "proposed", title: e.Title || "", desc: String(e.Description || "").slice(0, 220) }))
          .filter(p => p.date.startsWith(year))
          .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
        const data = { year, events, truncated: r.truncated };
        tlCache.set(key, { at: Date.now(), data });
        return data;
      })().finally(() => setTimeout(() => inflight.delete("tl|" + key), 0)));
      return inflight.get("tl|" + key);
    };

    let m;
    if (route === "/me" && method === "GET") return send(200, { ...me, agent: agentName || null });
    requireMember();

    // ── dashboard ──
    if (route === "/stats" && method === "GET") {
      const hit = statsCache.get(scopeKey);
      if (hit && Date.now() - hit.at < TTL && qp("fresh") !== "1") return send(200, { ...hit.data, cached: true });
      if (!inflight.has(scopeKey)) inflight.set(scopeKey, (async () => {
        const counts = {};
        await Promise.all(["companies", "people", "knowledge-entries", "sources", "historical-events", "projects", "products", "decisions", "communications"].map(async f => { counts[f] = await store.count(f); }));
        const byStatus = {};
        await Promise.all(["proposed", "verified", "disputed", "rejected", "superseded", "needs-research"].map(async s => { byStatus[s] = await store.count("knowledge-entries", `values[Review Status] = ${kq(s)}`); }));
        const bySystem = {};
        await Promise.all(Object.keys(CONNECTORS).map(async s => { bySystem[s] = await store.count("sources", `values[Source System] = ${kq(s)}`); }));
        const recentEvents = (await store.page("historical-events", { limit: 8 })).items;
        const recentJobs = (await store.page("research-jobs", { limit: 8 })).items;
        const review = (await store.page("knowledge-entries", { q: `values[Review Status] = "proposed"`, limit: 6 })).items;
        return { counts, byStatus, bySystem, recentEvents, recentJobs, review, connectors: connectorStatus(), generatedAt: new Date().toISOString() };
      })().finally(() => setTimeout(() => inflight.delete(scopeKey), 0)));
      const data = await inflight.get(scopeKey);
      statsCache.set(scopeKey, { at: Date.now(), data });
      return send(200, data);
    }

    // ── search ──
    // Company explorer: alphabetical pages of 25 for a letter (a–z, "#" for digits), a typed name prefix, or all.
    // Keyset paging on Name Key (`after` = last key shown): sorted scans must stay bounded away from blank keys, and
    // pageTokens aren't passed back on sorted queries. Name keys are unique per active company (duplicates are refused).
    if (route === "/companies/alpha" && method === "GET") {
      const letter = (qp("letter") || "").toLowerCase(), prefix = nameKey(qp("prefix") || ""), after = qp("after") || "";
      const bump = (s) => s.slice(0, -1) + String.fromCharCode(s.charCodeAt(s.length - 1) + 1);   // first key past every s…
      let lo = "", hi = "";
      if (prefix) { lo = prefix; hi = bump(prefix); }
      else if (letter === "#") { lo = "0"; hi = ":"; }   // ":" sorts right after "9"
      else if (/^[a-z]$/.test(letter)) { lo = letter; hi = bump(letter); }
      const parts = [], st = qp("status");
      if (st) parts.push(`values[Customer Status] = ${kq(st)}`); else parts.push(`values[Record Status] = "active"`);
      parts.push(after && after >= lo ? `values[Name Key] > ${kq(after)}` : lo ? `values[Name Key] >= ${kq(lo)}` : `values[Name Key] > ""`);
      if (hi) parts.push(`values[Name Key] < ${kq(hi)}`);
      const r = await store.page("companies", { q: parts.join(" AND "), orderBy: st ? "values[Customer Status],values[Name Key]" : "values[Record Status],values[Name Key]", direction: "ASC", limit: 25 });
      const items = r.items.filter(c => !c["Merged Into"]);
      return send(200, { items, next: r.items.length === 25 ? r.items[24]["Name Key"] : "" });
    }
    if (route === "/search" && method === "GET") {
      const types = qp("types") ? qp("types").split(",").filter(t => SEARCHABLE[t]) : [];
      const r = await retrieval.search({ q: qp("q"), types, companyId: qp("companyId"), status: qp("status"), kind: qp("kind"), from: qp("from"), to: qp("to"), limit: 50 });
      return send(200, r);
    }
    if (route === "/retrieval/providers") return send(200, { providers, modelProvider: activeProvider() });

    // ── generic entity CRUD (25 per page) ──
    if ((m = route.match(/^\/entities\/([\w-]+)$/))) {
      const form = m[1]; const def = FORM_BY_SLUG[form];
      if (!def) return send(404, { error: `Unknown entity form ${form}` });
      if (method === "GET") {
        const parts = []; let orderBy = "";
        const filt = (field, val) => { if (val) parts.push(`values[${field}] = ${kq(val)}`); };
        if (form === "companies") { filt("Customer Status", qp("status")); }
        if (form === "people") filt("Primary Company ID", qp("companyId"));
        if (["historical-events", "knowledge-entries", "sources", "communications", "projects", "decisions"].includes(form)) filt("Company ID", qp("companyId"));
        if (form === "knowledge-entries") { filt("Review Status", qp("status")); filt("Knowledge Type", qp("kind")); }
        if (form === "sources") { filt("Source System", qp("system")); filt("Processing Status", qp("status")); }
        if (form === "research-jobs") filt("Status", qp("status"));
        if (form === "historical-events") filt("Event Type", qp("kind"));
        if (form === "audit-log") filt("Entity ID", qp("entityId"));
        if (qp("prefix") && ["companies", "people", "projects", "products"].includes(form)) {
          parts.push(`values[Name Key] =* ${kq(nameKey(qp("prefix")))}`); orderBy = "values[Name Key]";
          if (parts.length > 1) { const pf = parts.pop(); const first = parts[0].match(/values\[([^\]]+)\]/)[1]; parts.push(pf); orderBy = `values[${first}],values[Name Key]`; }
        }
        const r = await store.page(form, { q: parts.join(" AND "), orderBy, pageToken: qp("pageToken") });
        return send(200, r);
      }
      if (method === "POST") {
        const b = await body(); const values = b.values || {};
        if (NO_CLIENT_CREATE.has(form)) return send(400, { error: form === "sources" ? "Sources are created by ingestion jobs or POST /notes" : "The audit log is written by the server" });
        if (ADMIN_ONLY_WRITE.has(form) && !me.roles.admin) return send(403, { error: "Only administrators manage products" });
        if (form === "knowledge-entries") { const k = await services.proposeKnowledge(values); bust(); return send(201, { item: k }); }
        if (form === "research-jobs") { const j = await ingestion.createJob({ title: values.Title, jobType: values["Job Type"] || "research", connector: values.Connector, scope: parseJson(values.Scope, {}), subjectType: values["Subject Type"], subjectId: values["Subject ID"], batchSize: +values["Batch Size"] || 10 }); bust(); return send(201, { item: j }); }
        for (const k of Object.keys(values)) if (!def.fields.some(f => f.name === k)) delete values[k];
        if (values.Name && def.fields.some(f => f.name === "Name Key")) values["Name Key"] = nameKey(values.Name);
        if (values["Full Name"]) values["Name Key"] = nameKey(values["Full Name"]);
        if (form === "companies" && !values["Customer Status"]) { values["Customer Status"] = "Unknown"; values["Customer Status Basis"] = values["Customer Status Basis"] || "Not established by any source yet"; }
        if (form === "historical-events" && !values["Verification Status"]) values["Verification Status"] = "proposed";
        if (form === "decisions" && !values["Verification Status"]) values["Verification Status"] = "proposed";
        values["Record Status"] = values["Record Status"] || "active"; values["Created Via"] = actor.type;
        if (form === "companies" && (await services.findCompanies(values.Name)).length) return send(409, { error: `A company named like "${values.Name}" already exists` });
        const item = await store.create(form, values);
        await services.audit("create", form, item[def.idField], { details: { values } });
        bust(); return send(201, { item });
      }
    }
    if ((m = route.match(/^\/entities\/([\w-]+)\/([\w-]+)$/))) {
      const [, form, subId] = m; const def = FORM_BY_SLUG[form];
      if (!def) return send(404, { error: `Unknown entity form ${form}` });
      const cur = await store.bySubmissionId(subId);
      if (!cur || cur._form !== form) return send(404, { error: "Record not found" });
      if (method === "GET") return send(200, { item: cur });
      if (method === "PUT") {
        const b = await body(); const values = { ...(b.values || {}) };
        if (form === "audit-log") return send(403, { error: "The audit log is append-only" });
        if (ADMIN_ONLY_WRITE.has(form) && !me.roles.admin) return send(403, { error: "Only administrators manage products" });
        for (const k of Object.keys(values)) if (!def.fields.some(f => f.name === k) || (PROTECTED[form] || []).includes(k) || k === def.idField) delete values[k];
        if (form === "historical-events" && cur["Verification Status"] === "verified" && ["Title", "Event Date", "Date Precision", "Description", "Company ID"].some(k => k in values && values[k] !== cur[k]))
          return send(409, { error: "Verified events are not overwritten. Record the new information as a new event or knowledge entry and supersede the old one." });
        if (form === "knowledge-entries" && !["proposed", "needs-research"].includes(cur["Review Status"]) && !me.roles.reviewer)
          return send(403, { error: "Only reviewers can edit knowledge after review" });
        if ((form === "historical-events" || form === "decisions") && "Verification Status" in values && !me.roles.reviewer) delete values["Verification Status"];
        if (form === "companies" && "Customer Status" in values && values["Customer Status"] !== cur["Customer Status"] && !String(values["Customer Status Basis"] ?? cur["Customer Status Basis"]).trim())
          return send(400, { error: "Changing customer status needs a basis (the evidence or reason)" });
        if (values.Name && def.fields.some(f => f.name === "Name Key")) values["Name Key"] = nameKey(values.Name);
        if (values["Full Name"]) values["Name Key"] = nameKey(values["Full Name"]);
        const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => (cur[k] || "") !== v));
        if (!Object.keys(changed).length) return send(200, { item: cur, unchanged: true });
        const item = await store.update(subId, changed);
        await services.audit("update", form, cur[def.idField], { details: { changed: Object.fromEntries(Object.keys(changed).map(k => [k, { from: cur[k] || "", to: changed[k] }])) } });
        bust(); return send(200, { item });
      }
    }

    // ── detail views ──
    if ((m = route.match(/^\/companies\/([\w-]+)$/)) && method === "GET") {
      const d = await services.companyDossier(m[1]); return d ? send(200, d) : send(404, { error: "Company not found" });
    }
    if ((m = route.match(/^\/people\/([\w-]+)$/)) && method === "GET") {
      const d = await services.personProfile(m[1]); return d ? send(200, d) : send(404, { error: "Person not found" });
    }
    if ((m = route.match(/^\/knowledge\/([\w-]+)$/)) && method === "GET") {
      const d = await services.knowledgeDetail(m[1]); return d ? send(200, d) : send(404, { error: "Knowledge entry not found" });
    }
    if ((m = route.match(/^\/sources\/([\w-]+)$/)) && method === "GET") {
      const d = await services.sourceDetail(m[1]);
      if (!d) return send(404, { error: "Source not found or you do not have access to it" });
      const conn = CONNECTORS[d.source["Source System"]];
      return send(200, { ...d, original: conn?.original ? conn.original(d.source) : { available: false } });
    }
    // Horizontal timeline: every event in one year (month, type and paging are filtered in the browser).
    if (route === "/timeline/year" && method === "GET") {
      const year = qp("year");
      if (!/^\d{4}$/.test(year)) return send(400, { error: "year must be YYYY" });
      return send(200, await timelineYear(year));
    }
    if (route === "/timeline" && method === "GET") {
      return send(200, await services.timeline({ companyId: qp("companyId"), productId: qp("productId"), projectId: qp("projectId"), eventType: qp("eventType"), from: qp("from"), to: qp("to"), pageToken: qp("pageToken") }));
    }
    if ((m = route.match(/^\/entity-title\/(\w+)\/([\w-]+)$/))) return send(200, { title: await services.entityTitle(m[1], m[2]) });
    if ((m = route.match(/^\/ref\/(\w+)\/([\w-]+)$/)) && method === "GET") {
      const form = ENTITY_FORMS[m[1]]; if (!form) return send(404, { error: `Unknown entity type ${m[1]}` });
      const item = await store.byId(form, m[2]); return item ? send(200, { item }) : send(404, { error: "Not found or not visible to you" });
    }

    // idempotent typed link between two stable IDs
    if (route === "/relationships" && method === "POST") {
      const b = await body();
      for (const k of ["fromType", "fromId", "toType", "toId", "relationshipType"]) if (!b[k]) return send(400, { error: `${k} is required` });
      for (const [t, id] of [[b.fromType, b.fromId], [b.toType, b.toId]]) {
        if (!ENTITY_FORMS[t]) return send(400, { error: `Unknown entity type ${t}` });
        if (!(await store.byId(ENTITY_FORMS[t], id))) return send(400, { error: `${t} ${id} not found` });
      }
      const rel = await services.link(b.fromType, b.fromId, b.toType, b.toId, b.relationshipType, { role: b.role || "", start: b.start || "", end: b.end || "", precision: b.precision || "", sourceIds: b.sourceIds || [], notes: b.notes || "" });
      await services.audit("link", "relationship", rel["Relationship ID"], { details: { from: b.fromId, to: b.toId, type: b.relationshipType } });
      bust(); return send(200, { item: rel });
    }

    // ── review ──
    if (route === "/review-queue" && method === "GET") {
      const status = qp("status") || "proposed";
      const q = [`values[Review Status] = ${kq(status)}`];
      if (qp("companyId")) q.unshift(`values[Company ID] = ${kq(qp("companyId"))}`);
      return send(200, await store.page("knowledge-entries", { q: q.join(" AND "), pageToken: qp("pageToken") }));
    }
    if ((m = route.match(/^\/knowledge\/([\w-]+)\/review$/)) && method === "POST") {
      const b = await body();
      if (!REVIEW_ACTIONS[b.action]) return send(400, { error: `action must be one of ${Object.keys(REVIEW_ACTIONS).join(", ")}` });
      if (b.action !== "research") requireReviewer();
      if (!me.roles.reviewer) {
        // Members cannot change reviewed records (Kinetic policy); their research request becomes a tracked job.
        if (!String(b.comment || "").trim()) return send(400, { error: "Say what research is needed" });
        const k = await store.byId("knowledge-entries", m[1]); if (!k) return send(404, { error: "Knowledge entry not found" });
        const job = await ingestion.createJob({ title: `Research request: ${k.Title}`.slice(0, 200), jobType: "research", scope: { knowledgeId: m[1], request: b.comment }, subjectType: "knowledge", subjectId: m[1] });
        await store.update(job._id, { "Open Questions": JSON.stringify([{ question: b.comment, knowledgeId: m[1] }]) });
        await services.audit("research-requested", "knowledge", m[1], { comment: b.comment, details: { job: job["Job ID"] } });
        bust(); return send(200, { requested: true, job });
      }
      const r = await services.review(m[1], b.action, { comment: b.comment, supersededBy: b.supersededBy });
      bust(); return send(200, r);
    }

    // ── notes & interviews (manual connector) ──
    if (route === "/notes" && method === "POST") {
      const b = await body();
      if (!String(b.title || "").trim() || !String(b.content || "").trim()) return send(400, { error: "title and content are required" });
      if (b.restricted && !me.roles.reviewer) return send(403, { error: "Restricted notes are visible to reviewers only, so only reviewers can add them. Ask a reviewer, or save it unrestricted." });
      const job = await ingestion.createJob({ title: `Note: ${b.title}`.slice(0, 200), connector: "manual", subjectType: b.companyId ? "company" : "", subjectId: b.companyId || "" });
      const originalId = `${me.username}:${Date.now()}`;
      const r = await ingestion.processBatch(job, [{ system: "manual", originalId, sourceType: b.kind || "interview", title: b.title, date: b.date || new Date().toISOString().slice(0, 10),
        owner: b.recalledBy || me.username, url: "", excerpt: String(b.content).slice(0, 4000), contentHash: "", accessScope: b.restricted ? "restricted" : "internal", participants: [], companyHints: [] }], { done: true });
      const sid = r.results[0].sourceId;
      let knowledge = null;
      if (b.propose !== false && sid) knowledge = await services.proposeKnowledge({ knowledgeType: "recollection", subjectType: b.companyId ? "company" : "", subjectId: b.companyId || "", companyId: b.companyId || "",
        title: b.title, statement: b.content, sourceIds: [sid], extractionMethod: "interview", note: `Recalled by ${b.recalledBy || me.username}` });
      bust(); return send(201, { sourceId: sid, knowledge, job: r.job["Job ID"] });
    }

    // ── jobs & ingestion ──
    if (route === "/connectors") return send(200, { connectors: connectorStatus(), modelProvider: activeProvider() });
    if (route === "/jobs" && method === "POST") {
      const b = await body();
      const job = await ingestion.createJob({ title: b.title || `${b.connector} ingestion`, jobType: b.jobType || "ingestion", connector: b.connector, scope: b.scope || {}, subjectType: b.subjectType || "", subjectId: b.subjectId || "", batchSize: b.batchSize || 10 });
      bust(); return send(201, { job });
    }
    if ((m = route.match(/^\/jobs\/([\w-]+)$/)) && method === "GET") {
      const job = await store.byId("research-jobs", m[1]); if (!job) return send(404, { error: "Job not found" });
      const sources = await store.page("sources", { q: `values[Ingest Job ID] = ${kq(m[1])}` });
      const knowledge = await store.page("knowledge-entries", { q: `values[Job ID] = ${kq(m[1])}` });
      return send(200, { job, sources: sources.items, knowledge: knowledge.items });
    }
    if ((m = route.match(/^\/jobs\/([\w-]+)\/batch$/)) && method === "POST") {
      const job = await store.byId("research-jobs", m[1]); if (!job) return send(404, { error: "Job not found" });
      if (["completed", "cancelled"].includes(job.Status)) return send(409, { error: `Job is ${job.Status}` });
      const b = await body();
      const records = Array.isArray(b.records) ? b.records : [];
      for (const r of records) if (r.system !== job.Connector) return send(400, { error: `Record system ${r.system} does not match job connector ${job.Connector}` });
      const r = await ingestion.processBatch(job, records, { checkpoint: b.checkpoint, done: !!b.done });
      bust(); return send(200, { results: r.results, job: r.job });
    }
    if ((m = route.match(/^\/jobs\/([\w-]+)\/run$/)) && method === "POST") {
      const job = await store.byId("research-jobs", m[1]); if (!job) return send(404, { error: "Job not found" });
      if (!CONNECTORS[job.Connector]?.discover) return send(400, { error: `${job.Connector} jobs are fed by an authorized agent (POST /jobs/${m[1]}/batch)` });
      // runs in the background of this server process — never inside the browser request
      ingestion.runPull(m[1]).then(() => bust()).catch(e => console.error(`[corporate-brain] job ${m[1]}:`, e.message));
      return send(202, { started: true, jobId: m[1] });
    }
    if ((m = route.match(/^\/jobs\/([\w-]+)\/(retry|cancel)$/)) && method === "POST") {
      const job = await store.byId("research-jobs", m[1]); if (!job) return send(404, { error: "Job not found" });
      const values = m[2] === "cancel" ? { Status: "cancelled" } : { Status: "queued" };
      await store.update(job._id, values);
      await services.audit(`job:${m[2]}`, "job", m[1], { from: job.Status, to: values.Status });
      bust(); return send(200, { job: { ...job, ...values } });
    }

    // ── historian ──
    if (route === "/historian/ask" && method === "POST") {
      const b = await body();
      return send(200, await historian.ask(b.question, { withNarrative: b.narrative !== false }));
    }
    if (route === "/historian/tools" && method === "GET") {
      return send(200, { tools: Object.entries(historian.tools).map(([name, t]) => ({ name, description: t.description })) });
    }
    if ((m = route.match(/^\/historian\/tools\/(\w+)$/)) && method === "POST") {
      const t = historian.tools[m[1]]; if (!t) return send(404, { error: "Unknown tool" });
      const r = await t.run(await body()); if (m[1] === "propose_knowledge") bust();
      return send(200, { result: r });
    }
    if (route === "/historian/research" && method === "POST") {
      // turns unanswered questions into a tracked research job (work for people/agents to pick up)
      const b = await body();
      const job = await ingestion.createJob({ title: b.title || `Research: ${b.question}`.slice(0, 200), jobType: "research", connector: "", scope: { question: b.question, openQuestions: b.openQuestions || [] }, subjectType: b.subjectType || "", subjectId: b.subjectId || "" });
      await store.update(job._id, { "Open Questions": JSON.stringify(b.openQuestions || []) });
      bust(); return send(201, { job });
    }

    if (route === "/audit" && method === "GET") {
      return send(200, await store.page("audit-log", { q: qp("entityId") ? `values[Entity ID] = ${kq(qp("entityId"))}` : "", pageToken: qp("pageToken") }));
    }
    return false;
  } catch (e) {
    const status = e.status || (e instanceof KineticError ? (e.status === 401 || e.status === 403 ? e.status : 502) : 500);
    if (status >= 500) console.error("[corporate-brain]", route, e.stack || e.message);
    return send(status, { error: e.message });
  }
}
