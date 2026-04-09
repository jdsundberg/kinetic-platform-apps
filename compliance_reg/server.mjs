/**
 * Compliance & Regulatory — Custom API Handler
 */

export const appId = "compliance-reg";
export const apiPrefix = "/api/reg";
export const kapp = "compliance-reg";

// ─── App-specific helpers ──────────────────────────────────────────────────

function nowISO() { return new Date().toISOString(); }
const FINDING_TRANSITIONS = {
  "Open": ["In Progress", "Closed"],
  "In Progress": ["Corrective Action Filed", "Closed"],
  "Corrective Action Filed": ["Verified", "In Progress"],
  "Verified": ["Closed"],
};
const CAPA_TRANSITIONS = {
  "Draft": ["Submitted"],
  "Submitted": ["In Progress"],
  "In Progress": ["Implemented"],
  "Implemented": ["Verified", "In Progress"],
  "Verified": ["Closed"],
};
const SURVEY_TRANSITIONS = {
  "Scheduled": ["In Progress"],
  "In Progress": ["Completed", "Report Pending"],
  "Report Pending": ["Completed"],
  "Completed": ["Closed"],
};
async function logActivity(auth, entityType, entityId, action, prevVal, newVal, performer, dept, standard, details) {
  const logId = `LOG-${Date.now()}`;
  try {
    await kineticRequest("POST", `/kapps/${KAPP}/forms/activity-log/submissions`, {
      values: {
        "Log ID": logId, "Entity Type": entityType, "Entity ID": entityId,
        "Action": action, "Previous Value": prevVal, "New Value": newVal,
        "Performed By": performer, "Timestamp": nowISO(),
        "Department": dept, "Details": details, "Related Standard": standard,
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


  // ─── 1. GET /api/reg/dashboard ───
  if (pathname === "/api/reg/dashboard" && req.method === "GET") {
    try {
      const [findings, capas, policies, attestations, departments, surveys, rounds] = await Promise.all([
        collect("findings", null, 4),
        collect("corrective-actions", null, 4),
        collect("policies", null, 4),
        collect("attestations", null, 4),
        collect("departments", null, 2),
        collect("surveys", null, 2),
        collect("rounds", null, 2),
      ]);

      const now = Date.now();

      // Open findings
      const openFindings = findings.filter(f => ["Open", "In Progress", "Corrective Action Filed"].includes(vf(f, "Status")));
      const criticalFindings = openFindings.filter(f => vf(f, "Severity") === "Critical").length;

      // Overdue CAPAs
      const overdueCAPAs = capas.filter(c => {
        const target = new Date(vf(c, "Target Date")).getTime();
        return target > 0 && target < now && !["Closed", "Verified"].includes(vf(c, "Status"));
      }).length;

      // Policy compliance % (active policies with completed attestations)
      const activePolicies = policies.filter(p => vf(p, "Status") === "Active");
      const completedAttestations = attestations.filter(a => vf(a, "Status") === "Completed").length;
      const totalAttestations = attestations.length;
      const policyComplianceRate = totalAttestations > 0 ? (completedAttestations / totalAttestations * 100).toFixed(1) : "0";

      // Average department score
      const activeDepts = departments.filter(d => vf(d, "Status") === "Active");
      const avgDeptScore = activeDepts.length > 0
        ? (activeDepts.reduce((s, d) => s + (parseInt(vf(d, "Compliance Score")) || 0), 0) / activeDepts.length).toFixed(1)
        : "0";

      // Upcoming surveys
      const upcomingSurveys = surveys
        .filter(s => ["Scheduled", "In Progress", "Report Pending"].includes(vf(s, "Status")))
        .map(s => ({
          id: s.id, surveyId: vf(s, "Survey ID"), type: vf(s, "Survey Type"),
          date: vf(s, "Survey Date"), status: vf(s, "Status"), body: vf(s, "Regulatory Body"),
        }));

      // Severity breakdown
      const severityBreakdown = { Critical: 0, Major: 0, Minor: 0, Observation: 0 };
      for (const f of openFindings) {
        const sev = vf(f, "Severity");
        if (severityBreakdown[sev] !== undefined) severityBreakdown[sev]++;
      }

      // Department readiness
      const deptReadiness = activeDepts.map(d => ({
        name: vf(d, "Department Name"), score: vf(d, "Compliance Score"),
        riskLevel: vf(d, "Risk Level"), officer: vf(d, "Compliance Officer"),
        lastAssessed: vf(d, "Last Assessment Date"),
      }));

      // Finding trend by survey
      const findingsBySurvey = surveys.map(s => ({
        surveyId: vf(s, "Survey ID"), type: vf(s, "Survey Type"),
        date: vf(s, "Survey Date"), total: parseInt(vf(s, "Findings Count")) || 0,
        critical: parseInt(vf(s, "Critical Findings")) || 0,
      })).filter(s => s.total > 0);

      jsonResp(res, 200, {
        openFindings: openFindings.length,
        criticalFindings,
        overdueCAPAs,
        policyComplianceRate,
        avgDeptScore,
        upcomingSurveys,
        severityBreakdown,
        deptReadiness,
        findingsBySurvey,
        totalPolicies: activePolicies.length,
        totalAttestations,
        completedAttestations,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 2. GET /api/reg/survey/:id/detail ───
  const surveyMatch = pathname.match(/^\/api\/reg\/survey\/([^/]+)\/detail$/);
  if (surveyMatch && req.method === "GET") {
    const surveyId = decodeURIComponent(surveyMatch[1]);
    try {
      const kql = `values[Survey ID] = "${surveyId}"`;
      const [survs, finds] = await Promise.all([
        collect("surveys", kql, 1),
        collect("findings", `values[Survey ID] = "${surveyId}"`, 4),
      ]);
      if (survs.length === 0) { jsonResp(res, 404, { error: "Survey not found" }); return true; }

      // Get CAPAs for these findings
      const findingIds = finds.map(f => vf(f, "Finding ID")).filter(Boolean);
      let allCAPAs = [];
      if (findingIds.length > 0) {
        allCAPAs = await collect("corrective-actions", null, 4);
        allCAPAs = allCAPAs.filter(c => findingIds.includes(vf(c, "Finding ID")));
      }

      // Get evidence for these findings
      let allEvidence = [];
      if (findingIds.length > 0) {
        allEvidence = await collect("evidence", null, 4);
        allEvidence = allEvidence.filter(e => findingIds.includes(vf(e, "Finding ID")));
      }

      const map = (arr) => arr.map(s => ({ id: s.id, ...s.values }));
      jsonResp(res, 200, {
        survey: { id: survs[0].id, ...survs[0].values },
        findings: map(finds),
        correctiveActions: map(allCAPAs),
        evidence: map(allEvidence),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 3. GET /api/reg/stats/compliance ───
  if (pathname === "/api/reg/stats/compliance" && req.method === "GET") {
    try {
      const [standards, findings] = await Promise.all([
        collect("standards", null, 4),
        collect("findings", null, 4),
      ]);

      // Group standards by regulatory body
      const byBody = {};
      for (const s of standards) {
        const body = vf(s, "Regulatory Body") || "Other";
        if (!byBody[body]) byBody[body] = { total: 0, assessed: 0, withFindings: 0, high: 0, medium: 0, low: 0 };
        byBody[body].total++;
        if (vf(s, "Last Assessed Date")) byBody[body].assessed++;
        const risk = vf(s, "Risk Level");
        if (risk === "High") byBody[body].high++;
        else if (risk === "Medium") byBody[body].medium++;
        else byBody[body].low++;
      }

      // Count open findings per standard code
      const openFindingCodes = new Set();
      for (const f of findings) {
        if (!["Closed", "Verified"].includes(vf(f, "Status"))) {
          openFindingCodes.add(vf(f, "Standard Code"));
        }
      }

      for (const s of standards) {
        const body = vf(s, "Regulatory Body") || "Other";
        if (openFindingCodes.has(vf(s, "Standard Code"))) {
          byBody[body].withFindings++;
        }
      }

      const matrix = Object.entries(byBody).map(([body, stats]) => ({
        regulatoryBody: body,
        totalStandards: stats.total,
        assessed: stats.assessed,
        assessedPct: stats.total > 0 ? (stats.assessed / stats.total * 100).toFixed(1) : "0",
        withOpenFindings: stats.withFindings,
        compliantPct: stats.total > 0 ? ((stats.total - stats.withFindings) / stats.total * 100).toFixed(1) : "0",
        high: stats.high, medium: stats.medium, low: stats.low,
      }));

      jsonResp(res, 200, {
        totalStandards: standards.length,
        totalOpenFindings: openFindingCodes.size,
        matrix,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 4. GET /api/reg/stats/departments ───
  if (pathname === "/api/reg/stats/departments" && req.method === "GET") {
    try {
      const [departments, findings, capas] = await Promise.all([
        collect("departments", null, 2),
        collect("findings", null, 4),
        collect("corrective-actions", null, 4),
      ]);

      const now = Date.now();
      const deptStats = departments.map(d => {
        const deptName = vf(d, "Department Name");
        const deptFindings = findings.filter(f => vf(f, "Department") === deptName);
        const openFinds = deptFindings.filter(f => !["Closed", "Verified"].includes(vf(f, "Status"))).length;
        const deptCAPAs = capas.filter(c => vf(c, "Department") === deptName);
        const overdue = deptCAPAs.filter(c => {
          const target = new Date(vf(c, "Target Date")).getTime();
          return target > 0 && target < now && !["Closed", "Verified"].includes(vf(c, "Status"));
        }).length;

        return {
          deptId: vf(d, "Dept ID"), name: deptName, division: vf(d, "Division"),
          score: vf(d, "Compliance Score"), riskLevel: vf(d, "Risk Level"),
          officer: vf(d, "Compliance Officer"), lastAssessed: vf(d, "Last Assessment Date"),
          totalFindings: deptFindings.length, openFindings: openFinds,
          totalCAPAs: deptCAPAs.length, overdueCAPAs: overdue,
        };
      });

      jsonResp(res, 200, { departments: deptStats });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 5. GET /api/reg/stats/policies ───
  if (pathname === "/api/reg/stats/policies" && req.method === "GET") {
    try {
      const [policies, attestations] = await Promise.all([
        collect("policies", null, 4),
        collect("attestations", null, 4),
      ]);

      const now = Date.now();
      const active = policies.filter(p => vf(p, "Status") === "Active").length;
      const underReview = policies.filter(p => vf(p, "Status") === "Under Review").length;
      const draft = policies.filter(p => vf(p, "Status") === "Draft").length;
      const retired = policies.filter(p => vf(p, "Status") === "Retired").length;

      // Overdue for review
      const overdueReview = policies.filter(p => {
        const due = new Date(vf(p, "Review Due Date")).getTime();
        return due > 0 && due < now && vf(p, "Status") === "Active";
      }).length;

      // Attestation stats by policy
      const policyAttestation = {};
      for (const a of attestations) {
        const pid = vf(a, "Policy ID");
        if (!policyAttestation[pid]) policyAttestation[pid] = { total: 0, completed: 0, pending: 0, overdue: 0 };
        policyAttestation[pid].total++;
        const st = vf(a, "Status");
        if (st === "Completed") policyAttestation[pid].completed++;
        else if (st === "Pending") policyAttestation[pid].pending++;
        else if (st === "Overdue" || st === "Expired") policyAttestation[pid].overdue++;
      }

      const totalAttest = attestations.length;
      const completedAttest = attestations.filter(a => vf(a, "Status") === "Completed").length;
      const overdueAttest = attestations.filter(a => ["Overdue", "Expired"].includes(vf(a, "Status"))).length;

      jsonResp(res, 200, {
        active, underReview, draft, retired,
        overdueReview, totalPolicies: policies.length,
        attestationRate: totalAttest > 0 ? (completedAttest / totalAttest * 100).toFixed(1) : "0",
        totalAttestations: totalAttest, completedAttestations: completedAttest,
        overdueAttestations: overdueAttest,
        byPolicy: policyAttestation,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 6. POST /api/reg/findings/:id/transition ───
  const findTransMatch = pathname.match(/^\/api\/reg\/findings\/([^/]+)\/transition$/);
  if (findTransMatch && req.method === "POST") {
    const subId = decodeURIComponent(findTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const performer = body.performer || "System";
      const r = await kineticRequest("GET", `/submissions/${subId}?include=values`, null, auth);
      if (r.status !== 200) { jsonResp(res, 404, { error: "Submission not found" }); return true; }
      const sub = r.data.submission;
      const oldStatus = sub.values?.["Status"] || "";
      const allowed = FINDING_TRANSITIONS[oldStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${oldStatus}" to "${newStatus}"`, allowed: allowed || [] });
        return true;
      }
      const updates = { "Status": newStatus };
      if (newStatus === "Closed") updates["Closed Date"] = nowISO().slice(0, 10);
      await kineticRequest("PUT", `/submissions/${subId}/values`, updates, auth);
      await logActivity(auth, "Finding", vf(sub, "Finding ID"), "Finding Status Changed", oldStatus, newStatus, performer, vf(sub, "Department"), vf(sub, "Standard Code"), `Finding transitioned from ${oldStatus} to ${newStatus}`);
      jsonResp(res, 200, { success: true, oldStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 7. POST /api/reg/corrective-actions/:id/transition ───
  const capaTransMatch = pathname.match(/^\/api\/reg\/corrective-actions\/([^/]+)\/transition$/);
  if (capaTransMatch && req.method === "POST") {
    const subId = decodeURIComponent(capaTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const performer = body.performer || "System";
      const r = await kineticRequest("GET", `/submissions/${subId}?include=values`, null, auth);
      if (r.status !== 200) { jsonResp(res, 404, { error: "Submission not found" }); return true; }
      const sub = r.data.submission;
      const oldStatus = sub.values?.["Status"] || "";
      const allowed = CAPA_TRANSITIONS[oldStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${oldStatus}" to "${newStatus}"`, allowed: allowed || [] });
        return true;
      }
      const updates = { "Status": newStatus };
      if (newStatus === "Closed" || newStatus === "Verified") updates["Completion Date"] = nowISO().slice(0, 10);
      if (body.verifiedBy) updates["Verified By"] = body.verifiedBy;
      await kineticRequest("PUT", `/submissions/${subId}/values`, updates, auth);
      await logActivity(auth, "Corrective Action", vf(sub, "CAPA ID"), "CAPA Status Changed", oldStatus, newStatus, performer, vf(sub, "Department"), vf(sub, "Standard Code"), `CAPA transitioned from ${oldStatus} to ${newStatus}`);
      jsonResp(res, 200, { success: true, oldStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 8. POST /api/reg/surveys/:id/transition ───
  const survTransMatch = pathname.match(/^\/api\/reg\/surveys\/([^/]+)\/transition$/);
  if (survTransMatch && req.method === "POST") {
    const subId = decodeURIComponent(survTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const performer = body.performer || "System";
      const r = await kineticRequest("GET", `/submissions/${subId}?include=values`, null, auth);
      if (r.status !== 200) { jsonResp(res, 404, { error: "Submission not found" }); return true; }
      const sub = r.data.submission;
      const oldStatus = sub.values?.["Status"] || "";
      const allowed = SURVEY_TRANSITIONS[oldStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${oldStatus}" to "${newStatus}"`, allowed: allowed || [] });
        return true;
      }
      const updates = { "Status": newStatus };
      if (newStatus === "Completed") updates["End Date"] = nowISO().slice(0, 10);
      if (body.score) updates["Score"] = body.score;
      if (body.outcome) updates["Outcome"] = body.outcome;
      if (body.findingsCount) updates["Findings Count"] = body.findingsCount;
      await kineticRequest("PUT", `/submissions/${subId}/values`, updates, auth);
      await logActivity(auth, "Survey", vf(sub, "Survey ID"), "Survey Status Changed", oldStatus, newStatus, performer, "", "", `Survey transitioned from ${oldStatus} to ${newStatus}`);
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

  server.listen(PORT, () => console.log(`\n  Compliance & Regulatory: http://localhost:${PORT}\n`));
}
