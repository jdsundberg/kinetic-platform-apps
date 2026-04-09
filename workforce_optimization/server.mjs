/**
 * Workforce Optimization — Custom API Handler
 */

export const appId = "workforce-optimization";
export const apiPrefix = "/api/wfo";
export const kapp = "workforce-optimization";

// ─── App-specific helpers ──────────────────────────────────────────────────

const vf = (s, f) => s.values?.[f] || "";
function nowISO() { return new Date().toISOString(); }
const VACANCY_TRANSITIONS = {
  "Open": ["Interviewing", "On Hold", "Cancelled"],
  "Interviewing": ["Offer Extended", "Open", "Cancelled"],
  "Offer Extended": ["Filled", "Open"],
  "Filled": [],
  "Cancelled": [],
  "On Hold": ["Open", "Cancelled"],
};
const SCHEDULE_TRANSITIONS = {
  "Draft": ["Published"],
  "Published": ["Confirmed", "Cancelled"],
  "Confirmed": ["Completed", "Cancelled", "No Show"],
  "Completed": [],
  "Cancelled": [],
  "No Show": [],
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


  // 1. GET /api/wfo/dashboard
  if (pathname === "/api/wfo/dashboard" && req.method === "GET") {
    try {
      const [staff, vacancies, overtime, certs, schedules, departments] = await Promise.all([
        collect("staff-roster", null, 8),
        collect("vacancies", null, 4),
        collect("overtime-records", null, 4),
        collect("certifications", null, 4),
        collect("schedules", null, 4),
        collect("departments", null, 2),
      ]);

      const now = Date.now();
      const d30ago = new Date(now - 30 * 864e5).toISOString().slice(0, 10);

      // KPIs
      const activeStaff = staff.filter(s => vf(s, "Status") === "Active").length;
      const totalStaff = staff.length;
      const openVacancies = vacancies.filter(v => !["Filled", "Cancelled"].includes(vf(v, "Status"))).length;

      const otLast30 = overtime.filter(o => (vf(o, "OT Date") || "") >= d30ago);
      const otHours30d = otLast30.reduce((sum, o) => sum + (Number(vf(o, "OT Hours")) || 0), 0);

      // Vacancy rate
      const totalBudgetedFTEs = departments.reduce((sum, d) => sum + (Number(vf(d, "Budgeted FTEs")) || 0), 0);
      const vacancyRate = totalBudgetedFTEs > 0 ? ((openVacancies / totalBudgetedFTEs) * 100).toFixed(1) : "0";

      // Avg tenure
      const activeWithTenure = staff.filter(s => vf(s, "Status") === "Active" && vf(s, "Tenure Years"));
      const avgTenure = activeWithTenure.length > 0
        ? (activeWithTenure.reduce((sum, s) => sum + Number(vf(s, "Tenure Years")), 0) / activeWithTenure.length).toFixed(1)
        : "0";

      // Cert compliance
      const currentCerts = certs.filter(c => vf(c, "Status") === "Current").length;
      const certCompliance = certs.length > 0 ? ((currentCerts / certs.length) * 100).toFixed(1) : "100";

      // Recent schedules
      const recentSchedules = schedules
        .filter(s => !["Completed", "Cancelled"].includes(vf(s, "Status")))
        .sort((a, b) => (vf(a, "Schedule Date") || "").localeCompare(vf(b, "Schedule Date") || ""))
        .slice(0, 10)
        .map(s => ({ id: s.id, schedId: vf(s, "Schedule ID"), staffName: vf(s, "Staff Name"), dept: vf(s, "Department"), shiftName: vf(s, "Shift Name"), date: vf(s, "Schedule Date"), status: vf(s, "Status") }));

      // Open vacancies list
      const vacancyList = vacancies
        .filter(v => !["Filled", "Cancelled"].includes(vf(v, "Status")))
        .sort((a, b) => {
          const pOrd = { Critical: 0, High: 1, Medium: 2, Low: 3 };
          return (pOrd[vf(a, "Priority")] ?? 9) - (pOrd[vf(b, "Priority")] ?? 9);
        })
        .slice(0, 10)
        .map(v => ({ id: v.id, vacId: vf(v, "Vacancy ID"), title: vf(v, "Position Title"), dept: vf(v, "Department"), priority: vf(v, "Priority"), status: vf(v, "Status"), targetFill: vf(v, "Target Fill Date"), applicants: vf(v, "Applicants") }));

      jsonResp(res, 200, {
        totalStaff, activeStaff, openVacancies, otHours30d, vacancyRate, avgTenure, certCompliance,
        recentSchedules, vacancyList,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 2. GET /api/wfo/department/:id/summary
  const deptSumMatch = pathname.match(/^\/api\/wfo\/department\/([^/]+)\/summary$/);
  if (deptSumMatch && req.method === "GET") {
    const did = decodeURIComponent(deptSumMatch[1]);
    try {
      const depts = await collect("departments", `values[Department ID] = "${did}"`, 1);
      if (depts.length === 0) { jsonResp(res, 404, { error: "Department not found" }); return true; }
      const dept = depts[0];
      const deptName = vf(dept, "Department Name");

      const [staffArr, vacArr, prodArr] = await Promise.all([
        collect("staff-roster", `values[Department] = "${deptName}"`, 4),
        collect("vacancies", `values[Department] = "${deptName}"`, 2),
        collect("productivity-metrics", `values[Department] = "${deptName}"`, 4),
      ]);

      const m = (s) => ({ id: s.id, ...s.values });
      jsonResp(res, 200, {
        department: m(dept),
        staff: staffArr.map(m),
        vacancies: vacArr.filter(v => !["Filled", "Cancelled"].includes(vf(v, "Status"))).map(m),
        metrics: prodArr.map(m),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 3. GET /api/wfo/stats/staffing
  if (pathname === "/api/wfo/stats/staffing" && req.method === "GET") {
    try {
      const [staff, vacancies] = await Promise.all([
        collect("staff-roster", null, 8),
        collect("vacancies", null, 4),
      ]);

      // FTE distribution
      const fteDist = {};
      for (const s of staff) {
        if (vf(s, "Status") !== "Active") continue;
        const fte = vf(s, "FTE Status") || "Unknown";
        fteDist[fte] = (fteDist[fte] || 0) + 1;
      }

      // By department
      const byDept = {};
      for (const s of staff) {
        if (vf(s, "Status") !== "Active") continue;
        const dept = vf(s, "Department") || "Unknown";
        if (!byDept[dept]) byDept[dept] = { active: 0, fullTime: 0, partTime: 0, prn: 0, travel: 0, contract: 0 };
        byDept[dept].active++;
        const fte = vf(s, "FTE Status");
        if (fte === "Full Time") byDept[dept].fullTime++;
        else if (fte === "Part Time") byDept[dept].partTime++;
        else if (fte === "PRN") byDept[dept].prn++;
        else if (fte === "Travel") byDept[dept].travel++;
        else if (fte === "Contract") byDept[dept].contract++;
      }

      // Job family breakdown
      const byFamily = {};
      for (const s of staff) {
        if (vf(s, "Status") !== "Active") continue;
        const jf = vf(s, "Job Family") || "Unknown";
        byFamily[jf] = (byFamily[jf] || 0) + 1;
      }

      // Vacancy trends (by department)
      const vacByDept = {};
      for (const v of vacancies) {
        if (["Filled", "Cancelled"].includes(vf(v, "Status"))) continue;
        const dept = vf(v, "Department") || "Unknown";
        vacByDept[dept] = (vacByDept[dept] || 0) + 1;
      }

      jsonResp(res, 200, { fteDist, byDept, byFamily, vacByDept });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 4. GET /api/wfo/stats/productivity
  if (pathname === "/api/wfo/stats/productivity" && req.method === "GET") {
    try {
      const [metrics, overtime] = await Promise.all([
        collect("productivity-metrics", null, 4),
        collect("overtime-records", null, 4),
      ]);

      // Metrics by department
      const byDept = {};
      for (const m of metrics) {
        const dept = vf(m, "Department") || "Unknown";
        if (!byDept[dept]) byDept[dept] = [];
        byDept[dept].push({
          metricId: vf(m, "Metric ID"), period: vf(m, "Period"), type: vf(m, "Metric Type"),
          value: vf(m, "Value"), target: vf(m, "Target"), variance: vf(m, "Variance"), trend: vf(m, "Trend"),
        });
      }

      // OT trends (by department)
      const otByDept = {};
      for (const o of overtime) {
        const dept = vf(o, "Department") || "Unknown";
        if (!otByDept[dept]) otByDept[dept] = { totalHours: 0, totalCost: 0, count: 0 };
        otByDept[dept].totalHours += Number(vf(o, "OT Hours")) || 0;
        otByDept[dept].totalCost += Number(vf(o, "Cost")) || 0;
        otByDept[dept].count++;
      }

      // OT by reason
      const otByReason = {};
      for (const o of overtime) {
        const reason = vf(o, "Reason") || "Unknown";
        otByReason[reason] = (otByReason[reason] || 0) + (Number(vf(o, "OT Hours")) || 0);
      }

      jsonResp(res, 200, { byDept, otByDept, otByReason });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 5. POST /api/wfo/vacancies/:id/transition
  const vacTransMatch = pathname.match(/^\/api\/wfo\/vacancies\/([^/]+)\/transition$/);
  if (vacTransMatch && req.method === "POST") {
    const vid = decodeURIComponent(vacTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const vacs = await collect("vacancies", `values[Vacancy ID] = "${vid}"`, 1);
      if (vacs.length === 0) { jsonResp(res, 404, { error: "Vacancy not found" }); return true; }
      const vac = vacs[0];
      const current = vf(vac, "Status");
      const allowed = VACANCY_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      await kineticRequest("PUT", `/submissions/${vac.id}/values`, updates, auth);
      await logActivity(auth, "Vacancy " + newStatus, "Vacancy", vid, current, newStatus,
        body.performer || "System", `Vacancy ${vid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 6. POST /api/wfo/schedules/:id/transition
  const schTransMatch = pathname.match(/^\/api\/wfo\/schedules\/([^/]+)\/transition$/);
  if (schTransMatch && req.method === "POST") {
    const sid = decodeURIComponent(schTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const schs = await collect("schedules", `values[Schedule ID] = "${sid}"`, 1);
      if (schs.length === 0) { jsonResp(res, 404, { error: "Schedule not found" }); return true; }
      const sch = schs[0];
      const current = vf(sch, "Status");
      const allowed = SCHEDULE_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      await kineticRequest("PUT", `/submissions/${sch.id}/values`, updates, auth);
      await logActivity(auth, "Schedule " + newStatus, "Schedule", sid, current, newStatus,
        body.performer || "System", `Schedule ${sid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 7. GET /api/wfo/report/:type
  const reportMatch = pathname.match(/^\/api\/wfo\/report\/([a-z-]+)$/);
  if (reportMatch && req.method === "GET") {
    const type = reportMatch[1];
    try {
      if (type === "staffing") {
        const staff = await collect("staff-roster", null, 8);
        jsonResp(res, 200, {
          report: "Staffing Report",
          items: staff.map(s => ({ staffId: vf(s, "Staff ID"), name: `${vf(s, "First Name")} ${vf(s, "Last Name")}`, dept: vf(s, "Department"), position: vf(s, "Position"), jobFamily: vf(s, "Job Family"), fteStatus: vf(s, "FTE Status"), shift: vf(s, "Shift Preference"), tenure: vf(s, "Tenure Years"), salary: vf(s, "Base Salary"), status: vf(s, "Status") })),
        });
      } else if (type === "overtime") {
        const ot = await collect("overtime-records", null, 4);
        jsonResp(res, 200, {
          report: "Overtime Report",
          items: ot.map(o => ({ otId: vf(o, "OT ID"), staffName: vf(o, "Staff Name"), dept: vf(o, "Department"), date: vf(o, "OT Date"), regHours: vf(o, "Regular Hours"), otHours: vf(o, "OT Hours"), dtHours: vf(o, "Double Time Hours"), totalHours: vf(o, "Total Hours"), reason: vf(o, "Reason"), cost: vf(o, "Cost"), status: vf(o, "Status") })),
        });
      } else if (type === "vacancy") {
        const vacs = await collect("vacancies", null, 4);
        jsonResp(res, 200, {
          report: "Vacancy Report",
          items: vacs.map(v => ({ vacId: vf(v, "Vacancy ID"), title: vf(v, "Position Title"), dept: vf(v, "Department"), jobFamily: vf(v, "Job Family"), priority: vf(v, "Priority"), posted: vf(v, "Posted Date"), targetFill: vf(v, "Target Fill Date"), applicants: vf(v, "Applicants"), interviews: vf(v, "Interviews"), status: vf(v, "Status") })),
        });
      } else if (type === "certification") {
        const certs = await collect("certifications", null, 4);
        jsonResp(res, 200, {
          report: "Certification Compliance Report",
          items: certs.map(c => ({ certId: vf(c, "Cert ID"), staffName: vf(c, "Staff Name"), certName: vf(c, "Certification Name"), body: vf(c, "Certifying Body"), issued: vf(c, "Issue Date"), expires: vf(c, "Expiration Date"), ceuReq: vf(c, "CEU Required"), ceuComp: vf(c, "CEU Completed"), dept: vf(c, "Department"), status: vf(c, "Status") })),
        });
      } else if (type === "productivity") {
        const metrics = await collect("productivity-metrics", null, 4);
        jsonResp(res, 200, {
          report: "Productivity Report",
          items: metrics.map(m => ({ metricId: vf(m, "Metric ID"), dept: vf(m, "Department"), period: vf(m, "Period"), type: vf(m, "Metric Type"), value: vf(m, "Value"), target: vf(m, "Target"), variance: vf(m, "Variance"), trend: vf(m, "Trend") })),
        });
      } else if (type === "department") {
        const [depts, staff, vacs] = await Promise.all([
          collect("departments", null, 2),
          collect("staff-roster", null, 8),
          collect("vacancies", null, 4),
        ]);
        const deptMap = {};
        for (const d of depts) {
          const name = vf(d, "Department Name");
          deptMap[name] = { name, type: vf(d, "Department Type"), manager: vf(d, "Manager"), budgetedFTEs: vf(d, "Budgeted FTEs"), currentFTEs: vf(d, "Current FTEs"), staff: 0, vacancies: 0 };
        }
        for (const s of staff) {
          const dept = vf(s, "Department");
          if (deptMap[dept] && vf(s, "Status") === "Active") deptMap[dept].staff++;
        }
        for (const v of vacs) {
          const dept = vf(v, "Department");
          if (deptMap[dept] && !["Filled", "Cancelled"].includes(vf(v, "Status"))) deptMap[dept].vacancies++;
        }
        jsonResp(res, 200, { report: "Department Report", items: Object.values(deptMap) });
      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${type}` });
      }
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 8. GET /api/wfo/search?q=&type=
  if (pathname === "/api/wfo/search" && req.method === "GET") {
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
      if (type === "all" || type === "staff") {
        const staff = await collect("staff-roster", null, 8);
        for (const s of staff) {
          const fullName = `${vf(s, "First Name")} ${vf(s, "Last Name")}`.toLowerCase();
          const id = (vf(s, "Staff ID") || "").toLowerCase();
          if (fullName.includes(q) || id.includes(q)) {
            results.push({ id: s.id, entityType: "Staff", entityId: vf(s, "Staff ID"), name: `${vf(s, "First Name")} ${vf(s, "Last Name")}`, status: vf(s, "Status"), dept: vf(s, "Department") || "" });
          }
        }
      }
      if (type === "all" || type === "vacancies") {
        const vacs = await collect("vacancies", null, 4);
        search(vacs, "Vacancy", "Position Title", "Vacancy ID");
      }
      if (type === "all" || type === "certifications") {
        const certs = await collect("certifications", null, 4);
        search(certs, "Certification", "Certification Name", "Cert ID");
      }
      if (type === "all" || type === "schedules") {
        const schs = await collect("schedules", null, 4);
        search(schs, "Schedule", "Staff Name", "Schedule ID");
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

  server.listen(PORT, () => console.log(`\n  Workforce Optimization: http://localhost:${PORT}\n`));
}
