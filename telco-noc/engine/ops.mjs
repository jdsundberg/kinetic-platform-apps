/**
 * engine/ops.mjs — the stateful operations: correlation run, impact assessment write, recovery verification,
 * and the incident / work-order / notification state machines. All writes are idempotent (deterministic IDs).
 */
import { buildGraph, correlate, assessImpact, verifyRecovery, prioritize, shouldOpenIncident, SA_TYPES, downstream, propagate } from "./core.mjs";
import { SERVICE_AUTH as S, rows, one, create, update, pool, reference, audit, timeline, nowIso, hash, q, bust } from "./store.mjs";

const TEAM_FOR = { "Fiber Span": "TEAM-TRANSPORT", Conduit: "TEAM-TRANSPORT", ROADM: "TEAM-TRANSPORT", "Optical Port": "TEAM-TRANSPORT", Wavelength: "TEAM-TRANSPORT", "OTN Link": "TEAM-TRANSPORT",
  Router: "TEAM-IP", Interface: "TEAM-IP", "Ethernet Link": "TEAM-IP", Circuit: "TEAM-IP", "Cell Site Router": "TEAM-RAN", gNodeB: "TEAM-RAN", eNodeB: "TEAM-RAN", Cell: "TEAM-RAN",
  "Microwave Link": "TEAM-RAN", "Power Plant": "TEAM-FIELD-EAST", "Network Function": "TEAM-IP" };
const OPEN_INC = ["New", "Acknowledged", "In Progress", "Mitigated", "Resolved"];
export const INC_TRANSITIONS = { New: ["Acknowledged", "Cancelled"], Acknowledged: ["In Progress", "Cancelled"], "In Progress": ["Mitigated", "Resolved", "Cancelled"],
  Mitigated: ["In Progress", "Resolved"], Resolved: ["Closed", "In Progress"], Closed: [], Cancelled: [] };
export const WO_TRANSITIONS = { Draft: ["Dispatched", "Cancelled"], Dispatched: ["Accepted", "Cancelled"], Accepted: ["En Route", "Cancelled"], "En Route": ["On Site", "Cancelled"],
  "On Site": ["Work Complete", "Cancelled"], "Work Complete": ["Verified", "On Site"], Verified: [], Cancelled: [] };
const day = (iso) => iso.slice(0, 10).replace(/-/g, "");

export function onCall(ref, teamId, at = Date.now()) {
  const act = ref.oncall.filter((o) => o["Team ID"] === teamId && Date.parse(o["Starts At"]) <= at && Date.parse(o["Ends At"]) > at);
  return act.find((o) => o.Role === "Primary") || act[0] || null;
}

/** Evidence resources for a service: its direct dependencies plus their part_of children (cells of a gNB). */
export function evidenceResources(graph, sid) {
  const direct = (graph.deps.get(sid) || []).map((e) => e.to); const ev = new Set(direct);
  for (const d of direct) for (const e of graph.rdeps.get(d) || []) if (e.type === "part_of") ev.add(e.from);
  return ev;
}

