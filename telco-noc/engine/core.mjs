/**
 * engine/core.mjs — pure, deterministic NOC reasoning. No I/O: callers pass plain records ({...values}).
 *
 *   buildGraph(relationships, at)          time-aware dependency graph ("From depends on To"), as of `at`
 *   correlate({alarms, graph, changes,…})  suppression → minimal root cover → groups with evidence + confidence
 *   propagate(graph, roots)                down / at-risk state with redundancy-group semantics
 *   assessImpact({...})                    Confirmed / Inferred / Potential per service × subscription, SLA exposure
 *   verifyRecovery({...})                  network recovery vs confirmed customer-service recovery
 *   prioritize(summary)                    P1–P4 from impact
 *
 * Definitions (see docs/blueprint.md §Definitions):
 *   Confirmed  topology says DOWN and there is direct evidence on the service (SA alarm on its own resources, or a failing probe/KPI)
 *   Inferred   topology says DOWN, no direct evidence (unmonitored) — or evidence missing because monitoring is itself down
 *   Potential  topology says AT RISK (redundancy degraded) or DOWN is contradicted by a healthy fresh measurement
 */
import fs from "node:fs";
import path from "node:path";
const CAT = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "catalog.json"), "utf-8"));
export { CAT };

const t = (s) => (s ? Date.parse(s) : NaN);
const MIN = 60000;
export const SA_TYPES = new Set(Object.entries(CAT.conditions).filter(([, v]) => v.sa).map(([k]) => k));
const TERM_LOS = new Set(["LOS", "OMS-LOS"]);
export const PROTECTION_TYPES = new Set(["APS-SWITCH", "MW-SWITCHOVER"]);

// ─────────────────────────────── graph ───────────────────────────────
export function buildGraph(relationships, at = new Date().toISOString()) {
  const when = t(at);
  const deps = new Map(), rdeps = new Map(), used = [];
  for (const r of relationships) {
    const from = r["From ID"], to = r["To ID"];
    if (!from || !to) continue;
    const vf = t(r["Valid From"]), vt = t(r["Valid To"]);
    if (!isNaN(vf) && vf > when) continue;           // not yet valid
    if (!isNaN(vt) && vt <= when) continue;          // already retired at `at`
    const e = { from, to, type: r["Relationship Type"], rg: r["Redundancy Group"] || "", role: r["Protection Role"] || "None",
      conf: Number(r["Confidence"] || 1), src: r["Source System"] || "", id: r["Relationship ID"], disputed: r["Status"] === "Disputed", kind: r["From Kind"] || "Resource" };
    (deps.get(from) || deps.set(from, []).get(from)).push(e);
    (rdeps.get(to) || rdeps.set(to, []).get(to)).push(e);
    used.push(e.id);
  }
  return { deps, rdeps, at, edgeCount: used.length };
}
export function upstream(graph, id, seen = new Set()) {
  for (const e of graph.deps.get(id) || []) if (!seen.has(e.to)) { seen.add(e.to); upstream(graph, e.to, seen); }
  return seen;
}
export function downstream(graph, id, seen = new Set()) {
  for (const e of graph.rdeps.get(id) || []) if (!seen.has(e.from)) { seen.add(e.from); downstream(graph, e.from, seen); }
  return seen;
}

