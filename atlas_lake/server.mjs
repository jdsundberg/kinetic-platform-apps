/**
 * AtlasLake — Custom API Handler
 *
 * Exports a handler for the base server to auto-discover and mount.
 * Also works standalone: node server.mjs [port]
 */

// ─── App metadata (used by base server auto-discovery) ─────────────────────
export const appId = "atlas-lake";
export const apiPrefix = "/api/lake";
export const kapp = "atlas-lake";

// ─── App-specific helpers ──────────────────────────────────────────────────

function nowISO() { return new Date().toISOString(); }

/* ───── Risk Scoring ───── */
function computeRisk(dataset) {
  const sensMap = { "Public": 1, "Internal": 3, "Confidential": 5, "Restricted": 8 };
  const expMap = { "None": 1, "Internal": 2, "Partner": 3, "Public": 4 };
  const sens = sensMap[dataset["Sensitivity Classification"]] || 1;
  const exp = expMap[dataset["Exposure Level"]] || 1;
  const accessCount = Math.max(1, Math.log10(parseInt(dataset["Access Count"]) || 1));
  const regTags = (dataset["Regulatory Tags"] || "").split(",").filter(Boolean);
  const complianceWeight = regTags.length > 0 ? 1 + (regTags.length * 0.2) : 1;
  return Math.round(sens * exp * accessCount * complianceWeight * 10) / 10;
}

/* ───── Transition Maps ───── */
const ACCESS_TRANSITIONS = {
  "Pending": ["Approved", "Denied"],
  "Approved": ["Revoked", "Expired"],
  "Denied": [],
  "Expired": ["Pending"],
  "Revoked": ["Pending"],
};

const FINDING_TRANSITIONS = {
  "Open": ["In Progress", "Closed"],
  "In Progress": ["Resolved", "Open"],
  "Resolved": ["Closed", "Open"],
  "Closed": [],
};