// ─────────────────────────────── correlation run ───────────────────────────────
export async function runCorrelation(tenant, { batch = "", settleSeconds = 0 } = {}) {
  const t0 = Date.now();
  const ref = await reference(tenant);
  const [active, openGroupsRows, changes] = await Promise.all([
    rows("alarms", tenant, `values[State]="Active"`, S, 5000), rows("correlation-groups", tenant, `values[State]="Open"`, S), rows("changes", tenant, "", S)]);
  // settle: do not correlate while the newest uncorrelated alarm is younger than settleSeconds (storm still arriving)
  const fresh = active.filter((a) => !a["Correlation Group ID"] && a["Correlation Role"] !== "Suppressed");
  if (settleSeconds && fresh.some((a) => Date.now() - Date.parse(a._createdAt) < settleSeconds * 1000)) return { skipped: "settling", uncorrelated: fresh.length };
  // enrich: site from resource
  const siteFix = active.filter((a) => a["Resource ID"] && !a["Site ID"] && ref.resById.get(a["Resource ID"])?.["Site ID"]);
  const graph = buildGraph(ref.relationships, nowIso());
  // only groups whose incident is still open accept late alarms; close any group left open behind a closed incident
  const incState = new Map((await rows("incidents", tenant, "", S)).map((i) => [i["Incident ID"], i.State]));
  const stale = openGroupsRows.filter((g) => g["Incident ID"] && !OPEN_INC.includes(incState.get(g["Incident ID"])));
  await pool(stale, 4, (g) => update(g._id, { State: "Closed" }, S));
  const openGroups = openGroupsRows.filter((g) => !stale.includes(g)).map((g) => ({ groupId: g["Group ID"], incidentId: g["Incident ID"], root: g["Root Resource ID"] }));
  const res = correlate({ alarms: active, graph, changes, resources: ref.resById, openGroups, now: Date.now() });
  const byId = new Map(active.map((a) => [a["Alarm ID"], a]));
  const writes = []; const summary = { suppressed: res.suppressed.length, joined: 0, groups: [], independent: res.independent.length, incidents: [] };

  for (const s of res.suppressed) { const a = byId.get(s.alarmId); writes.push([a._id, { "Correlation Role": "Suppressed", "Suppressed By Change ID": s.changeId }]); }
  for (const j of res.joins) {
    summary.joined += j.alarms.length;
    for (const x of j.alarms) { const a = byId.get(x.id); writes.push([a._id, { "Correlation Group ID": j.groupId, "Correlation Role": x.role, "Incident ID": j.incidentId || "" }]); }
    if (j.incidentId) await timeline(tenant, j.incidentId, { type: "Correlation", summary: `${j.alarms.length} late/new alarm(s) joined correlation group ${j.groupId} (explained by root ${j.root}).`, details: { alarms: j.alarms.slice(0, 50) }, batch });
  }
  for (const g of res.groups) {
    const groupId = `CG-${day(g.firstAt)}-${hash(g.root + "|" + g.firstAt, 6)}`;
    const openInc = await rows("incidents", tenant, `values[Root Resource ID]="${q(g.root)}"`, S).then((r) => r.find((i) => OPEN_INC.includes(i.State)));
    const willOpen = shouldOpenIncident(g, byId);
    let incidentId = openInc?.["Incident ID"] || (willOpen ? `INC-${day(g.firstAt)}-${hash(groupId, 4)}` : "");
    await create("correlation-groups", { "Tenant ID": tenant, "Group ID": groupId, "Rule": "topology-min-root-cover/v1", "Root Resource ID": g.root, "Root Confidence": String(g.confidence),
      "Root Basis": g.basis.join(" · "), "Alarm Count": String(g.alarms.length), "Resource Count": String(g.resourceCount), "First Alarm At": g.firstAt, "Last Alarm At": g.lastAt, "State": "Open",
      "Incident ID": incidentId, "Evidence": JSON.stringify({ hypothesis: g.hypothesis, candidates: g.candidates, roles: countBy(g.alarms, "role") }), "Replay Batch": batch }, S);
    for (const x of g.alarms) writes.push([byId.get(x.id)._id, { "Correlation Group ID": groupId, "Correlation Role": x.role, "Incident ID": incidentId }]);
    summary.groups.push({ groupId, root: g.root, alarms: g.alarms.length, confidence: g.confidence, incidentId });
    if (incidentId && !openInc) {
      const inc = await openIncident(tenant, { g, groupId, incidentId, ref, graph, batch });
      summary.incidents.push(inc);
    } else if (openInc) await timeline(tenant, incidentId, { type: "Correlation", summary: `New correlation group ${groupId} (${g.alarms.length} alarms) attached — same root ${g.root}.`, batch });
  }
  // leftovers stay visible as Independent (the scheduler only wakes for Uncorrelated); every run still reconsiders them
  for (const aid of res.independent) { const a = byId.get(aid); if (a && a["Correlation Role"] !== "Independent") writes.push([a._id, { "Correlation Role": "Independent" }]); }
  for (const a of siteFix) if (!writes.some((w) => w[0] === a._id)) writes.push([a._id, {}]);
  const siteOf = (id) => { const a = active.find((x) => x._id === id); return a && ref.resById.get(a["Resource ID"])?.["Site ID"]; };
  const results = await pool(writes, 10, ([id, v]) => update(id, { ...v, ...(siteOf(id) ? { "Site ID": siteOf(id) } : {}) }, S));
  summary.alarmWrites = writes.length; summary.writeFailures = results.filter((r) => !r.ok).length;
  summary.orphanClears = await applyOrphanClears(tenant, active);
  summary.ms = Date.now() - t0;
  return summary;
}
const countBy = (arr, k) => arr.reduce((m, x) => ((m[x[k]] = (m[x[k]] || 0) + 1), m), {});

