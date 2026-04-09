/**
 * Contract Lifecycle — Custom API Handler
 */

export const appId = "contract-lifecycle";
export const apiPrefix = "/api/clm";
export const kapp = "contract-lifecycle";

// ─── App-specific helpers ──────────────────────────────────────────────────

const vf = (s, f) => s.values?.[f] || "";
function nowISO() { return new Date().toISOString(); }
const CONTRACT_TRANSITIONS = {
  "Draft": ["Under Review"],
  "Under Review": ["Active", "Draft"],
  "Active": ["Expiring", "Terminated"],
  "Expiring": ["Active", "Expired", "Terminated"],
  "Expired": ["Draft"],
  "Terminated": [],
};
const AMENDMENT_TRANSITIONS = {
  "Draft": ["Proposed"],
  "Proposed": ["Under Negotiation", "Rejected"],
  "Under Negotiation": ["Approved", "Rejected", "Proposed"],
  "Approved": ["Executed"],
  "Rejected": ["Draft"],
  "Executed": [],
};
const COMPLIANCE_TRANSITIONS = {
  "Scheduled": ["In Progress"],
  "In Progress": ["Completed", "Follow Up Required"],
  "Completed": [],
  "Follow Up Required": ["In Progress", "Completed"],
};
async function logActivity(auth, contractId, action, entityType, entityId, prev, next, performer, details) {
  const logs = await collect("activity-log", null, 1);
  const logId = `LOG-${String(logs.length + 1).padStart(4, "0")}`;
  await kineticRequest("POST", `/kapps/${KAPP}/forms/activity-log/submissions`, {
    values: {
      "Log ID": logId, "Contract ID": contractId || "",
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


  // 1. GET /api/clm/dashboard
  if (pathname === "/api/clm/dashboard" && req.method === "GET") {
    try {
      const [contracts, amendments, compChecks, renewals, notifications] = await Promise.all([
        collect("contracts", null, 8),
        collect("amendments", null, 4),
        collect("compliance-checks", null, 4),
        collect("renewals", null, 4),
        collect("notifications", null, 4),
      ]);

      const now = Date.now();
      const d90 = new Date(now + 90 * 864e5).toISOString().slice(0, 10);

      // KPIs
      const activeContracts = contracts.filter(c => vf(c, "Status") === "Active").length;
      const totalAnnualValue = contracts
        .filter(c => vf(c, "Status") === "Active")
        .reduce((sum, c) => sum + (parseInt(vf(c, "Annual Value")) || 0), 0);
      const expiring90d = contracts.filter(c => {
        const exp = vf(c, "Expiration Date");
        const st = vf(c, "Status");
        return (st === "Active" || st === "Expiring") && exp && exp <= d90;
      }).length;
      const openAmendments = amendments.filter(a => !["Executed", "Rejected"].includes(vf(a, "Status"))).length;

      const completedChecks = compChecks.filter(c => vf(c, "Status") === "Completed" || vf(c, "Status") === "Follow Up Required");
      const avgComplianceScore = completedChecks.length > 0
        ? (completedChecks.reduce((sum, c) => sum + (parseInt(vf(c, "Compliance Score")) || 0), 0) / completedChecks.length).toFixed(1)
        : "0";
      const pendingRenewals = renewals.filter(r => ["Upcoming", "In Negotiation"].includes(vf(r, "Status"))).length;

      // Recent contracts
      const recentContracts = contracts
        .sort((a, b) => (vf(b, "Effective Date") || "").localeCompare(vf(a, "Effective Date") || ""))
        .slice(0, 10)
        .map(c => ({
          id: c.id, contractId: vf(c, "Contract ID"), name: vf(c, "Contract Name"),
          payer: vf(c, "Payer Name"), type: vf(c, "Contract Type"), status: vf(c, "Status"),
          value: vf(c, "Annual Value"), risk: vf(c, "Risk Level"), expiration: vf(c, "Expiration Date"),
        }));

      // Amendment pipeline
      const amendmentList = amendments
        .filter(a => !["Executed", "Rejected"].includes(vf(a, "Status")))
        .slice(0, 10)
        .map(a => ({
          id: a.id, amendmentId: vf(a, "Amendment ID"), contract: vf(a, "Contract Name"),
          type: vf(a, "Amendment Type"), status: vf(a, "Status"), priority: vf(a, "Priority"),
          impact: vf(a, "Financial Impact"),
        }));

      jsonResp(res, 200, {
        activeContracts, totalAnnualValue, expiring90d, openAmendments,
        avgComplianceScore, pendingRenewals, recentContracts, amendmentList,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 2. GET /api/clm/contract/:id/summary
  const contractSumMatch = pathname.match(/^\/api\/clm\/contract\/([^/]+)\/summary$/);
  if (contractSumMatch && req.method === "GET") {
    const cid = decodeURIComponent(contractSumMatch[1]);
    try {
      const kql = `values[Contract ID] = "${cid}"`;
      const [conArr, termArr, feeArr, amdArr, chkArr, docArr] = await Promise.all([
        collect("contracts", kql, 1),
        collect("terms", `values[Contract ID] = "${cid}"`, 4),
        collect("fee-schedules", `values[Contract ID] = "${cid}"`, 4),
        collect("amendments", `values[Contract ID] = "${cid}"`, 4),
        collect("compliance-checks", `values[Contract ID] = "${cid}"`, 4),
        collect("documents", `values[Contract ID] = "${cid}"`, 4),
      ]);
      if (conArr.length === 0) { jsonResp(res, 404, { error: "Contract not found" }); return true; }

      // Lookup payer
      const payerId = vf(conArr[0], "Payer ID");
      let payer = null;
      if (payerId) {
        const payerArr = await collect("payers", `values[Payer ID] = "${payerId}"`, 1);
        if (payerArr.length > 0) payer = { id: payerArr[0].id, ...payerArr[0].values };
      }

      const m = (s) => ({ id: s.id, ...s.values });
      jsonResp(res, 200, {
        contract: m(conArr[0]),
        payer,
        terms: termArr.map(m),
        feeSchedules: feeArr.map(m),
        amendments: amdArr.map(m),
        complianceChecks: chkArr.map(m),
        documents: docArr.map(m),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 3. GET /api/clm/stats/financials
  if (pathname === "/api/clm/stats/financials" && req.method === "GET") {
    try {
      const contracts = await collect("contracts", null, 8);
      const active = contracts.filter(c => vf(c, "Status") === "Active");

      // By type
      const byType = {};
      for (const c of active) {
        const t = vf(c, "Contract Type") || "Unknown";
        if (!byType[t]) byType[t] = { count: 0, totalValue: 0 };
        byType[t].count++;
        byType[t].totalValue += parseInt(vf(c, "Annual Value")) || 0;
      }

      // By payer
      const byPayer = {};
      for (const c of active) {
        const p = vf(c, "Payer Name") || "Unknown";
        if (!byPayer[p]) byPayer[p] = { count: 0, totalValue: 0 };
        byPayer[p].count++;
        byPayer[p].totalValue += parseInt(vf(c, "Annual Value")) || 0;
      }

      jsonResp(res, 200, { byType, byPayer });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 4. GET /api/clm/stats/compliance
  if (pathname === "/api/clm/stats/compliance" && req.method === "GET") {
    try {
      const checks = await collect("compliance-checks", null, 4);

      // By type
      const byType = {};
      for (const c of checks) {
        const t = vf(c, "Check Type") || "Unknown";
        if (!byType[t]) byType[t] = { count: 0, totalScore: 0, scored: 0, issues: 0 };
        byType[t].count++;
        const score = parseInt(vf(c, "Compliance Score"));
        if (!isNaN(score)) { byType[t].totalScore += score; byType[t].scored++; }
        byType[t].issues += parseInt(vf(c, "Issues Found")) || 0;
      }
      for (const k of Object.keys(byType)) {
        byType[k].avgScore = byType[k].scored > 0 ? (byType[k].totalScore / byType[k].scored).toFixed(1) : "N/A";
      }

      const overdue = checks.filter(c => vf(c, "Status") === "Follow Up Required").length;
      const completed = checks.filter(c => vf(c, "Status") === "Completed").length;
      const scheduled = checks.filter(c => vf(c, "Status") === "Scheduled").length;

      jsonResp(res, 200, { byType, overdue, completed, scheduled, total: checks.length });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 5. POST /api/clm/contracts/:id/transition
  const conTransMatch = pathname.match(/^\/api\/clm\/contracts\/([^/]+)\/transition$/);
  if (conTransMatch && req.method === "POST") {
    const cid = decodeURIComponent(conTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const cons = await collect("contracts", `values[Contract ID] = "${cid}"`, 1);
      if (cons.length === 0) { jsonResp(res, 404, { error: "Contract not found" }); return true; }
      const con = cons[0];
      const current = vf(con, "Status");
      const allowed = CONTRACT_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      await kineticRequest("PUT", `/submissions/${con.id}/values`, updates, auth);
      await logActivity(auth, cid, "Status Changed", "Contract", cid, current, newStatus,
        body.performer || "System", `Contract ${cid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 6. POST /api/clm/amendments/:id/transition
  const amdTransMatch = pathname.match(/^\/api\/clm\/amendments\/([^/]+)\/transition$/);
  if (amdTransMatch && req.method === "POST") {
    const aid = decodeURIComponent(amdTransMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const newStatus = body.status;
      const amds = await collect("amendments", `values[Amendment ID] = "${aid}"`, 1);
      if (amds.length === 0) { jsonResp(res, 404, { error: "Amendment not found" }); return true; }
      const amd = amds[0];
      const current = vf(amd, "Status");
      const allowed = AMENDMENT_TRANSITIONS[current];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${current}" to "${newStatus}"`, allowed });
        return true;
      }
      const updates = { Status: newStatus };
      if (newStatus === "Executed") updates["Effective Date"] = new Date().toISOString().slice(0, 10);
      await kineticRequest("PUT", `/submissions/${amd.id}/values`, updates, auth);
      await logActivity(auth, vf(amd, "Contract ID"), "Amendment " + newStatus, "Amendment", aid, current, newStatus,
        body.performer || "System", `Amendment ${aid} transitioned from ${current} to ${newStatus}`);
      jsonResp(res, 200, { success: true, previous: current, current: newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 7. GET /api/clm/report/:type
  const reportMatch = pathname.match(/^\/api\/clm\/report\/([a-z-]+)$/);
  if (reportMatch && req.method === "GET") {
    const type = reportMatch[1];
    try {
      if (type === "contract-summary") {
        const contracts = await collect("contracts", null, 8);
        jsonResp(res, 200, {
          report: "Contract Summary",
          items: contracts.map(c => ({
            contractId: vf(c, "Contract ID"), name: vf(c, "Contract Name"), payer: vf(c, "Payer Name"),
            type: vf(c, "Contract Type"), status: vf(c, "Status"), risk: vf(c, "Risk Level"),
            value: vf(c, "Annual Value"), effective: vf(c, "Effective Date"), expiration: vf(c, "Expiration Date"),
            autoRenew: vf(c, "Auto Renew"), managedBy: vf(c, "Managed By"),
          })),
        });
      } else if (type === "financial") {
        const contracts = await collect("contracts", null, 8);
        const active = contracts.filter(c => vf(c, "Status") === "Active");
        const byType = {};
        for (const c of active) {
          const t = vf(c, "Contract Type") || "Other";
          if (!byType[t]) byType[t] = { count: 0, total: 0, contracts: [] };
          byType[t].count++;
          const val = parseInt(vf(c, "Annual Value")) || 0;
          byType[t].total += val;
          byType[t].contracts.push({ name: vf(c, "Contract Name"), payer: vf(c, "Payer Name"), value: val });
        }
        jsonResp(res, 200, { report: "Financial Report", byType, totalActive: active.length, totalValue: active.reduce((s, c) => s + (parseInt(vf(c, "Annual Value")) || 0), 0) });
      } else if (type === "compliance") {
        const checks = await collect("compliance-checks", null, 4);
        jsonResp(res, 200, {
          report: "Compliance Report",
          items: checks.map(c => ({
            checkId: vf(c, "Check ID"), contract: vf(c, "Contract Name"), type: vf(c, "Check Type"),
            auditor: vf(c, "Auditor"), date: vf(c, "Audit Date"), score: vf(c, "Compliance Score"),
            issues: vf(c, "Issues Found"), status: vf(c, "Status"), findings: vf(c, "Findings"),
          })),
        });
      } else if (type === "expiration") {
        const contracts = await collect("contracts", null, 8);
        const expiringOrActive = contracts.filter(c => ["Active", "Expiring"].includes(vf(c, "Status")));
        expiringOrActive.sort((a, b) => (vf(a, "Expiration Date") || "").localeCompare(vf(b, "Expiration Date") || ""));
        jsonResp(res, 200, {
          report: "Expiration Report",
          items: expiringOrActive.map(c => ({
            contractId: vf(c, "Contract ID"), name: vf(c, "Contract Name"), payer: vf(c, "Payer Name"),
            status: vf(c, "Status"), expiration: vf(c, "Expiration Date"), autoRenew: vf(c, "Auto Renew"),
            value: vf(c, "Annual Value"), risk: vf(c, "Risk Level"),
          })),
        });
      } else if (type === "amendment") {
        const amendments = await collect("amendments", null, 4);
        jsonResp(res, 200, {
          report: "Amendment Report",
          items: amendments.map(a => ({
            amendmentId: vf(a, "Amendment ID"), contract: vf(a, "Contract Name"), type: vf(a, "Amendment Type"),
            description: vf(a, "Description"), status: vf(a, "Status"), priority: vf(a, "Priority"),
            impact: vf(a, "Financial Impact"), requestedDate: vf(a, "Requested Date"), effectiveDate: vf(a, "Effective Date"),
          })),
        });
      } else if (type === "renewal") {
        const renewals = await collect("renewals", null, 4);
        jsonResp(res, 200, {
          report: "Renewal Report",
          items: renewals.map(r => ({
            renewalId: vf(r, "Renewal ID"), contract: vf(r, "Contract Name"), payer: vf(r, "Payer Name"),
            status: vf(r, "Status"), currentExpiration: vf(r, "Current Expiration"),
            proposedEnd: vf(r, "Proposed End"), lead: vf(r, "Negotiation Lead"),
            impact: vf(r, "Financial Impact"), changes: vf(r, "Proposed Changes"),
          })),
        });
      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${type}` });
      }
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // 8. GET /api/clm/search?q=&type=
  if (pathname === "/api/clm/search" && req.method === "GET") {
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
            results.push({ id: s.id, entityType, entityId: vf(s, idField), name: vf(s, nameField), status: vf(s, "Status") || "" });
          }
        }
      };
      if (type === "all" || type === "contracts") {
        const contracts = await collect("contracts", null, 8);
        search(contracts, "Contract", "Contract Name", "Contract ID");
      }
      if (type === "all" || type === "payers") {
        const payers = await collect("payers", null, 4);
        search(payers, "Payer", "Payer Name", "Payer ID");
      }
      if (type === "all" || type === "amendments") {
        const amds = await collect("amendments", null, 4);
        search(amds, "Amendment", "Description", "Amendment ID");
      }
      if (type === "all" || type === "fee-schedules") {
        const fees = await collect("fee-schedules", null, 8);
        search(fees, "Fee Schedule", "Service Description", "Schedule ID");
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

  server.listen(PORT, () => console.log(`\n  Contract Lifecycle: http://localhost:${PORT}\n`));
}
