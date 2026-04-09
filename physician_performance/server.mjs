/**
 * Physician Performance — Custom API Handler
 */

export const appId = "physician-performance";
export const apiPrefix = "/api/ppc";
export const kapp = "physician-performance";

// ─── App-specific helpers ──────────────────────────────────────────────────

const vf = (s, f) => s.values?.[f] || "";
function nowISO() { return new Date().toISOString(); }
const REVIEW_TRANSITIONS = {
  "Draft": ["Scheduled"],
  "Scheduled": ["In Progress"],
  "In Progress": ["Completed", "Draft"],
  "Completed": ["Acknowledged"],
  "Acknowledged": [],
};
const INCENTIVE_TRANSITIONS = {
  "Calculated": ["Under Review"],
  "Under Review": ["Approved", "Disputed"],
  "Approved": ["Paid"],
  "Disputed": ["Under Review", "Calculated"],
  "Paid": [],
};
async function logActivity(auth, action, entityType, entityId, prev, next, performer, details) {
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


  // 1. GET /api/ppc/dashboard
  if (pathname === "/api/ppc/dashboard" && req.method === "GET") {
    try {
      const [physicians, productivity, quality, incentives, reviews] = await Promise.all([
        collect("physicians", null, 4),
        collect("productivity-data", null, 8),
        collect("quality-metrics", null, 8),
        collect("incentive-payments", null, 4),
        collect("reviews", null, 4),
      ]);

      // KPIs
      const activePhysicians = physicians.filter(p => vf(p, "Status") === "Active").length;

      // Avg wRVU %
      const prodWithTarget = productivity.filter(p => parseFloat(vf(p, "Total wRVUs")) > 0 && parseFloat(vf(p, "Target wRVUs")) > 0);
      let avgWRVUPct = 0;
      if (prodWithTarget.length > 0) {
        const totalPct = prodWithTarget.reduce((sum, p) => sum + (parseFloat(vf(p, "Total wRVUs")) / parseFloat(vf(p, "Target wRVUs")) * 100), 0);
        avgWRVUPct = (totalPct / prodWithTarget.length).toFixed(1);
      }

      // Avg quality score (use Percentile field)
      const qualWithScore = quality.filter(q => parseFloat(vf(q, "Score")) > 0);
      let avgQualScore = 0;
      if (qualWithScore.length > 0) {
        avgQualScore = (qualWithScore.reduce((sum, q) => sum + parseFloat(vf(q, "Score")), 0) / qualWithScore.length).toFixed(1);
      }

      // Total incentives YTD
      const yearStart = new Date().getFullYear() + "-01-01";
      const paidIncentives = incentives.filter(i => vf(i, "Status") === "Paid" && (vf(i, "Payment Date") || "") >= yearStart);
      const totalIncentivesYTD = paidIncentives.reduce((sum, i) => sum + (parseFloat(vf(i, "Amount")) || 0), 0);

      // Open reviews
      const openReviews = reviews.filter(r => !["Completed", "Acknowledged"].includes(vf(r, "Status"))).length;

      // Above benchmark %
      const aboveBenchmark = productivity.filter(p => parseFloat(vf(p, "Percentile vs Benchmark")) >= 50).length;
      const aboveBenchmarkPct = prodWithTarget.length > 0 ? ((aboveBenchmark / prodWithTarget.length) * 100).toFixed(1) : "0";

      // Top performers (latest period, by wRVU %)
      const topPerformers = productivity
        .filter(p => parseFloat(vf(p, "Total wRVUs")) > 0 && parseFloat(vf(p, "Target wRVUs")) > 0)
        .map(p => ({
          id: p.id, phyId: vf(p, "Physician ID"), name: vf(p, "Physician Name"),
          dept: vf(p, "Department"), period: vf(p, "Period Name"),
          wrvuPct: (parseFloat(vf(p, "Total wRVUs")) / parseFloat(vf(p, "Target wRVUs")) * 100).toFixed(1),
          totalWRVU: vf(p, "Total wRVUs"),
        }))
        .sort((a, b) => parseFloat(b.wrvuPct) - parseFloat(a.wrvuPct))
        .slice(0, 10);

      // Pending reviews
      const pendingReviews = reviews
        .filter(r => !["Completed", "Acknowledged"].includes(vf(r, "Status")))
        .slice(0, 10)
        .map(r => ({
          id: r.id, reviewId: vf(r, "Review ID"), physician: vf(r, "Physician Name"),
          period: vf(r, "Period Name"), status: vf(r, "Status"), reviewer: vf(r, "Reviewer"),
          date: vf(r, "Review Date"),
        }));

      jsonResp(res, 200, {
        activePhysicians, avgWRVUPct, avgQualScore, totalIncentivesYTD,
        openReviews, aboveBenchmarkPct, topPerformers, pendingReviews,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 2. GET /api/ppc/physician/:id/profile
  const phyProfileMatch = pathname.match(/^\/api\/ppc\/physician\/([^/]+)\/profile$/);
  if (phyProfileMatch && req.method === "GET") {
    const pid = decodeURIComponent(phyProfileMatch[1]);
    try {
      const kql = `values[Physician ID] = "${pid}"`;
      const [phyArr, prodArr, qualArr, incArr, revArr] = await Promise.all([
        collect("physicians", kql, 1),
        collect("productivity-data", `values[Physician ID] = "${pid}"`, 4),
        collect("quality-metrics", `values[Physician ID] = "${pid}"`, 4),
        collect("incentive-payments", `values[Physician ID] = "${pid}"`, 4),
        collect("reviews", `values[Physician ID] = "${pid}"`, 4),
      ]);
      if (phyArr.length === 0) { jsonResp(res, 404, { error: "Physician not found" }); return true; }
      const m = (s) => ({ id: s.id, ...s.values });
      jsonResp(res, 200, {
        physician: m(phyArr[0]),
        productivity: prodArr.map(m),
        quality: qualArr.map(m),
        incentives: incArr.map(m),
        reviews: revArr.map(m),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 3. GET /api/ppc/stats/performance
  if (pathname === "/api/ppc/stats/performance" && req.method === "GET") {
    try {
      const [productivity, quality] = await Promise.all([
        collect("productivity-data", null, 8),
        collect("quality-metrics", null, 8),
      ]);

      // wRVU distribution by department
      const wrvuByDept = {};
      for (const p of productivity) {
        const dept = vf(p, "Department") || "Unknown";
        if (!wrvuByDept[dept]) wrvuByDept[dept] = { total: 0, target: 0, count: 0 };
        wrvuByDept[dept].total += parseFloat(vf(p, "Total wRVUs")) || 0;
        wrvuByDept[dept].target += parseFloat(vf(p, "Target wRVUs")) || 0;
        wrvuByDept[dept].count++;
      }
      for (const dept of Object.keys(wrvuByDept)) {
        const d = wrvuByDept[dept];
        d.avgWRVU = Math.round(d.total / d.count);
        d.avgTarget = Math.round(d.target / d.count);
        d.pctOfTarget = d.target > 0 ? ((d.total / d.target) * 100).toFixed(1) : "0";
      }

      // Quality trends by metric type
      const qualByType = {};
      for (const q of quality) {
        const mt = vf(q, "Metric Type") || "Unknown";
        if (!qualByType[mt]) qualByType[mt] = { scores: [], count: 0 };
        const score = parseFloat(vf(q, "Score"));
        if (!isNaN(score)) { qualByType[mt].scores.push(score); qualByType[mt].count++; }
      }
      for (const mt of Object.keys(qualByType)) {
        const scores = qualByType[mt].scores;
        qualByType[mt].avg = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : "0";
        qualByType[mt].min = scores.length > 0 ? Math.min(...scores).toFixed(1) : "0";
        qualByType[mt].max = scores.length > 0 ? Math.max(...scores).toFixed(1) : "0";
      }

      // Department rankings
      const deptRank = Object.entries(wrvuByDept)
        .map(([dept, d]) => ({ dept, avgWRVU: d.avgWRVU, avgTarget: d.avgTarget, pctOfTarget: d.pctOfTarget, count: d.count }))
        .sort((a, b) => parseFloat(b.pctOfTarget) - parseFloat(a.pctOfTarget));

      jsonResp(res, 200, { wrvuByDept, qualByType, deptRank });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 4. GET /api/ppc/stats/compensation
  if (pathname === "/api/ppc/stats/compensation" && req.method === "GET") {
    try {
      const [incentives, models, benchmarks] = await Promise.all([
        collect("incentive-payments", null, 4),
        collect("compensation-models", null, 2),
        collect("benchmarks", null, 4),
      ]);

      // Incentive breakdown by type
      const incByType = {};
      for (const inc of incentives) {
        const t = vf(inc, "Incentive Type") || "Unknown";
        if (!incByType[t]) incByType[t] = { count: 0, total: 0, paid: 0 };
        incByType[t].count++;
        incByType[t].total += parseFloat(vf(inc, "Amount")) || 0;
        if (vf(inc, "Status") === "Paid") incByType[t].paid += parseFloat(vf(inc, "Amount")) || 0;
      }

      // Incentive pipeline by status
      const incByStatus = {};
      for (const inc of incentives) {
        const s = vf(inc, "Status") || "Unknown";
        if (!incByStatus[s]) incByStatus[s] = { count: 0, amount: 0 };
        incByStatus[s].count++;
        incByStatus[s].amount += parseFloat(vf(inc, "Amount")) || 0;
      }

      // Model overview
      const modelSummary = models.map(m => ({
        id: m.id, modelId: vf(m, "Model ID"), name: vf(m, "Model Name"),
        type: vf(m, "Model Type"), base: vf(m, "Base Component"),
        productivity: vf(m, "Productivity Component"), quality: vf(m, "Quality Component"),
        wrvuRate: vf(m, "wRVU Rate"), status: vf(m, "Status"),
      }));

      // Benchmark summary
      const bmSummary = benchmarks.map(b => ({
        specialty: vf(b, "Specialty"), source: vf(b, "Source"),
        metricType: vf(b, "Metric Type"), p25: vf(b, "Percentile 25"),
        p50: vf(b, "Percentile 50"), p75: vf(b, "Percentile 75"),
        p90: vf(b, "Percentile 90"), status: vf(b, "Status"),
      }));

      jsonResp(res, 200, { incByType, incByStatus, modelSummary, bmSummary });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 5. POST /api/ppc/reviews/:id/transition
  const revTransMatch = pathname.match(/^\/api\/ppc\/reviews\/([^/]+)\/transition$/);
  if (revTransMatch && req.method === "POST") {
    const rid = decodeURIComponent(revTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const revs = await collect("reviews", `values[Review ID] = "${rid}"`, 1);
      if (revs.length === 0) { jsonResp(res, 404, { error: "Review not found" }); return true; }
      const rev = revs[0];
      const current = vf(rev, "Status");
      const allowed = REVIEW_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Completed") updates["Review Date"] = new Date().toISOString().slice(0, 10);
      if (body.overallScore) updates["Overall Score"] = body.overallScore;
      if (body.strengths) updates["Strengths"] = body.strengths;
      if (body.improvementAreas) updates["Improvement Areas"] = body.improvementAreas;
      await kineticRequest("PUT", `/submissions/${rev.id}/values`, updates, auth);
      await logActivity(auth, "Status Changed", "Review", rid, current, newStatus,
        body.performer || "System", `Review ${rid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 6. POST /api/ppc/incentives/:id/transition
  const incTransMatch = pathname.match(/^\/api\/ppc\/incentives\/([^/]+)\/transition$/);
  if (incTransMatch && req.method === "POST") {
    const iid = decodeURIComponent(incTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const incs = await collect("incentive-payments", `values[Incentive ID] = "${iid}"`, 1);
      if (incs.length === 0) { jsonResp(res, 404, { error: "Incentive not found" }); return true; }
      const inc = incs[0];
      const current = vf(inc, "Status");
      const allowed = INCENTIVE_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Paid") updates["Payment Date"] = new Date().toISOString().slice(0, 10);
      if (newStatus === "Approved" && body.approvedBy) updates["Approved By"] = body.approvedBy;
      await kineticRequest("PUT", `/submissions/${inc.id}/values`, updates, auth);
      await logActivity(auth, "Incentive " + newStatus, "Incentive", iid, current, newStatus,
        body.performer || "System", `Incentive ${iid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 7. GET /api/ppc/report/:type
  const reportMatch = pathname.match(/^\/api\/ppc\/report\/([a-z-]+)$/);
  if (reportMatch && req.method === "GET") {
    const type = reportMatch[1];
    try {
      if (type === "performance") {
        const productivity = await collect("productivity-data", null, 8);
        jsonResp(res, 200, {
          report: "Performance Report",
          items: productivity.map(p => ({
            phyId: vf(p, "Physician ID"), name: vf(p, "Physician Name"), dept: vf(p, "Department"),
            period: vf(p, "Period Name"), totalWRVU: vf(p, "Total wRVUs"), targetWRVU: vf(p, "Target wRVUs"),
            variance: vf(p, "wRVU Variance"), encounters: vf(p, "Patient Encounters"),
            collections: vf(p, "Collections"), benchPct: vf(p, "Percentile vs Benchmark"), status: vf(p, "Status"),
          })),
        });
      } else if (type === "compensation") {
        const incentives = await collect("incentive-payments", null, 4);
        jsonResp(res, 200, {
          report: "Compensation Report",
          items: incentives.map(i => ({
            incId: vf(i, "Incentive ID"), phyId: vf(i, "Physician ID"), name: vf(i, "Physician Name"),
            period: vf(i, "Period Name"), type: vf(i, "Incentive Type"), amount: vf(i, "Amount"),
            basis: vf(i, "Calculation Basis"), approvedBy: vf(i, "Approved By"),
            payDate: vf(i, "Payment Date"), status: vf(i, "Status"),
          })),
        });
      } else if (type === "quality") {
        const quality = await collect("quality-metrics", null, 8);
        jsonResp(res, 200, {
          report: "Quality Report",
          items: quality.map(q => ({
            metricId: vf(q, "Metric ID"), phyId: vf(q, "Physician ID"), name: vf(q, "Physician Name"),
            period: vf(q, "Period Name"), metricType: vf(q, "Metric Type"),
            score: vf(q, "Score"), target: vf(q, "Target"), percentile: vf(q, "Percentile"),
            source: vf(q, "Benchmark Source"), status: vf(q, "Status"),
          })),
        });
      } else if (type === "productivity") {
        const productivity = await collect("productivity-data", null, 8);
        // Group by physician
        const byPhy = {};
        for (const p of productivity) {
          const name = vf(p, "Physician Name") || "Unknown";
          if (!byPhy[name]) byPhy[name] = { totalWRVU: 0, targetWRVU: 0, encounters: 0, periods: 0, dept: vf(p, "Department") };
          byPhy[name].totalWRVU += parseFloat(vf(p, "Total wRVUs")) || 0;
          byPhy[name].targetWRVU += parseFloat(vf(p, "Target wRVUs")) || 0;
          byPhy[name].encounters += parseInt(vf(p, "Patient Encounters")) || 0;
          byPhy[name].periods++;
        }
        jsonResp(res, 200, {
          report: "Productivity Summary",
          items: Object.entries(byPhy).map(([name, d]) => ({
            name, dept: d.dept, totalWRVU: d.totalWRVU, targetWRVU: d.targetWRVU,
            pctOfTarget: d.targetWRVU > 0 ? ((d.totalWRVU / d.targetWRVU) * 100).toFixed(1) : "0",
            encounters: d.encounters, periods: d.periods,
          })).sort((a, b) => parseFloat(b.pctOfTarget) - parseFloat(a.pctOfTarget)),
        });
      } else if (type === "benchmark") {
        const benchmarks = await collect("benchmarks", null, 4);
        jsonResp(res, 200, {
          report: "Benchmark Report",
          items: benchmarks.map(b => ({
            bmId: vf(b, "Benchmark ID"), specialty: vf(b, "Specialty"), source: vf(b, "Source"),
            year: vf(b, "Year"), metricType: vf(b, "Metric Type"),
            p25: vf(b, "Percentile 25"), p50: vf(b, "Percentile 50"),
            p75: vf(b, "Percentile 75"), p90: vf(b, "Percentile 90"), status: vf(b, "Status"),
          })),
        });
      } else if (type === "review") {
        const reviews = await collect("reviews", null, 4);
        jsonResp(res, 200, {
          report: "Review Summary",
          items: reviews.map(r => ({
            revId: vf(r, "Review ID"), phyId: vf(r, "Physician ID"), name: vf(r, "Physician Name"),
            period: vf(r, "Period Name"), reviewer: vf(r, "Reviewer"), date: vf(r, "Review Date"),
            overall: vf(r, "Overall Score"), prodScore: vf(r, "Productivity Score"),
            qualScore: vf(r, "Quality Score"), citizenScore: vf(r, "Citizenship Score"),
            status: vf(r, "Status"),
          })),
        });
      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${type}` });
      }
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 8. GET /api/ppc/search?q=&type=
  if (pathname === "/api/ppc/search" && req.method === "GET") {
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
      if (type === "all" || type === "physicians") {
        const phys = await collect("physicians", null, 4);
        search(phys, "Physician", "Last Name", "Physician ID");
      }
      if (type === "all" || type === "reviews") {
        const revs = await collect("reviews", null, 4);
        search(revs, "Review", "Physician Name", "Review ID");
      }
      if (type === "all" || type === "incentives") {
        const incs = await collect("incentive-payments", null, 4);
        search(incs, "Incentive", "Physician Name", "Incentive ID");
      }
      if (type === "all" || type === "benchmarks") {
        const bms = await collect("benchmarks", null, 4);
        search(bms, "Benchmark", "Specialty", "Benchmark ID");
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

  server.listen(PORT, () => console.log(`\n  Physician Performance: http://localhost:${PORT}\n`));
}
