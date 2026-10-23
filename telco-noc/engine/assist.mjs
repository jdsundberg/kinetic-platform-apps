/**
 * engine/assist.mjs — grounded assistant (generator "rules/v1": deterministic, template-driven over records).
 *
 * Contract for EVERY output (the same contract an LLM generator must satisfy — see docs/ai.md):
 *   facts[]       — statements copied from records, each with citations [{form, id, at}]
 *   inferences[]  — hypotheses with confidence 0..1 and the citations they rest on
 *   requiresApproval — the action the operator must explicitly approve (dispatch | send-comms | close | config-change | none)
 * checkCitations() rejects any output that cites a record the requesting user cannot see.
 * Customer drafts never include internal identifiers, root-cause speculation or other customers' names.
 */
const cite = (form, id, at) => ({ form, id, at: at || "" });
const fmtMin = (ms) => { const m = Math.round(ms / 60000); return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

export function evidencePack({ inc, group, alarms, impacts, updates, workOrders, history, runbooks, changes, resources }) {
  return { inc, group, alarms, impacts, updates, workOrders, history, runbooks, changes, resources };
}

export function generate(kind, P, now = Date.now(), opts = {}) {
  const { inc, group } = P;
  const I = cite("incidents", inc["Incident ID"], inc._updatedAt);
  const G = group ? cite("correlation-groups", group["Group ID"], group._createdAt) : null;
  const sum = safeJson(inc["Impact Summary"]) || {};
  const rootEv = P.alarms.filter((a) => a["Correlation Role"] === "Root Evidence");
  const active = P.alarms.filter((a) => a.State === "Active");
  const hard = P.impacts.filter((i) => i["Impact Class"] !== "Potential");
  const ps = [...new Set(P.impacts.filter((i) => i["Public Safety"] === "Yes").map((i) => i["Account Name"]))];
  const recur = P.history.filter((h) => h["Root Resource ID"] === inc["Root Resource ID"] && h["Incident ID"] !== inc["Incident ID"]);
  const out = { kind, facts: [], inferences: [], requiresApproval: "none", content: "" };
  const F = (text, ...c) => out.facts.push({ text, citations: c.filter(Boolean) });
  const N = (text, confidence, ...c) => out.inferences.push({ text, confidence, citations: c.filter(Boolean) });

  if (kind === "Summary") {
    F(`${inc["Incident ID"]} detected ${inc["Detected At"]}; state ${inc.State}, priority ${inc.Priority}, owner ${inc.Owner || "unassigned"} (${inc["Owner Team ID"]}).`, I);
    if (group) F(`${group["Alarm Count"]} normalized alarms across ${group["Resource Count"]} resources were correlated to root resource ${group["Root Resource ID"]}.`, G);
    for (const a of rootEv.slice(0, 3)) F(`${a["Alarm Type"]} on ${a["Resource ID"]} first at ${a["First Occurred At"]} (${a.State}).`, cite("alarms", a["Alarm ID"], a["First Occurred At"]));
    F(`Impact: ${sum.confirmed ?? "?"} confirmed, ${sum.inferred ?? "?"} inferred, ${sum.potential ?? "?"} potential services; ${sum.customers ?? "?"} customer accounts; ${(sum.subscribers || 0).toLocaleString()} consumer subscribers.`, I,
      ...hard.slice(0, 3).map((i) => cite("impacts", i["Impact ID"], i._updatedAt)));
    if (ps.length) F(`Public-safety accounts involved: ${ps.join(", ")}.`, ...P.impacts.filter((i) => i["Public Safety"] === "Yes").slice(0, 3).map((i) => cite("impacts", i["Impact ID"], i._updatedAt)));
    const wo = P.workOrders[0]; if (wo) F(`Work order ${wo["Work Order ID"]} is ${wo.State}${wo["Assigned Tech"] ? " (" + wo["Assigned Tech"] + ")" : ""}${wo.ETA ? ", ETA " + wo.ETA : ""}.`, cite("work-orders", wo["Work Order ID"], wo._updatedAt));
    F(`Recovery verification: ${inc["Verification State"]}; ${active.length} alarms in the incident still active.`, I);
    if (group) N(group ? JSON.parse(group.Evidence || "{}").hypothesis || inc["Probable Cause"] : inc["Probable Cause"], Number(group?.["Root Confidence"] || inc["Probable Cause Confidence"] || 0.5), G, ...rootEv.slice(0, 2).map((a) => cite("alarms", a["Alarm ID"], a["First Occurred At"])));
    if (recur.length) N(`This root has failed ${recur.length} time(s) before (${recur.map((h) => h["Incident ID"]).join(", ")}) — likely a recurring problem.`, 0.8, ...recur.map((h) => cite("incidents", h["Incident ID"], h["Closed At"])));
    out.content = [`${inc.Priority} ${inc.Title}.`, `Elapsed ${fmtMin(now - Date.parse(inc["Detected At"]))}. Root: ${inc["Root Resource ID"]}${inc["Observed Root Cause"] ? " — CONFIRMED: " + inc["Observed Root Cause"] : " (probable, not yet confirmed)"}.`,
      `Impact ${sum.confirmed ?? 0}/${sum.inferred ?? 0}/${sum.potential ?? 0} (confirmed/inferred/potential), ${sum.customers ?? 0} customers${ps.length ? ", incl. public safety" : ""}.`, `Verification: ${inc["Verification State"]}.`].join(" ");
  }

  if (kind === "Hypothesis") {
    const ev = group ? safeJson(group.Evidence) || {} : {};
    N(ev.hypothesis || inc["Probable Cause"], Number(group?.["Root Confidence"] || 0.5), G, ...rootEv.map((a) => cite("alarms", a["Alarm ID"], a["First Occurred At"])));
    for (const c of (ev.candidates || []).slice(1, 3)) N(`Alternative: ${c.resource} (explains ${c.explains} alarms) — less likely because the fiber span explains more with a smaller blast radius.`, 0.1, G);
    const chg = P.changes.filter((c) => ["In Progress", "Completed"].includes(c.State) && String(c["Affected Resource IDs"]).includes(inc["Root Resource ID"]));
    for (const c of chg) N(`Change ${c["Change ID"]} ("${c.Title}") touched this resource — rule out as a cause.`, 0.3, cite("changes", c["Change ID"], c["Window Start"]));
    if (!chg.length) F(`No in-progress change touches ${inc["Root Resource ID"]}.`, ...P.changes.slice(0, 1).map((c) => cite("changes", c["Change ID"], c._updatedAt)));
    if (recur.length) F(`Prior confirmed causes on this root: ${recur.map((h) => `${h["Incident ID"]}: ${h["Observed Root Cause"]}`).join("; ")}.`, ...recur.map((h) => cite("incidents", h["Incident ID"], h["Closed At"])));
    out.content = out.inferences.map((x) => `• (${Math.round(x.confidence * 100)}%) ${x.text}`).join("\n");
  }

  if (kind === "Next Step" || kind === "Runbook") {
    const rt = P.resources.get(inc["Root Resource ID"])?.["Resource Type"];
    const rbs = P.runbooks.filter((r) => String(r["Applies To Resource Types"]).split(",").includes(rt) || rootEv.some((a) => String(r["Applies To Alarm Types"]).split(",").includes(a["Alarm Type"])));
    const rb = rbs[0];
    if (rb) {
      const steps = safeJson(rb.Steps) || []; const approvals = String(rb["Requires Approval Steps"] || "").split(",").map(Number);
      F(`Runbook ${rb["Runbook ID"]} v${rb.Version} matches resource type ${rt}.`, cite("runbooks", rb["Runbook ID"], rb._updatedAt), I);
      const done = P.workOrders.length > 0;
      const next = steps.filter((s) => !(done && s.n <= 4)).slice(0, kind === "Runbook" ? 8 : 3);
      out.content = next.map((s) => `${s.n}. ${s.text}${approvals.includes(s.n) ? "  ⚠ requires explicit approval" : ""}`).join("\n");
      N(done ? "Dispatch already done; focus on protection status, comms and post-splice verification." : "Dispatch has not happened yet — the break location (OTDR) and crew dispatch are the critical path.", 0.75, I, ...P.workOrders.slice(0, 1).map((w) => cite("work-orders", w["Work Order ID"], w._updatedAt)));
      out.requiresApproval = !done ? "dispatch" : next.some((s) => approvals.includes(s.n)) ? "config-change" : "none";
    } else { out.content = "No runbook matches this resource type; follow the generic triage checklist."; F(`No runbook for ${rt}.`, I); }
  }

  if (kind === "Customer Draft") {
    const services = [...new Set(hard.map((i) => i["Segment"] === "Consumer Segment" ? "mobile service" : "business connectivity"))];
    const areas = "the East Metro / St Paul area";
    const seq = opts.sequence || (inc["Service Recovered At"] ? "Resolution" : (P.updates.some((u) => u["Update Type"] === "Comms") ? "Update" : "Initial"));
    const eta = P.workOrders.find((w) => w.ETA)?.ETA;
    out.sequence = seq;
    out.subject = seq === "Resolution" ? "Resolved: service disruption in the St Paul East Metro area" : "Service disruption in the St Paul East Metro area";
    out.content = seq === "Resolution"
      ? `Service has been restored and verified for affected ${services.join(" and ")} customers in ${areas}. The disruption began at ${hhmm(inc["Detected At"])} UTC and service was confirmed restored at ${hhmm(inc["Service Recovered At"] || new Date(now).toISOString())} UTC. We apologise for the disruption; eligible customers will receive SLA credits automatically.`
      : `We are aware of a disruption affecting some ${services.join(" and ")} customers in ${areas} since ${hhmm(inc["Detected At"])} UTC. The cause has been located on our fiber network and repair crews are ${P.workOrders.some((w) => ["On Site", "Work Complete"].includes(w.State)) ? "on site" : "dispatched"}${eta ? ` (estimated arrival ${hhmm(eta)} UTC)` : ""}. Our next update will be within 60 minutes.`;
    F(`${hard.length} impacted subscriptions across ${new Set(hard.map((i) => i["Account ID"])).size} accounts form the audience.`, ...hard.slice(0, 4).map((i) => cite("impacts", i["Impact ID"], i._updatedAt)));
    F(`Detected ${inc["Detected At"]}.`, I);
    if (eta) F(`Crew ETA ${eta}.`, cite("work-orders", P.workOrders.find((w) => w.ETA)["Work Order ID"], P.workOrders.find((w) => w.ETA)._updatedAt));
    N("Wording avoids naming the root resource or speculating on cause beyond 'located on our fiber network' (customer-safe).", 0.9, I);
    out.requiresApproval = "send-comms";
  }

  if (kind === "Recurrence") {
    if (recur.length) {
      F(`${recur.length + 1} incidents on ${inc["Root Resource ID"]} in the last 120 days.`, I, ...recur.map((h) => cite("incidents", h["Incident ID"], h["Detected At"])));
      N(`Open or link a problem record: the span sits in a construction-heavy corridor and AGG-STP-01 has no diverse uplink, so every event on this span becomes a P1.`, 0.8, I, ...recur.map((h) => cite("incidents", h["Incident ID"], h["Closed At"])));
      out.content = `Recurring failure: ${recur.length} prior incident(s) on this root (${recur.map((h) => h["Incident ID"] + " — " + h["Observed Root Cause"]).join("; ")}). Recommend problem management review + diverse uplink for AGG-STP-01.`;
    } else { out.content = "No prior incidents on this root resource in history."; F("No matching history.", I); }
  }
  out.confidence = out.inferences.length ? Math.round((out.inferences.reduce((s, x) => s + x.confidence, 0) / out.inferences.length) * 100) / 100 : 1;
  out.citations = dedupe([...out.facts, ...out.inferences].flatMap((x) => x.citations));
  return out;
}
const hhmm = (iso) => (iso ? iso.slice(11, 16) : "—");
const dedupe = (cs) => [...new Map(cs.map((c) => [c.form + "|" + c.id, c])).values()];
export function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

/** Every citation must resolve to a record in `visible` (records fetched with the requesting user's identity). */
export function checkCitations(out, visible) {
  const missing = out.citations.filter((c) => !visible.has(`${c.form}|${c.id}`));
  const uncited = out.facts.filter((f) => !f.citations.length);
  return { ok: !missing.length && !uncited.length, missing, uncited: uncited.map((f) => f.text) };
}

/** Natural-language questions over authorized data — an intent matcher (NOT an LLM), answering from records with citations. */
export function answer(question, ctx) {
  const qn = question.toLowerCase();
  const inc = ctx.incident; const cites = [];
  const m = (re) => re.test(qn);
  if (!inc && !m(/customer|account/)) return { answer: "Open an incident (or name one) to ask about it.", citations: [] };
  if (m(/(which|what|how many) (customers|accounts)|who is (affected|impacted)/)) {
    const hard = ctx.impacts.filter((i) => i["Impact Class"] !== "Potential" && i["Account Name"]);
    const byAcct = [...new Map(hard.map((i) => [i["Account ID"], i])).values()];
    byAcct.slice(0, 20).forEach((i) => cites.push(cite("impacts", i["Impact ID"], i._updatedAt)));
    return { answer: `${byAcct.length} accounts are confirmed or inferred impacted: ${byAcct.map((i) => `${i["Account Name"]} (${i["Impact Class"]}${i["Public Safety"] === "Yes" ? ", PUBLIC SAFETY" : ""})`).join("; ")}.`, citations: cites, intent: "affected-customers" };
  }
  if (m(/what (failed|broke|is the (root|cause))|root cause|why/)) {
    cites.push(cite("incidents", inc["Incident ID"], inc._updatedAt)); if (ctx.group) cites.push(cite("correlation-groups", ctx.group["Group ID"], ctx.group._createdAt));
    return { answer: `${inc["Observed Root Cause"] ? "Confirmed: " + inc["Observed Root Cause"] : "Probable (not confirmed): " + inc["Probable Cause"]} Root resource ${inc["Root Resource ID"]} (confidence ${inc["Probable Cause Confidence"]}).`, citations: cites, intent: "root-cause" };
  }
  if (m(/sla|credit|exposure|breach/)) {
    const top = [...ctx.impacts].filter((i) => Number(i["SLA Exposure USD"]) > 0 || i["SLA Breach At"]).sort((a, b) => Number(b["SLA Exposure USD"]) - Number(a["SLA Exposure USD"])).slice(0, 6);
    top.forEach((i) => cites.push(cite("impacts", i["Impact ID"], i._updatedAt)));
    return { answer: `Total SLA exposure $${Number(inc["SLA Exposure USD"] || 0).toLocaleString()}. Earliest breach: ${top.map((i) => i["SLA Breach At"]).filter(Boolean).sort()[0] || "none computed"}. Largest: ${top.map((i) => `${i["Account Name"] || i["Service Instance ID"]} $${i["SLA Exposure USD"]}`).join(", ") || "none"}.`, citations: cites, intent: "sla" };
  }
  if (m(/recover|restored|back up|verified/)) {
    cites.push(cite("incidents", inc["Incident ID"], inc._updatedAt));
    const bad = ctx.impacts.filter((i) => i["Recovery State"] !== "Service Verified"); bad.slice(0, 10).forEach((i) => cites.push(cite("impacts", i["Impact ID"], i._updatedAt)));
    return { answer: `Network recovered: ${inc["Network Recovered At"] || "no"}. Customer service verification: ${inc["Verification State"]}. Not yet verified: ${[...new Set(bad.map((i) => `${i["Service Instance ID"]} (${i["Recovery State"]})`))].join(", ") || "none"}.`, citations: cites, intent: "recovery" };
  }
  if (m(/who (owns|is working|is assigned)|owner|assigned/)) {
    cites.push(cite("incidents", inc["Incident ID"], inc._updatedAt));
    return { answer: `Owner ${inc.Owner || "unassigned"} (${inc["Owner Team ID"]}); escalation level ${inc["Escalation Level"] || 0}; major incident ${inc["Major Incident"]}.`, citations: cites, intent: "owner" };
  }
  if (m(/public safety|911|psap/)) {
    const ps = ctx.impacts.filter((i) => i["Public Safety"] === "Yes"); ps.forEach((i) => cites.push(cite("impacts", i["Impact ID"], i._updatedAt)));
    return { answer: ps.length ? ps.map((i) => `${i["Account Name"]}: ${i["Service Instance ID"]} — ${i["Impact Class"]}, ${i["Recovery State"]}`).join("; ") : "No public-safety services in the impact set.", citations: cites, intent: "public-safety" };
  }
  return { answer: "I can answer: which customers are affected · what failed / root cause · SLA exposure · has service recovered · who owns it · public safety impact.", citations: [], intent: "unknown" };
}
