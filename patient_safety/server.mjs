/**
 * Patient Safety — Custom API Handler
 */

export const appId = "patient-safety";
export const apiPrefix = "/api/psafe";
export const kapp = "patient-safety";

// ─── App-specific helpers ──────────────────────────────────────────────────

const vf = (s, f) => s.values?.[f] || "";
function nowISO() { return new Date().toISOString(); }
const EVENT_TRANSITIONS = {
  "New": ["Under Review", "Void"],
  "Under Review": ["Investigation Ordered", "Closed", "Void"],
  "Investigation Ordered": ["Under Review", "Closed"],
  "Closed": ["Under Review"],
};
const INVESTIGATION_TRANSITIONS = {
  "Initiated": ["In Progress"],
  "In Progress": ["Findings Pending", "Initiated"],
  "Findings Pending": ["Complete", "In Progress"],
  "Complete": ["Closed"],
};
const CAPA_TRANSITIONS = {
  "Open": ["In Progress", "Cancelled"],
  "In Progress": ["Completed", "Open", "Overdue"],
  "Completed": ["Verified"],
  "Overdue": ["In Progress", "Cancelled"],
  "Verified": ["Completed"],
};
const REGULATORY_TRANSITIONS = {
  "Draft": ["Ready for Review"],
  "Ready for Review": ["Submitted", "Draft"],
  "Submitted": ["Acknowledged", "Follow Up Required"],
  "Acknowledged": ["Closed"],
  "Follow Up Required": ["Submitted", "Closed"],
};
async function logActivity(auth, eventId, action, entityType, entityId, prev, next, performer, details) {
  const logs = await collect("activity-log", null, 1);
  const logId = `LOG-${String(logs.length + 1).padStart(4, "0")}`;
  await kineticRequest("POST", `/kapps/${KAPP}/forms/activity-log/submissions`, {
    values: {
      "Log ID": logId, "Event ID": eventId || "",
      Action: action, "Entity Type": entityType, "Entity ID": entityId,
      "Previous Value": prev, "New Value": next, "Performed By": performer,
      Timestamp: nowISO(), Details: details,
    },
  }, auth);
}