// ─── API Handler ───────────────────────────────────────────────────────────

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  // ─── 1. GET /api/lake/dashboard ───
  if (pathname === "/api/lake/dashboard" && req.method === "GET") {
    try {
      const [datasets, accessReqs, findings, products, domains, platforms] = await Promise.all([
        collect("datasets", null, 8),
        collect("access-requests", null, 4),
        collect("security-findings", null, 4),
        collect("data-products", null, 4),
        collect("domains", null, 4),
        collect("platforms", null, 4),
      ]);

      // KPIs
      const totalDatasets = datasets.length;
      const totalPlatforms = platforms.length;
      const totalProducts = products.length;
      const openFindings = findings.filter(s => vf(s, "Status") !== "Closed" && vf(s, "Status") !== "Resolved").length;
      const criticalFindings = findings.filter(s => vf(s, "Severity") === "Critical" && vf(s, "Status") !== "Closed").length;
      const pendingAccess = accessReqs.filter(s => vf(s, "Approval State") === "Pending").length;

      // Average quality score
      const qualityScores = datasets.map(s => parseFloat(vf(s, "Quality Score"))).filter(v => !isNaN(v));
      const avgQuality = qualityScores.length > 0
        ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length)
        : 0;

      // Risk heatmap: domain x sensitivity
      const riskHeatmap = {};
      for (const s of datasets) {
        const domain = vf(s, "Domain") || "Unknown";
        const sens = vf(s, "Sensitivity Classification") || "Unknown";
        if (!riskHeatmap[domain]) riskHeatmap[domain] = {};
        if (!riskHeatmap[domain][sens]) riskHeatmap[domain][sens] = { count: 0, totalRisk: 0 };
        riskHeatmap[domain][sens].count++;
        riskHeatmap[domain][sens].totalRisk += parseFloat(vf(s, "Risk Score")) || 0;
      }

      // Regulatory exposure
      const regMap = {};
      for (const s of datasets) {
        const tags = (vf(s, "Regulatory Tags") || "").split(",").filter(Boolean);
        for (const tag of tags) {
          const t = tag.trim();
          if (!regMap[t]) regMap[t] = 0;
          regMap[t]++;
        }
      }

      // Top 10 critical datasets by risk score
      const top10 = datasets
        .map(s => ({
          id: s.id, name: vf(s, "Name"), domain: vf(s, "Domain"),
          platform: vf(s, "Platform"), sensitivity: vf(s, "Sensitivity Classification"),
          riskScore: parseFloat(vf(s, "Risk Score")) || 0,
          qualityScore: parseInt(vf(s, "Quality Score")) || 0,
          regulatoryTags: vf(s, "Regulatory Tags"),
        }))
        .sort((a, b) => b.riskScore - a.riskScore)
        .slice(0, 10);

      // Datasets by platform
      const byPlatform = {};
      for (const s of datasets) {
        const p = vf(s, "Platform") || "Unknown";
        byPlatform[p] = (byPlatform[p] || 0) + 1;
      }

      jsonResp(res, 200, {
        totalDatasets, totalPlatforms, totalProducts, openFindings,
        criticalFindings, pendingAccess, avgQuality,
        riskHeatmap, regulatoryExposure: regMap, top10Critical: top10,
        byPlatform,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 2. GET /api/lake/security ───
  if (pathname === "/api/lake/security" && req.method === "GET") {
    try {
      const [findings, accessReqs, datasets] = await Promise.all([
        collect("security-findings", null, 4),
        collect("access-requests", null, 4),
        collect("datasets", null, 8),
      ]);

      // Open findings by severity
      const findingsBySeverity = { Critical: 0, High: 0, Medium: 0, Low: 0 };
      const findingsByCategory = {};
      const openFindingsList = [];
      for (const s of findings) {
        const sev = vf(s, "Severity");
        if (sev in findingsBySeverity) findingsBySeverity[sev]++;
        const cat = vf(s, "Category") || "Other";
        findingsByCategory[cat] = (findingsByCategory[cat] || 0) + 1;
        if (vf(s, "Status") !== "Closed" && vf(s, "Status") !== "Resolved") {
          openFindingsList.push({
            id: s.id, title: vf(s, "Title"), severity: sev,
            category: vf(s, "Category"), affectedDataset: vf(s, "Affected Dataset"),
            status: vf(s, "Status"), assignedTo: vf(s, "Assigned To"),
            dueDate: vf(s, "Due Date"),
          });
        }
      }

      // High-risk access grants (approved + restricted/confidential datasets)
      const dsMap = {};
      for (const s of datasets) dsMap[vf(s, "Name")] = vf(s, "Sensitivity Classification");

      const highRiskGrants = accessReqs
        .filter(s => vf(s, "Approval State") === "Approved")
        .filter(s => {
          const ds = vf(s, "Dataset");
          return dsMap[ds] === "Restricted" || dsMap[ds] === "Confidential";
        })
        .map(s => ({
          id: s.id, requestor: vf(s, "Requestor"), dataset: vf(s, "Dataset"),
          accessType: vf(s, "Access Type"), sensitivity: dsMap[vf(s, "Dataset")] || "",
          expiryDate: vf(s, "Expiry Date"), riskLevel: vf(s, "Risk Level"),
        }));

      // Encryption gaps
      const encryptionGaps = datasets
        .filter(s => vf(s, "Encryption At Rest") === "None" || vf(s, "Encryption In Transit") === "")
        .map(s => ({
          id: s.id, name: vf(s, "Name"), platform: vf(s, "Platform"),
          sensitivity: vf(s, "Sensitivity Classification"),
          encAtRest: vf(s, "Encryption At Rest"), encInTransit: vf(s, "Encryption In Transit"),
        }));

      // Stale access (approved but expired)
      const today = new Date().toISOString().slice(0, 10);
      const staleAccess = accessReqs
        .filter(s => {
          const state = vf(s, "Approval State");
          const expiry = vf(s, "Expiry Date");
          return state === "Approved" && expiry && expiry < today;
        })
        .map(s => ({
          id: s.id, requestor: vf(s, "Requestor"), dataset: vf(s, "Dataset"),
          expiryDate: vf(s, "Expiry Date"),
        }));

      jsonResp(res, 200, {
        findingsBySeverity, findingsByCategory, openFindings: openFindingsList,
        highRiskGrants, encryptionGaps, staleAccess,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 3. GET /api/lake/steward ───
  if (pathname === "/api/lake/steward" && req.method === "GET") {
    try {
      const datasets = await collect("datasets", null, 8);

      // Missing metadata alerts
      const missingMetadata = datasets
        .filter(s => !vf(s, "Owner") || !vf(s, "Data Steward") || !vf(s, "Description"))
        .map(s => ({
          id: s.id, name: vf(s, "Name"), platform: vf(s, "Platform"),
          missingOwner: !vf(s, "Owner"), missingSteward: !vf(s, "Data Steward"),
          missingDescription: !vf(s, "Description"),
        }));

      // Unclassified datasets
      const unclassified = datasets
        .filter(s => !vf(s, "Sensitivity Classification"))
        .map(s => ({ id: s.id, name: vf(s, "Name"), platform: vf(s, "Platform"), domain: vf(s, "Domain") }));

      // Quality degradation (score < 85)
      const qualityAlerts = datasets
        .filter(s => {
          const q = parseInt(vf(s, "Quality Score"));
          return !isNaN(q) && q < 85;
        })
        .map(s => ({
          id: s.id, name: vf(s, "Name"), qualityScore: parseInt(vf(s, "Quality Score")),
          completeness: vf(s, "Completeness"), domain: vf(s, "Domain"), platform: vf(s, "Platform"),
        }))
        .sort((a, b) => a.qualityScore - b.qualityScore);

      // Full dataset registry
      const registry = datasets.map(s => ({
        id: s.id, name: vf(s, "Name"), platform: vf(s, "Platform"), domain: vf(s, "Domain"),
        owner: vf(s, "Owner"), steward: vf(s, "Data Steward"),
        sensitivity: vf(s, "Sensitivity Classification"),
        qualityScore: parseInt(vf(s, "Quality Score")) || 0,
        riskScore: parseFloat(vf(s, "Risk Score")) || 0,
        recordCount: vf(s, "Record Count"), refreshFrequency: vf(s, "Refresh Frequency"),
        regulatoryTags: vf(s, "Regulatory Tags"), status: vf(s, "Status"),
      }));

      jsonResp(res, 200, { missingMetadata, unclassified, qualityAlerts, registry });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 4. GET /api/lake/compliance ───
  if (pathname === "/api/lake/compliance" && req.method === "GET") {
    try {
      const [datasets, accessReqs] = await Promise.all([
        collect("datasets", null, 8),
        collect("access-requests", null, 4),
      ]);

      // Regulatory matrix: for each regulation, list affected datasets
      const regMatrix = {};
      for (const s of datasets) {
        const tags = (vf(s, "Regulatory Tags") || "").split(",").filter(Boolean);
        for (const tag of tags) {
          const t = tag.trim();
          if (!regMatrix[t]) regMatrix[t] = [];
          regMatrix[t].push({
            id: s.id, name: vf(s, "Name"), domain: vf(s, "Domain"),
            platform: vf(s, "Platform"), sensitivity: vf(s, "Sensitivity Classification"),
            encryption: vf(s, "Encryption At Rest"), masking: vf(s, "Masking Policy"),
            qualityScore: parseInt(vf(s, "Quality Score")) || 0,
          });
        }
      }

      // Audit trail: access request history (all states)
      const auditTrail = accessReqs
        .map(s => ({
          id: s.id, requestor: vf(s, "Requestor"), dataset: vf(s, "Dataset"),
          accessType: vf(s, "Access Type"), state: vf(s, "Approval State"),
          approver: vf(s, "Approver"), approvedDate: vf(s, "Approved Date"),
          expiryDate: vf(s, "Expiry Date"), riskLevel: vf(s, "Risk Level"),
          justification: vf(s, "Justification"),
        }));

      // Compliance summary per regulation
      const complianceSummary = {};
      for (const [reg, dsList] of Object.entries(regMatrix)) {
        const encrypted = dsList.filter(d => d.encryption && d.encryption !== "None").length;
        const masked = dsList.filter(d => d.masking && d.masking !== "None").length;
        const highQuality = dsList.filter(d => d.qualityScore >= 90).length;
        complianceSummary[reg] = {
          datasetCount: dsList.length,
          encryptedPct: dsList.length > 0 ? Math.round(encrypted / dsList.length * 100) : 0,
          maskedPct: dsList.length > 0 ? Math.round(masked / dsList.length * 100) : 0,
          highQualityPct: dsList.length > 0 ? Math.round(highQuality / dsList.length * 100) : 0,
        };
      }

      jsonResp(res, 200, { regulatoryMatrix: regMatrix, auditTrail, complianceSummary });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 5. GET /api/lake/lineage ───
  if (pathname === "/api/lake/lineage" && req.method === "GET") {
    try {
      const [lineageRecords, platforms] = await Promise.all([
        collect("lineage", null, 4),
        collect("platforms", null, 4),
      ]);

      const lineageGraph = lineageRecords.map(s => ({
        id: s.id,
        source: vf(s, "Source Dataset"),
        target: vf(s, "Target Dataset"),
        transformType: vf(s, "Transform Type"),
        platform: vf(s, "Platform"),
        frequency: vf(s, "Frequency"),
        status: vf(s, "Status"),
      }));

      const platformInventory = platforms.map(s => ({
        id: s.id, name: vf(s, "Name"), type: vf(s, "Platform Type"),
        vendor: vf(s, "Vendor"), environment: vf(s, "Environment"),
        region: vf(s, "Region"), status: vf(s, "Status"),
        owner: vf(s, "Owner"), costCenter: vf(s, "Cost Center"),
        description: vf(s, "Description"),
      }));

      jsonResp(res, 200, { lineageGraph, platformInventory });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 6. POST /api/lake/access-requests/:id/transition ───
  const accessTransMatch = pathname.match(/^\/api\/lake\/access-requests\/([^/]+)\/transition$/);
  if (accessTransMatch && req.method === "POST") {
    try {
      const submissionId = accessTransMatch[1];
      const body = JSON.parse(await readBody(req));
      const { newStatus, notes, user } = body;

      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};
      const currentStatus = vals["Approval State"];

      const allowed = ACCESS_TRANSITIONS[currentStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${currentStatus}" to "${newStatus}"` });
        return true;
      }

      const updates = { "Approval State": newStatus };

      if (newStatus === "Approved") {
        updates["Approver"] = user || "";
        updates["Approved Date"] = nowISO().slice(0, 10);
        updates["Expiry Date"] = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
      }

      if (notes) updates["Notes"] = (vals["Notes"] || "") + (vals["Notes"] ? "\n" : "") + `${nowISO().slice(0, 10)} | ${user || "system"}: ${notes}`;

      await kineticRequest("PUT", `/submissions/${submissionId}/values`, updates, auth);

      jsonResp(res, 200, { success: true, previousStatus: currentStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 7. POST /api/lake/security-findings/:id/transition ───
  const findingTransMatch = pathname.match(/^\/api\/lake\/security-findings\/([^/]+)\/transition$/);
  if (findingTransMatch && req.method === "POST") {
    try {
      const submissionId = findingTransMatch[1];
      const body = JSON.parse(await readBody(req));
      const { newStatus, notes, user, remediationPlan } = body;

      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};
      const currentStatus = vals["Status"];

      const allowed = FINDING_TRANSITIONS[currentStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${currentStatus}" to "${newStatus}"` });
        return true;
      }

      const updates = { Status: newStatus };

      if (newStatus === "In Progress" && remediationPlan) {
        updates["Remediation Plan"] = remediationPlan;
      }
      if (newStatus === "Resolved" || newStatus === "Closed") {
        updates["Resolved Date"] = nowISO().slice(0, 10);
      }

      await kineticRequest("PUT", `/submissions/${submissionId}/values`, updates, auth);

      jsonResp(res, 200, { success: true, previousStatus: currentStatus, newStatus });
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

  const PORT = process.env.PORT || 3020;
  const KINETIC = process.env.KINETIC_URL || "https://first.kinetics.com";
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

  server.listen(PORT, () => console.log(`\n  AtlasLake: http://localhost:${PORT}\n`));
}
