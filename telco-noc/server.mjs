/**
 * Telco NOC — integration service + API (auto-mounted by apps/base/server.mjs at /api/noc).
 *
 * Identity: every request carries the user's Kinetic Basic auth. /me (with attributes) resolves
 *   tenant  = user attribute "NOC Tenant"   (space admins may pick a tenant with X-NOC-Tenant / ?tenant=)
 *   roles   = user attribute "NOC Role"     (Operator | Service Owner | Field Tech | Support Agent | Executive | Tenant Admin)
 * Operational reads use the USER's credentials (Kinetic KSL policies apply). Engine writes use the service
 * account and are attributed in audit as Actor Type "Engine". Operator actions are checked here against
 * role + state machine, then written with service credentials and audited with the operator's username.
 *
 * Endpoints (GET unless noted):
 *   /api/noc/me                         identity, tenant, roles
 *   /api/noc/command-center             KPIs, open incidents, alarm funnel, integration freshness
 *   /api/noc/incidents?state&page       paged incident list (25)
 *   /api/noc/incidents/:id              incident workspace bundle
 *   /api/noc/incidents/:id/alarms       paged alarms (25) ?role=&state=&pageToken=
 *   /api/noc/incidents/:id/impacts      paged impacts (25) ?class=&pageToken=
 *   /api/noc/incidents/:id/map          impact map graph (sites, spans, states)
 *   POST /api/noc/incidents/:id/action  {action: ack|assign|declare-major|transition|confirm-cause|note|confirm-service, ...}
 *   POST /api/noc/incidents/:id/verify  run recovery verification
 *   POST /api/noc/incidents/:id/impact  recompute impact (topology as of detection)
 *   POST /api/noc/incidents/:id/dispatch  create work order (Draft — requires approval to dispatch)
 *   POST /api/noc/incidents/:id/assist  {kinds:[...]} → AI recommendations with citations
 *   POST /api/noc/incidents/:id/notifications  create draft from AI draft
 *   POST /api/noc/ai/:id/decision       {decision: accept|reject, feedback}
 *   POST /api/noc/notifications/:id/:op submit|approve|reject
 *   GET  /api/noc/work-orders?mine=1    field queue; POST /api/noc/work-orders/:id/transition {to,...}
 *   GET  /api/noc/resources?type&q&pageToken ; /api/noc/resources/:id
 *   GET  /api/noc/customers?pageToken ; /api/noc/customers/:id
 *   GET  /api/noc/changes ; POST /api/noc/changes/:id/risk-review
 *   GET  /api/noc/exec                  executive dashboard
 *   GET  /api/noc/integrations          integration health + freshness
 *   POST /api/noc/ask                   {question, incidentId}
 *   POST /api/noc/ingest/metrics        {tenantId, observations:[...]} — unit-normalizing metric adapter
 *   POST /api/noc/engine/correlate      {tenant} — run correlation now (also runs every 20s in-process)
 *   POST /api/noc/demo/reset            {batch} — delete runtime records of one replay batch (admin)
 */
import { rows, one, page, create, update, pool, reference, audit, timeline, nowIso, hash, q, cached, bust, SERVICE_AUTH as S, core, KAPP } from "./engine/store.mjs";
import { runCorrelation, writeImpact, runVerification, changeRisk, onCall, INC_TRANSITIONS, WO_TRANSITIONS, OPEN_INC, evidenceResources } from "./engine/ops.mjs";
import { buildGraph, propagate, CAT } from "./engine/core.mjs";
import { generate, checkCitations, answer, safeJson } from "./engine/assist.mjs";

export const appId = "telco-noc";
export const apiPrefix = "/api/noc";
export const kapp = KAPP;

const ROLES = ["Operator", "Service Owner", "Field Tech", "Support Agent", "Executive", "Tenant Admin"];
const idents = new Map();
async function whoami(auth) {
  if (!auth) return null;
  const c = idents.get(auth); if (c && Date.now() - c.at < 60000) return c.v;
  const r = await core("GET", "/me?include=attributes", null, auth);
  if (r.status === 401 || r.status === 403) return null;
  if (r.status !== 200) return { transient: true, status: r.status };
  const attrs = Object.fromEntries((r.data.attributes || []).map((a) => [a.name, a.values || []]));
  const v = { username: r.data.username, displayName: r.data.displayName || r.data.username, spaceAdmin: !!r.data.spaceAdmin, tenant: (attrs["NOC Tenant"] || [])[0] || "", roles: attrs["NOC Role"] || [] };
  idents.set(auth, { at: Date.now(), v }); return v;
}
const has = (ctx, ...roles) => ctx.spaceAdmin || roles.some((r) => ctx.roles.includes(r));

function readBody(req) { return new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { res(d ? JSON.parse(d) : {}); } catch { res({ __bad: true }); } }); }); }
function send(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); return true; }
const fail = (res, code, msg, extra = {}) => send(res, code, { error: msg, ...extra });

// ─────────────────────────── continuous correlation (in-process scheduler) ───────────────────────────
let corrBusy = false; const lastRun = new Map();
async function tick() {
  if (corrBusy || process.env.NOC_AUTOCORRELATE !== "1") return; // opt-in: exactly one process per deployment runs the correlator
  corrBusy = true;
  try {
    const tenants = await cached("tenants", 300000, async () => (await core("GET", `/kapps/${KAPP}/forms/tenants/submissions?include=values&limit=25`, null, S)).data.submissions?.map((s) => s.values["Tenant ID"]) || []);
    for (const t of tenants) {
      const u = await core("GET", `/kapps/${KAPP}/forms/alarms/submissions?include=values&limit=25&q=${encodeURIComponent(`values[Tenant ID]="${t}" AND values[State]="Active" AND values[Correlation Role]="Uncorrelated"`)}`, null, S);
      const pend = (u.data.submissions || []).filter((s) => !s.values["Correlation Group ID"]);
      if (!pend.length) continue;
      const r = await runCorrelation(t, { settleSeconds: 15, batch: pend[0].values["Replay Batch"] || "" });
      lastRun.set(t, { at: nowIso(), result: r });
    }
  } catch (e) { lastRun.set("_error", { at: nowIso(), error: e.message }); } finally { corrBusy = false; }
}
if (!globalThis.__nocTimer) globalThis.__nocTimer = setInterval(tick, 20000);

// ─────────────────────────── metric adapter (unit normalization) ───────────────────────────
export function normalizeMetric(o) {
  const def = CAT.metrics[o.metric]; if (!def) return { error: `unknown metric ${o.metric}` };
  const f = def.from[o.unit]; if (f == null) return { error: `unit ${o.unit} not convertible to ${def.unit}` };
  const v = Number(o.value); if (!isFinite(v)) return { error: "value not numeric" };
  const t = Date.parse(o.observedAt); if (isNaN(t)) return { error: "observedAt not ISO-8601" };
  return { value: Math.round(v * f * 1000) / 1000, unit: def.unit, observedAt: new Date(Math.min(t, Date.now() + 120000)).toISOString().replace(/\.\d+Z/, "Z"), quality: t > Date.now() + 120000 ? "Suspect" : "Good" };
}