// ─── API Handler ───────────────────────────────────────────────────────────

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }


  // 1. GET /api/psafe/dashboard
  if (pathname === "/api/psafe/dashboard" && req.method === "GET") {
    try {
      const [events, investigations, capas, regulatory, actLogs] = await Promise.all([
        collect("events", null, 8),
        collect("investigations", null, 4),
        collect("capas", null, 4),
        collect("regulatory-reports", null, 4),
        collect("activity-log", null, 4),
      ]);

      const now = Date.now();
      const d30ago = new Date(now - 30 * 864e5).toISOString().slice(0, 10);
      const yearStart = new Date().getFullYear() + "-01-01";

      // KPIs
      const events30d = events.filter(e => (vf(e, "Event Date") || "") >= d30ago).length;
      const openInvestigations = investigations.filter(i => !["Complete", "Closed"].includes(vf(i, "Status"))).length;
      const overdueCAPAs = capas.filter(c => vf(c, "Status") === "Overdue").length;
      const pendingReg = regulatory.filter(r => !["Acknowledged", "Closed"].includes(vf(r, "Status"))).length;
      const sac1YTD = events.filter(e => vf(e, "SAC Score") === "1" && (vf(e, "Event Date") || "") >= yearStart).length;

      // Avg days to close
      const closedEvents = events.filter(e => vf(e, "Status") === "Closed" && vf(e, "Closed Date") && vf(e, "Event Date"));
      let avgDaysToClose = 0;
      if (closedEvents.length > 0) {
        const totalDays = closedEvents.reduce((sum, e) => {
          const days = (new Date(vf(e, "Closed Date")).getTime() - new Date(vf(e, "Event Date")).getTime()) / 864e5;
          return sum + Math.max(0, days);
        }, 0);
        avgDaysToClose = (totalDays / closedEvents.length).toFixed(1);
      }

      // Event trend (6 months)
      const trend = {};
      for (let m = 5; m >= 0; m--) {
        const dt = new Date(now - m * 30 * 864e5);
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
        trend[key] = 0;
      }
      for (const e of events) {
        const dt = (vf(e, "Event Date") || "").slice(0, 7);
        if (dt in trend) trend[dt]++;
      }

      // SAC distribution
      const sacDist = { "1": 0, "2": 0, "3": 0, "4": 0 };
      for (const e of events) {
        const sac = vf(e, "SAC Score");
        if (sac in sacDist) sacDist[sac]++;
      }

      // Department heatmap
      const deptMap = {};
      for (const e of events) {
        const dept = vf(e, "Department") || "Unknown";
        deptMap[dept] = (deptMap[dept] || 0) + 1;
      }

      // Recent events
      const recentEvents = events
        .sort((a, b) => (vf(b, "Event Date") || "").localeCompare(vf(a, "Event Date") || ""))
        .slice(0, 10)
        .map(e => ({ id: e.id, eventId: vf(e, "Event ID"), title: vf(e, "Event Title"), type: vf(e, "Event Type"), category: vf(e, "Category"), sacScore: vf(e, "SAC Score"), status: vf(e, "Status"), date: vf(e, "Event Date"), dept: vf(e, "Department") }));

      // Open investigations
      const openInvList = investigations
        .filter(i => !["Complete", "Closed"].includes(vf(i, "Status")))
        .slice(0, 10)
        .map(i => ({ id: i.id, invId: vf(i, "Investigation ID"), eventTitle: vf(i, "Event Title"), type: vf(i, "Investigation Type"), status: vf(i, "Status"), priority: vf(i, "Priority"), target: vf(i, "Target Completion") }));

      jsonResp(res, 200, {
        events30d, openInvestigations, overdueCAPAs, pendingReg, sac1YTD, avgDaysToClose,
        trend, sacDist, deptMap, recentEvents, openInvList,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 2. GET /api/psafe/event/:id/summary
  const evtSumMatch = pathname.match(/^\/api\/psafe\/event\/([^/]+)\/summary$/);
  if (evtSumMatch && req.method === "GET") {
    const eid = decodeURIComponent(evtSumMatch[1]);
    try {
      const kql = `values[Event ID] = "${eid}"`;
      const [evtArr, invArr, capaArr, noteArr, factorArr] = await Promise.all([
        collect("events", kql, 1),
        collect("investigations", `values[Event ID] = "${eid}"`, 2),
        collect("capas", `values[Event ID] = "${eid}"`, 4),
        collect("event-notes", `values[Event ID] = "${eid}"`, 4),
        collect("contributing-factors", `values[Event ID] = "${eid}"`, 4),
      ]);
      if (evtArr.length === 0) { jsonResp(res, 404, { error: "Event not found" }); return true; }
      const m = (s) => ({ id: s.id, ...s.values });
      jsonResp(res, 200, {
        event: m(evtArr[0]),
        investigations: invArr.map(m),
        capas: capaArr.map(m),
        notes: noteArr.sort((a, b) => (vf(b, "Timestamp") || "").localeCompare(vf(a, "Timestamp") || "")).map(m),
        factors: factorArr.map(m),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 3. GET /api/psafe/stats/trends
  if (pathname === "/api/psafe/stats/trends" && req.method === "GET") {
    try {
      const events = await collect("events", null, 8);
      const now = Date.now();

      // By month
      const byMonth = {};
      for (let m = 5; m >= 0; m--) {
        const dt = new Date(now - m * 30 * 864e5);
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
        byMonth[key] = { total: 0, nearMiss: 0, adverse: 0, sentinel: 0 };
      }
      for (const e of events) {
        const dt = (vf(e, "Event Date") || "").slice(0, 7);
        if (dt in byMonth) {
          byMonth[dt].total++;
          const t = vf(e, "Event Type");
          if (t === "Near Miss") byMonth[dt].nearMiss++;
          else if (t === "Adverse Event") byMonth[dt].adverse++;
          else if (t === "Sentinel Event") byMonth[dt].sentinel++;
        }
      }

      // By department
      const byDept = {};
      for (const e of events) {
        const dept = vf(e, "Department") || "Unknown";
        if (!byDept[dept]) byDept[dept] = { total: 0, nearMiss: 0, adverse: 0, sentinel: 0 };
        byDept[dept].total++;
        const t = vf(e, "Event Type");
        if (t === "Near Miss") byDept[dept].nearMiss++;
        else if (t === "Adverse Event") byDept[dept].adverse++;
        else if (t === "Sentinel Event") byDept[dept].sentinel++;
      }

      // By category
      const byCat = {};
      for (const e of events) {
        const cat = vf(e, "Category") || "Unknown";
        byCat[cat] = (byCat[cat] || 0) + 1;
      }

      jsonResp(res, 200, { byMonth, byDept, byCat });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 4. GET /api/psafe/stats/departments
  if (pathname === "/api/psafe/stats/departments" && req.method === "GET") {
    try {
      const [events, capas] = await Promise.all([
        collect("events", null, 8),
        collect("capas", null, 4),
      ]);
      const depts = {};
      for (const e of events) {
        const dept = vf(e, "Department") || "Unknown";
        if (!depts[dept]) depts[dept] = { total: 0, sac1: 0, sac2: 0, sac3: 0, sac4: 0, openCAPAs: 0 };
        depts[dept].total++;
        const sac = vf(e, "SAC Score");
        if (sac === "1") depts[dept].sac1++;
        else if (sac === "2") depts[dept].sac2++;
        else if (sac === "3") depts[dept].sac3++;
        else if (sac === "4") depts[dept].sac4++;
      }
      for (const c of capas) {
        const dept = vf(c, "Department") || "Unknown";
        if (!depts[dept]) depts[dept] = { total: 0, sac1: 0, sac2: 0, sac3: 0, sac4: 0, openCAPAs: 0 };
        if (["Open", "In Progress", "Overdue"].includes(vf(c, "Status"))) depts[dept].openCAPAs++;
      }
      jsonResp(res, 200, { departments: depts });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 5. POST /api/psafe/events/:id/transition
  const evtTransMatch = pathname.match(/^\/api\/psafe\/events\/([^/]+)\/transition$/);
  if (evtTransMatch && req.method === "POST") {
    const eid = decodeURIComponent(evtTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const evts = await collect("events", `values[Event ID] = "${eid}"`, 1);
      if (evts.length === 0) { jsonResp(res, 404, { error: "Event not found" }); return true; }
      const evt = evts[0];
      const current = vf(evt, "Status");
      const allowed = EVENT_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Closed") updates["Closed Date"] = new Date().toISOString().slice(0, 10);
      if (body.assignedTo) updates["Assigned To"] = body.assignedTo;
      await kineticRequest("PUT", `/submissions/${evt.id}/values`, updates, auth);
      await logActivity(auth, eid, "Status Changed", "Event", eid, current, newStatus, body.performer || "System",
        `Event ${eid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 6. POST /api/psafe/investigations/:id/transition
  const invTransMatch = pathname.match(/^\/api\/psafe\/investigations\/([^/]+)\/transition$/);
  if (invTransMatch && req.method === "POST") {
    const iid = decodeURIComponent(invTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const invs = await collect("investigations", `values[Investigation ID] = "${iid}"`, 1);
      if (invs.length === 0) { jsonResp(res, 404, { error: "Investigation not found" }); return true; }
      const inv = invs[0];
      const current = vf(inv, "Status");
      const allowed = INVESTIGATION_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Complete" || newStatus === "Closed") updates["Actual Completion"] = new Date().toISOString().slice(0, 10);
      if (body.findings) updates["Findings Summary"] = body.findings;
      if (body.recommendations) updates["Recommendations"] = body.recommendations;
      await kineticRequest("PUT", `/submissions/${inv.id}/values`, updates, auth);
      await logActivity(auth, vf(inv, "Event ID"), "Investigation " + newStatus, "Investigation", iid, current, newStatus,
        body.performer || "System", `Investigation ${iid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 7. POST /api/psafe/capas/:id/transition
  const capaTransMatch = pathname.match(/^\/api\/psafe\/capas\/([^/]+)\/transition$/);
  if (capaTransMatch && req.method === "POST") {
    const cid = decodeURIComponent(capaTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const caps = await collect("capas", `values[CAPA ID] = "${cid}"`, 1);
      if (caps.length === 0) { jsonResp(res, 404, { error: "CAPA not found" }); return true; }
      const capa = caps[0];
      const current = vf(capa, "Status");
      const allowed = CAPA_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Completed") updates["Completion Date"] = new Date().toISOString().slice(0, 10);
      if (newStatus === "Verified") {
        updates["Effectiveness Check Date"] = new Date().toISOString().slice(0, 10);
        updates["Effectiveness Result"] = body.effectivenessResult || "Effective";
      }
      await kineticRequest("PUT", `/submissions/${capa.id}/values`, updates, auth);
      await logActivity(auth, vf(capa, "Event ID"), "CAPA " + newStatus, "CAPA", cid, current, newStatus,
        body.performer || "System", `CAPA ${cid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 8. POST /api/psafe/regulatory/:id/transition
  const regTransMatch = pathname.match(/^\/api\/psafe\/regulatory\/([^/]+)\/transition$/);
  if (regTransMatch && req.method === "POST") {
    const rid = decodeURIComponent(regTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const regs = await collect("regulatory-reports", `values[Report ID] = "${rid}"`, 1);
      if (regs.length === 0) { jsonResp(res, 404, { error: "Regulatory report not found" }); return true; }
      const reg = regs[0];
      const current = vf(reg, "Status");
      const allowed = REGULATORY_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Submitted") {
        updates["Submitted Date"] = new Date().toISOString().slice(0, 10);
        updates["Submitted By"] = body.performer || "System";
      }
      if (newStatus === "Acknowledged" && body.ackNumber) updates["Acknowledgment Number"] = body.ackNumber;
      await kineticRequest("PUT", `/submissions/${reg.id}/values`, updates, auth);
      await logActivity(auth, vf(reg, "Event ID"), "Regulatory Report " + newStatus, "Regulatory Report", rid, current, newStatus,
        body.performer || "System", `Report ${rid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 9. GET /api/psafe/report/:type
  const reportMatch = pathname.match(/^\/api\/psafe\/report\/([a-z-]+)$/);
  if (reportMatch && req.method === "GET") {
    const type = reportMatch[1];
    try {
      if (type === "event-summary") {
        const events = await collect("events", null, 8);
        jsonResp(res, 200, {
          report: "Event Summary",
          items: events.map(e => ({ eventId: vf(e, "Event ID"), title: vf(e, "Event Title"), type: vf(e, "Event Type"), category: vf(e, "Category"), dept: vf(e, "Department"), date: vf(e, "Event Date"), sacScore: vf(e, "SAC Score"), severity: vf(e, "Severity"), harm: vf(e, "Harm Level"), status: vf(e, "Status") })),
        });
      } else if (type === "sac-analysis") {
        const events = await collect("events", null, 8);
        const sacGroups = { "1": [], "2": [], "3": [], "4": [] };
        for (const e of events) {
          const sac = vf(e, "SAC Score");
          if (sac in sacGroups) sacGroups[sac].push({ eventId: vf(e, "Event ID"), title: vf(e, "Event Title"), type: vf(e, "Event Type"), dept: vf(e, "Department"), severity: vf(e, "Severity"), likelihood: vf(e, "Likelihood"), status: vf(e, "Status") });
        }
        jsonResp(res, 200, { report: "SAC Analysis", sacGroups });
      } else if (type === "department-comparison") {
        const [events, capas] = await Promise.all([
          collect("events", null, 8),
          collect("capas", null, 4),
        ]);
        const depts = {};
        for (const e of events) {
          const dept = vf(e, "Department") || "Unknown";
          if (!depts[dept]) depts[dept] = { events: 0, nearMiss: 0, adverse: 0, sentinel: 0, capas: 0 };
          depts[dept].events++;
          if (vf(e, "Event Type") === "Near Miss") depts[dept].nearMiss++;
          if (vf(e, "Event Type") === "Adverse Event") depts[dept].adverse++;
          if (vf(e, "Event Type") === "Sentinel Event") depts[dept].sentinel++;
        }
        for (const c of capas) {
          const dept = vf(c, "Department") || "Unknown";
          if (!depts[dept]) depts[dept] = { events: 0, nearMiss: 0, adverse: 0, sentinel: 0, capas: 0 };
          depts[dept].capas++;
        }
        jsonResp(res, 200, { report: "Department Comparison", departments: depts });
      } else if (type === "capa-effectiveness") {
        const capas = await collect("capas", null, 4);
        jsonResp(res, 200, {
          report: "CAPA Effectiveness",
          items: capas.map(c => ({ capaId: vf(c, "CAPA ID"), type: vf(c, "CAPA Type"), dept: vf(c, "Department"), category: vf(c, "Category"), status: vf(c, "Status"), priority: vf(c, "Priority"), effectivenessResult: vf(c, "Effectiveness Result"), dueDate: vf(c, "Due Date"), completionDate: vf(c, "Completion Date") })),
        });
      } else if (type === "regulatory-compliance") {
        const regs = await collect("regulatory-reports", null, 4);
        jsonResp(res, 200, {
          report: "Regulatory Compliance",
          items: regs.map(r => ({ reportId: vf(r, "Report ID"), agency: vf(r, "Reporting Agency"), type: vf(r, "Report Type"), eventId: vf(r, "Event ID"), status: vf(r, "Status"), reportDate: vf(r, "Report Date"), dueDate: vf(r, "Due Date"), submittedDate: vf(r, "Submitted Date"), ackNumber: vf(r, "Acknowledgment Number") })),
        });
      } else if (type === "contributing-factors") {
        const factors = await collect("contributing-factors", null, 8);
        const byCat = {};
        for (const f of factors) {
          const cat = vf(f, "Factor Category") || "Unknown";
          if (!byCat[cat]) byCat[cat] = { count: 0, highMit: 0, medMit: 0, lowMit: 0 };
          byCat[cat].count++;
          const mit = vf(f, "Mitigation Potential");
          if (mit === "High") byCat[cat].highMit++;
          else if (mit === "Medium") byCat[cat].medMit++;
          else byCat[cat].lowMit++;
        }
        jsonResp(res, 200, { report: "Contributing Factor Analysis", categories: byCat, totalFactors: factors.length });
      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${type}` });
      }
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 10. GET /api/psafe/search?q=&type=
  if (pathname === "/api/psafe/search" && req.method === "GET") {
    const parsedUrl = new URL(req.url, "http://localhost");
    const q = (parsedUrl.searchParams.get("q") || "").toLowerCase();
    const type = parsedUrl.searchParams.get("type") || "all";
    if (!q || q.length < 2) { jsonResp(res, 400, { error: "Query must be at least 2 characters" }); return true; }
    try {
      const results = [];
      const search = (arr, entityType, nameField, idField) => {
        for (const s of arr) {
          const name = (vf(s, nameField) || "").toLowerCase();
          const id = (vf(s, idField) || "").toLowerCase();
          if (name.includes(q) || id.includes(q)) {
            results.push({ id: s.id, entityType, entityId: vf(s, idField), name: vf(s, nameField), status: vf(s, "Status"), dept: vf(s, "Department") || "" });
          }
        }
      };
      if (type === "all" || type === "events") {
        const events = await collect("events", null, 8);
        search(events, "Event", "Event Title", "Event ID");
      }
      if (type === "all" || type === "investigations") {
        const invs = await collect("investigations", null, 4);
        search(invs, "Investigation", "Event Title", "Investigation ID");
      }
      if (type === "all" || type === "capas") {
        const caps = await collect("capas", null, 4);
        search(caps, "CAPA", "Description", "CAPA ID");
      }
      if (type === "all" || type === "regulatory") {
        const regs = await collect("regulatory-reports", null, 4);
        search(regs, "Regulatory Report", "Reporting Agency", "Report ID");
      }
      jsonResp(res, 200, { query: q, type, results: results.slice(0, 50) });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}

// ─── Standalone mode ───────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const http = await import("node:http");
  const https = await import("node:https");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const PORT = process.env.PORT || 3099;
  const KINETIC = process.env.KINETIC_URL || "https://localhost";
  const __dir = path.dirname(new URL(import.meta.url).pathname);

  function kineticRequest(method, apiPath, body, authHeader) {
    return new Promise((resolve, reject) => {
      const url = new URL(`/app/api/v1${apiPath}`, KINETIC);
      const headers = { "Content-Type": "application/json" };
      if (authHeader) headers["Authorization"] = authHeader;
      const payload = body ? JSON.stringify(body) : null;
      if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
      const r = https.request(url, { method, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
          catch { resolve({ status: res.statusCode, data: text }); }
        });
      });
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  }

  function jsonResp(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" });
    res.end(JSON.stringify(data));
  }

  function readBody(req) {
    return new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c).toString())); });
  }

  async function collectByQuery(kappSlug, formSlug, kql, authHeader, maxPages = 8) {
    const all = []; let lastCreatedAt = null;
    for (let i = 0; i < maxPages; i++) {
      let url = `/kapps/${kappSlug}/forms/${formSlug}/submissions?include=values,details&limit=25`;
      let q = kql || "";
      if (lastCreatedAt) q = (q ? "(" + q + ") AND " : "") + `createdAt < "${lastCreatedAt}"`;
      if (q) url += `&q=${encodeURIComponent(q)}`;
      const r = await kineticRequest("GET", url, null, authHeader);
      const subs = r.data?.submissions || [];
      all.push(...subs);
      if (subs.length > 0) lastCreatedAt = subs[subs.length - 1].createdAt;
      if (!r.data?.nextPageToken || subs.length < 25) break;
    }
    return all;
  }

  const helpers = {
    kineticRequest, jsonResp, readBody, collectByQuery,
    vf: (s, f) => s.values?.[f] || "",
  };

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }); res.end(); return; }
    if (pathname.startsWith(apiPrefix)) {
      const handled = await handleAPI(req, res, pathname, req.headers.authorization, helpers);
      if (handled) return;
    }
    if (pathname.startsWith("/app/")) {
      const url = new URL(req.url, KINETIC);
      const headers = { ...req.headers, host: url.host }; delete headers.origin; delete headers.referer;
      const body = await readBody(req);
      const pr = https.request(url, { method: req.method, headers }, (pres) => {
        res.writeHead(pres.statusCode, { ...pres.headers, "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
        pres.pipe(res);
      });
      pr.on("error", e => { res.writeHead(502); res.end(e.message); });
      if (body.length) pr.write(body);
      pr.end(); return;
    }
    let fp = pathname === "/" ? "/index.html" : pathname;
    fp = path.join(__dir, fp);
    try { const c = fs.readFileSync(fp); res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(fp)] || "application/octet-stream" }); res.end(c); }
    catch { res.writeHead(404); res.end("Not found"); }
  });

  server.listen(PORT, () => console.log(`\n  Patient Safety: http://localhost:${PORT}\n`));
}
