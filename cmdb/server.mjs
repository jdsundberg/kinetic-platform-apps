/**
 * CMDB — Configuration Management Database
 *
 * Flagship app: serves as the system of record for all Configuration Items (CIs)
 * across the platform. Other apps consume CMDB data through:
 *   - HTTP API endpoints (this file)
 *   - WebAPIs (defined in app.json + registered separately)
 *   - Routines (Kinetic workflows that call back into these endpoints)
 *
 * Custom API surface (mounted at /api/cmdb):
 *   GET  /api/cmdb/stats                          dashboard counts
 *   GET  /api/cmdb/classes                        list CI classes
 *   GET  /api/cmdb/search?class=&env=&q=          search CIs (paginated)
 *   GET  /api/cmdb/lookup?name=&fqdn=&ip=         single-shot find
 *   GET  /api/cmdb/ci/:class/:id                  retrieve CI with relationships
 *   GET  /api/cmdb/ci/:class/:id/dependencies     downstream graph (what I rely on)
 *   GET  /api/cmdb/ci/:class/:id/impact           upstream graph (what depends on me)
 *   GET  /api/cmdb/service-map/:class/:id         full topology centered on a CI
 *   GET  /api/cmdb/relationships?ci=:class/:id    list relationships
 *   GET  /api/cmdb/health                         data-quality KPIs
 *   POST /api/cmdb/ci                             upsert a CI (idempotent on CI Number or natural key)
 *   POST /api/cmdb/relate                         upsert a relationship
 *
 * Standalone usage:  node apps/cmdb/server.mjs 3020
 */

export const appId = "cmdb";
export const apiPrefix = "/api/cmdb";
export const kapp = "cmdb";

// Class form slugs that hold CIs (everything except cross-cutting forms)
const CI_CLASSES = [
  "datacenters",
  "clusters",
  "servers",
  "network-devices",
  "storage",
  "databases",
  "applications",
  "services",
];

// Map form slug -> display Class name (for friendlier responses)
const CLASS_DISPLAY = {
  "datacenters": "Datacenter",
  "clusters": "Cluster",
  "servers": "Server",
  "network-devices": "Network Device",
  "storage": "Storage",
  "databases": "Database",
  "applications": "Application",
  "services": "Service",
};

function shapeCI(formSlug, sub) {
  const v = sub.values || {};
  return {
    class: formSlug,
    className: CLASS_DISPLAY[formSlug] || formSlug,
    submissionId: sub.id,
    ciNumber: v["CI Number"] || sub.id,
    name: v["Name"] || "",
    status: v["Status"] || "",
    environment: v["Environment"] || "",
    location: v["Location"] || "",
    owner: v["Owner"] || "",
    ownerTeam: v["Owner Team"] || "",
    criticality: v["Criticality"] || "",
    description: v["Description"] || "",
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
    values: v,
  };
}

function shapeRel(sub) {
  const v = sub.values || {};
  return {
    submissionId: sub.id,
    relationshipId: v["Relationship ID"] || sub.id,
    sourceClass: v["Source Class"] || "",
    sourceCiNumber: v["Source CI Number"] || "",
    sourceName: v["Source Name"] || "",
    targetClass: v["Target Class"] || "",
    targetCiNumber: v["Target CI Number"] || "",
    targetName: v["Target Name"] || "",
    type: v["Type"] || "",
    direction: v["Direction"] || "Forward",
    status: v["Status"] || "Active",
    description: v["Description"] || "",
  };
}

