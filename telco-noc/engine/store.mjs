/**
 * engine/store.mjs — Kinetic I/O for the NOC engine. Every read is tenant-scoped KQL (index-backed);
 * every write carries the tenant and a deterministic business ID (unique index ⇒ retry-safe).
 *
 * Two identities:
 *   user auth    — reads for screens and operator actions (Kinetic KSL policies apply to the person)
 *   service auth — engine writes (correlation, impact, verification); attributed as Actor Type "Engine" in audit
 */
import https from "node:https";
import crypto from "node:crypto";

export const KAPP = "telco-noc";
const SERVER = (process.env.NOC_KINETIC_URL || process.env.KINETIC_URL || "https://first.kinetics.com").replace(/\/+$/, "");
export const SERVICE_AUTH = "Basic " + Buffer.from(`${process.env.NOC_SERVICE_USER || "john"}:${process.env.NOC_SERVICE_PASS || "john1"}`).toString("base64");
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 24 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
export const hash = (s, n = 8) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, n).toUpperCase();
export const q = (s) => String(s ?? "").replace(/["\\]/g, "");

function once(method, p, body, auth) {
  return new Promise((resolve) => {
    const url = new URL(SERVER + p); const data = body == null ? null : JSON.stringify(body);
    const headers = { Authorization: auth, "Content-Type": "application/json" }; if (data) headers["Content-Length"] = Buffer.byteLength(data);
    const r = https.request(url, { method, headers, agent, timeout: 45000 }, (res) => {
      const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => { const s = Buffer.concat(c).toString(); let d; try { d = s ? JSON.parse(s) : {}; } catch { d = { raw: s }; } resolve({ status: res.statusCode, data: d }); });
    });
    r.on("timeout", () => r.destroy(new Error("timeout"))); r.on("error", (e) => resolve({ status: 0, data: { error: e.message } }));
    if (data) r.write(data); r.end();
  });
}
export async function kin(method, p, body, auth, retries = 3) {
  let last;
  for (let i = 0; i <= retries; i++) { last = await once(method, p, body, auth); if (!(last.status === 0 || last.status >= 500 || last.status === 409 || last.status === 429)) return last; await sleep(300 * 2 ** i); }
  return last;
}
export const core = (m, p, b, auth) => kin(m, "/app/api/v1" + p, b, auth);

/** Keyset-paged, 25 per page (repo golden rule), tenant-scoped. */
export async function list(form, tenant, kql, auth, max = 3000) {
  const base = `values[Tenant ID]="${q(tenant)}"` + (kql ? ` AND (${kql})` : "");
  const out = [], seen = new Set(); let last = null;
  for (let i = 0; i < Math.ceil(max / 25) + 2; i++) {
    const qq = last ? `(${base}) AND createdAt <= "${last}"` : base;
    const r = await core("GET", `/kapps/${KAPP}/forms/${form}/submissions?include=values,details&limit=25&q=${encodeURIComponent(qq)}`, null, auth);
    if (r.status !== 200) throw Object.assign(new Error(`list ${form}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`), { status: r.status });
    const subs = r.data.submissions || []; let added = 0;
    for (const s of subs) if (!seen.has(s.id)) { seen.add(s.id); out.push(s); added++; }
    if (subs.length) last = subs[subs.length - 1].createdAt;
    if ((added === 0 && i > 0) || subs.length < 25 || out.length >= max) break;
  }
  return out;
}
/** One page (≤25) for UI tables, with Kinetic pageToken passthrough. */
export async function page(form, tenant, kql, auth, pageToken, limit = 25) {
  const qq = `values[Tenant ID]="${q(tenant)}"` + (kql ? ` AND (${kql})` : "");
  const r = await core("GET", `/kapps/${KAPP}/forms/${form}/submissions?include=values,details&limit=${Math.min(25, limit)}&q=${encodeURIComponent(qq)}${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`, null, auth);
  if (r.status !== 200) throw Object.assign(new Error(`page ${form}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`), { status: r.status });
  return { rows: (r.data.submissions || []).map(flat), nextPageToken: r.data.nextPageToken || null };
}
export const flat = (s) => ({ _id: s.id, _createdAt: s.createdAt, _updatedAt: s.updatedAt, _createdBy: s.createdBy, _updatedBy: s.updatedBy, ...(s.values || {}) });
export async function rows(form, tenant, kql, auth, max) { return (await list(form, tenant, kql, auth, max)).map(flat); }
export async function one(form, tenant, idField, id, auth) { const r = await rows(form, tenant, `values[${idField}]="${q(id)}"`, auth, 1); return r[0] || null; }

export async function create(form, values, auth) {
  const r = await core("POST", `/kapps/${KAPP}/forms/${form}/submissions`, { values, coreState: "Submitted" }, auth);
  if (r.status === 200) return { ok: true, row: flat(r.data.submission) };
  if (r.status === 400 && r.data?.errorKey === "uniqueness_violation") return { ok: true, existed: true };
  return { ok: false, status: r.status, error: r.data?.error || JSON.stringify(r.data).slice(0, 300), fields: r.data?.fieldConstraintViolations };
}
export async function update(subId, values, auth) {
  const r = await core("PUT", `/submissions/${subId}`, { values }, auth);
  if (r.status === 200) return { ok: true, row: flat(r.data.submission) };
  return { ok: false, status: r.status, error: r.data?.error || JSON.stringify(r.data).slice(0, 300) };
}
export async function pool(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } }));
  return res;
}

