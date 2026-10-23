/**
 * Band Scheduler — reconcile live submissions with seed-data.json.
 * Updates (PUT) every record whose values drifted from the seed file and
 * creates (POST) any that are missing. Idempotent — safe to re-run.
 * Usage: node reconcile.mjs [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const __dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = process.env.KINETIC_URL || "https://first.kinetics.com";
const USER = process.env.KINETIC_USER || "john";
const PASS = process.env.KINETIC_PASS || "john1";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const KAPP = "band-scheduler";
const DRY = process.argv.includes("--dry");
const ID_FIELD = { venues: "Venue ID", bands: "Band ID", gigs: "Gig ID", feedback: "Feedback ID" };

async function req(method, apiPath, body) {
  const r = await fetch(`${SERVER}/app/api/v1${apiPath}`, {
    method, headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let d = {}; try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t.slice(0, 200) }; }
  return { status: r.status, data: d };
}

async function listAll(form) {
  const out = []; let token = null;
  do {
    const r = await req("GET", `/kapps/${KAPP}/forms/${form}/submissions?include=values&limit=1000`
      + (token ? `&pageToken=${encodeURIComponent(token)}` : ""));
    if (r.status >= 300) throw new Error(`${form} list ${r.status}`);
    out.push(...(r.data.submissions || []));
    token = r.data.nextPageToken || null;
  } while (token);
  return out;
}

// run promises with a small concurrency cap — higher rates trip licensing/rate limits
async function pool(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return results;
}

const seed = JSON.parse(fs.readFileSync(path.join(__dir, "seed-data.json"), "utf8"));

for (const form of Object.keys(seed)) {
  const idField = ID_FIELD[form];
  const live = await listAll(form);
  const byId = new Map(live.map(s => [s.values[idField], s]));

  const toUpdate = [], toCreate = [];
  for (const rec of seed[form]) {
    const cur = byId.get(rec[idField]);
    if (!cur) { toCreate.push(rec); continue; }
    if (!Object.keys(rec).every(k => String(cur.values[k] ?? "") === String(rec[k] ?? ""))) {
      toUpdate.push({ id: cur.id, values: rec });
    }
  }
  console.log(`${form}: live=${live.length} seed=${seed[form].length} update=${toUpdate.length} create=${toCreate.length}${DRY ? " (dry run)" : ""}`);
  if (DRY) continue;

  let uOk = 0, uErr = "", cOk = 0, cErr = "";
  await pool(toUpdate, 5, async (u) => {
    const r = await req("PUT", `/submissions/${u.id}`, { values: u.values });
    if (r.status < 300) uOk++; else if (!uErr) uErr = `${r.status} ${JSON.stringify(r.data).slice(0, 150)}`;
  });
  await pool(toCreate, 5, async (values) => {
    const r = await req("POST", `/kapps/${KAPP}/forms/${form}/submissions`, { values, coreState: "Submitted" });
    if (r.status < 300) cOk++; else if (!cErr) cErr = `${r.status} ${JSON.stringify(r.data).slice(0, 150)}`;
  });
  if (toUpdate.length) console.log(`  updated ${uOk}/${toUpdate.length}${uErr ? " — " + uErr : ""}`);
  if (toCreate.length) console.log(`  created ${cOk}/${toCreate.length}${cErr ? " — " + cErr : ""}`);
}