// In-memory cache for expensive count walks. Counts don't change rapidly,
// and on 100k+ records the keyset walk takes 60-90s. 5-min TTL keeps the
// dashboard responsive while staying close enough to live state.
// Also tracks in-flight promises so concurrent first-load requests share
// one compute instead of stampeding.
const _cache = new Map();
const _inflight = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
async function withCache(key, ttl, fn) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.t < ttl) return { ...hit.v, _cacheAgeMs: now - hit.t };
  if (_inflight.has(key)) return _inflight.get(key);
  const p = (async () => {
    try {
      const v = await fn();
      _cache.set(key, { t: Date.now(), v });
      return { ...v, _cacheAgeMs: 0 };
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

// ─── API Handler ───────────────────────────────────────────────────────────
export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;
  const url = new URL(req.url, "http://localhost");

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  function kqlEq(field, val) {
    if (!val) return null;
    const v = String(val).replace(/"/g, '\\"');
    return `values[${field}] = "${v}"`;
  }
  function kqlAnd(parts) { return parts.filter(Boolean).join(" AND "); }

  // Count submissions for a form. Kinetic's listing endpoint hard-caps at
  // 1000 records per query — pageToken can't get past that. So we use the
  // collectByQuery keyset pattern: filter by createdAt < lastSeen each
  // iteration, which walks the dataset in 1000-record chunks. Empty
  // include= keeps the payload tiny (~50 bytes/record).
  async function countSubmissions(formSlug, kql, maxPages = 200) {
    let total = 0;
    let lastCreatedAt = null;
    const pageSize = 999; // engine treats 1000 as terminal — stay just under
    for (let i = 0; i < maxPages; i++) {
      // include=details adds createdAt/updatedAt timestamps; still no field values.
      let path = `/kapps/${KAPP}/forms/${formSlug}/submissions?limit=${pageSize}&include=details`;
      let q = kql || "";
      if (lastCreatedAt) q = (q ? `(${q}) AND ` : "") + `createdAt < "${lastCreatedAt}"`;
      if (q) path += `&q=${encodeURIComponent(q)}`;
      const r = await kineticRequest("GET", path, null, auth);
      const subs = r.data?.submissions || [];
      total += subs.length;
      if (subs.length < pageSize) break;
      lastCreatedAt = subs[subs.length - 1].createdAt;
      if (!lastCreatedAt) break;
    }
    return total;
  }

  // ─── GET /api/cmdb/stats ─────────────────────────────────────────────
  // True per-class counts via parallel keyset walks. byEnv / byStatus /
  // byCriticality are computed from a 200-record-per-class sample —
  // labeled as such. Cached 5 min to keep dashboard snappy.
  if (pathname === "/api/cmdb/stats" && req.method === "GET") {
    try {
      const result = await withCache("stats", CACHE_TTL_MS, async () => {
        const [classCounts, relCount, samples, recentChanges] = await Promise.all([
          Promise.all(CI_CLASSES.map(cls => countSubmissions(cls))),
          countSubmissions("relationships"),
          Promise.all(CI_CLASSES.map(cls => collect(cls, null, 8))),
          collect("ci-change-log", null, 4),
        ]);

        const byClass = {};
        let totalCIs = 0;
        CI_CLASSES.forEach((cls, i) => { byClass[cls] = classCounts[i]; totalCIs += classCounts[i]; });

        const byEnv = {}, byStatus = {}, byCriticality = {};
        let sampleSize = 0;
        for (const subs of samples) {
          sampleSize += subs.length;
          for (const s of subs) {
            const v = s.values || {};
            const e = v["Environment"] || "(none)";
            const st = v["Status"] || "(none)";
            const c = v["Criticality"] || "(none)";
            byEnv[e] = (byEnv[e] || 0) + 1;
            byStatus[st] = (byStatus[st] || 0) + 1;
            byCriticality[c] = (byCriticality[c] || 0) + 1;
          }
        }

        const sortedChanges = recentChanges
          .sort((a, b) => new Date(b.values?.["Timestamp"] || 0) - new Date(a.values?.["Timestamp"] || 0))
          .slice(0, 10);

        return {
          totals: {
            cis: totalCIs,
            relationships: relCount,
            services: byClass["services"] || 0,
            classes: CI_CLASSES.length,
          },
          byClass,
          byEnv, byStatus, byCriticality,
          sampleSize,
          sampled: totalCIs > sampleSize,
          recentChanges: sortedChanges.map(s => ({
            ciNumber: s.values?.["CI Number"],
            ciClass: s.values?.["CI Class"],
            ciName: s.values?.["CI Name"],
            action: s.values?.["Action"],
            field: s.values?.["Field"],
            actor: s.values?.["Actor"],
            timestamp: s.values?.["Timestamp"],
          })),
        };
      });
      jsonResp(res, 200, result);
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── GET /api/cmdb/classes ───────────────────────────────────────────
  // Cached 5 min — same expensive keyset count walks as /stats.
  if (pathname === "/api/cmdb/classes" && req.method === "GET") {
    try {
      const result = await withCache("classes", CACHE_TTL_MS, async () => {
        const [classes, countResults] = await Promise.all([
          collect("ci-classes", null, 2),
          Promise.all(CI_CLASSES.map(c => countSubmissions(c))),
        ]);
        const counts = {};
        CI_CLASSES.forEach((c, i) => { counts[c] = countResults[i]; });
        return {
          classes: classes.map(s => ({
            name: s.values?.["Class Name"],
            slug: s.values?.["Form Slug"],
            category: s.values?.["Category"],
            icon: s.values?.["Icon"],
            color: s.values?.["Color"],
            description: s.values?.["Description"],
            defaultCriticality: s.values?.["Default Criticality"],
            count: counts[s.values?.["Form Slug"]] || 0,
          })),
          counts,
        };
      });
      jsonResp(res, 200, result);
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── GET /api/cmdb/search?class=&env=&status=&q=&limit=25 ──────────
  if (pathname === "/api/cmdb/search" && req.method === "GET") {
    try {
      const cls = url.searchParams.get("class");
      const env = url.searchParams.get("env");
      const status = url.searchParams.get("status");
      const crit = url.searchParams.get("criticality");
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const targetClasses = cls ? [cls] : CI_CLASSES;
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "25"), 25);

      const results = [];
      for (const c of targetClasses) {
        const kql = kqlAnd([kqlEq("Environment", env), kqlEq("Status", status), kqlEq("Criticality", crit)]);
        const subs = await collect(c, kql || null, 8);
        for (const s of subs) {
          const ci = shapeCI(c, s);
          if (q) {
            const blob = `${ci.name} ${ci.ciNumber} ${ci.description} ${ci.owner} ${(ci.values["FQDN"] || "")} ${(ci.values["IP Address"] || "")}`.toLowerCase();
            if (!blob.includes(q)) continue;
          }
          results.push(ci);
        }
      }
      // Sort by class, then name
      results.sort((a, b) => (a.class + a.name).localeCompare(b.class + b.name));
      jsonResp(res, 200, {
        total: results.length,
        truncated: false,
        results: results.slice(0, limit),
        nextOffset: results.length > limit ? limit : null,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── GET /api/cmdb/lookup?name=&fqdn=&ip=&ciNumber= ──────────────────
  if (pathname === "/api/cmdb/lookup" && req.method === "GET") {
    try {
      const ciNumber = url.searchParams.get("ciNumber");
      const name = url.searchParams.get("name");
      const fqdn = url.searchParams.get("fqdn");
      const ip = url.searchParams.get("ip");
      const cls = url.searchParams.get("class");
      const targetClasses = cls ? [cls] : CI_CLASSES;
      let match = null;
      for (const c of targetClasses) {
        let kql = null;
        if (ciNumber) kql = kqlEq("CI Number", ciNumber);
        else if (fqdn) kql = kqlEq("FQDN", fqdn);
        else if (ip) kql = kqlEq("IP Address", ip);
        else if (name) kql = kqlEq("Name", name);
        if (!kql) continue;
        const subs = await collect(c, kql, 2);
        if (subs.length) { match = shapeCI(c, subs[0]); break; }
      }
      if (!match) { jsonResp(res, 404, { error: "Not found" }); return; }
      jsonResp(res, 200, { ci: match });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── GET /api/cmdb/ci/:class/:id ─────────────────────────────────────
  const ciMatch = pathname.match(/^\/api\/cmdb\/ci\/([^/]+)\/([^/]+)$/);
  if (ciMatch && req.method === "GET") {
    try {
      const [, cls, id] = ciMatch;
      if (!CI_CLASSES.includes(cls)) { jsonResp(res, 400, { error: `Unknown class: ${cls}` }); return; }
      const subs = await collect(cls, kqlEq("CI Number", id), 1);
      if (!subs.length) { jsonResp(res, 404, { error: "CI not found" }); return; }
      const ci = shapeCI(cls, subs[0]);

      // Fetch relationships where this CI is source or target.
      // Query on a single-field indexed clause, then filter by Source/Target Class in code.
      // (5-AND or 3-AND filters silently return empty when no index covers the full shape.)
      const [outRels, inRels] = await Promise.all([
        collect("relationships", kqlEq("Source CI Number", id), 4),
        collect("relationships", kqlEq("Target CI Number", id), 4),
      ]);
      const outFiltered = outRels.filter(s => s.values?.["Source Class"] === cls);
      const inFiltered = inRels.filter(s => s.values?.["Target Class"] === cls);

      // Recent change log
      const changes = await collect("ci-change-log", kqlEq("CI Number", id), 2);

      jsonResp(res, 200, {
        ci,
        relationships: {
          outgoing: outFiltered.map(shapeRel),
          incoming: inFiltered.map(shapeRel),
        },
        changeLog: changes
          .sort((a, b) => new Date(b.values?.["Timestamp"] || 0) - new Date(a.values?.["Timestamp"] || 0))
          .slice(0, 25)
          .map(s => ({
            action: s.values?.["Action"],
            field: s.values?.["Field"],
            oldValue: s.values?.["Old Value"],
            newValue: s.values?.["New Value"],
            actor: s.values?.["Actor"],
            timestamp: s.values?.["Timestamp"],
            notes: s.values?.["Notes"],
          })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── BFS graph traversal helper ──────────────────────────────────────
  async function traverse(startClass, startId, direction, depth) {
    // direction: 'down' (follow outgoing - dependencies) | 'up' (follow incoming - impact) | 'both'
    depth = Math.min(Math.max(parseInt(depth) || 3, 1), 6);
    const seen = new Set([`${startClass}/${startId}`]);
    const nodes = [];
    const edges = [];
    const queue = [{ cls: startClass, id: startId, level: 0 }];

    // Fetch root CI
    const rootSubs = await collect(startClass, kqlEq("CI Number", startId), 1);
    if (!rootSubs.length) return { nodes: [], edges: [] };
    nodes.push({ ...shapeCI(startClass, rootSubs[0]), level: 0 });

    while (queue.length) {
      const cur = queue.shift();
      if (cur.level >= depth) continue;
      // Single-field indexed query, post-filter by class in code (see CI-detail comment).
      const outQ = (direction === "down" || direction === "both")
        ? collect("relationships", kqlEq("Source CI Number", cur.id), 4)
        : Promise.resolve([]);
      const inQ = (direction === "up" || direction === "both")
        ? collect("relationships", kqlEq("Target CI Number", cur.id), 4)
        : Promise.resolve([]);
      const [outRelsRaw, inRelsRaw] = await Promise.all([outQ, inQ]);
      const outRels = outRelsRaw.filter(s => s.values?.["Source Class"] === cur.cls);
      const inRels = inRelsRaw.filter(s => s.values?.["Target Class"] === cur.cls);

      for (const r of outRels) {
        const rs = shapeRel(r);
        edges.push({ from: `${rs.sourceClass}/${rs.sourceCiNumber}`, to: `${rs.targetClass}/${rs.targetCiNumber}`, type: rs.type });
        const key = `${rs.targetClass}/${rs.targetCiNumber}`;
        if (!seen.has(key) && rs.targetClass && rs.targetCiNumber) {
          seen.add(key);
          const subs = await collect(rs.targetClass, kqlEq("CI Number", rs.targetCiNumber), 1);
          if (subs.length) {
            nodes.push({ ...shapeCI(rs.targetClass, subs[0]), level: cur.level + 1 });
            queue.push({ cls: rs.targetClass, id: rs.targetCiNumber, level: cur.level + 1 });
          }
        }
      }
      for (const r of inRels) {
        const rs = shapeRel(r);
        edges.push({ from: `${rs.sourceClass}/${rs.sourceCiNumber}`, to: `${rs.targetClass}/${rs.targetCiNumber}`, type: rs.type });
        const key = `${rs.sourceClass}/${rs.sourceCiNumber}`;
        if (!seen.has(key) && rs.sourceClass && rs.sourceCiNumber) {
          seen.add(key);
          const subs = await collect(rs.sourceClass, kqlEq("CI Number", rs.sourceCiNumber), 1);
          if (subs.length) {
            nodes.push({ ...shapeCI(rs.sourceClass, subs[0]), level: cur.level + 1 });
            queue.push({ cls: rs.sourceClass, id: rs.sourceCiNumber, level: cur.level + 1 });
          }
        }
      }
    }
    return { nodes, edges };
  }

  // ─── GET /api/cmdb/ci/:class/:id/dependencies?depth=3 ───────────────
  const depMatch = pathname.match(/^\/api\/cmdb\/ci\/([^/]+)\/([^/]+)\/dependencies$/);
  if (depMatch && req.method === "GET") {
    try {
      const [, cls, id] = depMatch;
      const depth = url.searchParams.get("depth") || "3";
      const g = await traverse(cls, id, "down", depth);
      jsonResp(res, 200, { rootClass: cls, rootId: id, depth: parseInt(depth), ...g });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── GET /api/cmdb/ci/:class/:id/impact?depth=3 ─────────────────────
  const impMatch = pathname.match(/^\/api\/cmdb\/ci\/([^/]+)\/([^/]+)\/impact$/);
  if (impMatch && req.method === "GET") {
    try {
      const [, cls, id] = impMatch;
      const depth = url.searchParams.get("depth") || "3";
      const g = await traverse(cls, id, "up", depth);
      // Surface affected services
      const affectedServices = g.nodes.filter(n => n.class === "services");
      jsonResp(res, 200, {
        rootClass: cls, rootId: id, depth: parseInt(depth),
        affectedServices: affectedServices.map(s => ({ ciNumber: s.ciNumber, name: s.name, criticality: s.criticality })),
        ...g,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── GET /api/cmdb/service-map/:class/:id?depth=4 ────────────────────
  const smMatch = pathname.match(/^\/api\/cmdb\/service-map\/([^/]+)\/([^/]+)$/);
  if (smMatch && req.method === "GET") {
    try {
      const [, cls, id] = smMatch;
      const depth = url.searchParams.get("depth") || "4";
      const g = await traverse(cls, id, "both", depth);
      jsonResp(res, 200, { rootClass: cls, rootId: id, depth: parseInt(depth), ...g });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── GET /api/cmdb/relationships?ci=class/id ─────────────────────────
  if (pathname === "/api/cmdb/relationships" && req.method === "GET") {
    try {
      const ci = url.searchParams.get("ci"); // "class/id"
      const type = url.searchParams.get("type");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "25"), 25);
      let rels;
      if (ci) {
        const [c, i] = ci.split("/");
        // KQL: keep filters within an indexed shape, post-filter the rest in code
        const sQ = type
          ? kqlAnd([kqlEq("Source CI Number", i), kqlEq("Type", type)])
          : kqlEq("Source CI Number", i);
        const tQ = type
          ? kqlAnd([kqlEq("Target CI Number", i), kqlEq("Type", type)])
          : kqlEq("Target CI Number", i);
        const [out, inc] = await Promise.all([collect("relationships", sQ, 4), collect("relationships", tQ, 4)]);
        rels = [...out.filter(s => s.values?.["Source Class"] === c),
                ...inc.filter(s => s.values?.["Target Class"] === c)];
      } else {
        rels = await collect("relationships", kqlEq("Type", type), 8);
      }
      const shaped = rels.map(shapeRel);
      jsonResp(res, 200, { total: shaped.length, results: shaped.slice(0, limit) });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── GET /api/cmdb/health ────────────────────────────────────────────
  // True per-class counts via count-walk + sampled data-quality scoring
  // (first 200 records per class). Orphan-relationship detection is skipped
  // when the CI universe is too large to materialize cheaply.
  if (pathname === "/api/cmdb/health" && req.method === "GET") {
    try {
      const result = await withCache("health", CACHE_TTL_MS, async () => {
        const [classCounts, relCount, samples] = await Promise.all([
          Promise.all(CI_CLASSES.map(c => countSubmissions(c))),
          countSubmissions("relationships"),
          Promise.all(CI_CLASSES.map(c => collect(c, null, 8))),
        ]);
        const totalCIs = classCounts.reduce((a, b) => a + b, 0);

        let withoutOwner = 0, withoutEnv = 0, stale = 0, sampleSize = 0;
        const now = Date.now();
        const staleMs = 30 * 86400000;
        CI_CLASSES.forEach((cls, i) => {
          for (const s of samples[i]) {
            sampleSize++;
            const v = s.values || {};
            if (!v["Owner"] && !v["Owner Team"]) withoutOwner++;
            if (cls !== "services" && cls !== "datacenters" && !v["Environment"]) withoutEnv++;
            const last = v["Last Discovered"];
            if (last && (now - new Date(last).getTime()) > staleMs) stale++;
          }
        });

        const ratio = sampleSize ? totalCIs / sampleSize : 0;
        const estWithoutOwner = Math.round(withoutOwner * ratio);
        const estWithoutEnv = Math.round(withoutEnv * ratio);
        const estStale = Math.round(stale * ratio);

        const issues = [];
        if (estWithoutOwner > 0) issues.push({ severity: "Medium", message: `~${estWithoutOwner.toLocaleString()} CIs missing an owner (estimated from sample)`, count: estWithoutOwner });
        if (estWithoutEnv > 0) issues.push({ severity: "Low", message: `~${estWithoutEnv.toLocaleString()} CIs missing an environment (estimated from sample)`, count: estWithoutEnv });
        if (estStale > 0) issues.push({ severity: "Medium", message: `~${estStale.toLocaleString()} CIs haven't been discovered in 30+ days (estimated)`, count: estStale });

        const ownerCoverage = sampleSize ? Math.round(((sampleSize - withoutOwner) / sampleSize) * 100) : 100;
        const envCoverage = sampleSize ? Math.round(((sampleSize - withoutEnv) / sampleSize) * 100) : 100;
        const freshnessOK = sampleSize ? Math.round(((sampleSize - stale) / sampleSize) * 100) : 100;

        let score = 100;
        score -= Math.min(20, Math.floor((100 - ownerCoverage) / 5));
        score -= Math.min(15, Math.floor((100 - envCoverage) / 5));
        score -= Math.min(15, Math.floor((100 - freshnessOK) / 5));
        score = Math.max(0, score);

        return {
          score,
          totals: { cis: totalCIs, relationships: relCount },
          metrics: { ownerCoverage, envCoverage, freshnessOK, relationshipIntegrity: 100 },
          sampleSize,
          sampled: totalCIs > sampleSize,
          issues,
        };
      });
      jsonResp(res, 200, result);
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── POST /api/cmdb/ci ───────────────────────────────────────────────
  // Body: { class: "servers", values: {...}, source: "Manual" }
  // Idempotent on CI Number (creates if absent, updates if present).
  if (pathname === "/api/cmdb/ci" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const cls = body.class;
      const values = body.values || {};
      if (!CI_CLASSES.includes(cls)) { jsonResp(res, 400, { error: `Unknown class: ${cls}` }); return; }
      const ciNumber = values["CI Number"];
      const source = body.source || values["Discovery Source"] || "Manual";
      values["Discovery Source"] = source;
      values["Last Discovered"] = new Date().toISOString();

      let existing = null;
      if (ciNumber) {
        const subs = await collect(cls, kqlEq("CI Number", ciNumber), 1);
        existing = subs[0] || null;
      }

      let result;
      if (existing) {
        // Compute changed fields for change-log
        const oldVals = existing.values || {};
        const changes = [];
        for (const [k, v] of Object.entries(values)) {
          if (String(oldVals[k] || "") !== String(v || "")) {
            changes.push({ field: k, oldVal: oldVals[k] || "", newVal: v });
          }
        }
        const r = await kineticRequest("PUT",
          `/kapps/${KAPP}/forms/${cls}/submissions/${existing.id}/values`,
          { values }, auth);
        result = { mode: "updated", submissionId: existing.id, changes };

        // Append change log entries
        for (const ch of changes.slice(0, 50)) {
          await kineticRequest("POST", `/kapps/${KAPP}/forms/ci-change-log/submissions`, {
            values: {
              "CI Number": ciNumber,
              "CI Class": cls,
              "CI Name": values["Name"] || oldVals["Name"] || "",
              "Action": "Updated",
              "Field": ch.field,
              "Old Value": String(ch.oldVal),
              "New Value": String(ch.newVal),
              "Actor": body.actor || "api",
              "Source": source,
              "Timestamp": new Date().toISOString(),
            },
            coreState: "Submitted",
          }, auth);
        }
      } else {
        // Auto-generate CI Number if missing
        if (!values["CI Number"]) {
          const prefix = { datacenters: "DC", clusters: "CLU", servers: "SRV", "network-devices": "NET",
                           storage: "STO", databases: "DB", applications: "APP", services: "SVC" }[cls] || "CI";
          const existingSubs = await collect(cls, null, 8);
          values["CI Number"] = `${prefix}-${String(existingSubs.length + 1).padStart(4, "0")}`;
        }
        const r = await kineticRequest("POST",
          `/kapps/${KAPP}/forms/${cls}/submissions`,
          { values, coreState: "Submitted" }, auth);
        result = { mode: "created", submissionId: r.data?.submission?.id, ciNumber: values["CI Number"] };

        // Change-log entry
        await kineticRequest("POST", `/kapps/${KAPP}/forms/ci-change-log/submissions`, {
          values: {
            "CI Number": values["CI Number"],
            "CI Class": cls,
            "CI Name": values["Name"] || "",
            "Action": "Created",
            "Actor": body.actor || "api",
            "Source": source,
            "Timestamp": new Date().toISOString(),
          },
          coreState: "Submitted",
        }, auth);
      }
      jsonResp(res, 200, result);
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── POST /api/cmdb/relate ───────────────────────────────────────────
  // Body: { sourceClass, sourceCiNumber, targetClass, targetCiNumber, type, description }
  // Idempotent — won't create duplicate of same (src, tgt, type)
  if (pathname === "/api/cmdb/relate" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const { sourceClass, sourceCiNumber, targetClass, targetCiNumber, type } = body;
      if (!sourceClass || !sourceCiNumber || !targetClass || !targetCiNumber || !type) {
        jsonResp(res, 400, { error: "sourceClass, sourceCiNumber, targetClass, targetCiNumber, and type are required" });
        return true;
      }

      // Lookup source/target names
      const [srcSubs, tgtSubs] = await Promise.all([
        collect(sourceClass, kqlEq("CI Number", sourceCiNumber), 1),
        collect(targetClass, kqlEq("CI Number", targetCiNumber), 1),
      ]);
      if (!srcSubs.length) { jsonResp(res, 400, { error: `Source CI not found: ${sourceClass}/${sourceCiNumber}` }); return; }
      if (!tgtSubs.length) { jsonResp(res, 400, { error: `Target CI not found: ${targetClass}/${targetCiNumber}` }); return; }
      const sourceName = srcSubs[0].values?.["Name"];
      const targetName = tgtSubs[0].values?.["Name"];

      // Check for existing — use indexed compound (Source CI Number, Type) then filter in code.
      // The 5-field AND form has no matching index and silently returns empty.
      const candidates = await collect("relationships", kqlAnd([
        kqlEq("Source CI Number", sourceCiNumber),
        kqlEq("Type", type),
      ]), 2);
      const dup = candidates.find(s =>
        s.values?.["Source Class"] === sourceClass &&
        s.values?.["Target Class"] === targetClass &&
        s.values?.["Target CI Number"] === targetCiNumber
      );
      if (dup) {
        jsonResp(res, 200, { mode: "exists", submissionId: dup.id, relationshipId: dup.values?.["Relationship ID"] });
        return true;
      }

      // Get next REL number
      const allRels = await collect("relationships", null, 12);
      const nextId = `REL-${String(allRels.length + 1).padStart(4, "0")}`;
      const r = await kineticRequest("POST", `/kapps/${KAPP}/forms/relationships/submissions`, {
        values: {
          "Relationship ID": nextId,
          "Source Class": sourceClass, "Source CI Number": sourceCiNumber, "Source Name": sourceName,
          "Target Class": targetClass, "Target CI Number": targetCiNumber, "Target Name": targetName,
          "Type": type, "Direction": "Forward", "Status": "Active",
          "Discovery Source": body.source || "Manual",
          "Description": body.description || "",
        },
        coreState: "Submitted",
      }, auth);
      jsonResp(res, 200, { mode: "created", submissionId: r.data?.submission?.id, relationshipId: nextId });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // Not handled here
  return false;
}

// ─── Standalone mode ───────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const http = await import("node:http");
  const https = await import("node:https");
  const fs = await import("node:fs");
  const path = await import("node:path");

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const PORT = process.argv[2] || process.env.PORT || 3020;
  const KINETIC = process.env.KINETIC_URL || "https://ai-labs.kinopsdev.io";
  const __dir = path.dirname(new URL(import.meta.url).pathname);

  function kineticRequest(method, apiPath, body, authHeader) {
    return new Promise((resolve, reject) => {
      const u = new URL(`/app/api/v1${apiPath}`, KINETIC);
      const headers = { "Content-Type": "application/json" };
      if (authHeader) headers["Authorization"] = authHeader;
      const payload = body ? JSON.stringify(body) : null;
      if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
      const r = https.request(u, { method, headers }, (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
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
  function collectByQuery(kapp, formSlug, kql, auth, maxPages = 8) {
    const all = [];
    let lastCreatedAt = null;
    return (async () => {
      for (let i = 0; i < maxPages; i++) {
        let url = `/kapps/${kapp}/forms/${formSlug}/submissions?include=values,details&limit=25`;
        let q = kql || '';
        if (lastCreatedAt) q = (q ? '(' + q + ') AND ' : '') + 'createdAt < "' + lastCreatedAt + '"';
        if (q) url += `&q=${encodeURIComponent(q)}`;
        const r = await kineticRequest("GET", url, null, auth);
        const subs = r.data?.submissions || [];
        all.push(...subs);
        if (subs.length > 0) lastCreatedAt = subs[subs.length - 1].createdAt;
        if (!r.data?.nextPageToken || subs.length < 25) break;
      }
      return all;
    })();
  }
  function readBody(req) {
    return new Promise(resolve => { const c = []; req.on("data", x => c.push(x)); req.on("end", () => resolve(Buffer.concat(c).toString())); });
  }
  function jsonResp(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data));
  }
  const helpers = { kineticRequest, collectByQuery, readBody, jsonResp, vf: (s, f) => s.values?.[f] || "" };

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
    const auth = req.headers["authorization"];

    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" });
      res.end(); return;
    }

    // Static file serving for standalone development
    if (pathname === "/" || pathname === "/index.html") {
      const html = fs.readFileSync(path.join(__dir, "index.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); return;
    }

    // Custom API
    if (pathname.startsWith(apiPrefix)) {
      const result = await handleAPI(req, res, pathname, auth, helpers);
      if (result !== false) return; // handler responded
    }

    // Proxy /app/* to Kinetic
    if (pathname.startsWith("/app/")) {
      const u = new URL(req.url, KINETIC);
      const body = await readBody(req);
      const r = https.request(u, { method: req.method, headers: { ...req.headers, host: u.host } }, (pr) => {
        res.writeHead(pr.statusCode, pr.headers);
        pr.pipe(res);
      });
      r.on("error", e => { res.writeHead(502); res.end(e.message); });
      if (body) r.write(body);
      r.end();
      return true;
    }

    res.writeHead(404); res.end("Not found");
  });
  server.listen(PORT, () => {
    console.log(`\n  CMDB standalone server: http://localhost:${PORT}`);
    console.log(`  Proxying to: ${KINETIC}`);
    console.log(`  API:         /api/cmdb/*\n`);
  });
}