/** Out-of-order repair: an Active alarm whose fingerprint has a later clear recorded as an orphan raw event → clear it. */
async function applyOrphanClears(tenant, active) {
  const orphans = (await rows("raw-alarms", tenant, `values[Processing State]="Normalized"`, S, 3000)).filter((r) => !r["Alarm ID"] && /clear/i.test(r["Reject Reason"] || r.Payload || ""));
  let n = 0;
  for (const a of active) {
    const o = orphans.find((r) => r.Fingerprint === a.Fingerprint && r["Event Time"] >= a["Last Occurred At"]);
    if (o) { const u = await update(a._id, { State: "Cleared", "Cleared At": o["Event Time"], "Normalization Notes": `${a["Normalization Notes"] || ""}; cleared by out-of-order clear ${o["Raw ID"]}`.slice(0, 1500) }, S); if (u.ok) n++; }
  }
  return n;
}

async function openIncident(tenant, { g, groupId, incidentId, ref, graph, batch }) {
  const root = ref.resById.get(g.root) || {};
  const site = ref.siteById.get(root["Site ID"] || root["A Site ID"] || "") || {};
  const team = TEAM_FOR[root["Resource Type"]] || "TEAM-NOC";
  const oc = onCall(ref, team);
  const detected = g.firstAt;
  const values = { "Tenant ID": tenant, "Incident ID": incidentId, "Title": `${root["Resource Type"] || "Resource"} ${g.root} failure — assessing impact`, "State": "New", "Priority": "P3",
    "Major Incident": "No", "Owner": oc?.User || "", "Owner Team ID": team, "Escalation Level": "0", "Root Resource ID": g.root, "Correlation Group ID": groupId,
    "Probable Cause": g.hypothesis, "Probable Cause Confidence": String(g.confidence), "Detected At": detected, "Verification State": "Not Started", "Comms State": "None",
    "Region ID": site["Region ID"] || "RGN-NC", "Market ID": site["Market ID"] || "", "Replay Batch": batch };
  const c = await create("incidents", values, S);
  if (!c.ok) throw new Error(`incident create failed: ${c.error}`);
  await timeline(tenant, incidentId, { id: `UPD-${incidentId}-OPEN`, type: "Correlation", summary: `Incident opened from correlation group ${groupId}: ${g.alarms.length} alarms explained by ${g.root} (confidence ${g.confidence}). Auto-assigned to ${team}${oc ? " / on-call " + oc.User : ""}.`, details: { basis: g.basis, candidates: g.candidates }, batch });
  await audit(tenant, { actor: "engine", actorType: "Engine", action: "incident.create", entityType: "Incident", entityId: incidentId, after: { root: g.root, team, owner: oc?.User }, reason: "correlation", batch });
  const imp = await writeImpact(tenant, incidentId, { batch });
  return { incidentId, ...imp };
}

