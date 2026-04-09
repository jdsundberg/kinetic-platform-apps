/**
 * Clinical Equipment — Custom API Handler
 */

export const appId = "clinical-equipment";
export const apiPrefix = "/api/biomed";
export const kapp = "clinical-equipment";

// ─── App-specific helpers ──────────────────────────────────────────────────

function nowISO() { return new Date().toISOString(); }
const WO_TRANSITIONS = {
  "Open": ["In Progress", "Cancelled"],
  "In Progress": ["On Hold", "Completed"],
  "On Hold": ["In Progress", "Cancelled"],
};
const RECALL_TRANSITIONS = {
  "Active": ["Under Review"],
  "Under Review": ["Remediation In Progress", "Closed"],
  "Remediation In Progress": ["Resolved"],
  "Resolved": ["Closed"],
};
const DISPOSAL_TRANSITIONS = {
  "Pending Approval": ["Approved"],
  "Approved": ["In Progress"],
  "In Progress": ["Completed"],
};
async function logActivity(auth, entityType, entityId, action, prevVal, newVal, performer, dept, details, relEquip) {
  const logId = `LOG-${Date.now()}`;
  try {
    await kineticRequest("POST", `/kapps/${KAPP}/forms/activity-log/submissions`, {
      values: {
        "Log ID": logId, "Entity Type": entityType, "Entity ID": entityId,
        "Action": action, "Previous Value": prevVal, "New Value": newVal,
        "Performed By": performer, "Timestamp": nowISO(),
        "Department": dept || "", "Details": details, "Related Equipment": relEquip || "",
      },
    }, auth);
  } catch (e) { console.error("Audit log failed:", e.message); }
}

