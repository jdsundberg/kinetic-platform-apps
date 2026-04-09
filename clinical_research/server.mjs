/**
 * Clinical Research — Custom API Handler
 */

export const appId = "clinical-research";
export const apiPrefix = "/api/cro";
export const kapp = "clinical-research";

// ─── App-specific helpers ──────────────────────────────────────────────────

const vf = (s, f) => s.values?.[f] || "";
function nowISO() { return new Date().toISOString(); }
const STUDY_TRANSITIONS = {
  "Planning": ["IRB Review"],
  "IRB Review": ["Enrolling", "Planning"],
  "Enrolling": ["Active", "Suspended"],
  "Active": ["Completed", "Suspended", "Terminated"],
  "Suspended": ["Enrolling", "Active", "Terminated"],
  "Completed": [],
  "Terminated": [],
};
const AE_TRANSITIONS = {
  "Reported": ["Under Review"],
  "Under Review": ["Assessed", "Reported to IRB", "Reported to FDA"],
  "Assessed": ["Closed"],
  "Reported to IRB": ["Assessed"],
  "Reported to FDA": ["Assessed"],
  "Closed": [],
};
const FILING_TRANSITIONS = {
  "Draft": ["Submitted"],
  "Submitted": ["Under Review"],
  "Under Review": ["Approved", "Revision Required"],
  "Approved": ["Closed"],
  "Revision Required": ["Draft"],
  "Closed": [],
};
async function logActivity(auth, studyId, action, entityType, entityId, prev, next, performer, details) {
  const logs = await collect("activity-log", null, 1);
  const logId = `LOG-${String(logs.length + 1).padStart(4, "0")}`;
  await kineticRequest("POST", `/kapps/${KAPP}/forms/activity-log/submissions`, {
    values: {
      "Log ID": logId, "Study ID": studyId || "",
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


  // 1. GET /api/cro/dashboard
  if (pathname === "/api/cro/dashboard" && req.method === "GET") {
    try {
      const [studies, sites, enrollments, aes, filings, budgets] = await Promise.all([
        collect("studies", null, 4),
        collect("sites", null, 4),
        collect("enrollments", null, 8),
        collect("adverse-events", null, 4),
        collect("regulatory-filings", null, 4),
        collect("budgets", null, 4),
      ]);

      // KPIs
      const activeStudies = studies.filter(s => ["Active", "Enrolling"].includes(vf(s, "Status"))).length;
      const totalEnrollment = enrollments.filter(e => ["Active", "Completed", "Randomized"].includes(vf(e, "Status"))).length;
      const activeSites = sites.filter(s => ["Active", "Enrolling"].includes(vf(s, "Status"))).length;
      const openAEs = aes.filter(a => !["Closed", "Assessed"].includes(vf(a, "Status"))).length;
      const pendingReg = filings.filter(f => !["Approved", "Closed"].includes(vf(f, "Status"))).length;

      // Budget utilization
      let totalBudget = 0, totalSpent = 0;
      for (const b of budgets) {
        totalBudget += parseInt(vf(b, "Budget Amount")) || 0;
        totalSpent += parseInt(vf(b, "Spent Amount")) || 0;
      }
      const budgetUtil = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;

      // Recent enrollments (last 10)
      const recentEnroll = enrollments
        .filter(e => vf(e, "Screening Date"))
        .sort((a, b) => (vf(b, "Screening Date") || "").localeCompare(vf(a, "Screening Date") || ""))
        .slice(0, 10)
        .map(e => ({
          id: e.id, enrollId: vf(e, "Enrollment ID"), subjectId: vf(e, "Subject ID"),
          studyTitle: vf(e, "Study Title"), siteName: vf(e, "Site Name"),
          status: vf(e, "Status"), date: vf(e, "Screening Date"),
        }));

      // Open AEs list
      const openAEList = aes
        .filter(a => !["Closed", "Assessed"].includes(vf(a, "Status")))
        .slice(0, 10)
        .map(a => ({
          id: a.id, aeId: vf(a, "AE ID"), eventTerm: vf(a, "Event Term"),
          severity: vf(a, "Severity"), seriousness: vf(a, "Seriousness"),
          studyTitle: vf(a, "Study Title"), status: vf(a, "Status"),
          reportDate: vf(a, "Report Date"),
        }));

      jsonResp(res, 200, {
        activeStudies, totalEnrollment, activeSites, openAEs, pendingReg, budgetUtil,
        recentEnroll, openAEList,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 2. GET /api/cro/study/:id/summary
  const studySumMatch = pathname.match(/^\/api\/cro\/study\/([^/]+)\/summary$/);
  if (studySumMatch && req.method === "GET") {
    const sid = decodeURIComponent(studySumMatch[1]);
    try {
      const kql = `values[Study ID] = "${sid}"`;
      const [studyArr, siteArr, enrollArr, aeArr, msArr, budArr] = await Promise.all([
        collect("studies", kql, 1),
        collect("sites", `values[Study ID] = "${sid}"`, 4),
        collect("enrollments", `values[Study ID] = "${sid}"`, 8),
        collect("adverse-events", `values[Study ID] = "${sid}"`, 4),
        collect("milestones", `values[Study ID] = "${sid}"`, 4),
        collect("budgets", `values[Study ID] = "${sid}"`, 4),
      ]);
      if (studyArr.length === 0) { jsonResp(res, 404, { error: "Study not found" }); return true; }
      const m = (s) => ({ id: s.id, ...s.values });
      jsonResp(res, 200, {
        study: m(studyArr[0]),
        sites: siteArr.map(m),
        enrollments: enrollArr.map(m),
        adverseEvents: aeArr.map(m),
        milestones: msArr.map(m),
        budgets: budArr.map(m),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 3. GET /api/cro/stats/enrollment
  if (pathname === "/api/cro/stats/enrollment" && req.method === "GET") {
    try {
      const [enrollments, sites] = await Promise.all([
        collect("enrollments", null, 8),
        collect("sites", null, 4),
      ]);

      // By status
      const byStatus = {};
      for (const e of enrollments) {
        const st = vf(e, "Status") || "Unknown";
        byStatus[st] = (byStatus[st] || 0) + 1;
      }

      // By study
      const byStudy = {};
      for (const e of enrollments) {
        const title = vf(e, "Study Title") || "Unknown";
        if (!byStudy[title]) byStudy[title] = { total: 0, active: 0, completed: 0, withdrawn: 0 };
        byStudy[title].total++;
        const st = vf(e, "Status");
        if (st === "Active" || st === "Randomized") byStudy[title].active++;
        else if (st === "Completed") byStudy[title].completed++;
        else if (st === "Withdrawn" || st === "Screen Failure") byStudy[title].withdrawn++;
      }

      // Site performance
      const sitePerf = sites
        .filter(s => vf(s, "Performance Score"))
        .map(s => ({
          siteId: vf(s, "Site ID"), name: vf(s, "Site Name"),
          score: parseInt(vf(s, "Performance Score")) || 0,
          enrolled: parseInt(vf(s, "Current Enrollment")) || 0,
          target: parseInt(vf(s, "Target Enrollment")) || 0,
        }))
        .sort((a, b) => b.score - a.score);

      // Completion rate
      const totalCompleted = enrollments.filter(e => vf(e, "Status") === "Completed").length;
      const totalActive = enrollments.filter(e => ["Active", "Randomized", "Completed"].includes(vf(e, "Status"))).length;
      const completionRate = totalActive > 0 ? Math.round((totalCompleted / totalActive) * 100) : 0;

      jsonResp(res, 200, { byStatus, byStudy, sitePerf, completionRate });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 4. GET /api/cro/stats/safety
  if (pathname === "/api/cro/stats/safety" && req.method === "GET") {
    try {
      const aes = await collect("adverse-events", null, 4);

      // By severity
      const bySeverity = {};
      for (const a of aes) {
        const sev = vf(a, "Severity") || "Unknown";
        bySeverity[sev] = (bySeverity[sev] || 0) + 1;
      }

      // By seriousness
      const bySeriousness = {};
      for (const a of aes) {
        const ser = vf(a, "Seriousness") || "Unknown";
        bySeriousness[ser] = (bySeriousness[ser] || 0) + 1;
      }

      // By relatedness
      const byRelatedness = {};
      for (const a of aes) {
        const rel = vf(a, "Relatedness") || "Unknown";
        byRelatedness[rel] = (byRelatedness[rel] || 0) + 1;
      }

      // By study
      const byStudy = {};
      for (const a of aes) {
        const title = vf(a, "Study Title") || "Unknown";
        if (!byStudy[title]) byStudy[title] = { total: 0, serious: 0, open: 0 };
        byStudy[title].total++;
        if (vf(a, "Seriousness") === "Serious") byStudy[title].serious++;
        if (!["Closed", "Assessed"].includes(vf(a, "Status"))) byStudy[title].open++;
      }

      // Reporting timeliness
      let totalDays = 0, countReported = 0;
      for (const a of aes) {
        const onset = vf(a, "Onset Date");
        const report = vf(a, "Report Date");
        if (onset && report) {
          const days = (new Date(report).getTime() - new Date(onset).getTime()) / 864e5;
          if (days >= 0 && days < 365) { totalDays += days; countReported++; }
        }
      }
      const avgReportDays = countReported > 0 ? (totalDays / countReported).toFixed(1) : "N/A";

      jsonResp(res, 200, { bySeverity, bySeriousness, byRelatedness, byStudy, avgReportDays });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 5. POST /api/cro/studies/:id/transition
  const studyTransMatch = pathname.match(/^\/api\/cro\/studies\/([^/]+)\/transition$/);
  if (studyTransMatch && req.method === "POST") {
    const sid = decodeURIComponent(studyTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const studs = await collect("studies", `values[Study ID] = "${sid}"`, 1);
      if (studs.length === 0) { jsonResp(res, 404, { error: "Study not found" }); return true; }
      const study = studs[0];
      const current = vf(study, "Status");
      const allowed = STUDY_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      await kineticRequest("PUT", `/submissions/${study.id}/values`, { Status: newStatus }, auth);
      await logActivity(auth, sid, "Status Changed", "Study", sid, current, newStatus,
        body.performer || "System", `Study ${sid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 6. POST /api/cro/adverse-events/:id/transition
  const aeTransMatch = pathname.match(/^\/api\/cro\/adverse-events\/([^/]+)\/transition$/);
  if (aeTransMatch && req.method === "POST") {
    const aeId = decodeURIComponent(aeTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const aes = await collect("adverse-events", `values[AE ID] = "${aeId}"`, 1);
      if (aes.length === 0) { jsonResp(res, 404, { error: "Adverse event not found" }); return true; }
      const ae = aes[0];
      const current = vf(ae, "Status");
      const allowed = AE_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Closed") updates["Resolution Date"] = new Date().toISOString().slice(0, 10);
      await kineticRequest("PUT", `/submissions/${ae.id}/values`, updates, auth);
      await logActivity(auth, vf(ae, "Study ID"), "AE Status Changed", "Adverse Event", aeId, current, newStatus,
        body.performer || "System", `AE ${aeId} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 7. GET /api/cro/report/:type
  const reportMatch = pathname.match(/^\/api\/cro\/report\/([a-z-]+)$/);
  if (reportMatch && req.method === "GET") {
    const type = reportMatch[1];
    try {
      if (type === "enrollment") {
        const enrollments = await collect("enrollments", null, 8);
        jsonResp(res, 200, {
          report: "Enrollment Report",
          items: enrollments.map(e => ({
            enrollId: vf(e, "Enrollment ID"), studyTitle: vf(e, "Study Title"),
            siteName: vf(e, "Site Name"), subjectId: vf(e, "Subject ID"),
            arm: vf(e, "Treatment Arm"), status: vf(e, "Status"),
            screenDate: vf(e, "Screening Date"), consentDate: vf(e, "Consent Date"),
          })),
        });
      } else if (type === "safety") {
        const aes = await collect("adverse-events", null, 4);
        jsonResp(res, 200, {
          report: "Safety Report",
          items: aes.map(a => ({
            aeId: vf(a, "AE ID"), studyTitle: vf(a, "Study Title"),
            subjectId: vf(a, "Subject ID"), eventTerm: vf(a, "Event Term"),
            severity: vf(a, "Severity"), seriousness: vf(a, "Seriousness"),
            relatedness: vf(a, "Relatedness"), outcome: vf(a, "Outcome"),
            status: vf(a, "Status"), onsetDate: vf(a, "Onset Date"),
          })),
        });
      } else if (type === "site-performance") {
        const sites = await collect("sites", null, 4);
        jsonResp(res, 200, {
          report: "Site Performance",
          items: sites.map(s => ({
            siteId: vf(s, "Site ID"), name: vf(s, "Site Name"),
            studyTitle: vf(s, "Study Title"), location: vf(s, "Location"),
            enrolled: vf(s, "Current Enrollment"), target: vf(s, "Target Enrollment"),
            score: vf(s, "Performance Score"), status: vf(s, "Status"),
          })),
        });
      } else if (type === "regulatory") {
        const filings = await collect("regulatory-filings", null, 4);
        jsonResp(res, 200, {
          report: "Regulatory Status",
          items: filings.map(f => ({
            filingId: vf(f, "Filing ID"), studyTitle: vf(f, "Study Title"),
            type: vf(f, "Filing Type"), agency: vf(f, "Agency"),
            status: vf(f, "Status"), outcome: vf(f, "Outcome"),
            submittedDate: vf(f, "Submitted Date"), dueDate: vf(f, "Due Date"),
          })),
        });
      } else if (type === "budget") {
        const budgets = await collect("budgets", null, 4);
        jsonResp(res, 200, {
          report: "Budget Summary",
          items: budgets.map(b => ({
            budgetId: vf(b, "Budget ID"), studyTitle: vf(b, "Study Title"),
            category: vf(b, "Budget Category"), budget: vf(b, "Budget Amount"),
            spent: vf(b, "Spent Amount"), committed: vf(b, "Committed Amount"),
            available: vf(b, "Available Amount"), status: vf(b, "Status"),
          })),
        });
      } else if (type === "milestone") {
        const milestones = await collect("milestones", null, 4);
        jsonResp(res, 200, {
          report: "Milestone Tracker",
          items: milestones.map(m => ({
            msId: vf(m, "Milestone ID"), studyTitle: vf(m, "Study Title"),
            name: vf(m, "Milestone Name"), category: vf(m, "Category"),
            planned: vf(m, "Planned Date"), actual: vf(m, "Actual Date"),
            pct: vf(m, "Completion Percentage"), status: vf(m, "Status"),
          })),
        });
      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${type}` });
      }
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 8. GET /api/cro/search?q=&type=
  if (pathname === "/api/cro/search" && req.method === "GET") {
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
            results.push({ id: s.id, entityType, entityId: vf(s, idField), name: vf(s, nameField), status: vf(s, "Status") });
          }
        }
      };
      if (type === "all" || type === "studies") {
        const studies = await collect("studies", null, 4);
        search(studies, "Study", "Study Title", "Study ID");
      }
      if (type === "all" || type === "sites") {
        const sites = await collect("sites", null, 4);
        search(sites, "Site", "Site Name", "Site ID");
      }
      if (type === "all" || type === "enrollments") {
        const enr = await collect("enrollments", null, 8);
        search(enr, "Enrollment", "Subject ID", "Enrollment ID");
      }
      if (type === "all" || type === "adverse-events") {
        const aes = await collect("adverse-events", null, 4);
        search(aes, "Adverse Event", "Event Term", "AE ID");
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

  server.listen(PORT, () => console.log(`\n  Clinical Research: http://localhost:${PORT}\n`));
}