// ─────────────────────────────── impact ───────────────────────────────
export async function writeImpact(tenant, incidentId, { batch = "" } = {}) {
  const inc = await one("incidents", tenant, "Incident ID", incidentId, S); if (!inc) throw new Error("incident not found");
  const ref = await reference(tenant);
  const graph = buildGraph(ref.relationships, inc["Detected At"]);            // topology AS OF detection time
  const [alarms, metrics, existing] = await Promise.all([
    rows("alarms", tenant, `values[State]="Active"`, S, 5000),
    rows("metrics", tenant, ref.services.length ? `values[Subject ID] IN (${ref.services.map((s) => `"${q(s["Service Instance ID"])}"`).join(",")})` : "", S, 3000),
    rows("impacts", tenant, `values[Incident ID]="${q(incidentId)}"`, S)]);
  const r = assessImpact({ root: inc["Root Resource ID"], graph, services: ref.services, subscriptions: ref.subscriptions, customers: ref.customers, slas: ref.slas, alarms, metrics,
    conflicts: ref.conflicts, resources: ref.resById, startedAt: inc["Detected At"] });
  const exById = new Map(existing.map((x) => [x["Impact ID"], x]));
  await pool(r.rows, 8, async (row) => {
    const id = `IMP-${incidentId.replace("INC-", "")}-${hash(row.serviceId + "|" + row.subscriptionId, 6)}`;
    const v = { "Tenant ID": tenant, "Impact ID": id, "Incident ID": incidentId, "Service Instance ID": row.serviceId, "Subscription ID": row.subscriptionId, "Account ID": row.accountId, "Account Name": row.accountName,
      "Segment": row.segment, "Public Safety": row.publicSafety ? "Yes" : "No", "Impact Class": row.cls, "Basis": row.basis.slice(0, 3000), "Path": JSON.stringify(row.path), "Topology As Of": inc["Detected At"],
      "Confidence": String(row.confidence), "SLA ID": row.slaId, "Impact Started At": inc["Detected At"], "Minutes Impacted": String(row.minutes), "SLA Exposure USD": String(row.exposureUsd), "SLA Breach At": row.breachAt || "",
      "Replay Batch": batch || inc["Replay Batch"] || "" };
    const ex = exById.get(id);
    if (ex) { if (ex["Recovery State"] && ex["Recovery State"] !== "Impacted") { delete v["Impact Class"]; } return update(ex._id, v, S); }
    return create("impacts", { ...v, "Recovery State": "Impacted" }, S);
  });
  const sum = r.summary; const pr = prioritize(sum);
  const root = ref.resById.get(inc["Root Resource ID"]) || {};
  const sites = new Set(r.rows.filter((x) => x.cls !== "Potential" && x.serviceId.startsWith("SVC-RAN")).map((x) => x.serviceId));
  const ent = new Set(r.rows.filter((x) => x.cls !== "Potential" && !x.serviceId.startsWith("SVC-RAN")).map((x) => x.serviceId));
  const title = `${root["Resource Type"] || "Resource"} ${inc["Root Resource ID"]} down — ${sites.size} cell sites, ${ent.size} enterprise/wholesale services, ${sum.customers} customers`;
  const upd = { Title: title, Priority: rank(pr.priority) < rank(inc.Priority) ? pr.priority : inc.Priority, "Impact Summary": JSON.stringify({ ...sum, priorityReason: pr.reason }),
    "Customers Affected": String(sum.customers), "Services Affected": String(sum.confirmed + sum.inferred), "SLA Exposure USD": String(sum.slaExposureUsd) };
  await update(inc._id, upd, S);
  await timeline(tenant, incidentId, { type: "Impact", summary: `Impact assessed (topology as of ${inc["Detected At"]}): ${sum.confirmed} confirmed, ${sum.inferred} inferred, ${sum.potential} potential services; ${sum.customers} customers (${sum.publicSafety} public safety), ${sum.subscribers.toLocaleString()} consumer subscribers; SLA exposure $${sum.slaExposureUsd.toLocaleString()}. Priority ${upd.Priority} — ${pr.reason}.`, details: sum, batch });
  bust(`inc|${tenant}`);
  return { summary: sum, priority: upd.Priority, rows: r.rows.length };
}
const rank = (p) => Number(String(p || "P4").slice(1));

