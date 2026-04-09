/**
 * Data Atlas — Custom API Handler
 */

export const appId = "atlas";
export const apiPrefix = "/api/atlas";
export const kapp = "atlas";

// ─── API Handler ───────────────────────────────────────────────────────────

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }


  // GET /api/atlas/stats/quick — fast: 1 page per form, 5 parallel requests
  if (pathname === "/api/atlas/stats/quick" && req.method === "GET") {
    try {
      const [sysr, dsr, fldr, termsr, issuesr] = await Promise.all([
        kineticRequest("GET", `/kapps/${KAPP}/forms/system/submissions?limit=25`, null, auth),
        kineticRequest("GET", `/kapps/${KAPP}/forms/dataset/submissions?limit=25`, null, auth),
        kineticRequest("GET", `/kapps/${KAPP}/forms/field/submissions?limit=25`, null, auth),
        kineticRequest("GET", `/kapps/${KAPP}/forms/glossary-term/submissions?limit=25`, null, auth),
        kineticRequest("GET", `/kapps/${KAPP}/forms/issue/submissions?include=values,details&limit=25`, null, auth),
      ]);

      const sysCount = (sysr.data?.submissions || []).length;
      const dsCount = (dsr.data?.submissions || []).length;
      const fldCount = (fldr.data?.submissions || []).length;
      const termCount = (termsr.data?.submissions || []).length;
      const issues = issuesr.data?.submissions || [];

      const approx = !!(sysr.data?.nextPageToken || dsr.data?.nextPageToken || fldr.data?.nextPageToken || termsr.data?.nextPageToken);

      const openIssues = issues.filter(s => {
        const st = vf(s, "Status");
        return st === "Open" || st === "In Review";
      });

      const issuesBySev = { Critical: 0, High: 0, Medium: 0, Low: 0 };
      openIssues.forEach(s => { const sev = vf(s, "Severity"); if (sev in issuesBySev) issuesBySev[sev]++; });

      jsonResp(res, 200, {
        systems: sysCount,
        systemsApprox: !!sysr.data?.nextPageToken,
        datasets: dsCount,
        datasetsApprox: !!dsr.data?.nextPageToken,
        fields: fldCount,
        fieldsApprox: !!fldr.data?.nextPageToken,
        terms: termCount,
        termsApprox: !!termsr.data?.nextPageToken,
        openIssues: openIssues.length,
        issuesBySeverity: issuesBySev,
        topIssues: openIssues.slice(0, 8).map(s => ({
          id: s.id,
          title: vf(s, "Title"),
          type: vf(s, "Issue Type"),
          severity: vf(s, "Severity"),
          status: vf(s, "Status"),
          dataset: vf(s, "Related Dataset"),
          system: vf(s, "Related System"),
        })),
        approximate: approx,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/atlas/stats
  if (pathname === "/api/atlas/stats" && req.method === "GET") {
    try {
      const [systems, datasets, fields, terms, issues] = await Promise.all([
        collect("system", null, 4),
        collect("dataset", null, 8),
        collect("field", null, 16),
        collect("glossary-term", null, 4),
        collect("issue", null, 4),
      ]);

      const openIssues = issues.filter(s => {
        const st = vf(s, "Status");
        return st === "Open" || st === "In Review";
      });

      const issuesBySev = { Critical: 0, High: 0, Medium: 0, Low: 0 };
      openIssues.forEach(s => {
        const sev = vf(s, "Severity");
        if (sev in issuesBySev) issuesBySev[sev]++;
      });

      const issuesByType = {};
      openIssues.forEach(s => {
        const t = vf(s, "Issue Type") || "Other";
        issuesByType[t] = (issuesByType[t] || 0) + 1;
      });

      jsonResp(res, 200, {
        systems: systems.length,
        datasets: datasets.length,
        fields: fields.length,
        terms: terms.length,
        openIssues: openIssues.length,
        issuesBySeverity: issuesBySev,
        issuesByType,
        topIssues: openIssues.slice(0, 8).map(s => ({
          id: s.id,
          title: vf(s, "Title"),
          type: vf(s, "Issue Type"),
          severity: vf(s, "Severity"),
          status: vf(s, "Status"),
          dataset: vf(s, "Related Dataset"),
          system: vf(s, "Related System"),
        })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/atlas/stats/health
  if (pathname === "/api/atlas/stats/health" && req.method === "GET") {
    try {
      const [datasets, fields, domains, systems] = await Promise.all([
        collect("dataset", null, 8),
        collect("field", null, 16),
        collect("domain", null, 4),
        collect("system", null, 4),
      ]);

      const totalDs = datasets.length;
      const withOwner = datasets.filter(s => vf(s, "Owner")).length;
      const withClass = datasets.filter(s => vf(s, "Classification")).length;
      const totalFields = fields.length;
      const withDef = fields.filter(s => vf(s, "Business Definition")).length;

      const domainHealth = domains.map(d => {
        const dName = vf(d, "Name");
        const dSystems = systems.filter(s => vf(s, "Domain") === dName);
        const dDatasets = datasets.filter(s => vf(s, "Domain") === dName);
        const dFields = fields.filter(s => {
          const ds = vf(s, "Dataset");
          return dDatasets.some(dd => vf(dd, "Name") === ds);
        });
        const dsWithOwner = dDatasets.filter(s => vf(s, "Owner")).length;
        const dsWithClass = dDatasets.filter(s => vf(s, "Classification")).length;
        const fWithDef = dFields.filter(s => vf(s, "Business Definition")).length;
        return {
          domain: dName,
          status: vf(d, "Status"),
          systems: dSystems.length,
          datasets: dDatasets.length,
          fields: dFields.length,
          ownershipPct: dDatasets.length ? Math.round(dsWithOwner / dDatasets.length * 100) : 0,
          classificationPct: dDatasets.length ? Math.round(dsWithClass / dDatasets.length * 100) : 0,
          definitionPct: dFields.length ? Math.round(fWithDef / dFields.length * 100) : 0,
        };
      });

      jsonResp(res, 200, {
        ownership: totalDs ? Math.round(withOwner / totalDs * 100) : 0,
        classification: totalDs ? Math.round(withClass / totalDs * 100) : 0,
        definition: totalFields ? Math.round(withDef / totalFields * 100) : 0,
        domainHealth,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/atlas/search?q=&type=
  if (pathname === "/api/atlas/search" && req.method === "GET") {
    try {
      const params = new URL(req.url, "http://x").searchParams;
      const q = (params.get("q") || "").toLowerCase().trim();
      const type = params.get("type") || "";

      if (!q) { jsonResp(res, 200, { results: [] }); return true; }

      const forms = type
        ? [type]
        : ["dataset", "field", "glossary-term", "system", "domain", "issue"];

      const results = [];
      for (const form of forms) {
        const subs = await collectByQuery(form, null, auth, 4);
        for (const s of subs) {
          const name = vf(s, "Name") || vf(s, "Title") || "";
          const desc = vf(s, "Description") || vf(s, "Definition") || vf(s, "Business Definition") || "";
          if (name.toLowerCase().includes(q) || desc.toLowerCase().includes(q)) {
            results.push({
              id: s.id,
              type: form,
              name,
              description: desc.slice(0, 200),
              status: vf(s, "Status"),
            });
          }
        }
        if (results.length >= 50) break;
      }

      jsonResp(res, 200, { results: results.slice(0, 50) });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // POST /api/atlas/scan/kinetic — streams newline-delimited JSON progress
  if (pathname === "/api/atlas/scan/kinetic" && req.method === "POST") {

    let parsed;
    try { parsed = JSON.parse(body); } catch { jsonResp(res, 400, { error: "Invalid JSON" }); return true; }
    const { url: sourceUrl, user: sourceUser, pass: sourcePass } = parsed;

    if (!sourceUrl || !sourceUser || !sourcePass) {
      jsonResp(res, 400, { error: "url, user, and pass are required" });
      return true;
    }

    // Stream response
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": "no-cache",
      "Transfer-Encoding": "chunked",
    });

    function send(event, message, extra) {
      const obj = { event, message, ...extra };
      res.write(JSON.stringify(obj) + "\n");
    }

    try {
      send("status", "Authenticating...");
      const scanId = `SCAN-${Date.now()}`;
      const startedAt = new Date().toISOString();
      const sourceAuth = "Basic " + Buffer.from(`${sourceUser}:${sourcePass}`).toString("base64");

      const meResp = await kineticRequest("GET", "/me", null, auth);
      const scannedByUser = meResp.data?.username || "unknown";
      send("status", `Authenticated as ${scannedByUser}`);

      const counts = { systems: 0, datasets: 0, fields: 0, relationships: 0, issues: 0 };

      const sourceReq = (apiPath) => {
        return new Promise((resolve, reject) => {
          const u = new URL(`/app/api/v1${apiPath}`, sourceUrl);
          const headers = { Authorization: sourceAuth, "Content-Type": "application/json" };
          const r = https.request(u, { method: "GET", headers }, (sres) => {
            const chunks = [];
            sres.on("data", c => chunks.push(c));
            sres.on("end", () => {
              const text = Buffer.concat(chunks).toString();
              try { resolve(JSON.parse(text)); } catch { resolve(text); }
            });
          });
          r.on("error", reject);
          r.end();
        });
      };

      send("status", `Connecting to ${sourceUrl}...`);
      const kappsData = await sourceReq("/kapps");
      const kapps = kappsData.kapps || [];
      send("status", `Found ${kapps.length} kapps to scan`);

      for (let ki = 0; ki < kapps.length; ki++) {
        const kapp = kapps[ki];
        const sysName = kapp.name || kapp.slug;
        send("progress", `Scanning kapp ${ki + 1}/${kapps.length}: ${sysName}`, { counts: { ...counts } });

        await kineticRequest("POST", `/kapps/${KAPP}/forms/system/submissions`, {
          values: {
            Name: sysName,
            Description: `Kinetic Kapp: ${kapp.slug}`,
            "System Type": "Platform",
            Technology: "Kinetic Platform",
            Environment: "Production",
            Domain: "",
            Owner: "",
            Status: "Active",
            Tags: "kinetic,auto-scanned",
            "Connection Info": sourceUrl,
          }
        }, auth);
        counts.systems++;

        const formsData = await sourceReq(`/kapps/${kapp.slug}/forms`);
        const forms = formsData.forms || [];
        send("progress", `${sysName}: ${forms.length} forms found`, { counts: { ...counts } });

        for (let fi = 0; fi < forms.length; fi++) {
          const form = forms[fi];
          const dsName = form.name || form.slug;

          await kineticRequest("POST", `/kapps/${KAPP}/forms/dataset/submissions`, {
            values: {
              Name: dsName,
              Description: form.description || `Form in ${kapp.name}`,
              System: sysName,
              Domain: "",
              "Dataset Type": "Form",
              "Schema Name": kapp.slug,
              "Record Count": "",
              "Source of Truth": "No",
              Owner: "",
              Classification: "",
              Status: "Active",
              Tags: "kinetic,auto-scanned",
              Version: "1",
            }
          }, auth);
          counts.datasets++;

          const formDetail = await sourceReq(`/kapps/${kapp.slug}/forms/${form.slug}?include=fields`);
          const formFields = formDetail.form?.fields || [];

          for (const field of formFields) {
            await kineticRequest("POST", `/kapps/${KAPP}/forms/field/submissions`, {
              values: {
                Name: field.name,
                Description: "",
                Dataset: dsName,
                System: sysName,
                "Data Type": "String",
                "Max Length": "",
                Nullable: field.required ? "No" : "Yes",
                "Primary Key": "No",
                "Foreign Key Target": "",
                "Default Value": "",
                "Allowed Values": "",
                "Example Values": "",
                "Business Definition": "",
                "Glossary Term": "",
                Classification: "",
                Status: "Active",
                Tags: "kinetic,auto-scanned",
                "Sort Order": "",
              }
            }, auth);
            counts.fields++;

            const lname = field.name.toLowerCase();
            if (lname.endsWith(" id") || lname.endsWith("_id")) {
              const target = field.name.replace(/[\s_][Ii][Dd]$/, "");
              if (target) {
                await kineticRequest("POST", `/kapps/${KAPP}/forms/relationship/submissions`, {
                  values: {
                    Name: `${dsName}.${field.name} → ${target}`,
                    "Relationship Type": "References",
                    "Source Entity Type": "Field",
                    "Source Entity": `${dsName}.${field.name}`,
                    "Target Entity Type": "Dataset",
                    "Target Entity": target,
                    Confidence: "Auto",
                    Description: "Auto-detected FK reference from field name",
                    Status: "Active",
                  }
                }, auth);
                counts.relationships++;
              }
            }
          }

          send("progress", `${sysName}: ${dsName} (${formFields.length} fields)`, { counts: { ...counts } });
        }
      }

      send("status", "Writing scan result...");

      await kineticRequest("POST", `/kapps/${KAPP}/forms/scan-result/submissions`, {
        values: {
          "Scan ID": scanId,
          "Source Type": "Kinetic Platform",
          "Source Name": sourceUrl,
          "Scan Status": "Completed",
          "Started At": startedAt,
          "Completed At": new Date().toISOString(),
          "Systems Found": String(counts.systems),
          "Datasets Found": String(counts.datasets),
          "Fields Found": String(counts.fields),
          "Relationships Found": String(counts.relationships),
          "Issues Found": String(counts.issues),
          "Scanned By": scannedByUser,
          Notes: `Scanner: server.mjs (POST /api/atlas/scan/kinetic) | Scanned ${kapps.length} kapps`,
        }
      }, auth);

      await kineticRequest("POST", `/kapps/${KAPP}/forms/change-log/submissions`, {
        values: {
          "Entity Type": "Scan",
          "Entity ID": scanId,
          "Entity Name": `Kinetic scan: ${sourceUrl}`,
          Action: "Scan Completed",
          "Changed By": scannedByUser,
          Timestamp: new Date().toISOString(),
          Details: JSON.stringify(counts),
          Notes: "Scanner: server.mjs (internal)",
        }
      }, auth);

      send("complete", "Scan completed", { scanId, counts });
    } catch (e) {
      send("error", e.message);
    }
    res.end();
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

  server.listen(PORT, () => console.log(`\n  Data Atlas: http://localhost:${PORT}\n`));
}
