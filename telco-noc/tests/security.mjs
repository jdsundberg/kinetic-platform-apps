// Tenant isolation + role enforcement, tested with REAL non-admin users on BOTH paths:
//   (a) direct Kinetic REST (proves the platform policies), (b) the NOC API (proves server checks).
import { core, basic } from "../deploy/lib.mjs";
import { PW } from "../deploy/users.mjs";
import { call } from "./api-smoke.mjs";
const A = (u) => basic(u, PW);
let fail = 0; const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${extra}`); if (!cond) fail++; };
const vals = async (u, form, q) => { const r = await core("GET", `/kapps/telco-noc/forms/${form}/submissions?include=values&limit=25${q ? "&q=" + encodeURIComponent(q) : ""}`, null, { auth: A(u) }); return { status: r.status, rows: (r.data.submissions || []), err: r.data.error }; };
// (a) platform — direct REST with the prairie user
let r = await vals("noc.prairie", "incidents", `values[Tenant ID]="borealis"`);
const leaked = r.rows.filter((s) => s.values && s.values["Tenant ID"] === "borealis" && s.values.Title);
ok("platform: prairie cannot read borealis incident values", leaked.length === 0, `(status ${r.status}, ${r.rows.length} rows, ${leaked.length} with values)`);
r = await vals("noc.prairie", "incidents", `values[Tenant ID]="prairie"`);
ok("platform: prairie reads its own incidents", r.status === 200 && r.rows.some((s) => s.values?.Title), `(${r.status} ${r.rows.length})`);
r = await vals("support.borealis", "contacts", `values[Tenant ID]="borealis"`);
ok("platform: support agent can read contacts (PII reader)", r.rows.some((s) => s.values?.Email), `(${r.status})`);
r = await vals("tech.borealis", "contacts", `values[Tenant ID]="borealis"`);
ok("platform: field tech cannot read customer contact PII", !r.rows.some((s) => s.values?.Email), `(${r.status}, ${r.rows.length} rows)`);
const inc = (await vals("noc.borealis", "incidents", `values[Tenant ID]="borealis" AND values[Incident ID]="INC-20260612-0003"`)).rows[0];
let u = await core("PUT", `/submissions/${inc?.id}`, { values: { Title: "tampered by support" } }, { auth: A("support.borealis") });
ok("platform: support agent cannot modify incidents", u.status >= 400, `(${u.status})`);
u = await core("PUT", `/submissions/${inc?.id}`, { values: { Title: "tampered by prairie" } }, { auth: A("noc.prairie") });
ok("platform: other-tenant operator cannot modify incidents", u.status >= 400, `(${u.status})`);
const aud = (await vals("noc.borealis", "audit", `values[Tenant ID]="borealis"`)).rows[0];
if (aud) { u = await core("PUT", `/submissions/${aud.id}`, { values: { Reason: "rewrite history" } }, { auth: A("noc.borealis") }); ok("platform: audit is append-only even for operators", u.status >= 400, `(${u.status})`); }
// (b) NOC API
const api = (u, m, p, b) => call(m, p, b, A(u));
let x = await api("noc.prairie", "GET", "/api/noc/incidents/INC-20260612-0003");
ok("api: prairie gets 404 for a borealis incident", x.status === 404, `(${x.status})`);
x = await api("noc.prairie", "GET", "/api/noc/command-center");
ok("api: prairie command center shows only prairie", x.status === 200 && x.data.incidents.every((i) => i.id.startsWith("INC-P-")), `(${x.data.incidents?.map((i) => i.id)})`);
x = await api("noc.prairie", "GET", "/api/noc/me", null, {});
const spoof = await call("GET", "/api/noc/command-center", null, A("noc.prairie"), { "X-NOC-Tenant": "borealis" });
ok("api: non-admin cannot switch tenant with X-NOC-Tenant", spoof.status === 200 && spoof.data.incidents.every((i) => i.id.startsWith("INC-P-")));
x = await api("support.borealis", "POST", "/api/noc/incidents/INC-20260612-0003/action", { action: "note", text: "hi" });
ok("api: support agent cannot act on incidents", x.status === 403, `(${x.status})`);
x = await api("tech.borealis", "POST", "/api/noc/engine/correlate", {});
ok("api: field tech cannot run the correlator", x.status === 403, `(${x.status})`);
x = await api("support.borealis", "GET", "/api/noc/customers/ACCT-1007");
ok("api: support view is customer-safe (no internal root cause, masked PII)", x.status === 200 && x.data.view.startsWith("support") && x.data.incidents.every((i) => !i.internal) && x.data.contacts.every((c) => !c.Email || c.Email.includes("•")), `(${x.status} ${x.data.view})`);
x = await api("exec.borealis", "GET", "/api/noc/exec");
ok("api: executive dashboard for executive", x.status === 200 && x.data.kpis.incidents90d > 0);
// (c) ingest WebAPI: platform policy + tree-level tenant binding
const { http: kh } = await import("../deploy/lib.mjs");
const ev = (t, id) => ({ schemaVersion: "1.0", tenantId: t, source: "optical-ems", sourceEventId: id, eventTime: new Date().toISOString().replace(/\.\d+Z/, "Z"), resourceRef: "SEC-TEST:1", condition: "LOS", vendorSeverity: "WR", replayBatch: "sec-test" });
let w = await kh("POST", "/app/kapps/telco-noc/webApis/ingest-event?timeout=25", ev("borealis", "SEC-" + Date.now()), { auth: A("support.borealis") });
ok("ingest: non-integration user blocked by platform policy", w.status === 403 || w.status === 401, `(${w.status})`);
w = await kh("POST", "/app/kapps/telco-noc/webApis/ingest-event?timeout=25", ev("borealis", "SEC-" + Date.now()), { auth: A("int.prairie") });
ok("ingest: prairie integration cannot inject into borealis", w.status === 403 && /may not ingest/.test(JSON.stringify(w.data)), `(${w.status} ${JSON.stringify(w.data).slice(0, 90)})`);
w = await kh("POST", "/app/kapps/telco-noc/webApis/ingest-event?timeout=25", ev("prairie", "SEC-" + Date.now()), { auth: A("int.prairie") });
ok("ingest: prairie integration can ingest for prairie", w.status === 202, `(${w.status} ${w.data?.kind})`);
// clean up the prairie test alarm (admin)
const { search, core: kc } = await import("../deploy/lib.mjs");
for (const f of ["raw-alarms", "alarms"]) for (const s2 of await search(f, `values[Tenant ID]="prairie" AND values[Replay Batch]="sec-test"`)) await kc("DELETE", `/submissions/${s2.id}`);
console.log(fail ? `${fail} FAILED` : "ALL PASS");