// ─────────────────────────── state propagation ───────────────────────────
/** roots: Set of failed resource IDs. Returns Map id → 'down' | 'at-risk' for every affected node (others are up). */
export function propagate(graph, roots) {
  const state = new Map([...roots].map((r) => [r, "down"]));
  const affected = new Set(); for (const r of roots) downstream(graph, r, affected);
  const order = [...affected];
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    for (const id of order) {
      if (roots.has(id)) continue;
      const groups = new Map();
      for (const e of graph.deps.get(id) || []) { const k = e.rg || `__${e.to}`; (groups.get(k) || groups.set(k, []).get(k)).push(e.to); }
      let s = "up";
      for (const members of groups.values()) {
        const st = members.map((m) => state.get(m) || "up");
        if (st.every((x) => x === "down")) { s = "down"; break; }
        if (st.some((x) => x !== "up")) s = "at-risk";
      }
      if ((state.get(id) || "up") !== s) { changed = true; if (s === "up") state.delete(id); else state.set(id, s); }
    }
    if (!changed) break;
  }
  return state;
}
/** Shortest dependency path from a node up to any root (for "why is this impacted" explanations). */
export function pathToRoot(graph, from, roots) {
  const q = [[from]], seen = new Set([from]);
  while (q.length) { const p = q.shift(), last = p[p.length - 1]; if (roots.has(last)) return p;
    for (const e of graph.deps.get(last) || []) if (!seen.has(e.to)) { seen.add(e.to); q.push([...p, e.to]); } }
  return [from];
}