// ─── API Handler ───────────────────────────────────────────────────────────

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }


  // ─── 1. GET /api/biomed/dashboard ───
  if (pathname === "/api/biomed/dashboard" && req.method === "GET") {
    try {
      const [equipment, workOrders, recalls, calibrations, disposals, activityLogs] = await Promise.all([
        collect("equipment", null, 4),
        collect("work-orders", null, 4),
        collect("recalls", null, 2),
        collect("calibrations", null, 4),
        collect("disposals", null, 2),
        collect("activity-log", null, 2),
      ]);

      const totalEquipment = equipment.length;
      const operational = equipment.filter(e => vf(e, "Status") === "Operational").length;
      const operationalPct = totalEquipment > 0 ? (operational / totalEquipment * 100).toFixed(1) : "0";

      // PM due: open PM work orders
      const pmDue = workOrders.filter(w => vf(w, "WO Type") === "Preventive Maintenance" && vf(w, "Status") === "Open").length;

      // Overdue calibrations
      const overdueCals = calibrations.filter(c => vf(c, "Status") === "Overdue").length;

      // Active recalls
      const activeRecalls = recalls.filter(r => ["Active", "Under Review", "Remediation In Progress"].includes(vf(r, "Status"))).length;

      // Pending disposals
      const pendingDisposals = disposals.filter(d => ["Pending Approval", "Approved", "In Progress"].includes(vf(d, "Status"))).length;

      // Equipment by status
      const statusDist = {};
      for (const e of equipment) {
        const s = vf(e, "Status") || "Unknown";
        statusDist[s] = (statusDist[s] || 0) + 1;
      }

      // Equipment by department
      const deptDist = {};
      for (const e of equipment) {
        const dept = vf(e, "Department") || "Unknown";
        deptDist[dept] = (deptDist[dept] || 0) + 1;
      }

      // Active recall alerts
      const recallAlerts = recalls
        .filter(r => ["Active", "Under Review", "Remediation In Progress"].includes(vf(r, "Status")))
        .map(r => ({
          id: r.id, recallId: vf(r, "Recall ID"), recallNumber: vf(r, "Recall Number"),
          recallClass: vf(r, "Recall Class"), deviceType: vf(r, "Device Type"),
          manufacturer: vf(r, "Manufacturer"), status: vf(r, "Status"),
          affectedCount: vf(r, "Affected Count"), remediatedCount: vf(r, "Remediated Count"),
          deadline: vf(r, "Deadline"),
        }));

      // Recent activity
      const recentActivity = activityLogs
        .sort((a, b) => (vf(b, "Timestamp") || "").localeCompare(vf(a, "Timestamp") || ""))
        .slice(0, 10)
        .map(l => ({
          action: vf(l, "Action"), entityType: vf(l, "Entity Type"),
          entityId: vf(l, "Entity ID"), performer: vf(l, "Performed By"),
          timestamp: vf(l, "Timestamp"), details: vf(l, "Details"),
        }));

      jsonResp(res, 200, {
        totalEquipment, operational, operationalPct, pmDue, overdueCals,
        activeRecalls, pendingDisposals, statusDist, deptDist,
        recallAlerts, recentActivity,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 2. GET /api/biomed/equipment/:id/history ───
  const equipMatch = pathname.match(/^\/api\/biomed\/equipment\/([^/]+)\/history$/);
  if (equipMatch && req.method === "GET") {
    const eqId = decodeURIComponent(equipMatch[1]);
    try {
      const kql = `values[Equipment ID] = "${eqId}"`;
      const [equips, wos, cals, disps, logs] = await Promise.all([
        collect("equipment", kql, 1),
        collect("work-orders", kql, 4),
        collect("calibrations", kql, 4),
        collect("disposals", kql, 2),
        collect("activity-log", `values[Entity ID] = "${eqId}"`, 4),
      ]);
      if (equips.length === 0) { jsonResp(res, 404, { error: "Equipment not found" }); return true; }
      const map = (arr) => arr.map(s => ({ id: s.id, ...s.values }));
      jsonResp(res, 200, {
        equipment: { id: equips[0].id, ...equips[0].values },
        workOrders: map(wos), calibrations: map(cals),
        disposals: map(disps), activityLog: map(logs),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 3. GET /api/biomed/stats/maintenance ───
  if (pathname === "/api/biomed/stats/maintenance" && req.method === "GET") {
    try {
      const workOrders = await collect("work-orders", null, 4);
      const pmOrders = workOrders.filter(w => vf(w, "WO Type") === "Preventive Maintenance");
      const completedPM = pmOrders.filter(w => vf(w, "Status") === "Completed").length;
      const pmCompletionRate = pmOrders.length > 0 ? (completedPM / pmOrders.length * 100).toFixed(1) : "0";

      // Open WOs by priority
      const openWOs = workOrders.filter(w => !["Completed", "Cancelled"].includes(vf(w, "Status")));
      const byPriority = { Critical: 0, High: 0, Medium: 0, Low: 0 };
      for (const w of openWOs) { const p = vf(w, "Priority"); if (byPriority[p] !== undefined) byPriority[p]++; }

      // By type
      const byType = {};
      for (const w of openWOs) { const t = vf(w, "WO Type") || "Unknown"; byType[t] = (byType[t] || 0) + 1; }

      // Avg labor hours for completed
      const completed = workOrders.filter(w => vf(w, "Status") === "Completed" && vf(w, "Labor Hours"));
      const avgLabor = completed.length > 0
        ? (completed.reduce((s, w) => s + parseFloat(vf(w, "Labor Hours") || "0"), 0) / completed.length).toFixed(1)
        : "0";

      // Total parts cost
      const totalPartsCost = completed.reduce((s, w) => s + parseFloat(vf(w, "Parts Cost") || "0"), 0).toFixed(0);

      jsonResp(res, 200, {
        totalWOs: workOrders.length, openWOs: openWOs.length,
        pmCompletionRate, completedPM, totalPM: pmOrders.length,
        byPriority, byType, avgLabor, totalPartsCost,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 4. GET /api/biomed/stats/compliance ───
  if (pathname === "/api/biomed/stats/compliance" && req.method === "GET") {
    try {
      const [calibrations, workOrders, recalls, inspections] = await Promise.all([
        collect("calibrations", null, 4),
        collect("work-orders", null, 4),
        collect("recalls", null, 2),
        collect("inspections", null, 2),
      ]);

      // Calibration current %
      const currentCals = calibrations.filter(c => vf(c, "Status") === "Current").length;
      const calCurrentPct = calibrations.length > 0 ? (currentCals / calibrations.length * 100).toFixed(1) : "0";
      const overdueCals = calibrations.filter(c => vf(c, "Status") === "Overdue").length;
      const dueCals = calibrations.filter(c => vf(c, "Status") === "Due").length;

      // PM on-time rate
      const pmOrders = workOrders.filter(w => vf(w, "WO Type") === "Preventive Maintenance");
      const completedOnTime = pmOrders.filter(w => {
        if (vf(w, "Status") !== "Completed") return false;
        const sched = vf(w, "Scheduled Date");
        const comp = vf(w, "Completed Date");
        return sched && comp && comp <= sched;
      }).length;
      const completedPM = pmOrders.filter(w => vf(w, "Status") === "Completed").length;
      const pmOnTimeRate = completedPM > 0 ? (completedOnTime / completedPM * 100).toFixed(1) : "0";

      // Active recalls
      const activeRecalls = recalls.filter(r => ["Active", "Under Review", "Remediation In Progress"].includes(vf(r, "Status"))).length;

      // Inspection scores
      const completedInsp = inspections.filter(i => vf(i, "Status") === "Completed" || vf(i, "Status") === "Closed");
      const avgScore = completedInsp.length > 0
        ? (completedInsp.reduce((s, i) => s + parseFloat(vf(i, "Score") || "0"), 0) / completedInsp.length).toFixed(1)
        : "0";

      jsonResp(res, 200, {
        calCurrentPct, currentCals, overdueCals, dueCals, totalCals: calibrations.length,
        pmOnTimeRate, completedOnTime, completedPM, totalPM: pmOrders.length,
        activeRecalls, totalRecalls: recalls.length,
        avgInspectionScore: avgScore, totalInspections: inspections.length,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 5. GET /api/biomed/stats/lifecycle ───
  if (pathname === "/api/biomed/stats/lifecycle" && req.method === "GET") {
    try {
      const [equipment, disposals, vendors] = await Promise.all([
        collect("equipment", null, 4),
        collect("disposals", null, 2),
        collect("vendors", null, 2),
      ]);

      const now = Date.now();
      const d90 = now + 90 * 864e5;

      // Equipment by age bracket
      const ageBrackets = { "0-2 years": 0, "2-5 years": 0, "5-8 years": 0, "8+ years": 0 };
      for (const e of equipment) {
        const purchase = new Date(vf(e, "Purchase Date")).getTime();
        if (!purchase) continue;
        const ageYears = (now - purchase) / (365.25 * 864e5);
        if (ageYears < 2) ageBrackets["0-2 years"]++;
        else if (ageYears < 5) ageBrackets["2-5 years"]++;
        else if (ageYears < 8) ageBrackets["5-8 years"]++;
        else ageBrackets["8+ years"]++;
      }

      // Approaching end of useful life
      const approachingEOL = equipment.filter(e => {
        const purchase = new Date(vf(e, "Purchase Date")).getTime();
        const lifeYears = parseFloat(vf(e, "Useful Life Years") || "0");
        if (!purchase || !lifeYears) return false;
        const eol = purchase + lifeYears * 365.25 * 864e5;
        return eol > now && eol <= now + 365 * 864e5; // within 1 year
      }).map(e => ({
        equipmentId: vf(e, "Equipment ID"), deviceName: vf(e, "Device Name"),
        department: vf(e, "Department"), assetValue: vf(e, "Asset Value"),
        usefulLifeYears: vf(e, "Useful Life Years"), purchaseDate: vf(e, "Purchase Date"),
      }));

      // Warranty expirations coming up (90 days)
      const warrantyExpiring = equipment.filter(e => {
        const exp = new Date(vf(e, "Warranty Expiration")).getTime();
        return exp > now && exp <= d90;
      }).map(e => ({
        equipmentId: vf(e, "Equipment ID"), deviceName: vf(e, "Device Name"),
        warrantyExpiration: vf(e, "Warranty Expiration"), department: vf(e, "Department"),
      }));

      // Disposal pipeline
      const disposalPipeline = {};
      for (const d of disposals) {
        const s = vf(d, "Status") || "Unknown";
        disposalPipeline[s] = (disposalPipeline[s] || 0) + 1;
      }

      // Total asset value
      const totalAssetValue = equipment.reduce((s, e) => s + parseFloat(vf(e, "Asset Value") || "0"), 0);

      // Vendor contracts expiring
      const vendorExpiring = vendors.filter(v => {
        const exp = new Date(vf(v, "Contract End")).getTime();
        return exp > now && exp <= d90;
      }).map(v => ({
        vendorId: vf(v, "Vendor ID"), vendorName: vf(v, "Vendor Name"),
        contractEnd: vf(v, "Contract End"), slaHours: vf(v, "SLA Hours"),
      }));

      jsonResp(res, 200, {
        ageBrackets, approachingEOL, warrantyExpiring,
        disposalPipeline, totalAssetValue, vendorExpiring,
        totalEquipment: equipment.length,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 6. POST /api/biomed/work-orders/:id/transition ───
  const woTransMatch = pathname.match(/^\/api\/biomed\/work-orders\/([^/]+)\/transition$/);
  if (woTransMatch && req.method === "POST") {
    const subId = decodeURIComponent(woTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const performer = body.performer || "System";
      const r = await kineticRequest("GET", `/submissions/${subId}?include=values`, null, auth);
      if (r.status !== 200) { jsonResp(res, 404, { error: "Submission not found" }); return true; }
      const sub = r.data.submission;
      const oldStatus = sub.values?.["Status"] || "";
      const allowed = WO_TRANSITIONS[oldStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${oldStatus}" to "${newStatus}"`, allowed: allowed || [] });
        return true;
      }
      const updates = { "Status": newStatus };
      if (newStatus === "Completed") updates["Completed Date"] = nowISO().slice(0, 10);
      if (body.laborHours) updates["Labor Hours"] = body.laborHours;
      if (body.partsCost) updates["Parts Cost"] = body.partsCost;
      if (body.resolution) updates["Resolution"] = body.resolution;
      await kineticRequest("PUT", `/submissions/${subId}/values`, updates, auth);
      await logActivity(auth, "Work Order", sub.values["WO ID"] || subId, "Status Changed", oldStatus, newStatus, performer, sub.values["Department"] || "", `WO transitioned from ${oldStatus} to ${newStatus}`, sub.values["Equipment ID"] || "");
      jsonResp(res, 200, { success: true, oldStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 7. POST /api/biomed/recalls/:id/transition ───
  const recallTransMatch = pathname.match(/^\/api\/biomed\/recalls\/([^/]+)\/transition$/);
  if (recallTransMatch && req.method === "POST") {
    const subId = decodeURIComponent(recallTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const performer = body.performer || "System";
      const r = await kineticRequest("GET", `/submissions/${subId}?include=values`, null, auth);
      if (r.status !== 200) { jsonResp(res, 404, { error: "Submission not found" }); return true; }
      const sub = r.data.submission;
      const oldStatus = sub.values?.["Status"] || "";
      const allowed = RECALL_TRANSITIONS[oldStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${oldStatus}" to "${newStatus}"`, allowed: allowed || [] });
        return true;
      }
      const updates = { "Status": newStatus };
      if (body.remediatedCount) updates["Remediated Count"] = body.remediatedCount;
      await kineticRequest("PUT", `/submissions/${subId}/values`, updates, auth);
      await logActivity(auth, "Recall", sub.values["Recall ID"] || subId, "Status Changed", oldStatus, newStatus, performer, "", `Recall transitioned from ${oldStatus} to ${newStatus}`, "");
      jsonResp(res, 200, { success: true, oldStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 8. POST /api/biomed/disposals/:id/transition ───
  const dispTransMatch = pathname.match(/^\/api\/biomed\/disposals\/([^/]+)\/transition$/);
  if (dispTransMatch && req.method === "POST") {
    const subId = decodeURIComponent(dispTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const performer = body.performer || "System";
      const r = await kineticRequest("GET", `/submissions/${subId}?include=values`, null, auth);
      if (r.status !== 200) { jsonResp(res, 404, { error: "Submission not found" }); return true; }
      const sub = r.data.submission;
      const oldStatus = sub.values?.["Status"] || "";
      const allowed = DISPOSAL_TRANSITIONS[oldStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${oldStatus}" to "${newStatus}"`, allowed: allowed || [] });
        return true;
      }
      const updates = { "Status": newStatus };
      if (newStatus === "Approved") updates["Approved By"] = performer;
      if (newStatus === "Completed") {
        updates["Disposal Date"] = nowISO().slice(0, 10);
        if (body.certificateNumber) updates["Certificate Number"] = body.certificateNumber;
      }
      await kineticRequest("PUT", `/submissions/${subId}/values`, updates, auth);
      await logActivity(auth, "Disposal", sub.values["Disposal ID"] || subId, "Status Changed", oldStatus, newStatus, performer, "", `Disposal transitioned from ${oldStatus} to ${newStatus}`, sub.values["Equipment ID"] || "");
      jsonResp(res, 200, { success: true, oldStatus, newStatus });
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

  server.listen(PORT, () => console.log(`\n  Clinical Equipment: http://localhost:${PORT}\n`));
}