export async function handleAPI(req, res, pathname, auth, helpers) {
  if (!pathname.startsWith(apiPrefix)) return false;
  const url = new URL(req.url, "http://x"); const P = pathname.slice(apiPrefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  const me = await whoami(auth);
  if (!me) return fail(res, 401, "Sign in with your Kinetic credentials.");
  if (me.transient) return fail(res, 503, `Kinetic identity check unavailable (${me.status}) — retry`);
  const tenant = me.spaceAdmin ? (req.headers["x-noc-tenant"] || url.searchParams.get("tenant") || me.tenant || "borealis") : me.tenant;
  if (!tenant) return fail(res, 403, "Your account is not assigned to a NOC tenant (user attribute 'NOC Tenant').");
  const ctx = { ...me, tenant, roles: me.spaceAdmin && !me.roles.length ? ROLES : me.roles };
  const body = req.method === "POST" ? await readBody(req) : {};
  if (body.__bad) return fail(res, 400, "Body is not valid JSON");
  const A = auth; // user identity for reads
  try {
    // ── identity ──
    if (P[0] === "me") return send(res, 200, { ...ctx, correlation: lastRun.get(tenant) || null });

    // ── command center ──
    if (P[0] === "command-center") {
      const data = await cached(`inc|${tenant}|cc`, 8000, async () => {
        const [incs, alarms, integ, raws] = await Promise.all([rows("incidents", tenant, "", A), rows("alarms", tenant, `values[State]="Active"`, A, 4000), rows("integrations", tenant, "", A),
          rows("raw-alarms", tenant, `values[Processing State]="Rejected"`, A, 500)]);
        const open = incs.filter((i) => OPEN_INC.includes(i.State));
        const rawTotal = await countRaw(tenant, A);
        const byRole = alarms.reduce((m, a) => ((m[a["Correlation Role"] || "Uncorrelated"] = (m[a["Correlation Role"] || "Uncorrelated"] || 0) + 1), m), {});
        return {
          kpis: { openIncidents: open.length, p1: open.filter((i) => i.Priority === "P1").length, major: open.filter((i) => i["Major Incident"] === "Yes").length,
            activeAlarms: alarms.length, rawEvents: rawTotal, rejected: raws.length, customersAffected: open.reduce((s, i) => s + Number(i["Customers Affected"] || 0), 0),
            slaExposureUsd: open.reduce((s, i) => s + Number(i["SLA Exposure USD"] || 0), 0), unacked: open.filter((i) => i.State === "New").length },
          funnel: { raw: rawTotal, normalized: alarms.length, correlated: alarms.filter((a) => a["Correlation Group ID"]).length, groups: new Set(alarms.map((a) => a["Correlation Group ID"]).filter(Boolean)).size, incidents: open.length, byRole },
          incidents: open.sort((a, b) => a.Priority.localeCompare(b.Priority) || b["Detected At"].localeCompare(a["Detected At"])).map(incCard),
          uncorrelated: alarms.filter((a) => !a["Correlation Group ID"] && a["Correlation Role"] !== "Suppressed").slice(0, 25).map(alarmRow),
          suppressed: alarms.filter((a) => a["Correlation Role"] === "Suppressed").map(alarmRow),
          integrations: await observedFreshness(tenant, integ, A), correlation: lastRun.get(tenant) || null,
        };
      });
      return send(res, 200, data);
    }

    // ── incidents ──
    if (P[0] === "incidents" && !P[1]) {
      const st = url.searchParams.get("state");
      const r = await page("incidents", tenant, st === "open" ? OPEN_INC.map((s) => `values[State]="${s}"`).join(" OR ") : st ? `values[State]="${q(st)}"` : "", A, url.searchParams.get("pageToken"));
      return send(res, 200, { rows: r.rows.map(incCard), nextPageToken: r.nextPageToken });
    }
    if (P[0] === "incidents" && P[1]) {
      const id = P[1];
      const inc = await one("incidents", tenant, "Incident ID", id, A);
      if (!inc) return fail(res, 404, `Incident ${id} not found in tenant ${tenant}`);
      if (!P[2] && req.method === "GET") return send(res, 200, await workspace(tenant, inc, A, ctx));
      if (P[2] === "alarms") { const role = url.searchParams.get("role"), st = url.searchParams.get("state");
        const r = await page("alarms", tenant, `values[Incident ID]="${q(id)}"` + (st ? ` AND values[State]="${q(st)}"` : "") + (role ? ` AND values[Correlation Role]="${q(role)}"` : ""), A, url.searchParams.get("pageToken"));
        return send(res, 200, { rows: r.rows.map(alarmRow), nextPageToken: r.nextPageToken }); }
      if (P[2] === "impacts") { const c = url.searchParams.get("class");
        const r = await page("impacts", tenant, `values[Incident ID]="${q(id)}"` + (c ? ` AND values[Impact Class]="${q(c)}"` : ""), A, url.searchParams.get("pageToken"));
        return send(res, 200, { rows: r.rows, nextPageToken: r.nextPageToken }); }
      if (P[2] === "map") return send(res, 200, await impactMap(tenant, inc, A));
      if (req.method !== "POST") return fail(res, 405, "method");
      if (P[2] === "action") return send(res, 200, await incidentAction(tenant, inc, body, ctx));
      if (P[2] === "verify") { if (!has(ctx, "Operator", "Service Owner")) return fail(res, 403, "Operators only"); return send(res, 200, await runVerification(tenant, id, ctx.username)); }
      if (P[2] === "impact") { if (!has(ctx, "Operator", "Service Owner")) return fail(res, 403, "Operators only"); return send(res, 200, await writeImpact(tenant, id)); }
      if (P[2] === "dispatch") return send(res, 200, await createWorkOrder(tenant, inc, body, ctx));
      if (P[2] === "assist") return send(res, 200, await assist(tenant, inc, body.kinds || ["Summary", "Hypothesis", "Next Step"], ctx, A));
      if (P[2] === "notifications") return send(res, 200, await draftNotification(tenant, inc, body, ctx, A));
      return fail(res, 404, "unknown incident operation");
    }

    // ── AI decisions ──
    if (P[0] === "ai" && P[1] && P[2] === "decision" && req.method === "POST") {
      if (!has(ctx, "Operator", "Service Owner")) return fail(res, 403, "Operators only");
      const rec = await one("ai-recommendations", tenant, "Recommendation ID", P[1], A); if (!rec) return fail(res, 404, "not found");
      if (!["accept", "reject"].includes(body.decision)) return fail(res, 400, "decision must be accept|reject");
      if (body.decision === "reject" && !String(body.feedback || "").trim()) return fail(res, 400, "Rejections need a reason (it is the training signal).");
      const status = body.decision === "accept" ? "Accepted" : "Rejected";
      await update(rec._id, { Status: status, "Decided By": ctx.username, "Decided At": nowIso(), Feedback: body.feedback || "" }, S);
      await timeline(tenant, rec["Incident ID"], { type: "AI", author: ctx.username, actorType: "User", summary: `${ctx.username} ${status.toLowerCase()} AI ${rec.Kind} ${rec["Recommendation ID"]}${body.feedback ? ": " + body.feedback : ""}. (Accepting a suggestion never executes it — approval-gated actions still need their own approval.)` });
      await audit(tenant, { actor: ctx.username, action: `ai.${body.decision}`, entityType: "AI Recommendation", entityId: rec["Recommendation ID"], reason: body.feedback });
      return send(res, 200, { ok: true, status });
    }

    // ── notifications ──
    if (P[0] === "notifications" && P[1] && P[2] && req.method === "POST") return send(res, 200, await notificationOp(tenant, P[1], P[2], body, ctx, A));

    // ── work orders ──
    if (P[0] === "work-orders" && !P[1]) {
      const mine = url.searchParams.get("mine") === "1";
      const kql = mine ? `values[Assigned Tech]="${q(ctx.username)}"` : "";
      const wos = await rows("work-orders", tenant, kql, A, 200);
      const ref = await reference(tenant);
      return send(res, 200, { rows: wos.filter((w) => !["Verified", "Cancelled"].includes(w.State) || url.searchParams.get("all")).map((w) => ({ ...w, site: ref.siteById.get(w["Site ID"]) || null })) });
    }
    if (P[0] === "work-orders" && P[1] && P[2] === "transition" && req.method === "POST") return send(res, 200, await woTransition(tenant, P[1], body, ctx));

    // ── network resources ──
    if (P[0] === "resources" && !P[1]) {
      const type = url.searchParams.get("type"), health = url.searchParams.get("health"), site = url.searchParams.get("site");
      const kql = [type && `values[Resource Type]="${q(type)}"`, health && `values[Health]="${q(health)}"`, site && `values[Site ID]="${q(site)}"`].filter(Boolean).join(" AND ");
      const r = await page("resources", tenant, kql, A, url.searchParams.get("pageToken"));
      return send(res, 200, { rows: r.rows.map(resRow), nextPageToken: r.nextPageToken, types: ENUM_TYPES });
    }
    if (P[0] === "resources" && P[1]) return send(res, 200, await resourceDetail(tenant, P.slice(1).join("/"), A));

    // ── customers ──
    if (P[0] === "customers" && !P[1]) {
      const seg = url.searchParams.get("segment");
      const r = await page("customers", tenant, seg ? `values[Segment]="${q(seg)}"` : "", A, url.searchParams.get("pageToken"));
      const openImpacts = await openImpactsByAccount(tenant, A);
      return send(res, 200, { rows: r.rows.map((c) => ({ ...c, status: openImpacts.get(c["Account ID"]) || null })), nextPageToken: r.nextPageToken });
    }
    if (P[0] === "customers" && P[1]) return send(res, 200, await customerView(tenant, P[1], ctx, A));

    // ── changes ──
    if (P[0] === "changes" && !P[1]) return send(res, 200, { rows: await rows("changes", tenant, "", A), now: nowIso() });
    if (P[0] === "changes" && P[1] && P[2] === "risk-review" && req.method === "POST") {
      if (!has(ctx, "Operator", "Service Owner")) return fail(res, 403, "Operators and service owners only");
      const r = await changeRisk(tenant, P[1]);
      const c = await one("changes", tenant, "Change ID", P[1], S);
      await update(c._id, { "Risk Score": String(r.score), Risk: r.risk, "Risk Factors": JSON.stringify([...r.conflicts.map((x) => x.reason), `${r.servicesDown.length} services down, ${r.servicesAtRisk.length} at risk, ${r.accounts.length} accounts, ${r.publicSafetyAccounts.length} public-safety`]) }, S);
      await audit(tenant, { actor: ctx.username, action: "change.risk-review", entityType: "Change", entityId: P[1], after: { score: r.score, risk: r.risk } });
      return send(res, 200, r);
    }

    // ── executive ──
    if (P[0] === "exec") return send(res, 200, await execView(tenant, A));
    if (P[0] === "integrations") return send(res, 200, { rows: await observedFreshness(tenant, await rows("integrations", tenant, "", A), A) });

    // ── ask ──
    if (P[0] === "ask" && req.method === "POST") {
      const inc = body.incidentId ? await one("incidents", tenant, "Incident ID", body.incidentId, A) : null;
      const [impacts, group] = inc ? await Promise.all([rows("impacts", tenant, `values[Incident ID]="${q(inc["Incident ID"])}"`, A), inc["Correlation Group ID"] ? one("correlation-groups", tenant, "Group ID", inc["Correlation Group ID"], A) : null]) : [[], null];
      const a = answer(String(body.question || ""), { incident: inc, impacts, group });
      if (inc) await create("ai-recommendations", { "Tenant ID": tenant, "Recommendation ID": `AIR-Q-${Date.now().toString(36).toUpperCase()}${hash(Math.random(), 3)}`, "Incident ID": inc["Incident ID"], Kind: "Answer",
        Content: `Q: ${body.question}\nA: ${a.answer}`.slice(0, 4000), Facts: "[]", Inferences: "[]", Confidence: "1", Citations: JSON.stringify(a.citations), Generator: "intent-matcher/v1", Status: "Proposed", "Requires Approval Action": "none", "Citation Check": a.citations.length ? "Passed" : "n/a" }, S);
      return send(res, 200, a);
    }

    // ── ingestion (metrics adapter) + engine ──
    if (P[0] === "ingest" && P[1] === "metrics" && req.method === "POST") {
      if (!has(ctx, "Tenant Admin", "Integration")) return fail(res, 403, "integration/service identities only");
      const obs = Array.isArray(body.observations) ? body.observations : []; if (obs.length > 500) return fail(res, 413, "max 500 observations per call");
      const results = await pool(obs, 8, async (o, i) => {
        const n = normalizeMetric(o); if (n.error) return { i, error: n.error };
        const id = `OBS-${hash(`${tenant}|${o.subject}|${o.metric}|${n.observedAt}|${o.source}`, 14)}`;
        const c = await create("metrics", { "Tenant ID": tenant, "Observation ID": id, "Subject ID": o.subject, Metric: o.metric, Value: String(n.value), Unit: n.unit, "Original Value": String(o.value), "Original Unit": o.unit,
          "Observed At": n.observedAt, "Source System": o.source || "unknown", Quality: n.quality, "Replay Batch": body.replayBatch || "" }, S);
        return c.ok ? { i, id, duplicate: !!c.existed } : { i, error: c.error };
      });
      return send(res, 200, { accepted: results.filter((r) => !r.error && !r.duplicate).length, duplicates: results.filter((r) => r.duplicate).length, rejected: results.filter((r) => r.error) });
    }
    if (P[0] === "engine" && P[1] === "correlate" && req.method === "POST") {
      if (!has(ctx, "Operator", "Tenant Admin")) return fail(res, 403, "Operators only");
      const r = await runCorrelation(tenant, { batch: body.batch || "" }); lastRun.set(tenant, { at: nowIso(), result: r }); bust(`inc|${tenant}`); return send(res, 200, r);
    }
    if (P[0] === "demo" && P[1] === "reset" && req.method === "POST") {
      if (!ctx.spaceAdmin) return fail(res, 403, "space admin only");
      if (!body.batch) return fail(res, 400, "batch required — reset only deletes records of one replay batch");
      const forms = ["raw-alarms", "alarms", "correlation-groups", "metrics", "incidents", "incident-updates", "work-orders", "impacts", "notifications", "audit", "ai-recommendations"];
      const out = {};
      const incIds = (await rows("incidents", tenant, `values[Replay Batch]="${q(body.batch)}"`, S)).map((i) => i["Incident ID"]).concat(body.incidentIds || []);
      for (const f of forms) {
        const r = await rows(f, tenant, `values[Replay Batch]="${q(body.batch)}"`, S, 5000);
        // records written by user actions carry the Incident ID (timeline, AI, WOs, comms) or Entity ID (audit), not always the batch
        const extra = [];
        for (const id of incIds) {
          if (["incident-updates", "impacts", "work-orders", "notifications", "ai-recommendations"].includes(f)) extra.push(...await rows(f, tenant, `values[Incident ID]="${q(id)}"`, S, 2000));
          if (f === "audit") extra.push(...await rows(f, tenant, `values[Entity ID]="${q(id)}"`, S, 2000));
        }
        const all = [...new Map([...r, ...extra].map((x) => [x._id, x])).values()];
        await pool(all, 8, (x) => core("DELETE", `/submissions/${x._id}`, null, S)); out[f] = all.length;
      }
      // release reservations: Qty Reserved = parts on work orders still in flight
      const live = (await rows("work-orders", tenant, "", S)).filter((w) => ["Dispatched", "Accepted", "En Route", "On Site"].includes(w.State));
      for (const p of await rows("parts", tenant, "", S)) { const qty = live.reduce((n, w) => n + (safeJson(w.Parts) || []).filter((x) => x.partId === p["Part ID"] && x.reservation).reduce((a, x) => a + Number(x.qty || 0), 0), 0);
        if (String(qty) !== String(p["Qty Reserved"] || "0")) await update(p._id, { "Qty Reserved": String(qty) }, S); }
      bust(`inc|${tenant}`); return send(res, 200, { deleted: out });
    }
    return fail(res, 404, "Not found");
  } catch (e) { return fail(res, [400, 401, 403, 404, 409].includes(e.status) ? e.status : 500, e.message, e.blockers ? { blockers: e.blockers } : {}); }
}

// ─────────────────────────── views ───────────────────────────
const incCard = (i) => ({ id: i["Incident ID"], title: i.Title, state: i.State, priority: i.Priority, major: i["Major Incident"] === "Yes", owner: i.Owner, team: i["Owner Team ID"], root: i["Root Resource ID"],
  detectedAt: i["Detected At"], customers: Number(i["Customers Affected"] || 0), services: Number(i["Services Affected"] || 0), sla: Number(i["SLA Exposure USD"] || 0), verification: i["Verification State"], comms: i["Comms State"],
  escalation: Number(i["Escalation Level"] || 0), summary: safeJson(i["Impact Summary"]) || {}, market: i["Market ID"] });
const alarmRow = (a) => ({ id: a["Alarm ID"], type: a["Alarm Type"], severity: a.Severity, resource: a["Resource ID"] || a["Resource Ref"], match: a["Resource Match"], state: a.State, role: a["Correlation Role"], count: Number(a["Occurrence Count"] || 1),
  first: a["First Occurred At"], last: a["Last Occurred At"], cleared: a["Cleared At"], sources: a["Source Systems"], group: a["Correlation Group ID"], site: a["Site ID"], notes: a["Normalization Notes"], suppressedBy: a["Suppressed By Change ID"], sa: a["Service Affecting"] });
const resRow = (r) => ({ id: r["Resource ID"], name: r.Name, type: r["Resource Type"], cls: r["Resource Class"], site: r["Site ID"] || [r["A Site ID"], r["Z Site ID"]].filter(Boolean).join(" ↔ "), health: r.Health, oper: r["Oper State"], vendor: r.Vendor, source: r["Source System"], lastSeen: r["Last Seen At"], confidence: r.Confidence });
const ENUM_TYPES = ["Fiber Span", "ROADM", "Optical Port", "Wavelength", "OTN Link", "Router", "Interface", "Circuit", "Cell Site Router", "gNodeB", "Cell", "Microwave Link", "Power Plant"];
function integRow(s) {
  const last = Date.parse(s["Last Success At"]); const ageMin = isNaN(last) ? null : Math.round((Date.now() - last) / 60000); const sla = Number(s["Freshness SLA Minutes"] || 0);
  const freshness = s.Status === "Not Configured" ? "Not Configured" : ageMin == null ? "Unknown" : ageMin <= sla ? "Fresh" : ageMin <= sla * 3 ? "Stale" : "Very Stale";
  return { id: s["Source ID"], name: s.Name, type: s["Source Type"], mode: s.Mode, status: s.Status, lastSuccess: s["Last Success At"], ageMin, slaMin: sla, freshness, lastError: s["Last Error"], authority: s.Authority };
}
/** Monitoring freshness is OBSERVED (newest raw event actually received per source), not self-reported. */
async function observedFreshness(tenant, integ, A) {
  return Promise.all(integ.map(async (s) => {
    const row = integRow(s);
    if (s["Source Type"] !== "Monitoring") return { ...row, basis: "last successful sync reported by the integration job" };
    const r = await page("raw-alarms", tenant, `values[Source System]="${q(s["Source ID"])}"`, A, null, 1);
    const last = r.rows[0]?.["Received At"];
    if (!last) return { ...row, basis: "no events received yet" };
    const ageMin = Math.round((Date.now() - Date.parse(last)) / 60000);
    return { ...row, lastSuccess: last, ageMin, freshness: ageMin <= row.slaMin ? "Fresh" : ageMin <= row.slaMin * 3 ? "Stale" : "Very Stale", basis: "newest raw event received (observed)" };
  }));
}
async function countRaw(tenant, A) {
  const r = await core("GET", `/kapps/${KAPP}/forms/raw-alarms/submissions?limit=1&count=true&q=${encodeURIComponent(`values[Tenant ID]="${q(tenant)}"`)}`, null, A);
  if (typeof r.data?.count === "number") return r.data.count;
  return (await rows("raw-alarms", tenant, "", A, 3000)).length;
}

async function workspace(tenant, inc, A, ctx) {
  const id = inc["Incident ID"];
  const [group, updates, wos, notes, recs, impacts, alarms, history] = await Promise.all([
    inc["Correlation Group ID"] ? one("correlation-groups", tenant, "Group ID", inc["Correlation Group ID"], A) : null,
    rows("incident-updates", tenant, `values[Incident ID]="${q(id)}"`, A, 400), rows("work-orders", tenant, `values[Incident ID]="${q(id)}"`, A),
    rows("notifications", tenant, `values[Incident ID]="${q(id)}"`, A), rows("ai-recommendations", tenant, `values[Incident ID]="${q(id)}"`, A),
    rows("impacts", tenant, `values[Incident ID]="${q(id)}"`, A, 400), rows("alarms", tenant, `values[Incident ID]="${q(id)}"`, A, 3000),
    rows("incidents", tenant, inc["Root Resource ID"] ? `values[Root Resource ID]="${q(inc["Root Resource ID"])}"` : "", A)]);
  const ref = await reference(tenant);
  const root = ref.resById.get(inc["Root Resource ID"]) || null;
  const byClass = (c) => impacts.filter((i) => i["Impact Class"] === c);
  const acct = [...new Map(impacts.filter((i) => i["Account ID"]).map((i) => [i["Account ID"] + "|" + i["Impact Class"], i])).values()];
  const typeCounts = alarms.reduce((m, a) => ((m[a["Alarm Type"]] = (m[a["Alarm Type"]] || 0) + 1), m), {});
  const allowed = INC_TRANSITIONS[inc.State] || [];
  const closeBlockers = closureBlockers(inc, notes, impacts);
  return {
    incident: inc, incidentCard: incCard(inc), allowedTransitions: allowed, closeBlockers,
    group: group ? { ...group, evidence: safeJson(group.Evidence) } : null,
    root: root ? { ...resRow(root), aSite: ref.siteById.get(root["A Site ID"])?.Name, zSite: ref.siteById.get(root["Z Site ID"])?.Name, characteristics: safeJson(root.Characteristics) } : null,
    alarmStats: { total: alarms.length, active: alarms.filter((a) => a.State === "Active").length, cleared: alarms.filter((a) => a.State === "Cleared").length, rawOccurrences: alarms.reduce((s, a) => s + Number(a["Occurrence Count"] || 1), 0),
      byRole: alarms.reduce((m, a) => ((m[a["Correlation Role"]] = (m[a["Correlation Role"]] || 0) + 1), m), {}), byType: typeCounts, rootEvidence: alarms.filter((a) => a["Correlation Role"] === "Root Evidence").map(alarmRow) },
    impact: { confirmed: [...new Set(byClass("Confirmed").map((i) => i["Service Instance ID"]))].length, inferred: [...new Set(byClass("Inferred").map((i) => i["Service Instance ID"]))].length,
      potential: [...new Set(byClass("Potential").map((i) => i["Service Instance ID"]))].length, summary: safeJson(inc["Impact Summary"]) || {},
      accounts: acct.map((i) => ({ accountId: i["Account ID"], name: i["Account Name"], segment: i.Segment, cls: i["Impact Class"], ps: i["Public Safety"] === "Yes", sla: Number(i["SLA Exposure USD"] || 0), breachAt: i["SLA Breach At"], recovery: i["Recovery State"], service: i["Service Instance ID"] }))
        .sort((a, b) => (b.ps - a.ps) || ["Confirmed", "Inferred", "Potential"].indexOf(a.cls) - ["Confirmed", "Inferred", "Potential"].indexOf(b.cls) || b.sla - a.sla),
      services: [...new Map(impacts.map((i) => [i["Service Instance ID"], i])).values()].map((i) => ({ id: i["Service Instance ID"], name: ref.svcById.get(i["Service Instance ID"])?.Name, cls: i["Impact Class"], confidence: i.Confidence, basis: i.Basis, recovery: i["Recovery State"], evidence: safeJson(i["Verification Evidence"]), monitoring: ref.svcById.get(i["Service Instance ID"])?.Monitoring })) },
    timeline: updates.sort((a, b) => (b.At || "").localeCompare(a.At || "")).map((u) => ({ id: u["Update ID"], type: u["Update Type"], at: u.At, author: u.Author, actorType: u["Actor Type"], summary: u.Summary, visibility: u.Visibility })),
    workOrders: wos.map((w) => ({ ...w, site: ref.siteById.get(w["Site ID"]) || null })), notifications: notes,
    ai: recs.filter((r) => r.Kind !== "Answer").sort((a, b) => (b._createdAt || "").localeCompare(a._createdAt || "")).map((r) => ({ ...r, facts: safeJson(r.Facts), inferences: safeJson(r.Inferences), citations: safeJson(r.Citations) })),
    history: history.filter((h) => h["Incident ID"] !== inc["Incident ID"]).map(incCard),
    oncall: onCall(ref, inc["Owner Team ID"]), teams: ref.teams.map((t) => ({ id: t["Team ID"], name: t.Name })),
    you: { username: ctx.username, roles: ctx.roles, admin: ctx.spaceAdmin },
  };
}
function closureBlockers(inc, notes, impacts) {
  const b = [];
  if (inc["Verification State"] !== "Passed") b.push(`Customer service recovery not verified (Verification State: ${inc["Verification State"]})`);
  if (["P1", "P2"].includes(inc.Priority) && !inc["Observed Root Cause"]) b.push("Observed root cause not recorded (required for P1/P2)");
  const hasCust = impacts.some((i) => i["Impact Class"] !== "Potential" && i["Account ID"]);
  if (hasCust && !notes.some((n) => n.Sequence === "Resolution" && n.Status === "Sent")) b.push("Resolution notification to impacted customers not sent");
  if (inc.State !== "Resolved") b.push(`Incident must be Resolved first (currently ${inc.State})`);
  return b;
}

// ─────────────────────────── incident actions (state machine + roles) ───────────────────────────
async function incidentAction(tenant, inc, body, ctx) {
  const id = inc["Incident ID"]; const act = body.action; const before = { State: inc.State, Owner: inc.Owner, Priority: inc.Priority };
  const need = (...r) => { if (!has(ctx, ...r)) throw Object.assign(new Error(`Requires role: ${r.join(" or ")}`), { status: 403 }); };
  const upd = {}; let summary = "", type = "State Change";
  const now = nowIso();
  if (act === "ack") { need("Operator"); if (inc.State !== "New") throw bad("Only New incidents can be acknowledged");
    Object.assign(upd, { State: "Acknowledged", "Acknowledged At": now, Owner: inc.Owner || ctx.username }); summary = `Acknowledged by ${ctx.username} (${Math.round((Date.now() - Date.parse(inc["Detected At"])) / 60000)} min after detection).`; }
  else if (act === "assign") { need("Operator", "Service Owner"); if (!body.owner && !body.team) throw bad("owner or team required");
    Object.assign(upd, { ...(body.owner ? { Owner: body.owner } : {}), ...(body.team ? { "Owner Team ID": body.team } : {}) }); type = "Assignment"; summary = `Assigned to ${body.owner || "(team queue)"}${body.team ? " / " + body.team : ""} by ${ctx.username}.`; }
  else if (act === "declare-major") { need("Operator", "Service Owner"); if (inc["Major Incident"] === "Yes") throw bad("Already a major incident");
    if (!String(body.reason || "").trim()) throw bad("A reason is required to declare a major incident");
    Object.assign(upd, { "Major Incident": "Yes", "Major Declared At": now, "Major Declared By": ctx.username, Priority: "P1", "Escalation Level": String(Math.max(2, Number(inc["Escalation Level"] || 0))), "Next Update Due At": new Date(Date.now() + 30 * 60000).toISOString().replace(/\.\d+Z/, "Z") });
    type = "Major Declared"; summary = `MAJOR INCIDENT declared by ${ctx.username}: ${body.reason}. Bridge opened; duty manager paged; exec updates every 30 min.`; }
  else if (act === "transition") { need("Operator", "Service Owner"); const to = body.to;
    if (!(INC_TRANSITIONS[inc.State] || []).includes(to)) throw bad(`Illegal transition ${inc.State} → ${to}. Allowed: ${(INC_TRANSITIONS[inc.State] || []).join(", ") || "none (terminal)"}`);
    if (to === "Resolved" && !["Partial", "Passed", "Failed"].includes(inc["Verification State"])) throw bad("Cannot resolve before the network has recovered — run verification first");
    if (to === "Closed") { const [notes, impacts] = await Promise.all([rows("notifications", tenant, `values[Incident ID]="${q(id)}"`, S), rows("impacts", tenant, `values[Incident ID]="${q(id)}"`, S)]);
      const b = closureBlockers(inc, notes, impacts); if (b.length) throw bad("Cannot close: " + b.join("; "), { blockers: b }); }
    if (to === "Cancelled" && !String(body.reason || "").trim()) throw bad("Cancelling needs a reason (false positive / duplicate)");
    Object.assign(upd, { State: to, ...(to === "Mitigated" ? { "Mitigated At": now } : {}), ...(to === "Resolved" ? { "Resolved At": now } : {}), ...(to === "Closed" ? { "Closed At": now } : {}), ...(to === "In Progress" && !inc["Acknowledged At"] ? { "Acknowledged At": now } : {}) });
    summary = `State ${inc.State} → ${to} by ${ctx.username}${body.reason ? ": " + body.reason : ""}.`; }
  else if (act === "confirm-cause") { need("Operator", "Field Tech"); if (!String(body.cause || "").trim()) throw bad("cause required");
    Object.assign(upd, { "Observed Root Cause": body.cause, "Cause Confirmed By": ctx.username, "Cause Confirmed At": now }); type = "Note"; summary = `Observed root cause CONFIRMED by ${ctx.username}: ${body.cause} (engine hypothesis was: ${inc["Probable Cause"] || "none"}).`; }
  else if (act === "note") { need("Operator", "Service Owner", "Field Tech"); if (!String(body.text || "").trim()) throw bad("text required"); type = "Note"; summary = `${ctx.username}: ${body.text}`; }
  else if (act === "confirm-service") { need("Operator", "Service Owner"); if (!body.serviceId || !String(body.note || "").trim()) throw bad("serviceId and note required");
    await timeline(tenant, id, { type: "Verification", author: ctx.username, actorType: "User", summary: `Manual service confirmation for ${body.serviceId}: ${body.note}`, details: { confirmService: body.serviceId, note: body.note } });
    await audit(tenant, { actor: ctx.username, action: "incident.confirm-service", entityType: "Incident", entityId: id, after: { serviceId: body.serviceId }, reason: body.note });
    return { ok: true }; }
  else throw bad(`unknown action ${act}`);
  if (Object.keys(upd).length) { const u = await update(inc._id, upd, S); if (!u.ok) throw new Error(u.error); }
  if (["Closed", "Cancelled"].includes(upd.State) && inc["Correlation Group ID"]) { const g = await one("correlation-groups", tenant, "Group ID", inc["Correlation Group ID"], S); if (g) await update(g._id, { State: "Closed" }, S); }
  await timeline(tenant, id, { type, author: ctx.username, actorType: "User", summary });
  await audit(tenant, { actor: ctx.username, action: `incident.${act}`, entityType: "Incident", entityId: id, before, after: upd, reason: body.reason || body.cause || "" });
  bust(`inc|${tenant}`);
  return { ok: true, updated: upd };
}
const bad = (m, extra = {}) => Object.assign(new Error(m), { status: 400, ...extra });

// ─────────────────────────── field work ───────────────────────────
async function createWorkOrder(tenant, inc, body, ctx) {
  if (!has(ctx, "Operator")) throw Object.assign(new Error("Operators only"), { status: 403 });
  const ref = await reference(tenant); const root = ref.resById.get(inc["Root Resource ID"]) || {};
  const isSpan = root["Resource Type"] === "Fiber Span";
  const siteId = body.siteId || (isSpan ? "SITE-FH-I94-09" : root["Site ID"]) || ""; const site = ref.siteById.get(siteId) || {};
  const woId = `WO-${inc["Incident ID"].replace("INC-", "")}-${hash(siteId + (body.workType || ""), 4)}`;
  const parts = body.parts || (isSpan ? [{ partId: "PRT-SPLICE-144", qty: 2 }, { partId: "PRT-FIBER-288-1KM", qty: 1 }, { partId: "PRT-OTDR-KIT", qty: 1 }] : []);
  const v = { "Tenant ID": tenant, "Work Order ID": woId, "Incident ID": inc["Incident ID"], "Work Type": body.workType || (isSpan ? "Fiber Repair" : "Site Visit"), State: "Draft", Priority: inc.Priority,
    Summary: body.summary || (isSpan ? `Locate and splice fiber break on ${inc["Root Resource ID"]} (${safeJson(root.Characteristics)?.route || ""})` : `Site visit ${siteId} for ${inc["Root Resource ID"]}`),
    "Site ID": siteId, "Resource ID": inc["Root Resource ID"], "Location Description": body.location || (isSpan ? "OTDR from ROADM-MSP-01 OTS-2: event at 9.41 km (±30 m) → I-94 right-of-way near Lexington Pkwy; nearest hut SITE-FH-I94-09" : site.Street || ""),
    Latitude: body.lat || site.Latitude || "", Longitude: body.lon || site.Longitude || "", "Access Instructions": site["Access Instructions"] || "", "Safety Notes": site["Safety Notes"] || "",
    Parts: JSON.stringify(parts), "Completion Criteria": body.criteria || (isSpan ? "All 144 fibers spliced; OTDR trace on each lit fiber < 0.1 dB per splice; NOC confirms rx power within 3 dB of baseline on all 8 channels and OTU LOF cleared" : "Site equipment operational; NOC confirms alarms cleared and KPIs healthy"),
    "Assigned Tech": body.tech || onCall(ref, "TEAM-FIELD-EAST")?.User || "", Crew: body.crew || "East Metro fiber crew 2", "Replay Batch": inc["Replay Batch"] || "" };
  const c = await create("work-orders", v, S); if (!c.ok) throw new Error(c.error);
  await timeline(tenant, inc["Incident ID"], { type: "Field", author: ctx.username, actorType: "User", summary: `Work order ${woId} drafted (${v["Work Type"]}, tech ${v["Assigned Tech"] || "unassigned"}). Awaiting explicit dispatch approval.` });
  await audit(tenant, { actor: ctx.username, action: "workorder.draft", entityType: "Work Order", entityId: woId, after: { site: siteId, tech: v["Assigned Tech"] } });
  return { ok: true, workOrderId: woId, existed: !!c.existed };
}
async function woTransition(tenant, woId, body, ctx) {
  const wo = await one("work-orders", tenant, "Work Order ID", woId, S); if (!wo) throw Object.assign(new Error("work order not found"), { status: 404 });
  const to = body.to;
  if (!(WO_TRANSITIONS[wo.State] || []).includes(to)) throw bad(`Illegal transition ${wo.State} → ${to}. Allowed: ${(WO_TRANSITIONS[wo.State] || []).join(", ") || "none"}`);
  const techStep = ["Accepted", "En Route", "On Site", "Work Complete"].includes(to);
  if (to === "Dispatched" && !has(ctx, "Operator")) throw Object.assign(new Error("Dispatch approval requires an Operator"), { status: 403 });
  if (to === "Verified" && !has(ctx, "Operator")) throw Object.assign(new Error("Only the NOC can verify completed field work"), { status: 403 });
  if (techStep && !(has(ctx, "Operator") || (ctx.roles.includes("Field Tech") && wo["Assigned Tech"] === ctx.username))) throw Object.assign(new Error("Only the assigned technician (or NOC) can update this work order"), { status: 403 });
  const now = nowIso(); const upd = { State: to };
  if (to === "Dispatched") {
    // explicit human approval + parts reservation (fails closed if stock is insufficient)
    const parts = safeJson(wo.Parts) || []; const reserved = [];
    for (const p of parts) { const part = await one("parts", tenant, "Part ID", p.partId, S);
      if (!part || Number(part["Qty On Hand"]) - Number(part["Qty Reserved"] || 0) < p.qty) { for (const r of reserved) await update(r._id, { "Qty Reserved": String(Number(r["Qty Reserved"] || 0)) }, S); throw bad(`Insufficient stock for ${p.partId}`); }
      await update(part._id, { "Qty Reserved": String(Number(part["Qty Reserved"] || 0) + p.qty) }, S); reserved.push(part); p.reservation = `RSV-${woId}-${p.partId}`; }
    Object.assign(upd, { "Dispatch Approved By": ctx.username, "Dispatched At": now, ETA: body.eta || new Date(Date.now() + 55 * 60000).toISOString().replace(/\.\d+Z/, "Z"), Parts: JSON.stringify(parts) });
  }
  if (to === "Accepted") upd["Accepted At"] = now;
  if (to === "On Site") upd["Arrived At"] = now;
  if (to === "Work Complete") {
    if (!String(body.findings || "").trim() || !String(body.notes || "").trim()) throw bad("Findings and completion notes are required");
    if (!Array.isArray(body.evidence) || !body.evidence.length) throw bad("At least one piece of completion evidence (e.g. OTDR trace, photo) is required");
    Object.assign(upd, { "Completed At": now, Findings: body.findings, "Completion Notes": body.notes, Evidence: JSON.stringify(body.evidence) });
  }
  const u = await update(wo._id, upd, S); if (!u.ok) throw new Error(u.error);
  if (wo["Incident ID"]) await timeline(tenant, wo["Incident ID"], { type: "Field", author: ctx.username, actorType: "User", summary: `Work order ${woId}: ${wo.State} → ${to}${to === "Dispatched" ? ` (dispatch approved by ${ctx.username}; ETA ${upd.ETA})` : ""}${to === "Work Complete" ? ` — findings: ${body.findings}` : ""}.` });
  await audit(tenant, { actor: ctx.username, action: `workorder.${to.toLowerCase().replace(/ /g, "-")}`, entityType: "Work Order", entityId: woId, before: { State: wo.State }, after: upd });
  return { ok: true, updated: upd };
}

// ─────────────────────────── AI assistance ───────────────────────────
async function assist(tenant, inc, kinds, ctx, A, opts = {}) {
  if (!has(ctx, "Operator", "Service Owner")) throw Object.assign(new Error("Operators only"), { status: 403 });
  const id = inc["Incident ID"]; const ref = await reference(tenant);
  const [group, alarms, impacts, updates, workOrders, history, changes] = await Promise.all([
    inc["Correlation Group ID"] ? one("correlation-groups", tenant, "Group ID", inc["Correlation Group ID"], A) : null, rows("alarms", tenant, `values[Incident ID]="${q(id)}"`, A, 3000),
    rows("impacts", tenant, `values[Incident ID]="${q(id)}"`, A), rows("incident-updates", tenant, `values[Incident ID]="${q(id)}"`, A), rows("work-orders", tenant, `values[Incident ID]="${q(id)}"`, A),
    rows("incidents", tenant, "", A), rows("changes", tenant, "", A)]);
  const P = { inc, group, alarms, impacts, updates, workOrders, history, runbooks: ref.runbooks, changes, resources: ref.resById };
  // everything the user could see (fetched with THEIR credentials) — citations must resolve into this set
  const visible = new Set([...[inc].map((x) => `incidents|${x["Incident ID"]}`), ...(group ? [`correlation-groups|${group["Group ID"]}`] : []), ...alarms.map((a) => `alarms|${a["Alarm ID"]}`),
    ...impacts.map((i) => `impacts|${i["Impact ID"]}`), ...workOrders.map((w) => `work-orders|${w["Work Order ID"]}`), ...history.map((h) => `incidents|${h["Incident ID"]}`),
    ...ref.runbooks.map((r) => `runbooks|${r["Runbook ID"]}`), ...changes.map((c) => `changes|${c["Change ID"]}`)]);
  const out = [];
  for (const kind of kinds) {
    const g = generate(kind, P, Date.now(), opts); const chk = checkCitations(g, visible);
    const recId = `AIR-${id.replace("INC-", "")}-${kind.replace(/ /g, "").toUpperCase().slice(0, 6)}-${Date.now().toString(36).toUpperCase()}`;
    // supersede older proposals of the same kind
    const old = (await rows("ai-recommendations", tenant, `values[Incident ID]="${q(id)}" AND values[Kind]="${q(kind)}"`, S)).filter((r) => r.Status === "Proposed");
    await pool(old, 4, (r) => update(r._id, { Status: "Superseded" }, S));
    const v = { "Tenant ID": tenant, "Recommendation ID": recId, "Incident ID": id, Kind: kind, Content: String(g.content).slice(0, 8000), Facts: JSON.stringify(g.facts), Inferences: JSON.stringify(g.inferences),
      Confidence: String(g.confidence), Citations: JSON.stringify(g.citations), Generator: "rules/v1", Status: chk.ok ? "Proposed" : "Rejected", "Requires Approval Action": g.requiresApproval,
      "Citation Check": chk.ok ? "Passed" : `Failed: ${JSON.stringify(chk).slice(0, 400)}`, Feedback: chk.ok ? "" : "auto-rejected: citation check failed", "Replay Batch": inc["Replay Batch"] || "" };
    await create("ai-recommendations", v, S);
    out.push({ ...v, facts: g.facts, inferences: g.inferences, citations: g.citations, subject: g.subject, sequence: g.sequence, citationCheck: chk });
  }
  await timeline(tenant, id, { type: "AI", author: "assistant", actorType: "AI", summary: `Assistant proposed: ${out.map((o) => `${o.Kind} (${o["Citation Check"] === "Passed" ? "citations verified" : "REJECTED — citation check failed"})`).join(", ")}. Nothing is executed without operator approval.` });
  return { recommendations: out };
}

// ─────────────────────────── communications ───────────────────────────
async function draftNotification(tenant, inc, body, ctx, A) {
  if (!has(ctx, "Operator", "Service Owner")) throw Object.assign(new Error("Operators only"), { status: 403 });
  const id = inc["Incident ID"];
  if (body.sequence === "Resolution" && inc["Verification State"] !== "Passed") throw bad("A Resolution notice can only be drafted after customer service recovery is verified (Verification State: " + inc["Verification State"] + ")");
  const r = await assist(tenant, inc, ["Customer Draft"], ctx, A, { sequence: body.sequence }); const d = r.recommendations[0];
  const impacts = await rows("impacts", tenant, `values[Incident ID]="${q(id)}"`, S);
  const hard = impacts.filter((i) => i["Impact Class"] !== "Potential" && i["Account ID"]);
  const accts = [...new Set(hard.map((i) => i["Account ID"]))];
  const contacts = accts.length ? await rows("contacts", tenant, `values[Account ID] IN (${accts.map((a) => `"${q(a)}"`).join(",")})`, S) : [];
  const size = contacts.filter((c) => c["Notify On"] !== "None").length + (hard.some((i) => i.Segment === "Consumer Segment") ? 1 : 0);
  const seq = body.sequence || d.sequence || "Initial";
  const nid = `NTF-${id.replace("INC-", "")}-${seq.slice(0, 3).toUpperCase()}${body.channel ? "-" + body.channel.slice(0, 2).toUpperCase() : ""}`;
  const v = { "Tenant ID": tenant, "Notification ID": nid, "Incident ID": id, Sequence: seq, Audience: JSON.stringify({ accounts: accts, contacts: size - (hard.some((i) => i.Segment === "Consumer Segment") ? 1 : 0), statusPage: hard.some((i) => i.Segment === "Consumer Segment"), excludedPotential: new Set(impacts.filter((i) => i["Impact Class"] === "Potential").map((i) => i["Account ID"])).size }),
    "Audience Size": String(size), Channel: body.channel || "Email", Subject: d.subject || "", Body: body.body || d.Content, Status: "Draft", "Drafted By": `${ctx.username} (AI draft ${d["Recommendation ID"]})`, "AI Recommendation ID": d["Recommendation ID"], "Replay Batch": inc["Replay Batch"] || "" };
  const c = await create("notifications", v, S);
  if (c.existed) return { ok: true, notificationId: nid, existed: true, note: "A notification with this sequence already exists" };
  const incRow = await one("incidents", tenant, "Incident ID", id, S); await update(incRow._id, { "Comms State": "Draft" }, S);
  await timeline(tenant, id, { type: "Comms", author: ctx.username, actorType: "User", summary: `${seq} customer notification ${nid} drafted for ${accts.length} accounts / ${size} recipients (from AI draft, citations ${d["Citation Check"]}).` });
  return { ok: true, notificationId: nid, draft: v };
}
async function notificationOp(tenant, nid, op, body, ctx) {
  const n = await one("notifications", tenant, "Notification ID", nid, S); if (!n) throw Object.assign(new Error("not found"), { status: 404 });
  const upd = {};
  if (op === "submit") { if (!has(ctx, "Operator", "Service Owner")) throw Object.assign(new Error("Operators only"), { status: 403 }); if (!["Draft", "Rejected"].includes(n.Status)) throw bad(`Cannot submit from ${n.Status}`);
    if (body.body) upd.Body = body.body; upd.Status = "Pending Approval"; }
  else if (op === "approve") {
    if (!has(ctx, "Service Owner")) throw Object.assign(new Error("Customer communications must be approved by a Service Owner"), { status: 403 });
    if (n.Status !== "Pending Approval") throw bad(`Cannot approve from ${n.Status}`);
    if (!ctx.spaceAdmin && String(n["Drafted By"]).startsWith(ctx.username)) throw bad("Separation of duties: the drafter cannot approve");
    Object.assign(upd, { Status: "Approved", "Approved By": ctx.username, "Approved At": nowIso() }); // Kinetic workflow "Deliver Approved Notification" sends it
  } else if (op === "reject") { if (!has(ctx, "Service Owner")) throw Object.assign(new Error("Service Owners only"), { status: 403 }); if (n.Status !== "Pending Approval") throw bad(`Cannot reject from ${n.Status}`);
    if (!String(body.reason || "").trim()) throw bad("reason required"); upd.Status = "Rejected"; }
  else throw bad("op must be submit|approve|reject");
  await update(n._id, upd, S);
  const inc = await one("incidents", tenant, "Incident ID", n["Incident ID"], S);
  if (op === "submit") await update(inc._id, { "Comms State": "Awaiting Approval" }, S);
  await timeline(tenant, n["Incident ID"], { type: "Comms", author: ctx.username, actorType: "User", summary: `Notification ${nid} ${op === "submit" ? "submitted for approval" : op === "approve" ? "APPROVED — delivery handed to the Kinetic workflow" : "rejected: " + body.reason} by ${ctx.username}.` });
  await audit(tenant, { actor: ctx.username, action: `notification.${op}`, entityType: "Notification", entityId: nid, before: { Status: n.Status }, after: upd, reason: body.reason });
  return { ok: true, updated: upd };
}

// ─────────────────────────── maps, resources, customers, exec ───────────────────────────
async function impactMap(tenant, inc, A) {
  const ref = await reference(tenant); const graph = buildGraph(ref.relationships, inc["Detected At"]);
  const state = propagate(graph, new Set([inc["Root Resource ID"]]));
  const impacts = await rows("impacts", tenant, `values[Incident ID]="${q(inc["Incident ID"])}"`, A);
  const svcCls = new Map(impacts.map((i) => [i["Service Instance ID"], { cls: i["Impact Class"], rec: i["Recovery State"] }]));
  const siteState = new Map();
  const rank = { down: 3, "at-risk": 2 };
  for (const [id, st] of state) { const r = ref.resById.get(id); const s = r?.["Site ID"]; if (s && (rank[st] || 0) > (rank[siteState.get(s)] || 0)) siteState.set(s, st); }
  const sites = ref.sites.map((s) => ({ id: s["Site ID"], name: s.Name, type: s["Site Type"], lat: Number(s.Latitude), lon: Number(s.Longitude), market: s["Market ID"], state: siteState.get(s["Site ID"]) || "up",
    services: ref.services.filter((x) => x["Primary Site ID"] === s["Site ID"]).map((x) => ({ id: x["Service Instance ID"], ...(svcCls.get(x["Service Instance ID"]) || {}) })) })).filter((s) => !isNaN(s.lat));
  const spans = ref.resources.filter((r) => r["Resource Type"] === "Fiber Span" || r["Resource Type"] === "Microwave Link").map((r) => ({ id: r["Resource ID"], a: r["A Site ID"] || r["Site ID"], z: r["Z Site ID"] || "", type: r["Resource Type"], state: r["Resource ID"] === inc["Root Resource ID"] ? "root" : state.get(r["Resource ID"]) || "up" }));
  const backhaul = [];
  for (const r of ref.resources.filter((x) => x["Resource Type"] === "Cell Site Router")) for (const e of graph.deps.get(r["Resource ID"]) || []) { const to = ref.resById.get(e.to); if (to && to["Site ID"] && to["Site ID"] !== r["Site ID"]) backhaul.push({ a: r["Site ID"], z: to["Site ID"], state: state.get(r["Resource ID"]) || "up", role: e.role }); }
  return { root: inc["Root Resource ID"], asOf: inc["Detected At"], sites, spans, backhaul, gisFreshness: integRow((await rows("integrations", tenant, `values[Source ID]="gis"`, A))[0] || {}) };
}
async function resourceDetail(tenant, rid, A) {
  const ref = await reference(tenant); const r = ref.resById.get(rid); if (!r) throw Object.assign(new Error("resource not found"), { status: 404 });
  const graph = buildGraph(ref.relationships, nowIso());
  const [alarms, incs, conflicts, idmap] = await Promise.all([rows("alarms", tenant, `values[Resource ID]="${q(rid)}"`, A, 200), rows("incidents", tenant, `values[Root Resource ID]="${q(rid)}"`, A), Promise.resolve(ref.conflicts.filter((c) => c["Entity ID"] === rid)), rows("identifiers", tenant, `values[Internal ID]="${q(rid)}"`, A)]);
  const edges = ref.relationships.filter((e) => e["From ID"] === rid || e["To ID"] === rid);
  const down = [...(await import("./engine/core.mjs")).downstream(graph, rid)];
  const impactIfDown = propagate(graph, new Set([rid]));
  return { resource: r, site: ref.siteById.get(r["Site ID"]) || null, dependsOn: edges.filter((e) => e["From ID"] === rid), dependents: edges.filter((e) => e["To ID"] === rid), history: edges.filter((e) => e["Valid To"]),
    alarms: alarms.map(alarmRow), incidents: incs.map(incCard), conflicts, identifiers: idmap, downstreamCount: down.length,
    whatIf: { servicesDown: ref.services.filter((s) => impactIfDown.get(s["Service Instance ID"]) === "down").map((s) => s["Service Instance ID"]), servicesAtRisk: ref.services.filter((s) => impactIfDown.get(s["Service Instance ID"]) === "at-risk").map((s) => s["Service Instance ID"]) } };
}
async function openImpactsByAccount(tenant, A) {
  const incs = (await rows("incidents", tenant, "", A)).filter((i) => OPEN_INC.includes(i.State)); const m = new Map();
  for (const i of incs) for (const imp of await rows("impacts", tenant, `values[Incident ID]="${q(i["Incident ID"])}"`, A)) if (imp["Account ID"]) {
    const cur = m.get(imp["Account ID"]); const rk = { Confirmed: 3, Inferred: 2, Potential: 1 };
    if (!cur || rk[imp["Impact Class"]] > rk[cur.cls]) m.set(imp["Account ID"], { incident: i["Incident ID"], cls: imp["Impact Class"], recovery: imp["Recovery State"] }); }
  return m;
}
async function customerView(tenant, acctId, ctx, A) {
  const ref = await reference(tenant); const cust = ref.custById.get(acctId); if (!cust) throw Object.assign(new Error("account not found"), { status: 404 });
  const subs = ref.subscriptions.filter((s) => s["Account ID"] === acctId);
  const [impacts, contacts] = await Promise.all([rows("impacts", tenant, `values[Account ID]="${q(acctId)}"`, A), has(ctx, "Operator", "Service Owner", "Support Agent", "Tenant Admin") ? rows("contacts", tenant, `values[Account ID]="${q(acctId)}"`, A) : Promise.resolve([])]);
  const incIds = [...new Set(impacts.map((i) => i["Incident ID"]))];
  const incs = (await Promise.all(incIds.map((i) => one("incidents", tenant, "Incident ID", i, A)))).filter(Boolean);
  const notes = (await Promise.all(incIds.map((i) => rows("notifications", tenant, `values[Incident ID]="${q(i)}"`, A)))).flat();
  const support = ctx.roles.includes("Support Agent") && !has(ctx, "Operator", "Service Owner");
  // Support agents see ONLY approved, customer-facing status — never internal root cause, resource IDs or unapproved drafts.
  const approved = notes.filter((n) => ["Approved", "Sent"].includes(n.Status) && JSON.parse(n.Audience || "{}").accounts?.includes(acctId));
  return { account: cust, contacts: contacts.map((c) => (support ? { ...c, Phone: mask(c.Phone), Email: mask(c.Email) } : c)),
    services: subs.map((s) => ({ ...s, service: ref.svcById.get(s["Service Instance ID"]) || null, sla: ref.slas.find((x) => x["SLA ID"] === s["SLA ID"]) || null })),
    incidents: incs.map((i) => { const mine = impacts.filter((x) => x["Incident ID"] === i["Incident ID"]); const n = approved.filter((x) => x["Incident ID"] === i["Incident ID"]).sort((a, b) => (b["Sent At"] || "").localeCompare(a["Sent At"] || ""));
      const base = { id: i["Incident ID"], state: OPEN_INC.includes(i.State) && i.State !== "Resolved" ? "Ongoing" : "Resolved", customerStatus: n[0]?.Body || "No approved customer update yet — do not speculate; tell the customer an update is coming.", lastUpdateAt: n[0]?.["Sent At"] || null,
        services: mine.map((x) => ({ id: x["Service Instance ID"], cls: x["Impact Class"], recovery: x["Recovery State"] })) };
      return support ? base : { ...base, internal: { title: i.Title, priority: i.Priority, root: i["Root Resource ID"], probableCause: i["Probable Cause"], observedCause: i["Observed Root Cause"], sla: mine.reduce((s, x) => s + Number(x["SLA Exposure USD"] || 0), 0), breachAt: mine.map((x) => x["SLA Breach At"]).filter(Boolean).sort()[0] } }; }),
    view: support ? "support-agent (customer-safe)" : "internal" };
}
const mask = (s) => (s ? String(s).replace(/(.{2}).+(@.*|.{2})$/, "$1•••$2") : s);
async function execView(tenant, A) {
  return cached(`inc|${tenant}|exec`, 15000, async () => {
    const ref = await reference(tenant);
    const incs = await rows("incidents", tenant, "", A);
    const dur = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 60000 : null);
    const closed = incs.filter((i) => i["Service Recovered At"]);
    const avg = (xs) => { const v = xs.filter((x) => x != null && isFinite(x)); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null; };
    const byMarket = {}; for (const i of incs) { const m = ref.areas.find((a) => a["Area ID"] === i["Market ID"])?.Name || i["Market ID"] || "Unknown"; (byMarket[m] ||= { incidents: 0, p1: 0, customers: 0, minutes: 0 }); byMarket[m].incidents++; if (i.Priority === "P1") byMarket[m].p1++; byMarket[m].customers += Number(i["Customers Affected"] || 0); byMarket[m].minutes += dur(i["Detected At"], i["Service Recovered At"] || nowIso()) || 0; }
    const byCause = {}; for (const i of incs) { const r = ref.resById.get(i["Root Resource ID"])?.["Resource Type"] || "Unknown"; byCause[r] = (byCause[r] || 0) + 1; }
    const open = incs.filter((i) => OPEN_INC.includes(i.State));
    const custMinutes = incs.reduce((s, i) => s + Number(i["Customers Affected"] || 0) * (dur(i["Detected At"], i["Service Recovered At"] || nowIso()) || 0), 0);
    const recurring = Object.entries(incs.reduce((m, i) => ((m[i["Root Resource ID"]] = (m[i["Root Resource ID"]] || 0) + 1), m), {})).filter(([, n]) => n > 1).map(([r, n]) => ({ resource: r, incidents: n }));
    return { kpis: { openIncidents: open.length, openP1: open.filter((i) => i.Priority === "P1").length, mttaMin: avg(incs.map((i) => dur(i["Detected At"], i["Acknowledged At"]))), mttrMin: avg(closed.map((i) => dur(i["Detected At"], i["Service Recovered At"]))),
      customerImpactHours: Math.round(custMinutes / 60), slaExposureOpenUsd: Math.round(open.reduce((s, i) => s + Number(i["SLA Exposure USD"] || 0), 0)), incidents90d: incs.length, verifiedClosures: incs.filter((i) => i.State === "Closed" && i["Verification State"] === "Passed").length },
      byMarket, byCause, byPriority: incs.reduce((m, i) => ((m[i.Priority] = (m[i.Priority] || 0) + 1), m), {}), recurring,
      timeline: incs.sort((a, b) => a["Detected At"].localeCompare(b["Detected At"])).map((i) => ({ id: i["Incident ID"], at: i["Detected At"], priority: i.Priority, minutes: Math.round(dur(i["Detected At"], i["Service Recovered At"] || nowIso()) || 0), customers: Number(i["Customers Affected"] || 0), title: i.Title, state: i.State })) };
  });
}
