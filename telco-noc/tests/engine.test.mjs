/**
 * Offline engine tests: run the fiber-cut scenario through a test-only JS mirror of the Ruby normalizer,
 * then correlation → impact → verification, and assert against the scenario's ground truth.
 * (The live test tests/e2e.mjs runs the same scenario through the real Kinetic WebAPI + server.)
 * Run: node --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CAT, buildGraph, correlate, assessImpact, verifyRecovery, prioritize, propagate, slaExposure } from "../engine/core.mjs";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ref = JSON.parse(fs.readFileSync(path.join(DIR, "../seed/reference.json"), "utf-8"));
const scen = JSON.parse(fs.readFileSync(path.join(DIR, "../seed/scenario-fiber-cut.json"), "utf-8"));
const B = (rows) => rows.filter((r) => r["Tenant ID"] === "borealis");
const T0 = Date.parse("2026-09-27T13:42:00Z");
const at = (off) => new Date(T0 + off * 1000).toISOString().replace(/\.\d+Z/, "Z");
const resources = new Map(B(ref.resources).map((r) => [r["Resource ID"], r]));
const idmap = B(ref.identifiers);

// test-only normalizer mirroring workflows/gen-trees.mjs NORM (fingerprint + clear semantics)
function normalize(events) {
  const seenIdem = new Set(), active = new Map(), all = [];
  const pk = (r, src) => idmap.find((m) => m["External ID"] === r && ["*", src].includes(m["Source System"]));
  for (const e of events) {
    if (e.malformed || !e.resourceRef) continue;
    const idem = `borealis|${e.source}|${e.sourceEventId}`; if (seenIdem.has(idem)) continue; seenIdem.add(idem);
    const sev = CAT.severityMap[e.source]?.[e.vendorSeverity] || "Indeterminate";
    const ct = CAT.conditionMap[e.source]?.[e.condition] || "UNKNOWN";
    const par = e.resourceRef.split(/[:|/]/)[0];
    const m = pk(e.resourceRef, e.source) || pk(par, e.source); const rid = m ? m["Internal ID"] : "";
    const rm = e.relatedResourceRef ? (pk(e.relatedResourceRef, e.source) || pk(e.relatedResourceRef.split(/[:|/]/)[0], e.source)) : null;
    const fp = `borealis|${rid || "ref:" + e.resourceRef}|${ct}`;
    const et = e.eventTimeOverride ? at(e.offset) : at(e.offset + (e.phase === "restore" ? 3600 : e.phase === "reboot" ? 4800 : 0));
    const cur = active.get(fp);
    if (e.state === "clear" || sev === "Cleared") { if (cur && et >= cur["First Occurred At"]) { cur.State = "Cleared"; cur["Cleared At"] = et; active.delete(fp); } continue; }
    if (cur) { cur["Occurrence Count"]++; cur["Last Occurred At"] = et > cur["Last Occurred At"] ? et : cur["Last Occurred At"]; continue; }
    const a = { "Normalization Notes": m && !pk(e.resourceRef, e.source) ? `resource "${e.resourceRef}" matched at parent "${par}"` : "", "Alarm ID": `ALM-${all.length + 1}`, Fingerprint: fp, "Resource ID": rid, "Related Resource ID": rm ? rm["Internal ID"] : "", "Resource Ref": e.resourceRef, "Alarm Type": ct, Severity: sev,
      "Service Affecting": CAT.conditions[ct]?.sa ? "Yes" : "No", State: "Active", "First Occurred At": et, "Last Occurred At": et, "Occurrence Count": 1, "Correlation Role": "Uncorrelated" };
    active.set(fp, a); all.push(a);
  }
  return all;
}
const changes = B(ref.changes).map((c) => ({ ...c, "Window Start": c["Window Start"].startsWith("RELATIVE") ? at(-3600) : c["Window Start"], "Window End": c["Window End"].startsWith("RELATIVE") ? at(7200) : c["Window End"] }));
const cutEvents = scen.events.filter((e) => e.phase === "cut");
const alarms = normalize(cutEvents);
const graph = buildGraph(B(ref.relationships), at(0));
const corr = correlate({ alarms, graph, changes, resources, now: T0 + 300000 });
const group = corr.groups[0];

test("dedup: hundreds of raw events collapse to far fewer normalized alarms", () => {
  assert.ok(cutEvents.length >= 300, `raw ${cutEvents.length}`);
  assert.ok(alarms.length < cutEvents.length * 0.6, `normalized ${alarms.length} vs raw ${cutEvents.length}`);
});
test("correlation: exactly one group for the cut, rooted at the fiber span", () => {
  assert.equal(group.root, scen.truth.rootResource);
  assert.equal(corr.groups.filter((g) => g.alarms.length >= 10).length, 1, "one large group");
  assert.ok(group.confidence >= 0.9, `confidence ${group.confidence}`);
  assert.match(group.hypothesis, /both terminating ends lost light/);
});
test("correlation: the group explains ≥ 95% of cut-related alarms", () => {
  const related = alarms.filter((a) => a.State === "Active" && a["Resource ID"] && !/DLH|RST|BLN-03|AGG-MSP/.test(a["Resource ID"]));
  assert.ok(group.alarms.length / related.length >= 0.95, `${group.alarms.length}/${related.length}`);
});
test("correlation: unrelated noise is NOT in the group; maintenance alarms are suppressed", () => {
  const inGroup = new Set(group.alarms.map((x) => x.id));
  const noise = alarms.filter((a) => /DLH-HUB1|RST-HUB1|AGG-MSP-01/.test(a["Resource ID"]));
  assert.ok(noise.length >= 3); for (const a of noise) assert.ok(!inGroup.has(a["Alarm ID"]), `${a["Resource ID"]} wrongly grouped`);
  const bln = alarms.filter((a) => a["Resource ID"].includes("ROADM-BLN-03"));
  assert.ok(bln.length >= 2); for (const a of bln) assert.ok(corr.suppressed.some((s) => s.alarmId === a["Alarm ID"] && s.changeId === "CHG-4410"));
});
test("correlation: root evidence = LOS on both terminating ports", () => {
  const ev = group.alarms.filter((x) => x.role === "Root Evidence").map((x) => alarms.find((a) => a["Alarm ID"] === x.id)["Resource ID"]);
  assert.ok(ev.includes("ROADM-MSP-01/OTS-2") && ev.includes("ROADM-STP-02/OTS-1"));
});
test("correlation: X2 alarms on healthy neighbours are explained through the related resource", () => {
  const x2 = alarms.filter((a) => a["Alarm Type"] === "X2-LINK-FAIL" && /C1[3-8]/.test(a["Resource ID"]));
  assert.ok(x2.length >= 4); const inGroup = new Set(group.alarms.map((x) => x.id)); for (const a of x2) assert.ok(inGroup.has(a["Alarm ID"]));
});
test("correlation: protection-switch events are explained by the root (no stray groups)", () => {
  const aps = alarms.filter((a) => a["Alarm Type"] === "APS-SWITCH"); assert.ok(aps.length >= 2);
  const inGroup = new Set(group.alarms.map((x) => x.id)); for (const a of aps) assert.ok(inGroup.has(a["Alarm ID"]), a["Resource ID"]);
  assert.equal(corr.groups.length, 1, `groups: ${corr.groups.map((g) => g.root + ":" + g.alarms.length).join(", ")}`);
});
test("correlation: parent-matched alarm (AID not in inventory) is explained via the chassis's components", () => {
  const osc = alarms.find((a) => a["Resource Ref"] === "ROADM-STP-02:OSC-9"); assert.ok(osc, "osc alarm");
  assert.ok(group.alarms.some((x) => x.id === osc["Alarm ID"]));
});
test("correlation: a late arrival joins the existing open group", () => {
  const late = { "Alarm ID": "ALM-LATE", "Resource ID": "CSR-STP-C03", "Alarm Type": "BFD-DOWN", State: "Active", "First Occurred At": at(600), "Last Occurred At": at(600) };
  const r = correlate({ alarms: [late], graph, changes, resources, openGroups: [{ groupId: "CG-1", incidentId: "INC-1", root: group.root }], now: T0 + 700000 });
  assert.equal(r.joins.length, 1); assert.equal(r.joins[0].alarms[0].id, "ALM-LATE");
});

const services = B(ref["service-instances"]), subs = B(ref.subscriptions), custs = B(ref.customers), slas = B(ref.slas), conflicts = B(ref.conflicts);
const metricRows = (phase, offset) => scen.metrics[phase].map((m, i) => ({ "Observation ID": `OBS-${phase}-${i}`, "Subject ID": m.subject, Metric: m.metric,
  Value: String(m.unit === "ratio" ? m.value * 100 : m.unit === "us" ? m.value / 1000 : m.value), Unit: m.metric === "latency_ms" ? "ms" : "%", "Observed At": at(offset), "Source System": m.source }));
const imp = assessImpact({ root: group.root, graph, services, subscriptions: subs, customers: custs, slas, alarms, metrics: metricRows("cut", 120), conflicts, resources, startedAt: at(0), now: T0 + 3600000 });
const cls = (c) => new Set(imp.rows.filter((r) => r.cls === c).map((r) => r.serviceId));

test("impact: confirmed / inferred / potential match ground truth exactly", () => {
  assert.deepEqual([...cls("Confirmed")].sort(), [...scen.truth.impacted.confirmed].sort());
  assert.deepEqual([...cls("Inferred")].sort(), [...scen.truth.impacted.inferred].sort());
  assert.deepEqual([...cls("Potential")].sort(), [...scen.truth.impacted.potential].sort());
});
test("impact: services elsewhere are not impacted", () => {
  for (const s of scen.truth.impacted.notImpacted) assert.ok(!imp.rows.some((r) => r.serviceId === s), s);
});
test("impact: time-aware topology — re-homed circuit uses the edge valid at incident time, and the conflict is surfaced", () => {
  const mrcu = imp.rows.find((r) => r.serviceId === "SVC-DIA-10479");
  assert.equal(mrcu.cls, "Potential"); assert.match(mrcu.basis, /RCN-000001/);
  const old = buildGraph(B(ref.relationships), "2026-09-10T00:00:00Z"); // before the re-home
  assert.equal(propagate(old, new Set(["FIB-MSP-STP-01"])).get("SVC-DIA-10479"), "down");
});
test("impact: public safety + customers + priority", () => {
  const sum = imp.summary;
  assert.ok(sum.publicSafety >= 1, "public safety impacted"); assert.ok(sum.customers >= 8, `customers ${sum.customers}`);
  assert.equal(prioritize(sum).priority, "P1");
  assert.ok(sum.subscribers > 10000, `subscribers ${sum.subscribers}`); assert.ok(sum.slaExposureUsd > 0);
});
test("sla exposure math", () => {
  const e = slaExposure({ "Availability Target Pct": "99.99", "MTTR Target Hours": "4", "Credit Pct Per Hour": "10", "Credit Cap Pct": "50" }, 1000, 0, 3 * 3600000);
  assert.equal(e.minutes, 180); assert.equal(e.usd, 300); // allowed 4.32 min → 3 started hours over × 10% × $1000
});

// ── recovery: restore phase (C07 hung) then reboot phase ──
const afterRestore = normalize([...cutEvents, ...scen.events.filter((e) => e.phase === "restore")]);
const impactRows = imp.rows.map((r) => ({ "Service Instance ID": r.serviceId, "Impact Class": r.cls }));
const svcAlarms = (list) => { const m = new Map(); for (const r of imp.rows) { const d = (graph.deps.get(r.serviceId) || []).map((e) => e.to); const ev = new Set(d); for (const x of d) for (const e of graph.rdeps.get(x) || []) if (e.type === "part_of") ev.add(e.from); m.set(r.serviceId, list.filter((a) => ev.has(a["Resource ID"]))); } return m; };
const inGroupIds = new Set(group.alarms.map((x) => x.id));
const grpAlarms = (list) => list.filter((a) => inGroupIds.has(a["Alarm ID"])).map((a) => ({ ...a, "Correlation Role": group.alarms.find((x) => x.id === a["Alarm ID"]).role }));
test("verification: network recovered but C07 service NOT recovered → Failed, cannot close", () => {
  const v = verifyRecovery({ impacts: impactRows, groupAlarms: grpAlarms(afterRestore), serviceAlarms: svcAlarms(afterRestore), metrics: metricRows("restore", 3700), services, now: T0 + 3800000 });
  assert.ok(v.networkRecoveredAt, "network recovered");
  const c07 = v.services.find((s) => s.serviceId === "SVC-RAN-STP-C07"); assert.equal(c07.state, "Verification Failed");
  assert.equal(v.overall, "Failed");
  assert.equal(v.services.find((s) => s.serviceId === "SVC-DIA-10442").state, "Service Verified");
  assert.equal(v.services.find((s) => s.serviceId === "SVC-DIA-10467").state, "Network Restored", "unmonitored needs confirmation");
});
test("verification: after C07 reboot + customer confirmation for the unmonitored circuit → Passed", () => {
  const all = normalize([...cutEvents, ...scen.events.filter((e) => e.phase !== "cut")]);
  const v = verifyRecovery({ impacts: impactRows, groupAlarms: grpAlarms(all), serviceAlarms: svcAlarms(all), metrics: [...metricRows("restore", 4700), ...metricRows("reboot", 4850)], services, now: T0 + 4900000,
    manualConfirmations: new Map([["SVC-DIA-10467", "Highland Grocers store manager confirmed POS online (call 14:55Z)"]]) });
  assert.equal(v.overall, "Passed", JSON.stringify(v.services.filter((s) => s.state !== "Service Verified")));
});
