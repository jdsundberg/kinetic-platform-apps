/**
 * Third-Party Risk — Custom API Handler
 */

export const appId = "third-party-risk";
export const apiPrefix = "/api/tprm";
export const kapp = "third-party-risk";

// ─── App-specific helpers ──────────────────────────────────────────────────

const vf = (s, f) => s.values?.[f] || "";
function nowISO() { return new Date().toISOString(); }
const ASSESSMENT_TRANSITIONS = {
  "Scheduled": ["In Progress"],
  "In Progress": ["Under Review"],
  "Under Review": ["Completed", "In Progress"],
  "Completed": [],
  "Overdue": ["In Progress"],
};
const INCIDENT_TRANSITIONS = {
  "Open": ["Investigating"],
  "Investigating": ["Contained", "Open"],
  "Contained": ["Resolved"],
  "Resolved": ["Closed"],
  "Closed": [],
};
const REMEDIATION_TRANSITIONS = {
  "Open": ["In Progress"],
  "In Progress": ["Completed", "Overdue"],
  "Completed": ["Verified"],
  "Overdue": ["In Progress", "Waived"],
  "Verified": [],
};
async function logActivity(auth, action, entityType, entityId, prev, next, performer, details) {
  const logs = await collect("activity-log", null, 1);
  const logId = `LOG-${String(logs.length + 1).padStart(4, "0")}`;
  await kineticRequest("POST", `/kapps/${KAPP}/forms/activity-log/submissions`, {
    values: {
      "Log ID": logId,
      "Entity Type": entityType, "Entity ID": entityId,
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


  // 1. GET /api/tprm/dashboard
  if (pathname === "/api/tprm/dashboard" && req.method === "GET") {
    try {
      const [vendors, assessments, incidents, certs, remediations, alerts] = await Promise.all([
        collect("vendors", null, 4),
        collect("assessments", null, 4),
        collect("incidents", null, 4),
        collect("certifications", null, 4),
        collect("remediation-plans", null, 4),
        collect("monitoring-alerts", null, 2),
      ]);

      const now = Date.now();
      const d90 = new Date(now + 90 * 864e5).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);

      // KPIs
      const totalVendors = vendors.filter(v => vf(v, "Status") === "Active").length;
      const highRiskVendors = vendors.filter(v => ["Critical", "High"].includes(vf(v, "Criticality")) && vf(v, "Status") === "Active").length;
      const openAssessments = assessments.filter(a => ["Scheduled", "In Progress", "Under Review", "Overdue"].includes(vf(a, "Status"))).length;
      const activeIncidents = incidents.filter(i => !["Resolved", "Closed"].includes(vf(i, "Status"))).length;
      const expiringCerts = certs.filter(c => {
        const exp = vf(c, "Expiration Date");
        return exp && exp <= d90 && exp >= today && vf(c, "Verification Status") === "Verified";
      }).length;
      const overdueRemediation = remediations.filter(r => vf(r, "Status") === "Overdue").length;

      // Recent assessments
      const recentAssessments = assessments
        .sort((a, b) => (vf(b, "Start Date") || "").localeCompare(vf(a, "Start Date") || ""))
        .slice(0, 10)
        .map(a => ({
          id: a.id, assessmentId: vf(a, "Assessment ID"), vendorName: vf(a, "Vendor Name"),
          type: vf(a, "Assessment Type"), score: vf(a, "Overall Risk Score"),
          status: vf(a, "Status"), priority: vf(a, "Priority"), dueDate: vf(a, "Due Date"),
        }));

      // Active incidents
      const incidentList = incidents
        .filter(i => !["Closed"].includes(vf(i, "Status")))
        .slice(0, 10)
        .map(i => ({
          id: i.id, incidentId: vf(i, "Incident ID"), vendorName: vf(i, "Vendor Name"),
          title: vf(i, "Title"), severity: vf(i, "Severity"), status: vf(i, "Status"),
          date: vf(i, "Discovery Date"),
        }));

      jsonResp(res, 200, {
        totalVendors, highRiskVendors, openAssessments, activeIncidents,
        expiringCerts, overdueRemediation, recentAssessments, incidentList,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 2. GET /api/tprm/vendor/:id/profile
  const vendorMatch = pathname.match(/^\/api\/tprm\/vendor\/([^/]+)\/profile$/);
  if (vendorMatch && req.method === "GET") {
    const vid = decodeURIComponent(vendorMatch[1]);
    try {
      const kql = `values[Vendor ID] = "${vid}"`;
      const [vendorArr, asmArr, riskArr, certArr, incArr] = await Promise.all([
        collect("vendors", kql, 1),
        collect("assessments", `values[Vendor ID] = "${vid}"`, 4),
        collect("risks", `values[Vendor ID] = "${vid}"`, 4),
        collect("certifications", `values[Vendor ID] = "${vid}"`, 4),
        collect("incidents", `values[Vendor ID] = "${vid}"`, 2),
      ]);
      if (vendorArr.length === 0) { jsonResp(res, 404, { error: "Vendor not found" }); return true; }
      const m = (s) => ({ id: s.id, ...s.values });
      jsonResp(res, 200, {
        vendor: m(vendorArr[0]),
        assessments: asmArr.map(m),
        risks: riskArr.map(m),
        certifications: certArr.map(m),
        incidents: incArr.map(m),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 3. GET /api/tprm/stats/risk-posture
  if (pathname === "/api/tprm/stats/risk-posture" && req.method === "GET") {
    try {
      const [risks, vendors] = await Promise.all([
        collect("risks", null, 8),
        collect("vendors", null, 4),
      ]);

      // Risk distribution by category
      const byCat = {};
      for (const r of risks) {
        const cat = vf(r, "Risk Category") || "Unknown";
        if (!byCat[cat]) byCat[cat] = { total: 0, open: 0, mitigating: 0, closed: 0 };
        byCat[cat].total++;
        const ms = vf(r, "Mitigation Status");
        if (ms === "Open") byCat[cat].open++;
        else if (ms === "Mitigating") byCat[cat].mitigating++;
        else if (ms === "Closed") byCat[cat].closed++;
      }

      // Vendor tier distribution
      const byTier = {};
      for (const v of vendors) {
        const tier = vf(v, "Tier") || "Unknown";
        byTier[tier] = (byTier[tier] || 0) + 1;
      }

      // Risk by likelihood/impact
      const riskMatrix = {};
      for (const r of risks) {
        const lik = vf(r, "Likelihood") || "Unknown";
        const imp = vf(r, "Impact") || "Unknown";
        const key = `${lik}|${imp}`;
        riskMatrix[key] = (riskMatrix[key] || 0) + 1;
      }

      jsonResp(res, 200, { byCat, byTier, riskMatrix, totalRisks: risks.length });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 4. GET /api/tprm/stats/compliance
  if (pathname === "/api/tprm/stats/compliance" && req.method === "GET") {
    try {
      const [certs, assessments, controls] = await Promise.all([
        collect("certifications", null, 4),
        collect("assessments", null, 4),
        collect("controls", null, 8),
      ]);

      // Cert coverage
      const certByType = {};
      for (const c of certs) {
        const t = vf(c, "Certification Type") || "Unknown";
        if (!certByType[t]) certByType[t] = { total: 0, verified: 0, expired: 0, pending: 0 };
        certByType[t].total++;
        const vs = vf(c, "Verification Status");
        if (vs === "Verified") certByType[t].verified++;
        else if (vs === "Expired") certByType[t].expired++;
        else if (vs === "Pending Verification") certByType[t].pending++;
      }

      // Assessment completion
      const totalAsm = assessments.length;
      const completedAsm = assessments.filter(a => vf(a, "Status") === "Completed").length;
      const overdueAsm = assessments.filter(a => vf(a, "Status") === "Overdue").length;

      // Control effectiveness
      const ctlEff = { effective: 0, partial: 0, ineffective: 0, notTested: 0, na: 0 };
      for (const c of controls) {
        const e = vf(c, "Effectiveness");
        if (e === "Effective") ctlEff.effective++;
        else if (e === "Partially Effective") ctlEff.partial++;
        else if (e === "Ineffective") ctlEff.ineffective++;
        else if (e === "Not Tested") ctlEff.notTested++;
        else ctlEff.na++;
      }

      jsonResp(res, 200, { certByType, totalAsm, completedAsm, overdueAsm, ctlEff });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 5. POST /api/tprm/assessments/:id/transition
  const asmTransMatch = pathname.match(/^\/api\/tprm\/assessments\/([^/]+)\/transition$/);
  if (asmTransMatch && req.method === "POST") {
    const aid = decodeURIComponent(asmTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const asms = await collect("assessments", `values[Assessment ID] = "${aid}"`, 1);
      if (asms.length === 0) { jsonResp(res, 404, { error: "Assessment not found" }); return true; }
      const asm = asms[0];
      const current = vf(asm, "Status");
      const allowed = ASSESSMENT_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Completed") updates["Completion Date"] = new Date().toISOString().slice(0, 10);
      await kineticRequest("PUT", `/submissions/${asm.id}/values`, updates, auth);
      await logActivity(auth, "Status Changed", "Assessment", aid, current, newStatus,
        body.performer || "System", `Assessment ${aid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 6. POST /api/tprm/incidents/:id/transition
  const incTransMatch = pathname.match(/^\/api\/tprm\/incidents\/([^/]+)\/transition$/);
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
      if (newStatus === "Resolved" || newStatus === "Closed") updates["Resolution Date"] = new Date().toISOString().slice(0, 10);
      if (body.rootCause) updates["Root Cause"] = body.rootCause;
      if (body.correctiveAction) updates["Corrective Action"] = body.correctiveAction;
      await kineticRequest("PUT", `/submissions/${inc.id}/values`, updates, auth);
      await logActivity(auth, "Incident " + newStatus, "Incident", iid, current, newStatus,
        body.performer || "System", `Incident ${iid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 7. GET /api/tprm/report/:type
  const reportMatch = pathname.match(/^\/api\/tprm\/report\/([a-z-]+)$/);
  if (reportMatch && req.method === "GET") {
    const type = reportMatch[1];
    try {
      if (type === "risk-summary") {
        const risks = await collect("risks", null, 8);
        jsonResp(res, 200, {
          report: "Risk Summary",
          items: risks.map(r => ({
            riskId: vf(r, "Risk ID"), vendor: vf(r, "Vendor Name"), category: vf(r, "Risk Category"),
            description: vf(r, "Risk Description"), likelihood: vf(r, "Likelihood"), impact: vf(r, "Impact"),
            inherent: vf(r, "Inherent Risk Score"), residual: vf(r, "Residual Risk Score"),
            status: vf(r, "Mitigation Status"), owner: vf(r, "Risk Owner"),
          })),
        });
      } else if (type === "vendor-assessment") {
        const [vendors, assessments] = await Promise.all([
          collect("vendors", null, 4),
          collect("assessments", null, 4),
        ]);
        const vendorMap = {};
        for (const v of vendors) {
          const vid = vf(v, "Vendor ID");
          vendorMap[vid] = { vendor: vf(v, "Vendor Name"), tier: vf(v, "Tier"), criticality: vf(v, "Criticality"), status: vf(v, "Status"), assessments: 0, completed: 0, latestScore: "" };
        }
        for (const a of assessments) {
          const vid = vf(a, "Vendor ID");
          if (vendorMap[vid]) {
            vendorMap[vid].assessments++;
            if (vf(a, "Status") === "Completed") {
              vendorMap[vid].completed++;
              vendorMap[vid].latestScore = vf(a, "Overall Risk Score") || vendorMap[vid].latestScore;
            }
          }
        }
        jsonResp(res, 200, { report: "Vendor Assessment", items: Object.values(vendorMap) });
      } else if (type === "incident") {
        const incidents = await collect("incidents", null, 4);
        jsonResp(res, 200, {
          report: "Incident Report",
          items: incidents.map(i => ({
            incidentId: vf(i, "Incident ID"), vendor: vf(i, "Vendor Name"), type: vf(i, "Incident Type"),
            title: vf(i, "Title"), severity: vf(i, "Severity"), status: vf(i, "Status"),
            discoveryDate: vf(i, "Discovery Date"), resolutionDate: vf(i, "Resolution Date"),
            rootCause: vf(i, "Root Cause"), notification: vf(i, "Notification Required"),
          })),
        });
      } else if (type === "certification") {
        const certs = await collect("certifications", null, 4);
        jsonResp(res, 200, {
          report: "Certification Report",
          items: certs.map(c => ({
            certId: vf(c, "Certification ID"), vendor: vf(c, "Vendor Name"), type: vf(c, "Certification Type"),
            body: vf(c, "Certifying Body"), issueDate: vf(c, "Issue Date"), expirationDate: vf(c, "Expiration Date"),
            scope: vf(c, "Scope"), status: vf(c, "Verification Status"),
          })),
        });
      } else if (type === "remediation") {
        const rems = await collect("remediation-plans", null, 4);
        jsonResp(res, 200, {
          report: "Remediation Report",
          items: rems.map(r => ({
            planId: vf(r, "Plan ID"), vendor: vf(r, "Vendor Name"), description: vf(r, "Description"),
            priority: vf(r, "Priority"), assignedTo: vf(r, "Assigned To"), status: vf(r, "Status"),
            targetDate: vf(r, "Target Date"), completionDate: vf(r, "Completion Date"),
          })),
        });
      } else if (type === "compliance") {
        const [certs, controls] = await Promise.all([
          collect("certifications", null, 4),
          collect("controls", null, 8),
        ]);
        const certStats = {};
        for (const c of certs) {
          const t = vf(c, "Certification Type");
          if (!certStats[t]) certStats[t] = { total: 0, verified: 0, expired: 0 };
          certStats[t].total++;
          if (vf(c, "Verification Status") === "Verified") certStats[t].verified++;
          if (vf(c, "Verification Status") === "Expired") certStats[t].expired++;
        }
        const ctlStats = {};
        for (const c of controls) {
          const cat = vf(c, "Control Category");
          if (!ctlStats[cat]) ctlStats[cat] = { total: 0, implemented: 0, partial: 0, notImpl: 0 };
          ctlStats[cat].total++;
          const impl = vf(c, "Implementation Status");
          if (impl === "Implemented") ctlStats[cat].implemented++;
          else if (impl === "Partially Implemented") ctlStats[cat].partial++;
          else if (impl === "Not Implemented") ctlStats[cat].notImpl++;
        }
        jsonResp(res, 200, { report: "Compliance Overview", certStats, ctlStats });
      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${type}` });
      }
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 8. GET /api/tprm/search?q=&type=
  if (pathname === "/api/tprm/search" && req.method === "GET") {
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
            results.push({ id: s.id, entityType, entityId: vf(s, idField), name: vf(s, nameField), status: vf(s, "Status") || vf(s, "Mitigation Status") || "" });
          }
        }
      };
      if (type === "all" || type === "vendors") {
        const vendors = await collect("vendors", null, 4);
        search(vendors, "Vendor", "Vendor Name", "Vendor ID");
      }
      if (type === "all" || type === "assessments") {
        const asms = await collect("assessments", null, 4);
        search(asms, "Assessment", "Vendor Name", "Assessment ID");
      }
      if (type === "all" || type === "risks") {
        const risks = await collect("risks", null, 8);
        search(risks, "Risk", "Risk Description", "Risk ID");
      }
      if (type === "all" || type === "incidents") {
        const incs = await collect("incidents", null, 4);
        search(incs, "Incident", "Title", "Incident ID");
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

  server.listen(PORT, () => console.log(`\n  Third-Party Risk: http://localhost:${PORT}\n`));
}
