/**
 * Capital Assets — Custom API Handler
 */

export const appId = "capital-assets";
export const apiPrefix = "/api/cafm";
export const kapp = "capital-assets";

// ─── App-specific helpers ──────────────────────────────────────────────────

const vf = (s, f) => s.values?.[f] || "";
function nowISO() { return new Date().toISOString(); }
const WO_TRANSITIONS = {
  "Open": ["Assigned"],
  "Assigned": ["In Progress", "Cancelled"],
  "In Progress": ["On Hold", "Completed"],
  "On Hold": ["In Progress", "Cancelled"],
  "Completed": [],
  "Cancelled": [],
};
const PROJECT_TRANSITIONS = {
  "Proposed": ["Approved"],
  "Approved": ["In Progress"],
  "In Progress": ["On Hold", "Completed", "Cancelled"],
  "On Hold": ["In Progress", "Cancelled"],
  "Completed": [],
  "Cancelled": [],
};
async function logActivity(auth, action, entityType, entityId, prev, next, performer, details) {
  const logs = await collect("activity-log", null, 1);
  const logId = `LOG-${String(logs.length + 1).padStart(4, "0")}`;
  await kineticRequest("POST", `/kapps/${KAPP}/forms/activity-log/submissions`, {
    values: {
      "Log ID": logId,
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


  // 1. GET /api/cafm/dashboard
  if (pathname === "/api/cafm/dashboard" && req.method === "GET") {
    try {
      const [assets, workOrders, schedules, projects, facilities, inspections, depreciation, budgets] = await Promise.all([
        collect("assets", null, 8),
        collect("work-orders", null, 8),
        collect("maintenance-schedules", null, 4),
        collect("projects", null, 4),
        collect("facilities", null, 2),
        collect("inspections", null, 4),
        collect("depreciation", null, 8),
        collect("budgets", null, 4),
      ]);

      // KPIs
      const totalAssets = assets.length;
      const activeWOs = workOrders.filter(w => !["Completed", "Cancelled"].includes(vf(w, "Status"))).length;
      const overduePMs = schedules.filter(s => vf(s, "Status") === "Overdue").length;
      const activeProjects = projects.filter(p => vf(p, "Status") === "In Progress").length;

      let totalAssetValue = 0;
      for (const a of assets) totalAssetValue += parseInt(vf(a, "Current Value") || "0");

      let totalScore = 0, scoreCount = 0;
      for (const f of facilities) {
        const score = parseInt(vf(f, "Condition Score") || "0");
        if (score > 0) { totalScore += score; scoreCount++; }
      }
      const avgConditionScore = scoreCount > 0 ? (totalScore / scoreCount).toFixed(1) : "0";

      // Recent work orders (10)
      const recentWOs = workOrders
        .sort((a, b) => (vf(b, "Requested Date") || "").localeCompare(vf(a, "Requested Date") || ""))
        .slice(0, 10)
        .map(w => ({
          id: w.id, woId: vf(w, "WO ID"), assetName: vf(w, "Asset Name"),
          type: vf(w, "WO Type"), priority: vf(w, "Priority"), status: vf(w, "Status"),
          facility: vf(w, "Facility Name"), date: vf(w, "Requested Date"),
        }));

      // WO pipeline
      const woPipeline = { Open: 0, Assigned: 0, "In Progress": 0, "On Hold": 0, Completed: 0, Cancelled: 0 };
      for (const w of workOrders) {
        const st = vf(w, "Status");
        if (st in woPipeline) woPipeline[st]++;
      }

      // Project status
      const projectStatus = projects.map(p => ({
        id: p.id, projectId: vf(p, "Project ID"), name: vf(p, "Project Name"),
        type: vf(p, "Project Type"), phase: vf(p, "Phase"), status: vf(p, "Status"),
        budget: vf(p, "Budget"), spent: vf(p, "Spent"), target: vf(p, "Target Completion"),
      }));

      jsonResp(res, 200, {
        totalAssets, activeWOs, overduePMs, activeProjects, totalAssetValue, avgConditionScore,
        recentWOs, woPipeline, projectStatus,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 2. GET /api/cafm/asset/:id/history
  const assetMatch = pathname.match(/^\/api\/cafm\/asset\/([^/]+)\/history$/);
  if (assetMatch && req.method === "GET") {
    const aid = decodeURIComponent(assetMatch[1]);
    try {
      const [assetArr, woArr, inspArr, deprArr, msArr] = await Promise.all([
        collect("assets", `values[Asset ID] = "${aid}"`, 1),
        collect("work-orders", `values[Asset ID] = "${aid}"`, 4),
        collect("inspections", `values[Asset ID] = "${aid}"`, 4),
        collect("depreciation", `values[Asset ID] = "${aid}"`, 4),
        collect("maintenance-schedules", `values[Asset ID] = "${aid}"`, 4),
      ]);
      if (assetArr.length === 0) { jsonResp(res, 404, { error: "Asset not found" }); return true; }
      const m = (s) => ({ id: s.id, ...s.values });
      jsonResp(res, 200, {
        asset: m(assetArr[0]),
        workOrders: woArr.map(m),
        inspections: inspArr.map(m),
        depreciation: deprArr.map(m),
        maintenance: msArr.map(m),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 3. GET /api/cafm/stats/maintenance
  if (pathname === "/api/cafm/stats/maintenance" && req.method === "GET") {
    try {
      const [workOrders, schedules] = await Promise.all([
        collect("work-orders", null, 8),
        collect("maintenance-schedules", null, 4),
      ]);

      // WO by type
      const byType = {};
      for (const w of workOrders) {
        const t = vf(w, "WO Type") || "Unknown";
        byType[t] = (byType[t] || 0) + 1;
      }

      // PM compliance
      const totalPMs = schedules.length;
      const activePMs = schedules.filter(s => vf(s, "Status") === "Active").length;
      const overduePMs = schedules.filter(s => vf(s, "Status") === "Overdue").length;
      const pmCompliance = totalPMs > 0 ? ((activePMs / totalPMs) * 100).toFixed(1) : "0";

      // Cost by trade
      const costByTrade = {};
      for (const w of workOrders) {
        if (vf(w, "Status") === "Completed") {
          const trade = vf(w, "Trade") || "Unknown";
          costByTrade[trade] = (costByTrade[trade] || 0) + parseInt(vf(w, "Actual Cost") || "0");
        }
      }

      // WO by priority
      const byPriority = { Critical: 0, High: 0, Medium: 0, Low: 0 };
      for (const w of workOrders) {
        const p = vf(w, "Priority");
        if (p in byPriority) byPriority[p]++;
      }

      jsonResp(res, 200, { byType, pmCompliance, overduePMs, totalPMs, activePMs, costByTrade, byPriority });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 4. GET /api/cafm/stats/financials
  if (pathname === "/api/cafm/stats/financials" && req.method === "GET") {
    try {
      const [assets, depreciation, budgets] = await Promise.all([
        collect("assets", null, 8),
        collect("depreciation", null, 8),
        collect("budgets", null, 4),
      ]);

      // Asset values by type
      const valueByType = {};
      for (const a of assets) {
        const t = vf(a, "Asset Type") || "Unknown";
        if (!valueByType[t]) valueByType[t] = { original: 0, current: 0, count: 0 };
        valueByType[t].original += parseInt(vf(a, "Purchase Cost") || "0");
        valueByType[t].current += parseInt(vf(a, "Current Value") || "0");
        valueByType[t].count++;
      }

      // Depreciation summary
      let totalOriginal = 0, totalAccumDepr = 0, totalBookValue = 0;
      for (const dep of depreciation) {
        totalOriginal += parseInt(vf(dep, "Original Cost") || "0");
        totalAccumDepr += parseInt(vf(dep, "Accumulated Depreciation") || "0");
        totalBookValue += parseInt(vf(dep, "Book Value") || "0");
      }

      // Budget utilization
      const budgetSummary = {};
      for (const b of budgets) {
        const cat = vf(b, "Category") || "Unknown";
        if (!budgetSummary[cat]) budgetSummary[cat] = { approved: 0, spent: 0, available: 0 };
        budgetSummary[cat].approved += parseInt(vf(b, "Approved Amount") || "0");
        budgetSummary[cat].spent += parseInt(vf(b, "Spent Amount") || "0");
        budgetSummary[cat].available += parseInt(vf(b, "Available Amount") || "0");
      }

      jsonResp(res, 200, {
        valueByType, totalOriginal, totalAccumDepr, totalBookValue, budgetSummary,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 5. POST /api/cafm/work-orders/:id/transition
  const woTransMatch = pathname.match(/^\/api\/cafm\/work-orders\/([^/]+)\/transition$/);
  if (woTransMatch && req.method === "POST") {
    const wid = decodeURIComponent(woTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const wos = await collect("work-orders", `values[WO ID] = "${wid}"`, 1);
      if (wos.length === 0) { jsonResp(res, 404, { error: "Work order not found" }); return true; }
      const wo = wos[0];
      const current = vf(wo, "Status");
      const allowed = WO_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Completed") updates["Completed Date"] = new Date().toISOString().slice(0, 10);
      if (newStatus === "Assigned" && body.assignedTo) updates["Assigned To"] = body.assignedTo;
      if (body.actualCost) updates["Actual Cost"] = body.actualCost;
      if (body.actualHours) updates["Actual Hours"] = body.actualHours;
      await kineticRequest("PUT", `/submissions/${wo.id}/values`, updates, auth);
      await logActivity(auth, "Status Changed", "Work Order", wid, current, newStatus,
        body.performer || "System", `Work order ${wid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 6. POST /api/cafm/projects/:id/transition
  const projTransMatch = pathname.match(/^\/api\/cafm\/projects\/([^/]+)\/transition$/);
  if (projTransMatch && req.method === "POST") {
    const pid = decodeURIComponent(projTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const projs = await collect("projects", `values[Project ID] = "${pid}"`, 1);
      if (projs.length === 0) { jsonResp(res, 404, { error: "Project not found" }); return true; }
      const proj = projs[0];
      const current = vf(proj, "Status");
      const allowed = PROJECT_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Completed") updates["Actual Completion"] = new Date().toISOString().slice(0, 10);
      if (newStatus === "In Progress" && !vf(proj, "Start Date")) updates["Start Date"] = new Date().toISOString().slice(0, 10);
      if (body.phase) updates["Phase"] = body.phase;
      await kineticRequest("PUT", `/submissions/${proj.id}/values`, updates, auth);
      await logActivity(auth, "Status Changed", "Project", pid, current, newStatus,
        body.performer || "System", `Project ${pid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 7. GET /api/cafm/report/:type
  const reportMatch = pathname.match(/^\/api\/cafm\/report\/([a-z-]+)$/);
  if (reportMatch && req.method === "GET") {
    const type = reportMatch[1];
    try {
      if (type === "asset-inventory") {
        const assets = await collect("assets", null, 8);
        jsonResp(res, 200, {
          report: "Asset Inventory",
          items: assets.map(a => ({
            assetId: vf(a, "Asset ID"), name: vf(a, "Asset Name"), type: vf(a, "Asset Type"),
            category: vf(a, "Category"), facility: vf(a, "Facility Name"), location: vf(a, "Location"),
            cost: vf(a, "Purchase Cost"), currentValue: vf(a, "Current Value"), status: vf(a, "Status"),
            manufacturer: vf(a, "Manufacturer"), model: vf(a, "Model"),
          })),
        });
      } else if (type === "maintenance") {
        const [wos, schedules] = await Promise.all([
          collect("work-orders", null, 8),
          collect("maintenance-schedules", null, 4),
        ]);
        jsonResp(res, 200, {
          report: "Maintenance Report",
          workOrders: wos.map(w => ({
            woId: vf(w, "WO ID"), asset: vf(w, "Asset Name"), type: vf(w, "WO Type"),
            priority: vf(w, "Priority"), trade: vf(w, "Trade"), status: vf(w, "Status"),
            estCost: vf(w, "Estimated Cost"), actCost: vf(w, "Actual Cost"),
            requested: vf(w, "Requested Date"), completed: vf(w, "Completed Date"),
          })),
          schedules: schedules.map(s => ({
            scheduleId: vf(s, "Schedule ID"), asset: vf(s, "Asset Name"),
            task: vf(s, "Task Description"), frequency: vf(s, "Frequency"),
            nextDue: vf(s, "Next Due"), status: vf(s, "Status"),
          })),
        });
      } else if (type === "depreciation") {
        const depr = await collect("depreciation", null, 8);
        jsonResp(res, 200, {
          report: "Depreciation Schedule",
          items: depr.map(dep => ({
            deprId: vf(dep, "Depreciation ID"), asset: vf(dep, "Asset Name"),
            method: vf(dep, "Method"), original: vf(dep, "Original Cost"),
            accumulated: vf(dep, "Accumulated Depreciation"), bookValue: vf(dep, "Book Value"),
            annual: vf(dep, "Annual Depreciation"), remaining: vf(dep, "Useful Life Remaining"),
            status: vf(dep, "Status"),
          })),
        });
      } else if (type === "project") {
        const projs = await collect("projects", null, 4);
        jsonResp(res, 200, {
          report: "Capital Projects",
          items: projs.map(p => ({
            projectId: vf(p, "Project ID"), name: vf(p, "Project Name"), type: vf(p, "Project Type"),
            facility: vf(p, "Facility Name"), phase: vf(p, "Phase"), status: vf(p, "Status"),
            budget: vf(p, "Budget"), spent: vf(p, "Spent"),
            start: vf(p, "Start Date"), target: vf(p, "Target Completion"),
            contractor: vf(p, "Contractor"),
          })),
        });
      } else if (type === "inspection") {
        const insps = await collect("inspections", null, 4);
        jsonResp(res, 200, {
          report: "Inspection Report",
          items: insps.map(i => ({
            inspId: vf(i, "Inspection ID"), facility: vf(i, "Facility Name"),
            type: vf(i, "Inspection Type"), inspector: vf(i, "Inspector"),
            date: vf(i, "Inspection Date"), nextDue: vf(i, "Next Due Date"),
            result: vf(i, "Result"), findings: vf(i, "Findings Count"),
            critical: vf(i, "Critical Findings"), status: vf(i, "Status"),
          })),
        });
      } else if (type === "budget") {
        const buds = await collect("budgets", null, 4);
        jsonResp(res, 200, {
          report: "Budget Report",
          items: buds.map(b => ({
            budgetId: vf(b, "Budget ID"), dept: vf(b, "Department"),
            fy: vf(b, "Fiscal Year"), category: vf(b, "Category"),
            budgeted: vf(b, "Budgeted Amount"), approved: vf(b, "Approved Amount"),
            spent: vf(b, "Spent Amount"), committed: vf(b, "Committed Amount"),
            available: vf(b, "Available Amount"), status: vf(b, "Status"),
          })),
        });
      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${type}` });
      }
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 8. GET /api/cafm/search?q=&type=
  if (pathname === "/api/cafm/search" && req.method === "GET") {
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
            results.push({ id: s.id, entityType, entityId: vf(s, idField), name: vf(s, nameField), status: vf(s, "Status"), facility: vf(s, "Facility Name") || "" });
          }
        }
      };
      if (type === "all" || type === "assets") {
        const arr = await collect("assets", null, 8);
        search(arr, "Asset", "Asset Name", "Asset ID");
      }
      if (type === "all" || type === "work-orders") {
        const arr = await collect("work-orders", null, 8);
        search(arr, "Work Order", "Asset Name", "WO ID");
      }
      if (type === "all" || type === "facilities") {
        const arr = await collect("facilities", null, 2);
        search(arr, "Facility", "Facility Name", "Facility ID");
      }
      if (type === "all" || type === "projects") {
        const arr = await collect("projects", null, 4);
        search(arr, "Project", "Project Name", "Project ID");
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

  server.listen(PORT, () => console.log(`\n  Capital Assets: http://localhost:${PORT}\n`));
}
