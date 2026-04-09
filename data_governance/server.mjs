/**
 * Data Governance — Custom API Handler
 */

export const appId = "data-governance";
export const apiPrefix = "/api/dgov";
export const kapp = "data-governance";

// ─── App-specific helpers ──────────────────────────────────────────────────

const vf = (s, f) => s.values?.[f] || "";
function nowISO() { return new Date().toISOString(); }
const ISSUE_TRANSITIONS = {
  "Open": ["In Progress"],
  "In Progress": ["Resolved", "Deferred"],
  "Resolved": [],
  "Deferred": ["Open", "In Progress"],
  "Accepted": [],
};
const ACCESS_TRANSITIONS = {
  "Submitted": ["Under Review"],
  "Under Review": ["Approved", "Denied"],
  "Approved": ["Expired", "Revoked"],
  "Denied": ["Submitted"],
  "Expired": [],
  "Revoked": [],
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


  // 1. GET /api/dgov/dashboard
  if (pathname === "/api/dgov/dashboard" && req.method === "GET") {
    try {
      const [assets, policies, rules, issues, accessReqs, domains, audits] = await Promise.all([
        collect("data-assets", null, 4),
        collect("policies", null, 4),
        collect("quality-rules", null, 4),
        collect("quality-issues", null, 4),
        collect("access-requests", null, 4),
        collect("data-domains", null, 4),
        collect("audits", null, 4),
      ]);

      // KPIs
      const totalAssets = assets.filter(a => vf(a, "Status") === "Active").length;
      const activePolicies = policies.filter(p => vf(p, "Status") === "Active").length;
      const domainsGoverned = domains.filter(d => vf(d, "Status") === "Active").length;

      // Avg quality score
      const scores = assets.filter(a => vf(a, "Quality Score")).map(a => parseFloat(vf(a, "Quality Score")));
      const avgQuality = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : "0";

      const openIssues = issues.filter(i => ["Open", "In Progress"].includes(vf(i, "Status"))).length;
      const pendingAccess = accessReqs.filter(r => ["Submitted", "Under Review"].includes(vf(r, "Status"))).length;

      // Quality by domain
      const qualityByDomain = {};
      for (const a of assets) {
        const dom = vf(a, "Domain") || "Unknown";
        const score = parseFloat(vf(a, "Quality Score")) || 0;
        if (!qualityByDomain[dom]) qualityByDomain[dom] = { total: 0, sum: 0 };
        qualityByDomain[dom].total++;
        qualityByDomain[dom].sum += score;
      }
      for (const k in qualityByDomain) {
        qualityByDomain[k].avg = (qualityByDomain[k].sum / qualityByDomain[k].total).toFixed(1);
      }

      // Sensitivity distribution
      const sensDist = {};
      for (const a of assets) {
        const s = vf(a, "Sensitivity Level") || "Unknown";
        sensDist[s] = (sensDist[s] || 0) + 1;
      }

      // Recent issues
      const recentIssues = issues
        .sort((a, b) => (vf(b, "Discovered Date") || "").localeCompare(vf(a, "Discovered Date") || ""))
        .slice(0, 8)
        .map(i => ({ id: i.id, issueId: vf(i, "Issue ID"), assetName: vf(i, "Asset Name"), type: vf(i, "Issue Type"), impact: vf(i, "Impact"), status: vf(i, "Status"), date: vf(i, "Discovered Date") }));

      // Recent access requests
      const recentAccess = accessReqs
        .sort((a, b) => (vf(b, "Request Date") || "").localeCompare(vf(a, "Request Date") || ""))
        .slice(0, 8)
        .map(r => ({ id: r.id, requestId: vf(r, "Request ID"), assetName: vf(r, "Asset Name"), requestor: vf(r, "Requestor"), level: vf(r, "Access Level"), status: vf(r, "Status"), date: vf(r, "Request Date") }));

      jsonResp(res, 200, {
        totalAssets, activePolicies, avgQuality, openIssues, pendingAccess, domainsGoverned,
        qualityByDomain, sensDist, recentIssues, recentAccess,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 2. GET /api/dgov/asset/:id/profile
  const assetMatch = pathname.match(/^\/api\/dgov\/asset\/([^/]+)\/profile$/);
  if (assetMatch && req.method === "GET") {
    const aid = decodeURIComponent(assetMatch[1]);
    try {
      const [assetArr, ruleArr, classArr, accessArr] = await Promise.all([
        collect("data-assets", `values[Asset ID] = "${aid}"`, 1),
        collect("quality-rules", `values[Asset ID] = "${aid}"`, 4),
        collect("classifications", `values[Asset ID] = "${aid}"`, 2),
        collect("access-requests", `values[Asset ID] = "${aid}"`, 4),
      ]);
      if (assetArr.length === 0) { jsonResp(res, 404, { error: "Asset not found" }); return true; }
      const m = (s) => ({ id: s.id, ...s.values });
      jsonResp(res, 200, {
        asset: m(assetArr[0]),
        rules: ruleArr.map(m),
        classifications: classArr.map(m),
        accessHistory: accessArr.map(m),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 3. GET /api/dgov/stats/quality
  if (pathname === "/api/dgov/stats/quality" && req.method === "GET") {
    try {
      const [rules, issues, assets] = await Promise.all([
        collect("quality-rules", null, 4),
        collect("quality-issues", null, 4),
        collect("data-assets", null, 4),
      ]);

      // Scores by domain
      const byDomain = {};
      for (const a of assets) {
        const dom = vf(a, "Domain") || "Unknown";
        const score = parseFloat(vf(a, "Quality Score")) || 0;
        if (!byDomain[dom]) byDomain[dom] = { assets: 0, sumScore: 0 };
        byDomain[dom].assets++;
        byDomain[dom].sumScore += score;
      }
      for (const k in byDomain) byDomain[k].avgScore = (byDomain[k].sumScore / byDomain[k].assets).toFixed(1);

      // Issue by type
      const issuesByType = {};
      for (const i of issues) {
        const t = vf(i, "Issue Type") || "Unknown";
        issuesByType[t] = (issuesByType[t] || 0) + 1;
      }

      // Rule compliance
      const ruleCompliance = { passing: 0, failing: 0 };
      for (const r of rules) {
        const threshold = parseFloat(vf(r, "Threshold")) || 0;
        const score = parseFloat(vf(r, "Current Score")) || 0;
        if (score >= threshold) ruleCompliance.passing++;
        else ruleCompliance.failing++;
      }

      // Issues by impact
      const issuesByImpact = { Critical: 0, High: 0, Medium: 0, Low: 0 };
      for (const i of issues) {
        const imp = vf(i, "Impact");
        if (imp in issuesByImpact) issuesByImpact[imp]++;
      }

      jsonResp(res, 200, { byDomain, issuesByType, ruleCompliance, issuesByImpact });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 4. GET /api/dgov/stats/compliance
  if (pathname === "/api/dgov/stats/compliance" && req.method === "GET") {
    try {
      const [policies, audits, classifications, assets] = await Promise.all([
        collect("policies", null, 4),
        collect("audits", null, 4),
        collect("classifications", null, 4),
        collect("data-assets", null, 4),
      ]);

      // Policy by status
      const policyByStatus = {};
      for (const p of policies) {
        const st = vf(p, "Status") || "Unknown";
        policyByStatus[st] = (policyByStatus[st] || 0) + 1;
      }

      // Policy by type
      const policyByType = {};
      for (const p of policies) {
        const t = vf(p, "Policy Type") || "Unknown";
        policyByType[t] = (policyByType[t] || 0) + 1;
      }

      // Audit results
      const auditByStatus = {};
      for (const a of audits) {
        const st = vf(a, "Status") || "Unknown";
        auditByStatus[st] = (auditByStatus[st] || 0) + 1;
      }
      const totalFindings = audits.reduce((sum, a) => sum + (parseInt(vf(a, "Findings Count")) || 0), 0);
      const criticalFindings = audits.reduce((sum, a) => sum + (parseInt(vf(a, "Critical Findings")) || 0), 0);

      // Classification coverage
      const classifiedAssets = new Set(classifications.map(c => vf(c, "Asset ID")));
      const totalAssetsCount = assets.length;
      const classifiedCount = classifiedAssets.size;
      const classByLevel = {};
      for (const c of classifications) {
        const lv = vf(c, "Classification Level") || "Unknown";
        classByLevel[lv] = (classByLevel[lv] || 0) + 1;
      }

      jsonResp(res, 200, {
        policyByStatus, policyByType, auditByStatus,
        totalFindings, criticalFindings,
        classificationCoverage: { total: totalAssetsCount, classified: classifiedCount },
        classByLevel,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 5. POST /api/dgov/issues/:id/transition
  const issueTransMatch = pathname.match(/^\/api\/dgov\/issues\/([^/]+)\/transition$/);
  if (issueTransMatch && req.method === "POST") {
    const iid = decodeURIComponent(issueTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const items = await collect("quality-issues", `values[Issue ID] = "${iid}"`, 1);
      if (items.length === 0) { jsonResp(res, 404, { error: "Issue not found" }); return true; }
      const item = items[0];
      const current = vf(item, "Status");
      const allowed = ISSUE_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (body.resolution) updates["Resolution"] = body.resolution;
      if (body.rootCause) updates["Root Cause"] = body.rootCause;
      await kineticRequest("PUT", `/submissions/${item.id}/values`, updates, auth);
      await logActivity(auth, "Quality Issue", iid, "Status Changed", current, newStatus,
        body.performer || "System", `Issue ${iid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 6. POST /api/dgov/access-requests/:id/transition
  const arTransMatch = pathname.match(/^\/api\/dgov\/access-requests\/([^/]+)\/transition$/);
  if (arTransMatch && req.method === "POST") {
    const rid = decodeURIComponent(arTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const items = await collect("access-requests", `values[Request ID] = "${rid}"`, 1);
      if (items.length === 0) { jsonResp(res, 404, { error: "Access request not found" }); return true; }
      const item = items[0];
      const current = vf(item, "Status");
      const allowed = ACCESS_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Approved") {
        updates["Approval Date"] = new Date().toISOString().slice(0, 10);
        updates["Expiration Date"] = body.expirationDate || new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10);
      }
      await kineticRequest("PUT", `/submissions/${item.id}/values`, updates, auth);
      await logActivity(auth, "Access Request", rid, "Status Changed", current, newStatus,
        body.performer || "System", `Access request ${rid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 7. GET /api/dgov/report/:type
  const reportMatch = pathname.match(/^\/api\/dgov\/report\/([a-z-]+)$/);
  if (reportMatch && req.method === "GET") {
    const type = reportMatch[1];
    try {
      if (type === "quality") {
        const [rules, issues] = await Promise.all([
          collect("quality-rules", null, 4),
          collect("quality-issues", null, 4),
        ]);
        jsonResp(res, 200, {
          report: "Data Quality Report",
          rules: rules.map(r => ({ ruleId: vf(r, "Rule ID"), name: vf(r, "Rule Name"), asset: vf(r, "Asset Name"), type: vf(r, "Rule Type"), threshold: vf(r, "Threshold"), score: vf(r, "Current Score"), status: vf(r, "Status") })),
          issues: issues.map(i => ({ issueId: vf(i, "Issue ID"), asset: vf(i, "Asset Name"), type: vf(i, "Issue Type"), impact: vf(i, "Impact"), records: vf(i, "Records Affected"), status: vf(i, "Status"), date: vf(i, "Discovered Date") })),
        });
      } else if (type === "asset-inventory") {
        const assets = await collect("data-assets", null, 4);
        jsonResp(res, 200, {
          report: "Asset Inventory Report",
          items: assets.map(a => ({ assetId: vf(a, "Asset ID"), name: vf(a, "Asset Name"), type: vf(a, "Asset Type"), domain: vf(a, "Domain"), dept: vf(a, "Department"), sensitivity: vf(a, "Sensitivity Level"), format: vf(a, "Data Format"), quality: vf(a, "Quality Score"), status: vf(a, "Status") })),
        });
      } else if (type === "classification") {
        const classes = await collect("classifications", null, 4);
        jsonResp(res, 200, {
          report: "Classification Report",
          items: classes.map(c => ({ classId: vf(c, "Classification ID"), asset: vf(c, "Asset Name"), level: vf(c, "Classification Level"), phi: vf(c, "Contains PHI"), pii: vf(c, "Contains PII"), financial: vf(c, "Contains Financial"), retention: vf(c, "Retention Period"), status: vf(c, "Status"), date: vf(c, "Classification Date") })),
        });
      } else if (type === "access") {
        const reqs = await collect("access-requests", null, 4);
        jsonResp(res, 200, {
          report: "Access Request Report",
          items: reqs.map(r => ({ requestId: vf(r, "Request ID"), asset: vf(r, "Asset Name"), requestor: vf(r, "Requestor"), level: vf(r, "Access Level"), dept: vf(r, "Department"), status: vf(r, "Status"), requestDate: vf(r, "Request Date"), approvalDate: vf(r, "Approval Date"), expiration: vf(r, "Expiration Date") })),
        });
      } else if (type === "policy") {
        const policies = await collect("policies", null, 4);
        jsonResp(res, 200, {
          report: "Policy Report",
          items: policies.map(p => ({ policyId: vf(p, "Policy ID"), name: vf(p, "Policy Name"), type: vf(p, "Policy Type"), compliance: vf(p, "Compliance Requirement"), version: vf(p, "Version"), status: vf(p, "Status"), effective: vf(p, "Effective Date"), review: vf(p, "Review Date") })),
        });
      } else if (type === "audit") {
        const audits = await collect("audits", null, 4);
        jsonResp(res, 200, {
          report: "Audit Report",
          items: audits.map(a => ({ auditId: vf(a, "Audit ID"), name: vf(a, "Audit Name"), type: vf(a, "Audit Type"), auditor: vf(a, "Auditor"), findings: vf(a, "Findings Count"), critical: vf(a, "Critical Findings"), status: vf(a, "Status"), start: vf(a, "Start Date"), end: vf(a, "End Date") })),
        });
      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${type}` });
      }
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 8. GET /api/dgov/search?q=&type=
  if (pathname === "/api/dgov/search" && req.method === "GET") {
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
            results.push({ id: s.id, entityType, entityId: vf(s, idField), name: vf(s, nameField), status: vf(s, "Status"), domain: vf(s, "Domain") || "" });
          }
        }
      };
      if (type === "all" || type === "assets") {
        const assets = await collect("data-assets", null, 4);
        search(assets, "Asset", "Asset Name", "Asset ID");
      }
      if (type === "all" || type === "policies") {
        const policies = await collect("policies", null, 4);
        search(policies, "Policy", "Policy Name", "Policy ID");
      }
      if (type === "all" || type === "issues") {
        const issues = await collect("quality-issues", null, 4);
        search(issues, "Issue", "Asset Name", "Issue ID");
      }
      if (type === "all" || type === "access") {
        const reqs = await collect("access-requests", null, 4);
        search(reqs, "Access Request", "Asset Name", "Request ID");
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

  server.listen(PORT, () => console.log(`\n  Data Governance: http://localhost:${PORT}\n`));
}
