/**
 * API Manager — Custom API Handler
 *
 * Exports a handler for the base server to auto-discover and mount.
 * Also works standalone: node server.mjs [port]
 */

// ─── App metadata (used by base server auto-discovery) ─────────────────────
export const appId = "api-manager";
export const apiPrefix = "/api/apimgr";
export const kapp = "api-manager";

// ─── API Handler ───────────────────────────────────────────────────────────

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  // GET /api/apimgr/stats — Dashboard statistics
  if (pathname === "/api/apimgr/stats" && req.method === "GET") {
    try {
      const [apis, consumers, contracts, changes, reuse] = await Promise.all([
        collect("apis", null, 4),
        collect("consumers", null, 4),
        collect("contracts", null, 4),
        collect("changes", null, 4),
        collect("reuse-requests", null, 4),
      ]);

      // Count by lifecycle status
      const lifecycle = {};
      const types = {};
      const exposure = {};
      const domains = {};
      const criticality = {};
      const aiUsable = { Yes: 0, No: 0, Restricted: 0 };
      const hosting = {};
      let needsReview = 0;
      const now = new Date();

      for (const a of apis) {
        const ls = vf(a, "Lifecycle Status") || "Unknown";
        lifecycle[ls] = (lifecycle[ls] || 0) + 1;

        const t = vf(a, "API Type") || "Unknown";
        types[t] = (types[t] || 0) + 1;

        const e = vf(a, "Exposure Type") || "Unknown";
        exposure[e] = (exposure[e] || 0) + 1;

        const d = vf(a, "Domain") || "Unknown";
        domains[d] = (domains[d] || 0) + 1;

        const c = vf(a, "Criticality") || "Unknown";
        criticality[c] = (criticality[c] || 0) + 1;

        const ai = vf(a, "AI Usable") || "Unknown";
        if (ai in aiUsable) aiUsable[ai]++;

        const h = vf(a, "Hosting Model") || "Unknown";
        hosting[h] = (hosting[h] || 0) + 1;

        const nextReview = vf(a, "Next Review Date");
        if (nextReview && new Date(nextReview) <= now) needsReview++;
      }

      // Consumer counts per API
      const consumerCounts = {};
      for (const c of consumers) {
        const apiId = vf(c, "API ID");
        if (apiId) consumerCounts[apiId] = (consumerCounts[apiId] || 0) + 1;
      }

      // Top consumed APIs
      const topConsumed = Object.entries(consumerCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([apiId, count]) => {
          const api = apis.find((a) => vf(a, "API ID") === apiId);
          return { apiId, name: api ? vf(api, "Name") : apiId, consumers: count };
        });

      // Contract renewals within 90 days
      const upcomingRenewals = contracts
        .filter((c) => {
          const rd = vf(c, "Renewal Date");
          if (!rd) return false;
          const diff = (new Date(rd) - now) / 86400000;
          return diff > 0 && diff <= 90;
        })
        .map((c) => ({
          contractId: vf(c, "Contract ID"),
          apiName: vf(c, "API Name"),
          vendor: vf(c, "Vendor Name"),
          renewalDate: vf(c, "Renewal Date"),
          annualCost: vf(c, "Annual Cost"),
        }));

      // Change stats
      const changesByStatus = {};
      for (const ch of changes) {
        const s = vf(ch, "Status") || "Unknown";
        changesByStatus[s] = (changesByStatus[s] || 0) + 1;
      }

      // Reuse stats
      const reuseByStatus = {};
      const reuseByRec = {};
      for (const r of reuse) {
        const s = vf(r, "Status") || "Unknown";
        reuseByStatus[s] = (reuseByStatus[s] || 0) + 1;
        const rec = vf(r, "Recommendation");
        if (rec) reuseByRec[rec] = (reuseByRec[rec] || 0) + 1;
      }

      // Deprecated with active consumers
      const deprecatedWithConsumers = apis
        .filter((a) => vf(a, "Lifecycle Status") === "Deprecated")
        .map((a) => {
          const apiId = vf(a, "API ID");
          return {
            apiId,
            name: vf(a, "Name"),
            consumers: consumerCounts[apiId] || 0,
          };
        })
        .filter((a) => a.consumers > 0);

      jsonResp(res, 200, {
        total: apis.length,
        lifecycle,
        types,
        exposure,
        domains,
        criticality,
        aiUsable,
        hosting,
        needsReview,
        topConsumed,
        upcomingRenewals,
        deprecatedWithConsumers,
        changesByStatus,
        reuseByStatus,
        reuseByRec,
        consumerCounts,
        totalConsumers: consumers.length,
        totalContracts: contracts.length,
        totalChanges: changes.length,
        totalReuse: reuse.length,
      });
    } catch (e) {
      jsonResp(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/apimgr/apis/:id/detail — Full detail for one API
  const detailMatch = pathname.match(/^\/api\/api-manager\/apis\/([^/]+)\/detail$/);
  if (detailMatch && req.method === "GET") {
    const apiId = decodeURIComponent(detailMatch[1]);
    try {
      const [apis, consumers, contracts, environments, changes, apiEndpoints] = await Promise.all([
        collect("apis", `values[API ID]="${apiId}"`, 1),
        collect("consumers", `values[API ID]="${apiId}"`, 4),
        collect("contracts", `values[API ID]="${apiId}"`, 2),
        collect("environments", `values[API ID]="${apiId}"`, 2),
        collect("changes", `values[API ID]="${apiId}"`, 4),
        collect("api-endpoints", `values[API ID]="${apiId}"`, 4),
      ]);

      if (apis.length === 0) {
        jsonResp(res, 404, { error: "API not found" });
        return true;
      }

      jsonResp(res, 200, {
        api: apis[0],
        consumers,
        contracts,
        environments,
        changes,
        endpoints: apiEndpoints,
      });
    } catch (e) {
      jsonResp(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/apimgr/reuse/search?q=capability — Search for matching APIs
  if (pathname === "/api/apimgr/reuse/search" && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const query = (url.searchParams.get("q") || "").toLowerCase();
    if (!query) {
      jsonResp(res, 400, { error: "Query parameter 'q' is required" });
      return true;
    }

    try {
      const apis = await collect("apis", null, 4);
      const results = apis
        .map((a) => {
          const name = (vf(a, "Name") || "").toLowerCase();
          const desc = (vf(a, "Short Description") || "").toLowerCase();
          const detailed = (vf(a, "Detailed Description") || "").toLowerCase();
          const capability = (vf(a, "Business Capability") || "").toLowerCase();
          const domain = (vf(a, "Domain") || "").toLowerCase();
          const aiNotes = (vf(a, "AI Recommended Use Cases") || "").toLowerCase();

          const words = query.split(/\s+/);
          let score = 0;
          for (const w of words) {
            if (name.includes(w)) score += 30;
            if (capability.includes(w)) score += 25;
            if (desc.includes(w)) score += 20;
            if (detailed.includes(w)) score += 15;
            if (domain.includes(w)) score += 10;
            if (aiNotes.includes(w)) score += 5;
          }
          return { api: a, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((r) => ({
          apiId: vf(r.api, "API ID"),
          name: vf(r.api, "Name"),
          description: vf(r.api, "Short Description"),
          capability: vf(r.api, "Business Capability"),
          lifecycle: vf(r.api, "Lifecycle Status"),
          type: vf(r.api, "API Type"),
          exposure: vf(r.api, "Exposure Type"),
          aiUsable: vf(r.api, "AI Usable"),
          score: r.score,
        }));

      jsonResp(res, 200, { query, results, totalCatalog: apis.length });
    } catch (e) {
      jsonResp(res, 500, { error: e.message });
    }
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

  server.listen(PORT, () => console.log(`\n  API Manager: http://localhost:${PORT}\n`));
}
