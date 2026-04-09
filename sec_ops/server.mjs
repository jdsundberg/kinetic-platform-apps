/**
 * Security Operations — Custom API Handler
 *
 * Exports a handler for the base server to auto-discover and mount.
 * Also works standalone: node server.mjs [port]
 */
import crypto from "node:crypto";

// ─── App metadata (used by base server auto-discovery) ─────────────────────
export const appId = "sec-ops";
export const apiPrefix = "/api/secops";
export const kapp = "sec-ops";

// ─── App-specific helpers ──────────────────────────────────────────────────

function computeDedupeHash(alert) {
  const key = `${alert.source}|${alert.external_alert_id || ""}|${(alert.indicators || []).sort().join(",")}|${alert.title}`;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function computeCorrelationKey(alert) {
  return `${alert.asset_id || ""}|${alert.category || ""}|${(alert.indicators || []).slice(0, 3).sort().join(",")}`;
}

function computeVulnRiskScore(vuln) {
  const sevWeights = { Critical: 10, High: 7, Medium: 4, Low: 2, Informational: 0 };
  const sevWeight = sevWeights[vuln.severity] || 0;
  const critFactor = (parseInt(vuln.asset_criticality) || 1) * 1.5;
  const epssBoost = parseFloat(vuln.epss) > 0.5 ? 3 : parseFloat(vuln.epss) > 0.1 ? 1.5 : 0;
  const kevBoost = vuln.cisa_kev === "true" || vuln.cisa_kev === true ? 4 : 0;
  return Math.round((sevWeight + critFactor + epssBoost + kevBoost) * 10) / 10;
}

function computeVulnDueDate(severity, assetCriticality) {
  const now = new Date();
  const crit = parseInt(assetCriticality) || 1;
  let days = 90;
  if (severity === "Critical" && crit >= 4) days = 7;
  else if (severity === "Critical") days = 15;
  else if (severity === "High") days = 30;
  else if (severity === "Medium") days = 60;
  now.setDate(now.getDate() + days);
  return now.toISOString().split("T")[0];
}

function nowISO() { return new Date().toISOString(); }

// ─── API Handler ───────────────────────────────────────────────────────────
// Called by the base server with shared helpers:
//   helpers.collectByQuery(kapp, formSlug, kql, auth, maxPages)
//   helpers.kineticRequest(method, path, body, auth)
//   helpers.jsonResp(res, status, data)
//   helpers.readBody(req)
//   helpers.vf(submission, fieldName)

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  // GET /api/secops/stats — dashboard KPIs (nested format for UI)
  if (pathname === "/api/secops/stats" && req.method === "GET") {
    try {
      const now = Date.now();
      const h24 = 864e5;
      const [allIncs, allAlerts, allVulns, assets] = await Promise.all([
        collect("security-incident", null, 8),
        collect("security-alert", null, 8),
        collect("vulnerability-finding", null, 8),
        collect("asset", null, 4),
      ]);

      const openIncs = allIncs.filter(s => vf(s, 'Status') !== 'Closed' && vf(s, 'Status') !== 'Resolved');
      const slaBreaches = openIncs.filter(s => vf(s, 'SLA Due') && new Date(vf(s, 'SLA Due')) < new Date());
      const alerts24h = allAlerts.filter(s => (now - new Date(s.createdAt || s.submittedAt).getTime()) < h24);
      const openVulns = allVulns.filter(s => vf(s, 'Status') !== 'Remediated' && vf(s, 'Status') !== 'Fixed' && vf(s, 'Status') !== 'Closed');
      const overdueVulns = openVulns.filter(s => vf(s, 'Due Date') && new Date(vf(s, 'Due Date')) < new Date());

      // Incidents by severity (S1-S4 mapping)
      const sevMap = { Critical: 'S1', High: 'S2', Medium: 'S3', Low: 'S4' };
      const bySev = { S1: 0, S2: 0, S3: 0, S4: 0 };
      for (const inc of allIncs) { const k = sevMap[vf(inc, 'Severity')]; if (k) bySev[k]++; }

      // Alerts by source (last 24h)
      const bySource = {};
      for (const a of alerts24h) { const s = vf(a, 'Source') || 'Unknown'; bySource[s] = (bySource[s] || 0) + 1; }

      // MTTC from incidents that have containment time
      const containedIncs = allIncs.filter(s => s.createdAt && (vf(s, 'Status') === 'Contained' || vf(s, 'Status') === 'Eradicated' || vf(s, 'Status') === 'Closed'));
      const mttcHours = containedIncs.length > 0
        ? Math.round(containedIncs.reduce((sum, s) => sum + (new Date(s.updatedAt || s.createdAt) - new Date(s.createdAt)) / 36e5, 0) / containedIncs.length * 10) / 10
        : 0;

      // Top risky assets
      const assetRisk = {};
      for (const v2 of openVulns) {
        const h = vf(v2, 'Hostname') || vf(v2, 'Asset ID') || 'Unknown';
        if (!assetRisk[h]) assetRisk[h] = { hostname: h, openVulns: 0, openIncidents: 0 };
        assetRisk[h].openVulns++;
      }
      for (const inc of openIncs) {
        const h = vf(inc, 'Hostname') || vf(inc, 'Asset ID') || '';
        if (h && assetRisk[h]) assetRisk[h].openIncidents++;
      }
      const topRiskyAssets = Object.values(assetRisk)
        .map(a => ({ ...a, total: a.openVulns + a.openIncidents }))
        .sort((a, b) => b.total - a.total).slice(0, 10);

      jsonResp(res, 200, {
        incidents: { open: openIncs.length, slaBreaches: slaBreaches.length, mttc: mttcHours + 'h', bySeverity: bySev },
        alerts: { last24h: alerts24h.length, bySource },
        vulns: { open: openVulns.length, overdue: overdueVulns.length },
        topRiskyAssets,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/secops/stats/reports (nested format for UI)
  if (pathname === "/api/secops/stats/reports" && req.method === "GET") {
    try {
      const now = Date.now();
      const [alerts, incidents, vulns, playbooks, runs] = await Promise.all([
        collect("security-alert"), collect("security-incident"),
        collect("vulnerability-finding"), collect("playbook"),
        collect("playbook-run"),
      ]);

      // MTTA, MTTC, MTTR from incidents
      const resolved = incidents.filter(s => vf(s, 'Status') === 'Closed' || vf(s, 'Status') === 'Resolved');
      const avgTime = (list, field) => {
        const valid = list.filter(s => s.createdAt);
        if (!valid.length) return '0h';
        const avg = valid.reduce((sum, s) => sum + (new Date(s.updatedAt || s.createdAt) - new Date(s.createdAt)) / 36e5, 0) / valid.length;
        return Math.round(avg * 10) / 10 + 'h';
      };

      // Weekly alert trend (last 8 weeks)
      const weeklyAlerts = [];
      for (let w = 7; w >= 0; w--) {
        const start = new Date(now - (w + 1) * 7 * 864e5);
        const end = new Date(now - w * 7 * 864e5);
        const count = alerts.filter(a => { const t = new Date(a.createdAt); return t >= start && t < end; }).length;
        weeklyAlerts.push({ label: start.toISOString().slice(0, 10), count });
      }

      // Closed this month / fixed this month
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const closedThisMonth = incidents.filter(s => (vf(s, 'Status') === 'Closed' || vf(s, 'Status') === 'Resolved') && new Date(s.updatedAt) >= monthStart).length;
      const fixedThisMonth = vulns.filter(s => (vf(s, 'Status') === 'Remediated' || vf(s, 'Status') === 'Fixed') && new Date(s.updatedAt) >= monthStart).length;

      // Vuln aging
      const vulnAging = { '<7d': 0, '7-30d': 0, '30-90d': 0, '>90d': 0 };
      for (const v2 of vulns) {
        if (vf(v2, 'Status') === 'Remediated' || vf(v2, 'Status') === 'Fixed') continue;
        const days = Math.floor((now - new Date(v2.createdAt).getTime()) / 864e5);
        const bucket = days < 7 ? '<7d' : days < 30 ? '7-30d' : days < 90 ? '30-90d' : '>90d';
        vulnAging[bucket]++;
      }

      jsonResp(res, 200, {
        mtta: avgTime(incidents), mttc: avgTime(incidents), mttr: avgTime(resolved),
        weeklyAlerts, closedThisMonth, fixedThisMonth, vulnAging,
        totalPlaybooks: playbooks.length, totalRuns: runs.length,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/secops/incidents/sla-at-risk
  if (pathname === "/api/secops/incidents/sla-at-risk" && req.method === "GET") {
    try {
      const incs = await collect("security-incident");
      const atRisk = incs
        .filter(s => vf(s, 'Status') !== 'Closed' && vf(s, 'SLA Due'))
        .filter(s => {
          const due = new Date(vf(s, 'SLA Due'));
          const hoursLeft = (due - Date.now()) / 36e5;
          return hoursLeft < 4;
        })
        .map(s => ({
          id: s.id, title: vf(s, 'Title'), severity: vf(s, 'Severity'),
          status: vf(s, 'Status'), slaDue: vf(s, 'SLA Due'),
          assignee: vf(s, 'Assigned To'),
        }));
      jsonResp(res, 200, { incidents: atRisk });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/secops/vulns/overdue
  if (pathname === "/api/secops/vulns/overdue" && req.method === "GET") {
    try {
      const vulns = await collect("vulnerability-finding");
      const overdue = vulns
        .filter(s => vf(s, 'Status') !== 'Remediated' && vf(s, 'Due Date'))
        .filter(s => new Date(vf(s, 'Due Date')) < new Date())
        .map(s => ({
          id: s.id, cveId: vf(s, 'CVE ID'), title: vf(s, 'Title'),
          severity: vf(s, 'Severity'), dueDate: vf(s, 'Due Date'),
          asset: vf(s, 'Asset ID'), owner: vf(s, 'Owner'),
        }));
      jsonResp(res, 200, { vulnerabilities: overdue });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/secops/alerts/ingest
  if (pathname === "/api/secops/alerts/ingest" && req.method === "POST") {
    try {
      const raw = JSON.parse(await readBody(req));
      const alerts = Array.isArray(raw) ? raw : [raw];
      const results = [];
      for (const alert of alerts) {
        const values = {
          "Source": alert.source || "", "External Alert ID": alert.external_alert_id || "",
          "Received At": nowISO(), "Severity": alert.severity || "Medium",
          "Status": "New", "Category": alert.category || "Unknown",
          "Title": alert.title || "", "Description": alert.description || "",
          "Asset ID": alert.asset_id || "", "Hostname": alert.hostname || "",
          "IP Address": alert.ip_address || "", "User ID": alert.user_id || "",
          "Indicators": (alert.indicators || []).join(","),
          "Correlation Key": computeCorrelationKey(alert),
          "Dedupe Hash": computeDedupeHash(alert),
          "Environment": alert.environment || "Production", "Alert Count": "1",
        };
        const r = await kineticRequest("POST", `/kapps/${KAPP}/forms/security-alert/submissions`,
          { values, coreState: "Submitted" }, auth);
        results.push({ status: r.status < 300 ? "created" : "error", id: r.data?.submission?.id });
      }
      jsonResp(res, 200, { ingested: results.length, results });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/secops/vulns/ingest
  if (pathname === "/api/secops/vulns/ingest" && req.method === "POST") {
    try {
      const raw = JSON.parse(await readBody(req));
      const vulns = Array.isArray(raw) ? raw : [raw];
      const results = [];
      for (const vuln of vulns) {
        const riskScore = computeVulnRiskScore(vuln);
        const dueDate = computeVulnDueDate(vuln.severity, vuln.asset_criticality);
        const values = {
          "CVE ID": vuln.cve_id || "", "Title": vuln.title || "",
          "Severity": vuln.severity || "Medium", "CVSS Score": String(vuln.cvss || ""),
          "Status": "Open", "Asset ID": vuln.asset_id || "",
          "Hostname": vuln.hostname || "", "Environment": vuln.environment || "Production",
          "Scanner Source": vuln.scanner || "", "First Seen": nowISO(),
          "Due Date": dueDate, "Risk Score": String(riskScore),
          "EPSS": String(vuln.epss || ""), "CISA KEV": String(vuln.cisa_kev || false),
          "Description": vuln.description || "", "Remediation": vuln.remediation || "",
        };
        const r = await kineticRequest("POST", `/kapps/${KAPP}/forms/vulnerability-finding/submissions`,
          { values, coreState: "Submitted" }, auth);
        results.push({ status: r.status < 300 ? "created" : "error", id: r.data?.submission?.id });
      }
      jsonResp(res, 200, { ingested: results.length, results });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/secops/incidents/:id/transition
  const transMatch = pathname.match(/^\/api\/secops\/incidents\/([^/]+)\/transition$/);
  if (transMatch && req.method === "POST") {
    try {
      const id = transMatch[1];
      const body = JSON.parse(await readBody(req));
      const values = {};
      if (body.status) values["Status"] = body.status;
      if (body.assignee) values["Assigned To"] = body.assignee;
      if (body.notes) values["Notes"] = body.notes;
      const r = await kineticRequest("PUT", `/submissions/${id}`, { values }, auth);
      jsonResp(res, r.status < 300 ? 200 : r.status, r.data);
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/secops/vulns/:id/accept-risk
  const riskMatch = pathname.match(/^\/api\/secops\/vulns\/([^/]+)\/accept-risk$/);
  if (riskMatch && req.method === "POST") {
    try {
      const id = riskMatch[1];
      const body = JSON.parse(await readBody(req));
      const values = { "Status": "Risk Accepted", "Risk Acceptance Notes": body.reason || "" };
      const r = await kineticRequest("PUT", `/submissions/${id}`, { values }, auth);
      jsonResp(res, r.status < 300 ? 200 : r.status, r.data);
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/secops/playbooks/:id/run
  const pbMatch = pathname.match(/^\/api\/secops\/playbooks\/([^/]+)\/run$/);
  if (pbMatch && req.method === "POST") {
    try {
      const pbId = pbMatch[1];
      const pb = await kineticRequest("GET", `/submissions/${pbId}?include=values`, null, auth);
      const pbData = pb.data?.submission || pb.data;
      const values = {
        "Playbook ID": pbId, "Playbook Name": pbData?.values?.["Name"] || "",
        "Started At": nowISO(), "Status": "Running", "Triggered By": "Manual",
      };
      const r = await kineticRequest("POST", `/kapps/${KAPP}/forms/playbook-run/submissions`,
        { values, coreState: "Submitted" }, auth);
      jsonResp(res, 200, { runId: r.data?.submission?.id, status: "started" });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/secops/audit
  if (pathname === "/api/secops/audit" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const values = {
        "Event Type": body.eventType || "Manual", "Actor": body.actor || "",
        "Target": body.target || "", "Details": body.details || "",
        "Timestamp": nowISO(), "Source IP": body.sourceIp || "",
      };
      const r = await kineticRequest("POST", `/kapps/${KAPP}/forms/audit-event/submissions`,
        { values, coreState: "Submitted" }, auth);
      jsonResp(res, 200, { id: r.data?.submission?.id });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}

// ─── Standalone mode ───────────────────────────────────────────────────────
// When run directly (not imported by base server), start a standalone server.
if (import.meta.url === `file://${process.argv[1]}`) {
  const http = await import("node:http");
  const https = await import("node:https");
  const fs = await import("node:fs");
  const path = await import("node:path");

  const PORT = process.env.PORT || 3007;
  const KINETIC = process.env.KINETIC_URL || "https://first.kinetics.com";
  const __dir = path.dirname(new URL(import.meta.url).pathname);

  // Build standalone helpers
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

  server.listen(PORT, () => console.log(`\n  Security Operations: http://localhost:${PORT}\n`));
}
