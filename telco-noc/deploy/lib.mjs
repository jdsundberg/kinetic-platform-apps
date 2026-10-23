/**
 * lib.mjs — zero-dependency Kinetic REST helpers shared by deploy, seed, replay and test scripts.
 * Retries transient failures (socket errors, 5xx, 409 version conflicts) with backoff.
 * Credentials come from env (KINETIC_URL / KINETIC_USER / KINETIC_PASS); defaults match this repo's dev space.
 */
import https from "node:https";

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 16 }); // dev space uses a private CA
export const ok = (r) => r.status >= 200 && r.status < 300;

export const SERVER = (process.env.KINETIC_URL || "https://first.kinetics.com").replace(/\/+$/, "");
export const USER = process.env.KINETIC_USER || "john";
export const PASS = process.env.KINETIC_PASS || "john1";
export const KAPP = "telco-noc";
export const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
export const AUTH = basic(USER, PASS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(method, fullPath, body, auth, extraHeaders = {}) {
  return new Promise((resolve) => {
    const url = new URL(SERVER + fullPath);
    const data = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const headers = { Authorization: auth, "Content-Type": "application/json", ...extraHeaders };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    const r = https.request(url, { method, headers, timeout: 60000, agent }, (res) => {
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => { const s = Buffer.concat(c).toString(); let d; try { d = s ? JSON.parse(s) : {}; } catch { d = { raw: s }; } resolve({ status: res.statusCode, data: d }); });
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", (e) => resolve({ status: 0, data: { error: e.message } }));
    if (data) r.write(data);
    r.end();
  });
}

export async function http(method, fullPath, body, { auth = AUTH, retries = 4, headers } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    last = await once(method, fullPath, body, auth, headers);
    const transient = last.status === 0 || last.status >= 500 || last.status === 409 || last.status === 429;
    if (!transient) return last;
    await sleep(400 * 2 ** i);
  }
  return last;
}
export const core = (m, p, b, o) => http(m, "/app/api/v1" + p, b, o);
export const task = (m, p, b, o) => http(m, "/app/components/task/app/api/v2" + p, b, o);

/** Submission search, tenant-scoped KQL, keyset-paged at 25/page (repo golden rule). */
export async function search(form, kql, { auth = AUTH, max = 4000 } = {}) {
  const out = [], seen = new Set(); let last = null;
  for (let i = 0; i < Math.ceil(max / 25) + 2; i++) {
    let q = kql || ""; if (last) q = (q ? `(${q}) AND ` : "") + `createdAt <= "${last}"`;
    const r = await core("GET", `/kapps/${KAPP}/forms/${form}/submissions?include=values,details&limit=25${q ? "&q=" + encodeURIComponent(q) : ""}`, null, { auth });
    if (r.status >= 300) throw new Error(`search ${form} ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    const subs = r.data.submissions || []; let added = 0;
    for (const s of subs) if (!seen.has(s.id)) { seen.add(s.id); out.push(s); added++; }
    if (subs.length) last = subs[subs.length - 1].createdAt;
    if ((added === 0 && i > 0) || subs.length < 25 || out.length >= max) break;
  }
  return out;
}

export async function create(form, values, { auth = AUTH } = {}) {
  const r = await core("POST", `/kapps/${KAPP}/forms/${form}/submissions`, { values, coreState: "Submitted" }, { auth });
  if (r.status >= 300) throw new Error(`create ${form} ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data.submission;
}
export async function update(id, values, { auth = AUTH } = {}) {
  const r = await core("PUT", `/submissions/${id}`, { values }, { auth });
  if (r.status >= 300) throw new Error(`update ${id} ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data.submission;
}

/** Run fn over items with bounded concurrency. */
export async function pool(items, n, fn) {
  const results = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; results[k] = await fn(items[k], k); }
  }));
  return results;
}
export const esc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
