/**
 * Grants & Funding — Custom API Handler
 */

export const appId = "grants-funding";
export const apiPrefix = "/api/grants";
export const kapp = "grants-funding";

// ─── App-specific helpers ──────────────────────────────────────────────────

const vf = (s, f) => s.values?.[f] || "";
function nowISO() { return new Date().toISOString(); }
const APPLICATION_TRANSITIONS = {
  "Drafting": ["Internal Review"],
  "Internal Review": ["Submitted", "Drafting"],
  "Submitted": ["Under Review"],
  "Under Review": ["Awarded", "Declined"],
  "Awarded": [],
  "Declined": ["Drafting"],
  "Withdrawn": [],
};
const GRANT_TRANSITIONS = {
  "Pre-Award": ["Active"],
  "Active": ["No Cost Extension", "Closeout", "Suspended"],
  "No Cost Extension": ["Closeout"],
  "Closeout": ["Closed"],
  "Suspended": ["Active", "Closeout"],
  "Closed": [],
};
async function logActivity(auth, entityType, entityId, action, prev, next, performer, details) {
  const logs = await collect("activity-log", null, 1);
  const logId = `LOG-${String(logs.length + 1).padStart(4, "0")}`;
  await kineticRequest("POST", `/kapps/${KAPP}/forms/activity-log/submissions`, {
    values: {
      "Log ID": logId, "Entity Type": entityType, "Entity ID": entityId,
      Action: action, "Previous Value": prev, "New Value": next,
      "Performed By": performer, Timestamp: nowISO(), Details: details,
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


  // 1. GET /api/grants/dashboard
  if (pathname === "/api/grants/dashboard" && req.method === "GET") {
    try {
      const [grants, applications, budgets, milestones, reports, expenditures] = await Promise.all([
        collect("grants", null, 4),
        collect("applications", null, 4),
        collect("budgets", null, 8),
        collect("milestones", null, 4),
        collect("reports", null, 4),
        collect("expenditures", null, 8),
      ]);

      const now = Date.now();
      const d90 = new Date(now + 90 * 864e5).toISOString().slice(0, 10);
      const d30 = new Date(now + 30 * 864e5).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);

      // KPIs
      const activeGrants = grants.filter(g => vf(g, "Status") === "Active" || vf(g, "Status") === "No Cost Extension").length;
      const totalFunding = grants.reduce((sum, g) => {
        const s = vf(g, "Status");
        return (s === "Active" || s === "No Cost Extension") ? sum + (parseInt(vf(g, "Award Amount")) || 0) : sum;
      }, 0);
      const pendingApps = applications.filter(a => ["Drafting", "Internal Review", "Submitted", "Under Review"].includes(vf(a, "Status"))).length;

      // Budget utilization
      let totalBudgeted = 0, totalSpent = 0;
      for (const b of budgets) {
        if (vf(b, "Status") === "Active" || vf(b, "Status") === "Under Review") {
          totalBudgeted += parseInt(vf(b, "Budgeted Amount")) || 0;
          totalSpent += parseInt(vf(b, "Spent Amount")) || 0;
        }
      }
      const budgetUtil = totalBudgeted > 0 ? ((totalSpent / totalBudgeted) * 100).toFixed(1) : "0.0";

      // Upcoming deadlines (reports + milestones due within 30 days)
      const upcomingDeadlines = [];
      for (const r of reports) {
        const due = vf(r, "Due Date");
        if (due && due >= today && due <= d30 && !["Accepted", "Submitted"].includes(vf(r, "Status"))) {
          upcomingDeadlines.push({ type: "Report", name: `${vf(r, "Report Type")} - ${vf(r, "Grant Title")}`, due, status: vf(r, "Status") });
        }
      }
      for (const m of milestones) {
        const planned = vf(m, "Planned Date");
        if (planned && planned >= today && planned <= d30 && !["Completed", "Waived"].includes(vf(m, "Status"))) {
          upcomingDeadlines.push({ type: "Milestone", name: `${vf(m, "Milestone Name")} - ${vf(m, "Grant Title")}`, due: planned, status: vf(m, "Status") });
        }
      }
      upcomingDeadlines.sort((a, b) => a.due.localeCompare(b.due));

      // Expiring grants (end date within 90 days)
      const expiringGrants = grants.filter(g => {
        const end = vf(g, "End Date");
        const s = vf(g, "Status");
        return end && end <= d90 && end >= today && (s === "Active" || s === "No Cost Extension");
      }).length;

      // Recent applications
      const recentApps = applications
        .sort((a, b) => (vf(b, "Submission Deadline") || "").localeCompare(vf(a, "Submission Deadline") || ""))
        .slice(0, 8)
        .map(a => ({
          id: a.id, appId: vf(a, "Application ID"), title: vf(a, "Grant Title"),
          funder: vf(a, "Funder Name"), amount: vf(a, "Requested Amount"),
          priority: vf(a, "Priority"), status: vf(a, "Status"),
          deadline: vf(a, "Submission Deadline"),
        }));

      // Budget overview by category
      const budgetOverview = {};
      for (const b of budgets) {
        const cat = vf(b, "Budget Category") || "Other";
        if (!budgetOverview[cat]) budgetOverview[cat] = { budgeted: 0, spent: 0 };
        budgetOverview[cat].budgeted += parseInt(vf(b, "Budgeted Amount")) || 0;
        budgetOverview[cat].spent += parseInt(vf(b, "Spent Amount")) || 0;
      }

      jsonResp(res, 200, {
        activeGrants, totalFunding, pendingApps, budgetUtil,
        upcomingDeadlines: upcomingDeadlines.slice(0, 10), expiringGrants,
        recentApps, budgetOverview,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 2. GET /api/grants/grant/:id/summary
  const grantSumMatch = pathname.match(/^\/api\/grants\/grant\/([^/]+)\/summary$/);
  if (grantSumMatch && req.method === "GET") {
    const gid = decodeURIComponent(grantSumMatch[1]);
    try {
      const kql = `values[Grant ID] = "${gid}"`;
      const [grantArr, awardArr, budgetArr, expArr, msArr, perArr] = await Promise.all([
        collect("grants", kql, 1),
        collect("awards", `values[Grant ID] = "${gid}"`, 4),
        collect("budgets", `values[Grant ID] = "${gid}"`, 4),
        collect("expenditures", `values[Grant ID] = "${gid}"`, 8),
        collect("milestones", `values[Grant ID] = "${gid}"`, 4),
        collect("personnel", `values[Grant ID] = "${gid}"`, 4),
      ]);
      if (grantArr.length === 0) { jsonResp(res, 404, { error: "Grant not found" }); return true; }
      const m = (s) => ({ id: s.id, ...s.values });
      jsonResp(res, 200, {
        grant: m(grantArr[0]),
        awards: awardArr.map(m),
        budgets: budgetArr.map(m),
        expenditures: expArr.map(m),
        milestones: msArr.map(m),
        personnel: perArr.map(m),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 3. GET /api/grants/stats/funding
  if (pathname === "/api/grants/stats/funding" && req.method === "GET") {
    try {
      const [grants, funders] = await Promise.all([
        collect("grants", null, 4),
        collect("funders", null, 2),
      ]);

      // By source
      const bySource = {};
      for (const g of grants) {
        const funder = vf(g, "Funder Name") || "Unknown";
        if (!bySource[funder]) bySource[funder] = { count: 0, total: 0 };
        bySource[funder].count++;
        bySource[funder].total += parseInt(vf(g, "Award Amount")) || 0;
      }

      // By department
      const byDept = {};
      for (const g of grants) {
        const dept = vf(g, "Department") || "Unknown";
        if (!byDept[dept]) byDept[dept] = { count: 0, total: 0 };
        byDept[dept].count++;
        byDept[dept].total += parseInt(vf(g, "Award Amount")) || 0;
      }

      // By category (grant type)
      const byCategory = {};
      for (const g of grants) {
        const cat = vf(g, "Grant Type") || "Unknown";
        if (!byCategory[cat]) byCategory[cat] = { count: 0, total: 0 };
        byCategory[cat].count++;
        byCategory[cat].total += parseInt(vf(g, "Award Amount")) || 0;
      }

      // Trends (by status)
      const byStatus = {};
      for (const g of grants) {
        const st = vf(g, "Status") || "Unknown";
        byStatus[st] = (byStatus[st] || 0) + 1;
      }

      jsonResp(res, 200, { bySource, byDept, byCategory, byStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 4. GET /api/grants/stats/compliance
  if (pathname === "/api/grants/stats/compliance" && req.method === "GET") {
    try {
      const [reports, expenditures, milestones] = await Promise.all([
        collect("reports", null, 4),
        collect("expenditures", null, 8),
        collect("milestones", null, 4),
      ]);

      // Report timeliness
      const today = new Date().toISOString().slice(0, 10);
      let onTime = 0, late = 0, pending = 0;
      for (const r of reports) {
        const status = vf(r, "Status");
        const due = vf(r, "Due Date");
        const submitted = vf(r, "Submitted Date");
        if (status === "Accepted" || status === "Submitted") {
          if (submitted && due && submitted <= due) onTime++;
          else late++;
        } else {
          pending++;
        }
      }

      // Expenditure allowability
      let allowable = 0, notAllowable = 0, underReview = 0;
      for (const e of expenditures) {
        const a = vf(e, "Allowable");
        if (a === "Yes") allowable++;
        else if (a === "No") notAllowable++;
        else underReview++;
      }

      // Milestone completion
      let completed = 0, onTrack = 0, atRisk = 0, delayed = 0;
      for (const m of milestones) {
        const s = vf(m, "Status");
        if (s === "Completed") completed++;
        else if (s === "On Track" || s === "Upcoming") onTrack++;
        else if (s === "At Risk") atRisk++;
        else if (s === "Delayed") delayed++;
      }

      jsonResp(res, 200, {
        reportTimeliness: { onTime, late, pending, total: reports.length },
        expenditureAllowability: { allowable, notAllowable, underReview, total: expenditures.length },
        milestoneCompletion: { completed, onTrack, atRisk, delayed, total: milestones.length },
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 5. POST /api/grants/applications/:id/transition
  const appTransMatch = pathname.match(/^\/api\/grants\/applications\/([^/]+)\/transition$/);
  if (appTransMatch && req.method === "POST") {
    const aid = decodeURIComponent(appTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const apps = await collect("applications", `values[Application ID] = "${aid}"`, 1);
      if (apps.length === 0) { jsonResp(res, 404, { error: "Application not found" }); return true; }
      const app = apps[0];
      const current = vf(app, "Status");
      const allowed = APPLICATION_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Submitted") updates["Submitted Date"] = new Date().toISOString().slice(0, 10);
      await kineticRequest("PUT", `/submissions/${app.id}/values`, updates, auth);
      await logActivity(auth, "Application", aid, "Status Changed", current, newStatus,
        body.performer || "System", `Application ${aid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 6. POST /api/grants/grants/:id/transition
  const grantTransMatch = pathname.match(/^\/api\/grants\/grants\/([^/]+)\/transition$/);
  if (grantTransMatch && req.method === "POST") {
    const gid = decodeURIComponent(grantTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const grnts = await collect("grants", `values[Grant ID] = "${gid}"`, 1);
      if (grnts.length === 0) { jsonResp(res, 404, { error: "Grant not found" }); return true; }
      const grant = grnts[0];
      const current = vf(grant, "Status");
      const allowed = GRANT_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      await kineticRequest("PUT", `/submissions/${grant.id}/values`, updates, auth);
      await logActivity(auth, "Grant", gid, "Status Changed", current, newStatus,
        body.performer || "System", `Grant ${gid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 7. GET /api/grants/report/:type
  const reportMatch = pathname.match(/^\/api\/grants\/report\/([a-z-]+)$/);
  if (reportMatch && req.method === "GET") {
    const type = reportMatch[1];
    try {
      if (type === "funding-summary") {
        const grants = await collect("grants", null, 4);
        jsonResp(res, 200, {
          report: "Funding Summary",
          items: grants.map(g => ({
            grantId: vf(g, "Grant ID"), title: vf(g, "Grant Title"), funder: vf(g, "Funder Name"),
            type: vf(g, "Grant Type"), pi: vf(g, "PI Name"), dept: vf(g, "Department"),
            award: vf(g, "Award Amount"), remaining: vf(g, "Remaining Balance"),
            status: vf(g, "Status"), start: vf(g, "Start Date"), end: vf(g, "End Date"),
          })),
        });
      } else if (type === "budget") {
        const budgets = await collect("budgets", null, 8);
        jsonResp(res, 200, {
          report: "Budget Analysis",
          items: budgets.map(b => ({
            budgetId: vf(b, "Budget ID"), grantId: vf(b, "Grant ID"), title: vf(b, "Grant Title"),
            category: vf(b, "Budget Category"), period: vf(b, "Budget Period"),
            budgeted: vf(b, "Budgeted Amount"), spent: vf(b, "Spent Amount"),
            committed: vf(b, "Committed Amount"), available: vf(b, "Available Amount"),
            status: vf(b, "Status"),
          })),
        });
      } else if (type === "expenditure") {
        const expenditures = await collect("expenditures", null, 8);
        jsonResp(res, 200, {
          report: "Expenditure Detail",
          items: expenditures.map(e => ({
            expId: vf(e, "Expenditure ID"), grantId: vf(e, "Grant ID"), title: vf(e, "Grant Title"),
            category: vf(e, "Budget Category"), desc: vf(e, "Description"),
            amount: vf(e, "Amount"), vendor: vf(e, "Vendor"), date: vf(e, "Date"),
            allowable: vf(e, "Allowable"), status: vf(e, "Status"),
          })),
        });
      } else if (type === "milestone") {
        const milestones = await collect("milestones", null, 4);
        jsonResp(res, 200, {
          report: "Milestone Tracking",
          items: milestones.map(m => ({
            msId: vf(m, "Milestone ID"), grantId: vf(m, "Grant ID"), title: vf(m, "Grant Title"),
            name: vf(m, "Milestone Name"), category: vf(m, "Category"),
            planned: vf(m, "Planned Date"), actual: vf(m, "Actual Date"),
            responsible: vf(m, "Responsible Person"), status: vf(m, "Status"),
          })),
        });
      } else if (type === "personnel") {
        const personnel = await collect("personnel", null, 4);
        jsonResp(res, 200, {
          report: "Personnel Effort",
          items: personnel.map(p => ({
            perId: vf(p, "Personnel ID"), grantId: vf(p, "Grant ID"), title: vf(p, "Grant Title"),
            name: vf(p, "Staff Name"), role: vf(p, "Role"), dept: vf(p, "Department"),
            fte: vf(p, "FTE Percentage"), salary: vf(p, "Annual Salary"),
            funded: vf(p, "Grant Funded Amount"), status: vf(p, "Status"),
          })),
        });
      } else if (type === "compliance") {
        const [reports, expenditures, milestones] = await Promise.all([
          collect("reports", null, 4),
          collect("expenditures", null, 8),
          collect("milestones", null, 4),
        ]);
        const overdueReports = reports.filter(r => {
          const due = vf(r, "Due Date");
          const today = new Date().toISOString().slice(0, 10);
          return due && due < today && !["Accepted", "Submitted"].includes(vf(r, "Status"));
        });
        const disallowedExp = expenditures.filter(e => vf(e, "Allowable") === "No");
        const delayedMs = milestones.filter(m => vf(m, "Status") === "Delayed" || vf(m, "Status") === "At Risk");
        jsonResp(res, 200, {
          report: "Compliance Summary",
          overdueReports: overdueReports.map(r => ({
            id: vf(r, "Report ID"), type: vf(r, "Report Type"), grant: vf(r, "Grant Title"),
            due: vf(r, "Due Date"), status: vf(r, "Status"),
          })),
          disallowedExpenditures: disallowedExp.map(e => ({
            id: vf(e, "Expenditure ID"), grant: vf(e, "Grant Title"), desc: vf(e, "Description"),
            amount: vf(e, "Amount"), status: vf(e, "Status"),
          })),
          delayedMilestones: delayedMs.map(m => ({
            id: vf(m, "Milestone ID"), name: vf(m, "Milestone Name"), grant: vf(m, "Grant Title"),
            planned: vf(m, "Planned Date"), status: vf(m, "Status"),
          })),
        });
      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${type}` });
      }
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 8. GET /api/grants/search?q=&type=
  if (pathname === "/api/grants/search" && req.method === "GET") {
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
      if (type === "all" || type === "grants") {
        const grants = await collect("grants", null, 4);
        search(grants, "Grant", "Grant Title", "Grant ID");
      }
      if (type === "all" || type === "applications") {
        const apps = await collect("applications", null, 4);
        search(apps, "Application", "Grant Title", "Application ID");
      }
      if (type === "all" || type === "funders") {
        const funders = await collect("funders", null, 2);
        search(funders, "Funder", "Funder Name", "Funder ID");
      }
      if (type === "all" || type === "personnel") {
        const per = await collect("personnel", null, 4);
        search(per, "Personnel", "Staff Name", "Personnel ID");
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

  server.listen(PORT, () => console.log(`\n  Grants & Funding: http://localhost:${PORT}\n`));
}