// ─────────────────────────────── correlation ───────────────────────────────
export function suppressionFor(alarm, changes, resources, now) {
  const rid = alarm["Resource ID"]; if (!rid) return null;
  const parent = resources.get(rid)?.["Parent Resource ID"] || "";
  for (const c of changes) {
    if (!["In Progress", "Scheduled", "Approved"].includes(c.State) || c["Suppress Alarms"] !== "Yes") continue;
    const ws = t(c["Window Start"]), we = t(c["Window End"]), at = t(alarm["First Occurred At"]);
    if (isNaN(ws) || isNaN(we) || at < ws || at > we || now > we + 30 * MIN) continue;
    const scope = String(c["Affected Resource IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (scope.includes(rid) || (parent && scope.includes(parent))) return c["Change ID"];
  }
  return null;
}

/**
 * alarms: active normalized alarms (values objects). resources: Map id → resource values.
 * openGroups: [{ group values, root }] existing open groups — new alarms explained by an open group's root join it (late/out-of-order arrivals).
 * Returns { suppressed:[{alarmId, changeId}], joins:[{groupId, alarms}], groups:[{root, alarms:[{id, role}], confidence, basis, candidates, firstAt, lastAt}], independent:[alarmId] }
 */
export function correlate({ alarms, graph, changes = [], resources = new Map(), openGroups = [], now = Date.now(), minGroup = 2 }) {
  const out = { suppressed: [], joins: [], groups: [], independent: [] };
  let pool = [];
  for (const a of alarms) {
    if (a.State !== "Active") continue;
    const chg = suppressionFor(a, changes, resources, now);
    if (chg) { if (a["Correlation Role"] !== "Suppressed") out.suppressed.push({ alarmId: a["Alarm ID"], changeId: chg }); continue; }
    if (a["Correlation Group ID"]) continue;           // already correlated
    pool.push(a);
  }
  const subj = (a) => [a["Resource ID"], a["Related Resource ID"]].filter(Boolean);
  // 1) late arrivals join an open group whose root explains them (same rules as the root cover below)
  for (const g of openGroups) {
    const d = downstream(graph, g.root, new Set([g.root]));
    const hit = pool.filter((a) => explainsExtra(a, g.root, d, graph) || subj(a).some((s) => d.has(s)));
    if (hit.length) { out.joins.push({ groupId: g.groupId, incidentId: g.incidentId, root: g.root, alarms: hit.map((a) => ({ id: a["Alarm ID"], role: roleFor(a, g.root, graph) })) }); pool = pool.filter((a) => !hit.includes(a)); }
  }
  // 2) minimal root cover over the remaining pool
  const unmatched = pool.filter((a) => !a["Resource ID"]);
  pool = pool.filter((a) => a["Resource ID"]);
  const downCache = new Map();
  const D = (c) => downCache.get(c) || downCache.set(c, downstream(graph, c, new Set([c]))).get(c);
  while (pool.length) {
    const cands = new Set();
    for (const a of pool) for (const s of subj(a)) { cands.add(s); for (const u of upstream(graph, s)) cands.add(u); }
    const scored = [...cands].map((c) => {
      const d = D(c); const ex = pool.filter((a) => subj(a).some((s) => d.has(s)));
      return { c, ex, n: ex.length, depth: d.size };
    }).filter((x) => x.n > 0);
    // most alarms explained; tie → smallest downstream (most specific explanation)
    scored.sort((x, y) => y.n - x.n || x.depth - y.depth || x.c.localeCompare(y.c));
    const best = scored[0];
    if (!best || best.n < minGroup) break;
    const dRoot = D(best.c);
    for (const a of pool) if (!best.ex.includes(a) && explainsExtra(a, best.c, dRoot, graph)) best.ex.push(a);
    best.n = best.ex.length;
    const ev = evidenceFor(best.c, best.ex, graph, resources, pool.length);
    out.groups.push({
      root: best.c, alarms: best.ex.map((a) => ({ id: a["Alarm ID"], role: roleFor(a, best.c, graph) })),
      confidence: ev.confidence, basis: ev.basis, hypothesis: ev.hypothesis,
      candidates: scored.slice(0, 5).map((x) => ({ resource: x.c, explains: x.n, downstreamSize: x.depth })),
      firstAt: best.ex.map((a) => a["First Occurred At"]).sort()[0], lastAt: best.ex.map((a) => a["Last Occurred At"]).sort().pop(),
      resourceCount: new Set(best.ex.map((a) => a["Resource ID"])).size,
    });
    pool = pool.filter((a) => !best.ex.includes(a));
  }
  out.independent = [...pool, ...unmatched].map((a) => a["Alarm ID"]);
  return out;
}
/**
 * Explanations beyond plain downstream reachability:
 *  - protection events (APS / microwave switchover) on a resource whose dependents are left AT RISK by the root failing
 *    (the protect path took over because of it);
 *  - poor source data: an alarm only matchable to a chassis/NE (parent fallback) whose own components (part_of children)
 *    are downstream of the root — e.g. an OSC LOS whose AID is not in inventory.
 */
const riskCache = new WeakMap();
function explainsExtra(a, root, dRoot, graph) {
  const rid = a["Resource ID"]; if (!rid) return false;
  if (PROTECTION_TYPES.has(a["Alarm Type"])) {
    let m = riskCache.get(graph); if (!m) riskCache.set(graph, (m = new Map()));
    if (!m.has(root)) m.set(root, new Set([...propagate(graph, new Set([root]))].filter(([, st]) => st === "at-risk").map(([id]) => id)));
    if ([...downstream(graph, rid)].some((x) => m.get(root).has(x))) return true;
  }
  if (/matched at parent/.test(a["Normalization Notes"] || "") && (graph.rdeps.get(rid) || []).some((e) => e.type === "part_of" && dRoot.has(e.from))) return true;
  return false;
}
function roleFor(a, root, graph) {
  const rid = a["Resource ID"];
  if (rid === root) return "Root Evidence";
  const isTerm = (graph.deps.get(rid) || []).some((e) => e.to === root && e.type === "terminates_on");
  return isTerm && TERM_LOS.has(a["Alarm Type"]) ? "Root Evidence" : "Symptom";
}
function evidenceFor(root, ex, graph, resources, poolSize) {
  const r = resources.get(root) || {}; const type = r["Resource Type"] || "resource";
  const direct = ex.filter((a) => a["Resource ID"] === root && SA_TYPES.has(a["Alarm Type"]));
  const termPorts = (graph.rdeps.get(root) || []).filter((e) => e.type === "terminates_on").map((e) => e.from);
  const losEnds = new Set(ex.filter((a) => termPorts.includes(a["Resource ID"]) && TERM_LOS.has(a["Alarm Type"])).map((a) => a["Resource ID"]));
  const coverage = ex.length / Math.max(poolSize, 1);
  const basis = [];
  let conf, hypothesis;
  if (direct.length) { conf = 0.95; basis.push(`${direct.length} service-affecting alarm(s) raised directly on ${root}`); hypothesis = `${type} ${root} failed (reported directly by the element).`; }
  else if (termPorts.length >= 2 && losEnds.size >= 2) {
    const ts = ex.filter((a) => losEnds.has(a["Resource ID"])).map((a) => t(a["First Occurred At"])); const spread = Math.round((Math.max(...ts) - Math.min(...ts)) / 1000);
    conf = spread <= 10 ? 0.92 : 0.8; hypothesis = `Physical break on ${type.toLowerCase()} ${root}: both terminating ends lost light within ${spread}s — consistent with a fiber cut, not an equipment fault.`;
    basis.push(`LOS on both terminating ports (${[...losEnds].join(", ")}) within ${spread}s`);
  } else if (losEnds.size === 1) { conf = 0.6; hypothesis = `Loss of signal at one end of ${root} — could be the span, an amplifier or the receiving card.`; basis.push(`LOS on only one terminating port (${[...losEnds][0]})`); }
  else { conf = 0.55; hypothesis = `${root} is the smallest common upstream dependency of the alarmed resources.`; basis.push("common upstream dependency (no direct or terminating evidence)"); }
  const ownRes = new Set(ex.map((a) => a["Resource ID"]));
  basis.push(`explains ${ex.length} of ${poolSize} active uncorrelated alarms (${Math.round(coverage * 100)}%) across ${ownRes.size} resources`);
  const lowConfEdges = [...downstream(graph, root)].flatMap((x) => (graph.deps.get(x) || [])).filter((e) => e.conf < 0.9 || e.disputed);
  if (lowConfEdges.length) { conf -= 0.03; basis.push(`${lowConfEdges.length} topology edge(s) below 0.9 confidence or disputed`); }
  return { confidence: Math.round(Math.max(0.3, Math.min(0.97, conf)) * 100) / 100, basis, hypothesis };
}

// ─────────────────────────────── impact ───────────────────────────────
const failingMetric = (m) => (m.Metric === "packet_loss_pct" && Number(m.Value) >= 50) || (m.Metric === "availability_pct" && Number(m.Value) < 50);
const healthyMetric = (m) => (m.Metric === "packet_loss_pct" && Number(m.Value) <= 0.5) || (m.Metric === "availability_pct" && Number(m.Value) >= 99) || (m.Metric === "latency_ms" && Number(m.Value) <= 25);

/**
 * Inputs are arrays of values objects. `alarms` = alarms in scope (active SA alarms are evidence).
 * Returns { rows:[impact rows], summary, states(Map) } — rows are per (service × active subscription), or per service when no subscriber.
 */
export function assessImpact({ root, graph, services, subscriptions, customers, slas, alarms, metrics, conflicts = [], resources = new Map(), startedAt, now = Date.now() }) {
  const state = propagate(graph, new Set([root]));
  const at = t(startedAt);
  const activeSA = new Map();
  for (const a of alarms) if (a.State === "Active" && (SA_TYPES.has(a["Alarm Type"]) || a["Service Affecting"] === "Yes") && a["Resource ID"]) (activeSA.get(a["Resource ID"]) || activeSA.set(a["Resource ID"], []).get(a["Resource ID"])).push(a);
  const latest = new Map(); // subject|metric → newest obs since incident start
  for (const m of metrics) { if (t(m["Observed At"]) < at - 2 * MIN) continue; const k = `${m["Subject ID"]}|${m.Metric}`; const cur = latest.get(k); if (!cur || t(m["Observed At"]) > t(cur["Observed At"])) latest.set(k, m); }
  const custById = new Map(customers.map((c) => [c["Account ID"], c]));
  const slaById = new Map(slas.map((s) => [s["SLA ID"], s]));
  const openConf = conflicts.filter((c) => c.State === "Open");
  const rows = [];
  const roots = new Set([root]);
  for (const s of services) {
    const sid = s["Service Instance ID"]; const st = state.get(sid); if (!st) continue;
    const direct = (graph.deps.get(sid) || []).map((e) => e.to);
    const evidenceRes = new Set(direct); for (const d of direct) for (const e of graph.rdeps.get(d) || []) if (e.type === "part_of") evidenceRes.add(e.from);
    const alarmEv = [...evidenceRes].flatMap((r) => activeSA.get(r) || []);
    const mets = ["packet_loss_pct", "availability_pct", "latency_ms"].map((m) => latest.get(`${sid}|${m}`)).filter(Boolean);
    const failing = mets.filter(failingMetric), healthy = mets.filter(healthyMetric);
    const p = pathToRoot(graph, sid, roots);
    const touches = new Set([...p, ...direct, ...evidenceRes]);
    const conflictHits = openConf.filter((c) => touches.has(c["Entity ID"]));
    let cls, basis = [], conf;
    if (st === "down") {
      if (alarmEv.length || failing.length) {
        cls = "Confirmed"; conf = 0.95;
        if (alarmEv.length) basis.push(`${alarmEv.length} service-affecting alarm(s) on the service's own resources (${[...new Set(alarmEv.map((a) => a["Alarm Type"]))].join(", ")})`);
        if (failing.length) basis.push(failing.map((m) => `${m.Metric}=${m.Value}${m.Unit} at ${m["Observed At"]} (${m["Source System"]})`).join("; "));
      } else if (healthy.length && !failing.length) {
        cls = "Potential"; conf = 0.5; basis.push(`topology says down, but a fresh measurement is healthy (${healthy.map((m) => `${m.Metric}=${m.Value}${m.Unit}`).join(", ")}) — possible inventory error`);
      } else { cls = "Inferred"; conf = 0.8; basis.push(`no working path: every dependency path to ${root} is down; service is ${s.Monitoring === "None" ? "unmonitored" : "monitored but silent"} — no direct evidence`); }
    } else {
      cls = "Potential"; conf = 0.7; basis.push("redundancy degraded — running on a single path (at risk if the remaining path fails)");
      if (failing.length) { cls = "Confirmed"; conf = 0.85; basis.push(`but measurement is failing: ${failing.map((m) => `${m.Metric}=${m.Value}${m.Unit}`).join(", ")}`); }
    }
    for (const c of conflictHits) { conf -= 0.1; basis.push(`inventory conflict ${c["Conflict ID"]}: ${c["Source A"]} says ${c["Value A"]}, ${c["Source B"]} says ${c["Value B"]} (policy value ${c["Policy Value"]})`); }
    basis.push(`path: ${p.join(" → ")}`);
    const subs = subscriptions.filter((x) => x["Service Instance ID"] === sid && x.Status === "Active" && (isNaN(t(x["Valid From"])) || t(x["Valid From"]) <= at) && (isNaN(t(x["Valid To"])) || t(x["Valid To"]) > at));
    const mk = (sub) => {
      const cust = sub ? custById.get(sub["Account ID"]) : null; const sla = sub ? slaById.get(sub["SLA ID"]) : null;
      const exposure = cls === "Potential" ? { usd: 0, breachAt: null, minutes: 0 } : slaExposure(sla, Number(sub?.["Monthly Recurring Charge"] || 0), at, now);
      return { serviceId: sid, serviceName: s.Name, offering: s["Offering ID"], subscriptionId: sub?.["Subscription ID"] || "", accountId: cust?.["Account ID"] || "", accountName: cust?.Name || "",
        segment: cust?.Segment || "", tier: cust?.Tier || "", publicSafety: cust?.["Public Safety"] === "Yes" || s["Offering ID"] === "OFF-PSAP", subscriberCount: Number(sub?.["Subscriber Count"] || 0),
        slaId: sla?.["SLA ID"] || "", cls, confidence: Math.round(Math.max(0.2, conf) * 100) / 100, basis: basis.join(" | "), path: p, state: st,
        minutes: exposure.minutes, exposureUsd: exposure.usd, breachAt: exposure.breachAt, evidenceAlarms: alarmEv.map((a) => a["Alarm ID"]).slice(0, 10), evidenceMetrics: [...failing, ...healthy].map((m) => m["Observation ID"]) };
    };
    if (subs.length) subs.forEach((sub) => rows.push(mk(sub))); else rows.push(mk(null));
  }
  return { rows, summary: summarize(rows), states: state };
}
export function slaExposure(sla, mrc, startMs, now) {
  if (!sla) return { usd: 0, breachAt: null, minutes: Math.max(0, Math.round((now - startMs) / MIN)) };
  const minutes = Math.max(0, (now - startMs) / MIN);
  const allowed = (1 - Number(sla["Availability Target Pct"]) / 100) * 30 * 24 * 60;
  const overHours = Math.max(0, Math.ceil((minutes - allowed) / 60));
  const credit = Math.min(overHours * Number(sla["Credit Pct Per Hour"] || 0), Number(sla["Credit Cap Pct"] || 0)) / 100 * mrc;
  const mttrAt = startMs + Number(sla["MTTR Target Hours"] || 0) * 3600000;
  const availAt = startMs + allowed * MIN;
  return { usd: Math.round(credit * 100) / 100, minutes: Math.round(minutes), breachAt: new Date(Math.min(mttrAt, availAt)).toISOString(), allowedMinutes: Math.round(allowed * 10) / 10 };
}
export function summarize(rows) {
  const svc = (c) => new Set(rows.filter((r) => r.cls === c).map((r) => r.serviceId)).size;
  const hard = rows.filter((r) => r.cls !== "Potential");
  return {
    confirmed: svc("Confirmed"), inferred: svc("Inferred"), potential: svc("Potential"),
    services: new Set(rows.map((r) => r.serviceId)).size,
    customers: new Set(hard.filter((r) => r.accountId).map((r) => r.accountId)).size,
    customersAtRisk: new Set(rows.filter((r) => r.cls === "Potential" && r.accountId).map((r) => r.accountId)).size,
    subscribers: hard.reduce((s, r) => s + (r.segment === "Consumer Segment" ? r.subscriberCount : 0), 0),
    publicSafety: new Set(hard.filter((r) => r.publicSafety).map((r) => r.accountId)).size,
    publicSafetyAtRisk: new Set(rows.filter((r) => r.publicSafety && r.cls === "Potential").map((r) => r.accountId)).size,
    slaExposureUsd: Math.round(hard.reduce((s, r) => s + r.exposureUsd, 0)),
  };
}
export function prioritize(sum) {
  if (sum.publicSafety > 0 || sum.subscribers >= 10000 || sum.customers >= 5) return { priority: "P1", reason: sum.publicSafety ? "public-safety service impacted" : sum.subscribers >= 10000 ? `${sum.subscribers.toLocaleString()} consumer subscribers impacted` : `${sum.customers} customer accounts impacted` };
  if (sum.confirmed + sum.inferred > 0) return { priority: "P2", reason: `${sum.confirmed + sum.inferred} services down` };
  if (sum.potential > 0 || sum.publicSafetyAtRisk > 0) return { priority: "P3", reason: "redundancy degraded, no outage" };
  return { priority: "P4", reason: "no service impact identified" };
}
export const shouldOpenIncident = (group, alarmsById) => group.alarms.some(({ id }) => { const a = alarmsById.get(id); return a && (a["Service Affecting"] === "Yes" || a.Severity === "Critical"); });

// ─────────────────────────────── verification ───────────────────────────────
/**
 * impacts: impact rows (values objects). groupAlarms: all alarms in the correlation group (any state).
 * serviceAlarms: Map serviceId → alarms on its evidence resources. metrics: observations. freshMinutes: max age of a verifying sample.
 */
export function verifyRecovery({ impacts, groupAlarms, serviceAlarms, metrics, services, now = Date.now(), freshMinutes = 20, manualConfirmations = new Map() }) {
  const saGroup = groupAlarms.filter((a) => SA_TYPES.has(a["Alarm Type"]) || a["Service Affecting"] === "Yes");
  const stillActive = saGroup.filter((a) => a.State === "Active");
  const rootEv = groupAlarms.filter((a) => a["Correlation Role"] === "Root Evidence");
  const rootCleared = rootEv.length > 0 && rootEv.every((a) => a.State === "Cleared");
  const networkRecoveredAt = rootCleared ? rootEv.map((a) => a["Cleared At"]).sort().pop() : null;
  const svcById = new Map(services.map((s) => [s["Service Instance ID"], s]));
  const per = new Map();
  for (const imp of impacts) {
    const sid = imp["Service Instance ID"]; if (per.has(sid)) continue;
    const s = svcById.get(sid) || {}; const checks = []; let st;
    const act = (serviceAlarms.get(sid) || []).filter((a) => a.State === "Active" && (SA_TYPES.has(a["Alarm Type"]) || a["Service Affecting"] === "Yes"));
    if (!networkRecoveredAt) { st = "Impacted"; checks.push("network not yet recovered (root evidence alarms still active)"); }
    else if (act.length) { st = "Verification Failed"; checks.push(`${act.length} service-affecting alarm(s) still active: ${[...new Set(act.map((a) => `${a["Alarm Type"]}@${a["Resource ID"]}`))].slice(0, 4).join(", ")}`); }
    else {
      // latest sample per metric taken after network recovery (an early failing sample is superseded by a later healthy one)
      const latestBy = new Map();
      for (const m of metrics) { if (m["Subject ID"] !== sid || t(m["Observed At"]) < t(networkRecoveredAt) - 60000 || now - t(m["Observed At"]) > freshMinutes * MIN) continue;
        const cur = latestBy.get(m.Metric); if (!cur || t(m["Observed At"]) > t(cur["Observed At"])) latestBy.set(m.Metric, m); }
      const after = [...latestBy.values()];
      const bad = after.filter(failingMetric), good = after.filter(healthyMetric);
      const clearedOwn = (serviceAlarms.get(sid) || []).filter((a) => a.State === "Cleared" && (SA_TYPES.has(a["Alarm Type"]) || a["Service Affecting"] === "Yes") && t(a["Cleared At"]) >= t(networkRecoveredAt) - 60000);
      if (bad.length) { st = "Verification Failed"; checks.push(`post-restore measurement failing: ${bad.map((m) => `${m.Metric}=${m.Value}${m.Unit} @ ${m["Observed At"]}`).join(", ")}`); }
      else if (good.length) { st = "Service Verified"; checks.push(`fresh healthy measurement after network recovery: ${good.map((m) => `${m.Metric}=${m.Value}${m.Unit} @ ${m["Observed At"]} (${m["Source System"]})`).join(", ")}`); }
      else if (manualConfirmations.get(sid)) { st = "Service Verified"; checks.push(`customer/field confirmation: ${manualConfirmations.get(sid)}`); }
      else if (clearedOwn.length) { st = "Service Verified"; checks.push(`service-level alarm(s) observed clearing after network recovery: ${[...new Set(clearedOwn.map((a) => `${a["Alarm Type"]}@${a["Resource ID"]} ${a["Cleared At"]}`))].slice(0, 3).join(", ")}`); }
      else if (imp["Impact Class"] === "Potential") { st = "Service Verified"; checks.push("no outage occurred; redundancy restored (no active alarms on path)"); }
      else { st = "Network Restored"; checks.push(s.Monitoring === "None" ? "unmonitored service: no probe, no service-level alarms — needs customer or field confirmation" : "no fresh post-restore measurement yet"); }
    }
    per.set(sid, { serviceId: sid, state: st, checks, verifiedAt: st === "Service Verified" ? new Date(now).toISOString() : "" });
  }
  const states = [...per.values()].map((x) => x.state);
  const overall = !networkRecoveredAt ? "Pending" : states.every((s) => s === "Service Verified") ? "Passed" : states.some((s) => s === "Verification Failed") ? "Failed" : "Partial";
  return { networkRecoveredAt, stillActiveSA: stillActive.length, overall, services: [...per.values()] };
}
