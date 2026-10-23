// Live smoke test of the ingest WebAPI: new, repeat, retransmit (idempotent), invalid, unscoped, clear.
import { http, search, core } from "../deploy/lib.mjs";
const T = "zz-smoke", batch = "smoke-" + Date.now();
const post = (b) => http("POST", `/app/kapps/telco-noc/webApis/ingest-event?timeout=25`, b);
const now = () => new Date().toISOString().replace(/\.\d+Z/, "Z");
const base = { schemaVersion: "1.0", tenantId: T, source: "optical-ems", eventTime: now(), resourceRef: "ROADM-STP-02:OTS-1", condition: "LOS", vendorSeverity: "CR", replayBatch: batch };
const cases = [
  ["new", { ...base, sourceEventId: "S-1" }], ["repeat", { ...base, sourceEventId: "S-2" }], ["retransmit", { ...base, sourceEventId: "S-2" }],
  ["invalid", { ...base, sourceEventId: "S-3", eventTime: "yesterday" }], ["unscoped", { ...base, tenantId: "" , sourceEventId: "S-4"}],
  ["clear", { ...base, sourceEventId: "S-5", state: "clear", vendorSeverity: "CL", eventTime: new Date(Date.now() + 1000).toISOString() }],
];
for (const [name, body] of cases) { const t = Date.now(); const r = await post(body); console.log(name.padEnd(10), r.status, `${Date.now() - t}ms`, JSON.stringify(r.data).slice(0, 260)); }
const raws = await search("raw-alarms", `values[Tenant ID]="${T}"`), alarms = await search("alarms", `values[Tenant ID]="${T}"`);
console.log("raw records:", raws.map((s) => `${s.values["Source Event ID"]}:${s.values["Processing State"]}`).join(" "));
console.log("alarms:", alarms.map((s) => `${s.values["Alarm ID"]} ${s.values.State} count=${s.values["Occurrence Count"]} res=${s.values["Resource ID"]}`).join(" | "));
if (!process.argv.includes("--keep")) { for (const s of [...raws, ...alarms]) await core("DELETE", `/submissions/${s.id}`); console.log("cleaned up", raws.length + alarms.length); }