// ─────────────────────────────── verification ───────────────────────────────
export async function runVerification(tenant, incidentId, actor) {
  const inc = await one("incidents", tenant, "Incident ID", incidentId, S); if (!inc) throw new Error("incident not found");
  const ref = await reference(tenant); const graph = buildGraph(ref.relationships, inc["Detected At"]);
  const [groupAlarms, impacts, updates] = await Promise.all([
    rows("alarms", tenant, `values[Incident ID]="${q(incidentId)}"`, S, 5000), rows("impacts", tenant, `values[Incident ID]="${q(incidentId)}"`, S),
    rows("incident-updates", tenant, `values[Incident ID]="${q(incidentId)}"`, S)]);
  const svcIds = [...new Set(impacts.map((i) => i["Service Instance ID"]))];
  const metrics = svcIds.length ? await rows("metrics", tenant, `values[Subject ID] IN (${svcIds.map((s) => `"${q(s)}"`).join(",")})`, S, 3000) : [];
  const serviceAlarms = new Map(svcIds.map((sid) => { const ev = evidenceResources(graph, sid); return [sid, groupAlarms.filter((a) => ev.has(a["Resource ID"]))]; }));
  const manual = new Map(updates.filter((u) => u["Update Type"] === "Verification" && u.Details).map((u) => { try { const d = JSON.parse(u.Details); return d.confirmService ? [d.confirmService, `${d.note} (${u.Author} ${u.At})`] : null; } catch { return null; } }).filter(Boolean));
  const v = verifyRecovery({ impacts, groupAlarms, serviceAlarms, metrics, services: ref.services, manualConfirmations: manual });
  const bySvc = new Map(v.services.map((s) => [s.serviceId, s]));
  await pool(impacts, 8, (i) => { const s = bySvc.get(i["Service Instance ID"]); if (!s) return null;
    return update(i._id, { "Recovery State": s.state, "Verified At": s.verifiedAt, "Verification Evidence": JSON.stringify(s.checks), ...(v.networkRecoveredAt && !i["Impact Ended At"] ? { "Impact Ended At": v.networkRecoveredAt } : {}) }, S); });
  const upd = { "Verification State": v.overall };
  if (v.networkRecoveredAt && !inc["Network Recovered At"]) upd["Network Recovered At"] = v.networkRecoveredAt;
  if (v.overall === "Passed" && !inc["Service Recovered At"]) upd["Service Recovered At"] = nowIso();
  await update(inc._id, upd, S);
  const counts = countBy(v.services, "state");
  await timeline(tenant, incidentId, { type: "Verification", author: actor, actorType: "User", summary: `Recovery verification: ${v.overall}. Network ${v.networkRecoveredAt ? "recovered at " + v.networkRecoveredAt : "NOT recovered"}; services — ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}.`, details: { failing: v.services.filter((s) => s.state !== "Service Verified").slice(0, 20) } });
  await audit(tenant, { actor, action: "incident.verify", entityType: "Incident", entityId: incidentId, after: upd });
  bust(`inc|${tenant}`);
  return v;
}

// ─────────────────────────────── change risk review ───────────────────────────────
export async function changeRisk(tenant, changeId) {
  const ref = await reference(tenant);
  const chg = await one("changes", tenant, "Change ID", changeId, S); if (!chg) throw new Error("change not found");
  const graph = buildGraph(ref.relationships, chg["Window Start"] || nowIso());
  const targets = String(chg["Affected Resource IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const st = propagate(graph, new Set(targets));
  const down = ref.services.filter((s) => st.get(s["Service Instance ID"]) === "down"), risk = ref.services.filter((s) => st.get(s["Service Instance ID"]) === "at-risk");
  const acct = new Set(ref.subscriptions.filter((x) => down.some((d) => d["Service Instance ID"] === x["Service Instance ID"])).map((x) => x["Account ID"]));
  const ps = [...acct].filter((a) => ref.custById.get(a)?.["Public Safety"] === "Yes");
  const openInc = (await rows("incidents", tenant, "", S)).filter((i) => OPEN_INC.includes(i.State));
  // any open incident whose impact makes these targets (or their dependents) the ONLY remaining path?
  const conflicts = [];
  for (const i of openInc) {
    const g2 = buildGraph(ref.relationships, i["Detected At"]); const cur = propagate(g2, new Set([i["Root Resource ID"]]));
    const hits = targets.filter((tg) => cur.get(tg) === "at-risk" || [...downstream(g2, tg)].some((x) => cur.get(x) === "at-risk"));
    if (hits.length) conflicts.push({ incidentId: i["Incident ID"], reason: `${hits.join(", ")} (or its dependents) are running without redundancy because of ${i["Incident ID"]} — taking them down would turn potential impact into an outage` });
  }
  const score = Math.min(100, down.length * 4 + risk.length * 1 + acct.size * 3 + ps.length * 25 + conflicts.length * 30 + (chg["Change Type"] === "Emergency" ? 10 : 0));
  return { changeId, targets, servicesDown: down.map((s) => s["Service Instance ID"]), servicesAtRisk: risk.map((s) => s["Service Instance ID"]), accounts: [...acct], publicSafetyAccounts: ps,
    conflicts, score, risk: score >= 60 ? "High" : score >= 30 ? "Medium" : "Low", recommendation: conflicts.length ? "Postpone: an open incident has already removed redundancy for these resources." : score >= 60 ? "Requires CAB approval and customer notice." : "Proceed under standard approval." };
}

export { SA_TYPES, OPEN_INC };
