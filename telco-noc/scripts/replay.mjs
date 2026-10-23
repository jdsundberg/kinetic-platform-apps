/**
 * replay.mjs — plays the fiber-cut scenario into the platform exactly as monitoring adapters would:
 *   events → Kinetic WebAPI ingest-event (Ruby normalization, idempotency, dedup)
 *   metrics → /api/noc/ingest/metrics (unit-normalizing adapter)
 * Ordering: events sharing a partition key (resource+condition) are sent serially in event-time order;
 * partitions run in parallel (like a Kafka consumer group keyed by fingerprint). "late" events are held
 * back and sent last; FUTURE events get a clock-skewed timestamp; malformed events lose required fields.
 *
 * Usage: node scripts/replay.mjs --phase=cut|restore|reboot [--batch=demo-XXXX] [--concurrency=8] [--launcher=http://host:3011] [--no-correlate]
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { http as khttp, basic } from "../deploy/lib.mjs";
import { PW } from "../deploy/users.mjs";

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `=${d}`).split("=").slice(1).join("=");
const PHASE = arg("phase", "cut"), CONC = Number(arg("concurrency", 8)), LAUNCHER = arg("launcher", process.env.NOC_LAUNCHER || "http://127.0.0.1:3011");
const TENANT = arg("tenant", "borealis");
// least privilege: the monitoring adapter ingests as int.<tenant>; correlation is triggered by an operator
const INGEST_AUTH = basic(arg("ingest-as", `int.${TENANT}`), PW), OPERATOR_AUTH = basic(arg("operator-as", `noc.${TENANT}`), PW);
const DIR = path.dirname(new URL(import.meta.url).pathname);
const scen = JSON.parse(fs.readFileSync(path.join(DIR, "../seed/scenario-fiber-cut.json"), "utf-8"));
const batchFile = path.join(DIR, "../.last-batch");
const BATCH = arg("batch", PHASE === "cut" ? `demo-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}` : (fs.existsSync(batchFile) ? fs.readFileSync(batchFile, "utf-8").trim() : "demo"));
if (PHASE === "cut") fs.writeFileSync(batchFile, BATCH);
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const events = scen.events.filter((e) => e.phase === PHASE);
const span = Math.max(...events.map((e) => e.offset), 1);
const base = Date.now() - (span + 30) * 1000;
// Event time is stamped at SEND time minus a small collector delay (the replay is not paced in real time, so
// offset-based times would make every event look minutes late). Deliberately-late events are stamped 5 min old;
// clock-skewed ones 10 min in the future. Order within a partition stays monotonic.
function envelope(e) {
  const et = e.eventTimeOverride ? Date.now() + 600000 : e.sendLast ? Date.now() - 300000 : Date.now() - 1500;
  // each replay batch is a NEW outage: suffix source event ids with the batch (retransmits inside a batch stay identical).
  // --exact-ids replays the literal ids (a second replay is then 100% duplicates — the idempotency proof).
  const sid = process.argv.includes("--exact-ids") ? e.sourceEventId : `${e.sourceEventId}@${BATCH}`;
  const b = { schemaVersion: "1.0", tenantId: TENANT, source: e.source, sourceEventId: sid, eventTime: iso(et),
    resourceRef: e.resourceRef, relatedResourceRef: e.relatedResourceRef || undefined, condition: e.condition, vendorSeverity: e.vendorSeverity, state: e.state, text: e.text, replayBatch: BATCH };
  if (e.malformed === "missing eventTime") delete b.eventTime;
  if (e.malformed === "missing resourceRef") delete b.resourceRef;
  return b;
}
const parts = new Map(); const lateOnes = [];
for (const e of [...events].sort((a, b) => a.offset - b.offset)) { if (e.sendLast) { lateOnes.push(e); continue; } const k = e.partition || e.sourceEventId; (parts.get(k) || parts.set(k, []).get(k)).push(e); }
const stats = { sent: 0, byStatus: {}, byKind: {}, errors: [] , ms: 0};
async function send(e) {
  const t = Date.now(); const r = await khttp("POST", `/app/kapps/telco-noc/webApis/ingest-event?timeout=25`, envelope(e), { auth: INGEST_AUTH });
  stats.ms += Date.now() - t; stats.sent++; stats.byStatus[r.status] = (stats.byStatus[r.status] || 0) + 1; const k = r.data?.kind || r.data?.status || "?"; stats.byKind[k] = (stats.byKind[k] || 0) + 1;
  if (r.status >= 500 || r.status === 0) stats.errors.push(`${e.sourceEventId}: ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  if (stats.sent % 50 === 0) process.stdout.write(`  … ${stats.sent}/${events.length}\n`);
}
const t0 = Date.now();
console.log(`▶ replay phase=${PHASE} batch=${BATCH} events=${events.length} partitions=${parts.size} concurrency=${CONC}`);
const queues = [...parts.values()]; let qi = 0;
await Promise.all(Array.from({ length: CONC }, async () => { while (qi < queues.length) { const q = queues[qi++]; for (const e of q) await send(e); } }));
for (const e of lateOnes) await send(e);
console.log(`✓ events: ${stats.sent} in ${Math.round((Date.now() - t0) / 1000)}s (avg ${Math.round(stats.ms / Math.max(stats.sent, 1))} ms/event) status=${JSON.stringify(stats.byStatus)} kinds=${JSON.stringify(stats.byKind)}`);
if (stats.errors.length) console.log("  errors:", stats.errors.slice(0, 5));

function launcher(method, p, body, auth = OPERATOR_AUTH) {
  return new Promise((resolve) => {
    const u = new URL(LAUNCHER + p); const data = body ? JSON.stringify(body) : null;
    const r = http.request(u, { method, headers: { Authorization: auth, "Content-Type": "application/json", "X-NOC-Tenant": TENANT, ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) }, timeout: 600000 }, (res) => {
      const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => { const s = Buffer.concat(c).toString(); try { resolve({ status: res.statusCode, data: JSON.parse(s) }); } catch { resolve({ status: res.statusCode, data: s }); } });
    });
    r.on("error", (e) => resolve({ status: 0, data: { error: e.message } })); if (data) r.write(data); r.end();
  });
}
const ms = scen.metrics[PHASE] || [];
if (ms.length) {
  const obs = ms.map((m) => ({ ...m, observedAt: iso(Date.now() - 5000) }));
  const r = await launcher("POST", "/api/noc/ingest/metrics", { tenantId: TENANT, replayBatch: BATCH, observations: obs }, INGEST_AUTH);
  console.log(`✓ metrics: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
}
if (!process.argv.includes("--no-correlate")) {
  const r = await launcher("POST", "/api/noc/engine/correlate", { batch: BATCH });
  console.log(`✓ correlate: ${r.status} ${JSON.stringify(r.data).slice(0, 700)}`);
}
console.log(`batch=${BATCH}`);