// ── reference-data cache (topology changes on inventory sync cadence, not per request) ──
const cache = new Map(), inflight = new Map();
export async function cached(key, ttlMs, fn) {
  const c = cache.get(key); if (c && Date.now() - c.at < ttlMs) return c.v;
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().then((v) => { cache.set(key, { at: Date.now(), v }); inflight.delete(key); return v; }, (e) => { inflight.delete(key); throw e; });
  inflight.set(key, p); return p;
}
export const bust = (prefix) => { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); };

/** Reference data for a tenant. Read with the SERVICE identity but only ever returned tenant-filtered. */
export function reference(tenant) {
  return cached(`ref|${tenant}`, 120000, async () => {
    const A = SERVICE_AUTH;
    const [resources, relationships, services, subscriptions, customers, slas, sites, areas, teams, oncall, conflicts, runbooks, offerings] = await Promise.all([
      rows("resources", tenant, "", A), rows("relationships", tenant, "", A), rows("service-instances", tenant, "", A), rows("subscriptions", tenant, "", A),
      rows("customers", tenant, "", A), rows("slas", tenant, "", A), rows("sites", tenant, "", A), rows("geo-areas", tenant, "", A), rows("teams", tenant, "", A),
      rows("oncall", tenant, "", A), rows("conflicts", tenant, "", A), rows("runbooks", tenant, "", A), rows("offerings", tenant, "", A)]);
    return { resources, relationships, services, subscriptions, customers, slas, sites, areas, teams, oncall, conflicts, runbooks, offerings,
      resById: new Map(resources.map((r) => [r["Resource ID"], r])), siteById: new Map(sites.map((s) => [s["Site ID"], s])), svcById: new Map(services.map((s) => [s["Service Instance ID"], s])),
      custById: new Map(customers.map((c) => [c["Account ID"], c])) };
  });
}

export async function audit(tenant, { actor, actorType = "User", action, entityType, entityId, before, after, reason, requestId, batch }) {
  return create("audit", { "Tenant ID": tenant, "Audit ID": `AUD-${Date.now().toString(36).toUpperCase()}-${hash(action + entityId + Math.random(), 6)}`, "At": nowIso(), "Actor": actor, "Actor Type": actorType,
    "Action": action, "Entity Type": entityType, "Entity ID": entityId, "Before": before ? JSON.stringify(before) : "", "After": after ? JSON.stringify(after) : "", "Reason": reason || "", "Request ID": requestId || "", "Replay Batch": batch || "" }, SERVICE_AUTH);
}
export async function timeline(tenant, incidentId, { type, summary, details, author = "engine", actorType = "Engine", visibility = "Internal", id, batch }) {
  return create("incident-updates", { "Tenant ID": tenant, "Update ID": id || `UPD-${incidentId}-${Date.now().toString(36).toUpperCase()}${hash(Math.random(), 4)}`, "Incident ID": incidentId, "Update Type": type,
    "At": nowIso(), "Author": author, "Actor Type": actorType, "Summary": summary, "Details": details ? JSON.stringify(details) : "", "Visibility": visibility, "Replay Batch": batch || "" }, SERVICE_AUTH);
}
