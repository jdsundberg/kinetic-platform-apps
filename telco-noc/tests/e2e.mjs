/**
 * e2e.mjs — the vertical slice, live, as real role users:
 *   fiber cut (316 events via Kinetic WebAPI) → normalization/dedup → correlation → ONE incident → topology traversal →
 *   service & customer impact → ack / major / AI assist → work order (approval-gated dispatch, parts reserved) →
 *   customer comms (Service Owner approval → Kinetic workflow delivers) → field completion (Kinetic workflow) →
 *   restore → verification FAILS for one hung site + platform closure guard → reboot → manual confirmation →
 *   verification PASSES → resolution comms → close. Plus the ack-timer escalation workflow on a probe incident.
 * Assertions compare against seed/scenario-fiber-cut.json ground truth. Prints a results table.
 * Usage: node tests/e2e.mjs [--skip-replay] (requires the dev launcher: scripts/dev-launcher.sh)
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { call } from "./api-smoke.mjs";
import { basic, search, core, create } from "../deploy/lib.mjs";
import { PW } from "../deploy/users.mjs";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const scen = JSON.parse(fs.readFileSync(path.join(DIR, "../seed/scenario-fiber-cut.json"), "utf-8"));
const LAUNCHER = process.env.NOC_LAUNCHER || "http://127.0.0.1:3031";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; let failures = 0;
const check = (name, cond, detail = "") => { results.push({ name, ok: !!cond, detail }); if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); return !!cond; };
const as = (u) => (m, p, b) => call(m, p, b, basic(u, PW));
const noc = as("noc.borealis"), owner = as("owner.borealis"), tech = as("tech.borealis"), support = as("support.borealis"), exec = as("exec.borealis");
const replay = (phase, extra = []) => { const t = Date.now(); const out = execFileSync("node", [path.join(DIR, "../scripts/replay.mjs"), `--phase=${phase}`, `--launcher=${LAUNCHER}`, ...extra], { encoding: "utf-8", timeout: 1800000 }); console.log(out.split("\n").filter((l) => /✓|✗|errors|batch=/.test(l)).join("\n")); return { out, s: Math.round((Date.now() - t) / 1000) }; };
const waitFor = async (label, fn, secs = 90) => { for (let i = 0; i < secs / 3; i++) { const v = await fn(); if (v) return v; await sleep(3000); } return null; };
const ws = async (id) => (await noc("GET", `/api/noc/incidents/${id}`)).data;
const t0 = Date.now();

// ── 0. ack-timer probe incident (Kinetic workflow: wait 3 min → escalate if still New) ──
const probeId = `INC-PROBE-${Date.now().toString(36).toUpperCase()}`;
await create("incidents", { "Tenant ID": "borealis", "Incident ID": probeId, Title: "Ack-timer probe (e2e)", State: "New", Priority: "P4", "Detected At": new Date().toISOString().replace(/\.\d+Z/, "Z"), "Owner Team ID": "TEAM-NOC", "Replay Batch": "e2e-probe" });
const probeAt = Date.now();

// ── 1. the cut ──
let batch;
if (!process.argv.includes("--skip-replay")) {
  const r = replay("cut"); batch = (r.out.match(/batch=(\S+)/) || [])[1];
  const m = r.out.match(/events: (\d+) in (\d+)s .*kinds=(\{[^}]+\})/); const kinds = m ? JSON.parse(m[3]) : {};
  check("ingest: all 316 events processed by the Kinetic WebAPI", m && Number(m[1]) === 316, m ? `${m[1]} events in ${m[2]}s, kinds ${m[3]}` : "no summary");
  check("ingest: retransmits rejected as duplicates (idempotency)", kinds.duplicate >= 10, `duplicate=${kinds.duplicate}`);
  check("ingest: malformed events dead-lettered (422)", kinds.invalid === 2, `invalid=${kinds.invalid}`);
} else batch = fs.readFileSync(path.join(DIR, "../.last-batch"), "utf-8").trim();
const B = `values[Tenant ID]="borealis" AND values[Replay Batch]="${batch}"`;
const raws = await search("raw-alarms", B, { max: 1000 }); const alarms = await search("alarms", B, { max: 1000 });
check("dedup: raw events → far fewer normalized alarms", raws.length > 290 && alarms.length < raws.length * 0.6, `${raws.length} raw → ${alarms.length} alarms`);
check("normalization: the deliberately-late event is flagged (and only a few are)", raws.some((r) => String(r.values["Source Event ID"]).startsWith("IPN-LATE-001") && r.values.Late === "Yes") && raws.filter((r) => r.values.Late === "Yes").length <= 5, `${raws.filter((r) => r.values.Late === "Yes").length} late`);
check("normalization: clock-skewed event clamped + flagged", raws.some((r) => r.values["Clock Skew"] === "Yes"));
check("normalization: unknown severity → Indeterminate with note", alarms.some((a) => a.values.Severity === "Indeterminate" && /unmapped severity/.test(a.values["Normalization Notes"])));
check("normalization: cross-source duplicates merged (ip-nms + mom-sentinel on one alarm)", alarms.some((a) => /ip-nms/.test(a.values["Source Systems"]) && /mom-sentinel/.test(a.values["Source Systems"])));
check("normalization: parent-match for AID not in inventory", alarms.some((a) => a.values["Resource Ref"] === "ROADM-STP-02:OSC-9" && a.values["Resource ID"] === "ROADM-STP-02"));
const incs = (await search("incidents", B)).map((s) => s.values);
check("correlation: exactly ONE incident for the cut", incs.length === 1, incs.map((i) => i["Incident ID"]).join(","));
const inc = incs[0]; const ID = inc?.["Incident ID"];
check("correlation: root resource is the fiber span", inc?.["Root Resource ID"] === scen.truth.rootResource, inc?.["Root Resource ID"]);
const groups = (await search("correlation-groups", B)).map((s) => s.values);
check("correlation: one group, confidence ≥ 0.9", groups.length === 1 && Number(groups[0]["Root Confidence"]) >= 0.9, groups.map((g) => `${g["Root Resource ID"]}:${g["Alarm Count"]}@${g["Root Confidence"]}`).join(" "));
const al2 = (await search("alarms", B, { max: 1000 })).map((s) => s.values);
const inIncident = al2.filter((a) => a["Incident ID"] === ID);
check("correlation: noise stays out of the incident", !inIncident.some((a) => /DLH-HUB1|RST-HUB1|AGG-MSP-01/.test(a["Resource ID"])), `${inIncident.length} alarms in incident`);
check("maintenance: CHG-4410 alarms suppressed", al2.filter((a) => a["Suppressed By Change ID"] === "CHG-4410").length >= 2);
check("priority: P1 (public safety impacted)", inc?.Priority === "P1", inc?.Priority);
let W = await ws(ID);
const cls = (c) => new Set(W.impact.services.filter((s) => s.cls === c).map((s) => s.id));
const eq = (a, b) => a.size === b.length && b.every((x) => a.has(x));
check("impact: Confirmed services = ground truth", eq(cls("Confirmed"), scen.truth.impacted.confirmed), `${cls("Confirmed").size}/${scen.truth.impacted.confirmed.length}`);
check("impact: Inferred services = ground truth", eq(cls("Inferred"), scen.truth.impacted.inferred), [...cls("Inferred")].join(","));
check("impact: Potential services = ground truth", eq(cls("Potential"), scen.truth.impacted.potential), `${cls("Potential").size}/${scen.truth.impacted.potential.length}`);
check("impact: public-safety accounts identified", scen.truth.publicSafetyAccounts.every((n) => W.impact.accounts.some((a) => a.name === n && a.ps)));
check("impact: re-homed circuit uses edge valid at incident time + conflict flagged", /RCN-000001/.test(W.impact.services.find((s) => s.id === "SVC-DIA-10479")?.basis || ""));
check("assignment: auto-assigned to transport on-call", W.incident.Owner === "noc.borealis" && W.incident["Owner Team ID"] === "TEAM-TRANSPORT");

// ── 2. operator actions ──
let r = await support("POST", `/api/noc/incidents/${ID}/action`, { action: "ack" });
check("roles: support agent cannot acknowledge", r.status === 403, `${r.status}`);
r = await noc("POST", `/api/noc/incidents/${ID}/action`, { action: "ack" }); check("operator acknowledges", r.status === 200, JSON.stringify(r.data).slice(0, 80));
r = await noc("POST", `/api/noc/incidents/${ID}/action`, { action: "declare-major", reason: "Public-safety radio + 911 PSAP at risk; 9 cell sites down" }); check("operator declares major incident", r.status === 200);
r = await noc("POST", `/api/noc/incidents/${ID}/action`, { action: "transition", to: "Resolved" }); check("state machine: Acknowledged → Resolved refused", r.status === 400, r.data.error);
r = await noc("POST", `/api/noc/incidents/${ID}/action`, { action: "transition", to: "In Progress" }); check("state machine: → In Progress", r.status === 200);
r = await noc("POST", `/api/noc/incidents/${ID}/assist`, { kinds: ["Summary", "Hypothesis", "Next Step", "Recurrence"] });
const recs = r.data.recommendations || [];
check("AI: 4 suggestions, every citation resolves to a visible record", recs.length === 4 && recs.every((x) => x["Citation Check"] === "Passed"), recs.map((x) => `${x.Kind}:${x["Citation Check"]}`).join(" "));
check("AI: facts cite records; inferences carry confidence", recs.every((x) => x.facts.every((f) => f.citations.length > 0) && x.inferences.every((i) => typeof i.confidence === "number")));
check("AI: next step flags dispatch as approval-gated", recs.find((x) => x.Kind === "Next Step")?.["Requires Approval Action"] === "dispatch");
check("AI: recurrence detected (2 prior incidents on span)", /2 prior incident/.test(recs.find((x) => x.Kind === "Recurrence")?.Content || ""));
r = await noc("POST", `/api/noc/ai/${recs[0]["Recommendation ID"]}/decision`, { decision: "accept" }); check("AI: operator accepts summary (recorded)", r.status === 200);
r = await noc("POST", `/api/noc/ai/${recs[1]["Recommendation ID"]}/decision`, { decision: "reject" }); check("AI: rejection without reason refused", r.status === 400);
r = await noc("POST", `/api/noc/ai/${recs[1]["Recommendation ID"]}/decision`, { decision: "reject", feedback: "Alternative hypotheses not useful — both-end LOS is conclusive" }); check("AI: rejection with reason recorded", r.status === 200);

// ── 3. field dispatch ──
r = await noc("POST", `/api/noc/incidents/${ID}/dispatch`, {}); const WO = r.data.workOrderId; check("work order drafted (not dispatched)", r.status === 200 && !!WO, WO);
r = await tech("POST", `/api/noc/work-orders/${WO}/transition`, { to: "Dispatched" }); check("approval: field tech cannot approve own dispatch", r.status === 403);
r = await tech("POST", `/api/noc/work-orders/${WO}/transition`, { to: "Accepted" }); check("state machine: cannot accept an undispatched WO", r.status === 400);
const partBefore = (await search("parts", `values[Tenant ID]="borealis" AND values[Part ID]="PRT-SPLICE-144"`))[0].values["Qty Reserved"];
r = await noc("POST", `/api/noc/work-orders/${WO}/transition`, { to: "Dispatched" }); check("operator approves dispatch", r.status === 200, r.data.updated?.ETA);
const partAfter = (await search("parts", `values[Tenant ID]="borealis" AND values[Part ID]="PRT-SPLICE-144"`))[0].values["Qty Reserved"];
check("inventory: splice kits reserved at dispatch", Number(partAfter) === Number(partBefore) + 2, `${partBefore} → ${partAfter}`);
for (const to of ["Accepted", "En Route", "On Site"]) { r = await tech("POST", `/api/noc/work-orders/${WO}/transition`, { to }); check(`tech: → ${to}`, r.status === 200); }

// ── 4. customer comms (initial) ──
r = await noc("POST", `/api/noc/incidents/${ID}/notifications`, {}); const N1 = r.data.notificationId; check("comms: initial draft from AI draft", r.status === 200 && !!N1, N1);
const draftBody = r.data.draft?.Body || ""; check("comms: draft is customer-safe (no internal IDs)", !/FIB-|ROADM|AGG-|CSR-|SVC-/.test(draftBody), draftBody.slice(0, 90));
r = await noc("POST", `/api/noc/notifications/${N1}/submit`, {}); check("comms: submitted for approval", r.status === 200);
r = await noc("POST", `/api/noc/notifications/${N1}/approve`, {}); check("approval: operator cannot approve customer comms", r.status === 403);
r = await owner("POST", `/api/noc/notifications/${N1}/approve`, {}); check("service owner approves", r.status === 200);
const sent = await waitFor("sent", async () => (await search("notifications", `values[Tenant ID]="borealis" AND values[Notification ID]="${N1}"`))[0]?.values.Status === "Sent", 90);
check("Kinetic workflow delivered the approved notification (Status=Sent)", sent);
check("Kinetic workflow set incident Comms State=Sent + timeline", await waitFor("comms", async () => { const w = await ws(ID); return w.incident["Comms State"] === "Sent" && w.timeline.some((t) => t.actorType === "Workflow" && t.type === "Comms"); }, 60));
W = await ws(ID);
r = await support("GET", `/api/noc/customers/${W.impact.accounts.find((a) => a.cls === "Confirmed" && a.segment !== "Consumer Segment").accountId}`);
check("support agent sees the approved text (not internal cause)", r.status === 200 && r.data.incidents.some((i) => i.customerStatus && !i.internal), r.data.incidents?.[0]?.customerStatus?.slice(0, 60));

// ── 5. field completion ──
r = await tech("POST", `/api/noc/work-orders/${WO}/transition`, { to: "Work Complete", findings: "x", notes: "y" }); check("completion without evidence refused", r.status === 400);
r = await tech("POST", `/api/noc/work-orders/${WO}/transition`, { to: "Work Complete", findings: "Backhoe cut at I-94 km 9.41 during unpermitted sound-wall footing work; 144F cable severed.", notes: "30 m of 288F placed; 144/144 spliced, avg 0.03 dB", evidence: [{ type: "OTDR", ref: "otdr-FIB-MSP-STP-01-post.sor" }, { type: "Photo", ref: "splice-km9.4.jpg" }] });
check("tech completes work with findings + evidence", r.status === 200);
const pending = await waitFor("pending", async () => (await ws(ID)).incident["Verification State"] === "Pending", 90);
check("Kinetic workflow: field completion → incident Verification State=Pending + timeline", pending && (await ws(ID)).timeline.some((t) => t.actorType === "Workflow" && t.type === "Field"));
r = await noc("POST", `/api/noc/incidents/${ID}/action`, { action: "confirm-cause", cause: "Backhoe cut at I-94 km 9.41 (unpermitted sound-wall footing work) — confirmed by field OTDR + photo" }); check("observed root cause confirmed (separate from engine hypothesis)", r.status === 200);

// ── 6. restore: network back, C07 hung ──
replay("restore");
// index/replication lag: freshly-written clears can take a few seconds to be visible to queries
r = await waitFor("recovered", async () => { const x = await noc("POST", `/api/noc/incidents/${ID}/verify`, {}); return x.data.networkRecoveredAt ? x : null; }, 60) || await noc("POST", `/api/noc/incidents/${ID}/verify`, {});
check("verification: network recovered", !!r.data.networkRecoveredAt, r.data.networkRecoveredAt);
const c07 = r.data.services?.find((s) => s.serviceId === "SVC-RAN-STP-C07");
check("verification: hung site C07 NOT recovered (network ≠ service)", c07?.state === "Verification Failed", c07?.checks?.join("; "));
check("verification: overall Failed while C07 down", r.data.overall === "Failed", r.data.overall);
check("verification: unmonitored circuit needs confirmation", r.data.services?.find((s) => s.serviceId === "SVC-DIA-10467")?.state === "Network Restored");
r = await noc("POST", `/api/noc/incidents/${ID}/action`, { action: "transition", to: "Resolved" }); check("operator can resolve (network recovered)", r.status === 200, r.data.error || "");
r = await noc("POST", `/api/noc/incidents/${ID}/action`, { action: "transition", to: "Closed" }); check("server refuses close: verification not passed", r.status === 400 && /not verified/.test(r.data.error), r.data.error?.slice(0, 100));
// platform-level guard: bypass the server and PUT State=Closed directly with the operator's own credentials
const incSub = (await search("incidents", `values[Tenant ID]="borealis" AND values[Incident ID]="${ID}"`))[0];
const put = await core("PUT", `/submissions/${incSub.id}`, { values: { State: "Closed" } }, { auth: basic("noc.borealis", PW) });
check("direct platform write of State=Closed accepted by Core (operator has modify)", put.status === 200, `${put.status}`);
const reverted = await waitFor("revert", async () => (await search("incidents", `values[Tenant ID]="borealis" AND values[Incident ID]="${ID}"`))[0].values.State === "Resolved", 90);
check("Kinetic Closure Guard workflow reverted it to Resolved + logged", reverted && (await ws(ID)).timeline.some((t) => t.type === "Closure Blocked"));

r = await noc("POST", `/api/noc/incidents/${ID}/notifications`, { sequence: "Resolution" }); check("resolution notice refused before verified recovery", r.status === 400, r.data.error?.slice(0, 80));
// ── 7. reboot C07, confirm unmonitored circuit, verify passes ──
replay("reboot");
r = await noc("POST", `/api/noc/incidents/${ID}/action`, { action: "confirm-service", serviceId: "SVC-DIA-10467", note: "Highland Grocers store manager confirmed POS + internet working (phone call)" }); check("manual confirmation recorded", r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
r = await waitFor("passed", async () => { const x = await noc("POST", `/api/noc/incidents/${ID}/verify`, {}); return x.data.overall === "Passed" ? x : null; }, 60) || await noc("POST", `/api/noc/incidents/${ID}/verify`, {});
check("verification: PASSED after reboot + confirmation", r.data.overall === "Passed", r.data.overall + " " + JSON.stringify(r.data.services?.filter((s) => s.state !== "Service Verified").map((s) => s.serviceId)));
r = await noc("POST", `/api/noc/incidents/${ID}/action`, { action: "transition", to: "Closed" });
check("close still blocked until resolution comms sent", r.status === 400 && /Resolution notification/.test(r.data.error), r.data.error?.slice(0, 90));
r = await noc("POST", `/api/noc/incidents/${ID}/notifications`, { sequence: "Resolution" }); const N2 = r.data.notificationId; check("resolution notice drafted", r.status === 200 && /restored/.test(r.data.draft?.Body || ""), N2);
await noc("POST", `/api/noc/notifications/${N2}/submit`, {}); r = await owner("POST", `/api/noc/notifications/${N2}/approve`, {}); check("resolution notice approved", r.status === 200);
check("resolution notice delivered by workflow", await waitFor("sent2", async () => (await search("notifications", `values[Tenant ID]="borealis" AND values[Notification ID]="${N2}"`))[0]?.values.Status === "Sent", 90));
r = await noc("POST", `/api/noc/incidents/${ID}/action`, { action: "transition", to: "Closed", reason: "Service verified for all impacted services; customers notified" });
check("incident CLOSED after verified recovery", r.status === 200, r.data.error || "");
W = await ws(ID);
check("closing the incident closed its correlation group (late alarms of a NEW outage cannot join it)", (await search("correlation-groups", B)).every((g) => g.values.State === "Closed"));
check("closed incident: verified, cause confirmed, comms sent", W.incident.State === "Closed" && W.incident["Verification State"] === "Passed" && !!W.incident["Observed Root Cause"] && W.incident["Comms State"] === "Sent");
check("audit trail recorded user, engine and workflow actions", (await search("audit", `values[Tenant ID]="borealis" AND values[Replay Batch]="${batch}"`)).length + (await search("audit", `values[Tenant ID]="borealis"`, { max: 400 })).filter((a) => a.values["Entity ID"] === ID).length > 8);
r = await noc("POST", "/api/noc/ask", { question: "which customers are affected?", incidentId: ID }); check("NL question answered with citations", r.status === 200 && r.data.citations.length > 3, r.data.answer?.slice(0, 80));
r = await exec("GET", "/api/noc/exec"); check("executive MTTR includes the verified incident", r.status === 200 && r.data.kpis.mttrMin > 0, `MTTR ${r.data.kpis.mttrMin} min`);

// ── 8. ack timer (Kinetic system_wait_v1) ──
const remaining = 3 * 60000 + 45000 - (Date.now() - probeAt); if (remaining > 0) { console.log(`… waiting ${Math.round(remaining / 1000)}s for the ack timer`); await sleep(remaining); }
const probe = await waitFor("probe", async () => { const p = (await search("incidents", `values[Tenant ID]="borealis" AND values[Incident ID]="${probeId}"`))[0]; return p?.values["Escalation Level"] === "1" ? p : null; }, 90);
check("Kinetic ack-timer workflow escalated the unacknowledged incident", !!probe);
const probeTl = await search("incident-updates", `values[Tenant ID]="borealis" AND values[Incident ID]="${probeId}"`);
check("ack-timer wrote Escalation timeline entry", probeTl.some((u) => u.values["Update Type"] === "Escalation"));
for (const s of [probe, ...probeTl, ...(await search("audit", `values[Tenant ID]="borealis" AND values[Entity ID]="${probeId}"`))].filter(Boolean)) await core("DELETE", `/submissions/${s.id}`);

const summary = { batch, incident: ID, passed: results.filter((x) => x.ok).length, failed: failures, minutes: Math.round((Date.now() - t0) / 6000) / 10, results };
fs.writeFileSync(path.join(DIR, "e2e-results.json"), JSON.stringify(summary, null, 1));
console.log(`\n${failures ? "✗" : "✓"} e2e: ${summary.passed}/${results.length} passed in ${summary.minutes} min — incident ${ID}, batch ${batch}`);
process.exit(failures ? 1 : 0);
