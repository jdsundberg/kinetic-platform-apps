/**
 * Vendor Credentialing — Custom API Handler
 */

export const appId = "vendor-cred";
export const apiPrefix = "/api/vcred";
export const kapp = "vendor-cred";

// ─── App-specific helpers ──────────────────────────────────────────────────

const vf = (s, f) => s.values?.[f] || "";
function nowISO() { return new Date().toISOString(); }
const REP_TRANSITIONS = {
  Active: ["Suspended", "Under Review"],
  Suspended: ["Active", "Under Review", "Denied"],
  Pending: ["Active", "Denied"],
  "Under Review": ["Active", "Suspended", "Denied"],
  Expired: ["Active", "Pending"],
  Denied: ["Pending"],
};
const ACCESS_TRANSITIONS = {
  Pending: ["Active", "Denied"],
  Active: ["Suspended", "Revoked", "Expired"],
  Suspended: ["Active", "Revoked"],
  Denied: ["Pending"],
  Expired: ["Pending"],
};
const INCIDENT_TRANSITIONS = {
  New: ["Under Investigation", "Dismissed"],
  "Under Investigation": ["Confirmed", "Dismissed", "Escalated"],
  Escalated: ["Confirmed", "Resolved"],
  Confirmed: ["Resolved"],
};
async function logActivity(auth, repName, repId, vendorName, action, entityType, entityId, prev, next, performer, details) {
  const count = await collect("activity-log", null, 1);
  const logId = `LOG-${String(count.length + 1).padStart(4, "0")}`;
  await kineticRequest("POST", `/kapps/${KAPP}/forms/activity-log/submissions`, {
    values: {
      "Log ID": logId, "Rep Name": repName, "Rep ID": repId, "Vendor Name": vendorName,
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


  // GET /api/vcred/dashboard
  if (pathname === "/api/vcred/dashboard" && req.method === "GET") {
    try {
      const [reps, creds, access, visits, incidents, notifications, activityLogs] = await Promise.all([
        collect("representatives", null, 4),
        collect("credentials", null, 8),
        collect("access-authorizations", null, 4),
        collect("visits", null, 8),
        collect("incidents", null, 4),
        collect("notifications", null, 4),
        collect("activity-log", null, 4),
      ]);

      const now = Date.now();
      const d30 = now + 30 * 864e5;
      const todayStr = new Date().toISOString().slice(0, 10);

      const activeReps = reps.filter(r => vf(r, "Status") === "Active").length;
      const activeRepIds = new Set(reps.filter(r => vf(r, "Status") === "Active").map(r => vf(r, "Rep ID")));
      let compliantCount = 0;
      for (const rid of activeRepIds) {
        const repCreds = creds.filter(c => vf(c, "Rep ID") === rid);
        const hasIssue = repCreds.some(c => vf(c, "Status") === "Expired" || vf(c, "Verification Status") === "Rejected");
        if (!hasIssue && repCreds.length > 0) compliantCount++;
      }
      const complianceRate = activeRepIds.size > 0 ? (compliantCount / activeRepIds.size * 100).toFixed(1) : "0";

      const expiring30 = creds.filter(c => {
        const exp = new Date(vf(c, "Expiration Date")).getTime();
        return exp > 0 && exp <= d30 && exp > now && vf(c, "Status") !== "Expired";
      }).length;

      const todayVisitors = visits.filter(v => vf(v, "Check-In Date") === todayStr).length;
      const openIncidents = incidents.filter(i => !["Resolved", "Dismissed"].includes(vf(i, "Status"))).length;
      const pendingAccess = access.filter(a => vf(a, "Status") === "Pending").length;

      const expiringList = creds
        .filter(c => { const exp = new Date(vf(c, "Expiration Date")).getTime(); return exp > now && vf(c, "Status") !== "Expired"; })
        .sort((a, b) => new Date(vf(a, "Expiration Date")).getTime() - new Date(vf(b, "Expiration Date")).getTime())
        .slice(0, 10)
        .map(c => ({ id: c.id, repName: vf(c, "Rep Name"), repId: vf(c, "Rep ID"), type: vf(c, "Credential Type"), expDate: vf(c, "Expiration Date"), status: vf(c, "Status") }));

      const deptVisits = {};
      for (const v of visits) {
        if (vf(v, "Check-In Date") === todayStr) {
          const dept = vf(v, "Department") || "Unknown";
          deptVisits[dept] = (deptVisits[dept] || 0) + 1;
        }
      }

      const recentIncidents = incidents
        .sort((a, b) => (vf(b, "Incident Date") || "").localeCompare(vf(a, "Incident Date") || ""))
        .slice(0, 5)
        .map(i => ({ id: i.id, incidentId: vf(i, "Incident ID"), repName: vf(i, "Rep Name"), type: vf(i, "Incident Type"), severity: vf(i, "Severity"), status: vf(i, "Status"), date: vf(i, "Incident Date") }));

      const recentActivity = activityLogs
        .sort((a, b) => (vf(b, "Timestamp") || "").localeCompare(vf(a, "Timestamp") || ""))
        .slice(0, 10)
        .map(l => ({ action: vf(l, "Action"), repName: vf(l, "Rep Name"), entityType: vf(l, "Entity Type"), performer: vf(l, "Performed By"), timestamp: vf(l, "Timestamp"), details: vf(l, "Details") }));

      jsonResp(res, 200, {
        activeReps, totalReps: reps.length, complianceRate, expiring30, todayVisitors, openIncidents, pendingAccess,
        expiringList, deptVisits, recentIncidents, recentActivity,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/vcred/rep/:id/summary
  const repMatch = pathname.match(/^\/api\/vcred\/rep\/([^/]+)\/summary$/);
  if (repMatch && req.method === "GET") {
    const rid = decodeURIComponent(repMatch[1]);
    try {
      const kql = `values[Rep ID] = "${rid}"`;
      const [repArr, credArr, accessArr, visitArr, incArr, docArr, checkArr] = await Promise.all([
        collect("representatives", kql, 1),
        collect("credentials", kql, 4),
        collect("access-authorizations", kql, 4),
        collect("visits", kql, 4),
        collect("incidents", kql, 2),
        collect("documents", kql, 4),
        collect("compliance-checks", kql, 4),
      ]);
      if (repArr.length === 0) { jsonResp(res, 404, { error: "Rep not found" }); return true; }
      const rep = repArr[0];
      const m = (s) => ({ id: s.id, ...s.values });
      jsonResp(res, 200, {
        rep: m(rep),
        credentials: credArr.map(m),
        access: accessArr.map(m),
        visits: visitArr.sort((a, b) => (vf(b, "Check-In Date") || "").localeCompare(vf(a, "Check-In Date") || "")).map(m),
        incidents: incArr.map(m),
        documents: docArr.map(m),
        checks: checkArr.map(m),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/vcred/stats/compliance
  if (pathname === "/api/vcred/stats/compliance" && req.method === "GET") {
    try {
      const creds = await collect("credentials", null, 8);
      const now = Date.now();
      const categories = {};
      for (const c of creds) {
        const cat = vf(c, "Credential Category") || "Unknown";
        if (!categories[cat]) categories[cat] = { total: 0, active: 0, expiring: 0, expired: 0, pending: 0 };
        categories[cat].total++;
        const st = vf(c, "Status");
        if (st === "Active") categories[cat].active++;
        else if (st === "Expiring Soon") categories[cat].expiring++;
        else if (st === "Expired") categories[cat].expired++;
        else categories[cat].pending++;
      }
      const byType = {};
      for (const c of creds) {
        const t = vf(c, "Credential Type") || "Unknown";
        if (!byType[t]) byType[t] = { total: 0, verified: 0, pending: 0, expired: 0 };
        byType[t].total++;
        const vs = vf(c, "Verification Status");
        if (vs === "Verified") byType[t].verified++;
        else if (vs === "Pending") byType[t].pending++;
        else if (vs === "Expired") byType[t].expired++;
      }
      jsonResp(res, 200, { categories, byType, totalCredentials: creds.length });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/vcred/stats/departments
  if (pathname === "/api/vcred/stats/departments" && req.method === "GET") {
    try {
      const [access, visits] = await Promise.all([
        collect("access-authorizations", null, 4),
        collect("visits", null, 8),
      ]);
      const depts = {};
      for (const a of access) {
        const dept = vf(a, "Department") || "Unknown";
        if (!depts[dept]) depts[dept] = { activeAccess: 0, pendingAccess: 0, totalVisits: 0, todayVisits: 0 };
        if (vf(a, "Status") === "Active") depts[dept].activeAccess++;
        if (vf(a, "Status") === "Pending") depts[dept].pendingAccess++;
      }
      const todayStr = new Date().toISOString().slice(0, 10);
      for (const v of visits) {
        const dept = vf(v, "Department") || "Unknown";
        if (!depts[dept]) depts[dept] = { activeAccess: 0, pendingAccess: 0, totalVisits: 0, todayVisits: 0 };
        depts[dept].totalVisits++;
        if (vf(v, "Check-In Date") === todayStr) depts[dept].todayVisits++;
      }
      jsonResp(res, 200, { departments: depts });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/vcred/reps/:id/transition
  const repTransMatch = pathname.match(/^\/api\/vcred\/reps\/([^/]+)\/transition$/);
  if (repTransMatch && req.method === "POST") {
    const rid = decodeURIComponent(repTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const reps = await collect("representatives", `values[Rep ID] = "${rid}"`, 1);
      if (reps.length === 0) { jsonResp(res, 404, { error: "Rep not found" }); return true; }
      const rep = reps[0];
      const current = vf(rep, "Status");
      const allowed = REP_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      await kineticRequest("PUT", `/submissions/${rep.id}/values`, { Status: newStatus }, auth);
      await logActivity(auth, `${vf(rep, "First Name")} ${vf(rep, "Last Name")}`, rid, vf(rep, "Vendor Name"),
        "Status Changed", "Representative", rid, current, newStatus, body.performer || "System",
        `Rep status changed from ${current} to ${newStatus}${body.reason ? ": " + body.reason : ""}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/vcred/access/:id/transition
  const accessTransMatch = pathname.match(/^\/api\/vcred\/access\/([^/]+)\/transition$/);
  if (accessTransMatch && req.method === "POST") {
    const aid = decodeURIComponent(accessTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const auths = await collect("access-authorizations", `values[Auth ID] = "${aid}"`, 1);
      if (auths.length === 0) { jsonResp(res, 404, { error: "Access authorization not found" }); return true; }
      const aa = auths[0];
      const current = vf(aa, "Status");
      const allowed = ACCESS_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Active" && !vf(aa, "Approval Date")) {
        updates["Approval Date"] = new Date().toISOString().slice(0, 10);
        updates["Approved By"] = body.performer || "System";
      }
      await kineticRequest("PUT", `/submissions/${aa.id}/values`, updates, auth);
      await logActivity(auth, vf(aa, "Rep Name"), vf(aa, "Rep ID"), vf(aa, "Vendor Name"),
        "Access " + newStatus, "Access Authorization", aid, current, newStatus, body.performer || "System",
        `${vf(aa, "Department")} access changed from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/vcred/visits/:id/checkout
  const visitMatch = pathname.match(/^\/api\/vcred\/visits\/([^/]+)\/checkout$/);
  if (visitMatch && req.method === "POST") {
    const vid = decodeURIComponent(visitMatch[1]);
    try {
      const visits = await collect("visits", `values[Visit ID] = "${vid}"`, 1);
      if (visits.length === 0) { jsonResp(res, 404, { error: "Visit not found" }); return true; }
      const visit = visits[0];
      if (vf(visit, "Status") !== "Checked In") {
        jsonResp(res, 400, { error: "Visit is not in Checked In status" }); return true;
      }
      const now = new Date();
      const checkOutTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const checkInParts = (vf(visit, "Check-In Time") || "12:00").split(":");
      const checkInMins = parseInt(checkInParts[0]) * 60 + parseInt(checkInParts[1]);
      const checkOutMins = now.getHours() * 60 + now.getMinutes();
      const duration = Math.max(0, checkOutMins - checkInMins);
      await kineticRequest("PUT", `/submissions/${visit.id}/values`, {
        "Check-Out Time": checkOutTime, "Duration Minutes": String(duration), Status: "Checked Out",
      }, auth);
      await logActivity(auth, vf(visit, "Rep Name"), vf(visit, "Rep ID"), vf(visit, "Vendor Name"),
        "Visit Check-Out", "Visit", vid, "Checked In", "Checked Out", "System",
        `Checked out at ${checkOutTime}, duration ${duration} minutes`);
      jsonResp(res, 200, { success: true, checkOutTime, duration });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/vcred/incidents/:id/transition
  const incTransMatch = pathname.match(/^\/api\/vcred\/incidents\/([^/]+)\/transition$/);
  if (incTransMatch && req.method === "POST") {
    const iid = decodeURIComponent(incTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const incs = await collect("incidents", `values[Incident ID] = "${iid}"`, 1);
      if (incs.length === 0) { jsonResp(res, 404, { error: "Incident not found" }); return true; }
      const inc = incs[0];
      const current = vf(inc, "Status");
      const allowed = INCIDENT_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Resolved") updates["Resolution Date"] = new Date().toISOString().slice(0, 10);
      if (body.escalatedTo) updates["Escalated To"] = body.escalatedTo;
      if (body.notes) updates["Investigation Notes"] = (vf(inc, "Investigation Notes") ? vf(inc, "Investigation Notes") + "\n" : "") + body.notes;
      if (body.correctiveAction) updates["Corrective Action"] = body.correctiveAction;
      await kineticRequest("PUT", `/submissions/${inc.id}/values`, updates, auth);
      await logActivity(auth, vf(inc, "Rep Name"), vf(inc, "Rep ID"), vf(inc, "Vendor Name"),
        "Incident " + newStatus, "Incident", iid, current, newStatus, body.performer || "System",
        `Incident ${iid} changed from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/vcred/report/:type
  const reportMatch = pathname.match(/^\/api\/vcred\/report\/([a-z-]+)$/);
  if (reportMatch && req.method === "GET") {
    const type = reportMatch[1];
    try {
      if (type === "vendor-roster") {
        const vendors = await collect("vendors", null, 4);
        const reps = await collect("representatives", null, 4);
        jsonResp(res, 200, {
          report: "Vendor Roster",
          vendors: vendors.map(v => ({
            vendorId: vf(v, "Vendor ID"), name: vf(v, "Vendor Name"), type: vf(v, "Vendor Type"),
            status: vf(v, "Status"), contract: vf(v, "Contract Status"), risk: vf(v, "Risk Level"),
            repCount: reps.filter(r => vf(r, "Vendor ID") === vf(v, "Vendor ID")).length,
          })),
        });
      } else if (type === "expiring") {
        const creds = await collect("credentials", null, 8);
        const now = Date.now();
        const d90 = now + 90 * 864e5;
        const expiring = creds
          .filter(c => { const exp = new Date(vf(c, "Expiration Date")).getTime(); return exp > now && exp <= d90 && vf(c, "Status") !== "Expired"; })
          .sort((a, b) => new Date(vf(a, "Expiration Date")).getTime() - new Date(vf(b, "Expiration Date")).getTime())
          .map(c => ({ credId: vf(c, "Credential ID"), repName: vf(c, "Rep Name"), repId: vf(c, "Rep ID"), vendor: vf(c, "Vendor Name"), type: vf(c, "Credential Type"), category: vf(c, "Credential Category"), expDate: vf(c, "Expiration Date"), status: vf(c, "Status") }));
        jsonResp(res, 200, { report: "Expiring Credentials", items: expiring });
      } else if (type === "compliance") {
        const reps = await collect("representatives", null, 4);
        const creds = await collect("credentials", null, 8);
        const items = reps.filter(r => vf(r, "Status") === "Active").map(r => {
          const rid = vf(r, "Rep ID");
          const rc = creds.filter(c => vf(c, "Rep ID") === rid);
          return {
            repId: rid, name: `${vf(r, "First Name")} ${vf(r, "Last Name")}`, vendor: vf(r, "Vendor Name"),
            title: vf(r, "Title"), complianceStatus: vf(r, "Compliance Status"),
            totalCreds: rc.length, active: rc.filter(c => vf(c, "Status") === "Active").length,
            expiring: rc.filter(c => vf(c, "Status") === "Expiring Soon").length,
            expired: rc.filter(c => vf(c, "Status") === "Expired").length,
          };
        });
        jsonResp(res, 200, { report: "Compliance Status", items });
      } else if (type === "access") {
        const access = await collect("access-authorizations", null, 4);
        jsonResp(res, 200, {
          report: "Access Authorizations",
          items: access.map(a => ({
            authId: vf(a, "Auth ID"), repName: vf(a, "Rep Name"), vendor: vf(a, "Vendor Name"),
            department: vf(a, "Department"), level: vf(a, "Access Level"), purpose: vf(a, "Purpose"),
            status: vf(a, "Status"), expDate: vf(a, "Expiration Date"),
          })),
        });
      } else if (type === "visit-log") {
        const visits = await collect("visits", null, 8);
        jsonResp(res, 200, {
          report: "Visit Log",
          items: visits.map(v => ({
            visitId: vf(v, "Visit ID"), repName: vf(v, "Rep Name"), vendor: vf(v, "Vendor Name"),
            department: vf(v, "Department"), date: vf(v, "Check-In Date"), checkIn: vf(v, "Check-In Time"),
            checkOut: vf(v, "Check-Out Time"), duration: vf(v, "Duration Minutes"),
            purpose: vf(v, "Purpose"), status: vf(v, "Status"),
          })),
        });
      } else if (type === "incidents") {
        const incidents = await collect("incidents", null, 4);
        jsonResp(res, 200, {
          report: "Incident Report",
          items: incidents.map(i => ({
            incidentId: vf(i, "Incident ID"), repName: vf(i, "Rep Name"), vendor: vf(i, "Vendor Name"),
            type: vf(i, "Incident Type"), severity: vf(i, "Severity"), department: vf(i, "Department"),
            date: vf(i, "Incident Date"), status: vf(i, "Status"), description: vf(i, "Description"),
          })),
        });
      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${type}` });
      }
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/vcred/search?q=&type=
  if (pathname === "/api/vcred/search" && req.method === "GET") {
    const parsedUrl = new URL(req.url, "http://localhost");
    const q = (parsedUrl.searchParams.get("q") || "").toLowerCase();
    const type = parsedUrl.searchParams.get("type") || "all";
    if (!q || q.length < 2) { jsonResp(res, 400, { error: "Query must be at least 2 characters" }); return true; }
    try {
      const results = [];
      const search = (arr, entityType, nameField, idField) => {
        for (const s of arr) {
          const name = vf(s, nameField).toLowerCase();
          const id = vf(s, idField).toLowerCase();
          const vendor = vf(s, "Vendor Name").toLowerCase();
          if (name.includes(q) || id.includes(q) || vendor.includes(q)) {
            results.push({ id: s.id, entityType, entityId: vf(s, idField), name: vf(s, nameField), vendor: vf(s, "Vendor Name"), status: vf(s, "Status") });
          }
        }
      };
      if (type === "all" || type === "vendors") {
        const vendors = await collect("vendors", null, 4);
        search(vendors, "Vendor", "Vendor Name", "Vendor ID");
      }
      if (type === "all" || type === "representatives") {
        const reps = await collect("representatives", null, 4);
        for (const r of reps) {
          const fullName = `${vf(r, "First Name")} ${vf(r, "Last Name")}`.toLowerCase();
          const id = vf(r, "Rep ID").toLowerCase();
          if (fullName.includes(q) || id.includes(q) || vf(r, "Vendor Name").toLowerCase().includes(q)) {
            results.push({ id: r.id, entityType: "Representative", entityId: vf(r, "Rep ID"), name: `${vf(r, "First Name")} ${vf(r, "Last Name")}`, vendor: vf(r, "Vendor Name"), status: vf(r, "Status") });
          }
        }
      }
      if (type === "all" || type === "products") {
        const products = await collect("products", null, 4);
        search(products, "Product", "Product Name", "Product ID");
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

  server.listen(PORT, () => console.log(`\n  Vendor Credentialing: http://localhost:${PORT}\n`));
}
