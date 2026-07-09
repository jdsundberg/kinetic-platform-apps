/**
 * Kinetic GRC Command Center — aggregation + ingestion API.
 * Powers every dashboard view (provider portfolio, client command center,
 * framework readiness, family heatmap, risk matrix, audit readiness, exec,
 * my-work) and exposes ingestion Web APIs for external integrations.
 *
 * Mounted by grcapps/base/server.mjs auto-discovery.
 */
export const appId = "grc";
export const apiPrefix = "/api/grc";
export const kapp = "grc";

const NA = "Not Applicable";
const IMPL = "Implemented";
const PARTIAL = "Partially Implemented";

/* ── tiny in-memory cache (60s) + in-flight dedup for dashboard endpoints ── */
const cache = new Map();      // key -> { at, data }
const inflight = new Map();   // key -> Promise
const TTL = 60_000;
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => { try { const d = await fn(); cache.set(key, { at: Date.now(), data: d }); return d; } finally { inflight.delete(key); } })();
  inflight.set(key, p);
  return p;
}

/* ── readiness math: implemented / (assessed - N/A) ── */
function readiness(rows) {
  const total = rows.length;
  const na = rows.filter(r => r.Status === NA).length;
  const impl = rows.filter(r => r.Status === IMPL).length;
  const partial = rows.filter(r => r.Status === PARTIAL).length;
  const denom = Math.max(1, total - na);
  // partial credit: 50%
  const pct = Math.round(((impl + partial * 0.5) / denom) * 100);
  return { total, na, impl, partial, denom, pct };
}
function tally(rows, field) { const m = {}; for (const r of rows) { const k = r[field] || "(none)"; m[k] = (m[k] || 0) + 1; } return m; }
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, jsonResp, kineticRequest, readBody } = helpers;
  const sub = pathname.slice(apiPrefix.length); // e.g. "/portfolio"
  // collectByQuery returns raw submissions; flatten to values (+ keep submission id as _id).
  const flat = (rows) => rows.map(s => Object.assign({ _id: s.id }, s.values));
  const q = async (form, kql, pages = 14) => flat(await collectByQuery(kapp, form, kql, auth, pages));
  const tq = (form, tenant, kql, pages = 14) =>
    q(form, `values[Tenant] = "${tenant}"` + (kql ? ` AND ${kql}` : ""), pages);

  try {
    /* ───────── generic overview ───────── */
    if (sub === "/overview" && req.method === "GET") {
      const forms = ["tenant", "framework", "control", "asset", "assessment", "evidence", "gap", "task", "risk"];
      const out = {};
      for (const f of forms) out[f] = (await q(f, null, 16)).length;
      return done(res, jsonResp, out);
    }

    /* ───────── provider portfolio (all tenants) ───────── */
    if (sub === "/portfolio" && req.method === "GET") {
      const data = await cached("portfolio", async () => {
        const tenants = await q("tenant", null, 4);
        const clients = tenants.map(t => ({
          id: t["Tenant ID"], name: t.Name, industry: t.Industry, color: t.Color,
          frameworks: (t.Frameworks || "").split(",").map(s => s.trim()).filter(Boolean),
          owner: t["Engagement Owner"], health: t["Project Health"],
          readiness: num(t["Readiness Score"]), risk: num(t["Risk Score"]),
          openGaps: num(t["Open Gaps"]), overdue: num(t["Overdue Tasks"]),
          evidenceMissing: num(t["Evidence Missing"]), auditDate: t["Audit Date"],
          lastReview: t["Last Review Date"], nextReview: t["Next Review Date"],
          contact: t["Primary Contact"], drivers: t["Regulatory Drivers"], contract: t["Contract Requirements"],
        }));
        const n = clients.length || 1;
        const totals = {
          clients: clients.length,
          avgReadiness: Math.round(clients.reduce((a, c) => a + c.readiness, 0) / n),
          avgRisk: Math.round(clients.reduce((a, c) => a + c.risk, 0) / n),
          openGaps: clients.reduce((a, c) => a + c.openGaps, 0),
          overdue: clients.reduce((a, c) => a + c.overdue, 0),
          evidenceMissing: clients.reduce((a, c) => a + c.evidenceMissing, 0),
          health: { Green: clients.filter(c => c.health === "Green").length, Yellow: clients.filter(c => c.health === "Yellow").length, Red: clients.filter(c => c.health === "Red").length },
        };
        return { clients, totals };
      });
      return done(res, jsonResp, data);
    }

    /* ───────── client command center / exec (per tenant) ───────── */
    let m;
    if ((m = sub.match(/^\/tenant\/([^/]+)$/)) && req.method === "GET") {
      const tid = decodeURIComponent(m[1]);
      const data = await cached("tenant:" + tid, async () => {
        const [tenantRows, assess, evidence, gaps, tasks, risks, assets, packets, snaps] = await Promise.all([
          q("tenant", `values[Tenant ID] = "${tid}"`, 2),
          tq("assessment", tid), tq("evidence", tid), tq("gap", tid),
          tq("task", tid), tq("risk", tid), tq("asset", tid),
          tq("audit-packet", tid, null, 4), tq("snapshot", tid, null, 8),
        ]);
        const t = tenantRows[0] || {};
        const frameworks = (t.Frameworks || "").split(",").map(s => s.trim()).filter(Boolean);

        // readiness by framework
        const byFramework = frameworks.map(fw => {
          const rows = assess.filter(a => a.Framework === fw);
          return { framework: fw, ...readiness(rows), count: rows.length };
        });
        // readiness by family
        const families = [...new Set(assess.map(a => a["Control Family"]))].sort();
        const byFamily = families.map(fam => {
          const rows = assess.filter(a => a["Control Family"] === fam);
          return { family: fam, ...readiness(rows) };
        });
        const overall = readiness(assess);

        // evidence health
        const evByStatus = tally(evidence, "Status");
        const expiringSoon = evidence.filter(e => {
          const d = e["Expiration Date"]; if (!d) return false;
          const days = (new Date(d) - new Date("2026-06-30")) / 86400000;
          return days >= 0 && days <= 45;
        }).length;
        const expired = evidence.filter(e => e.Status === "Expired").length;

        // gaps / tasks / risks
        const openGaps = gaps.filter(g => !["Resolved", "Accepted"].includes(g.Status));
        const gapBySeverity = tally(openGaps, "Severity");
        const taskByStatus = tally(tasks, "Status");
        const overdueTasks = tasks.filter(t2 => t2.Status !== "Complete" && t2["Due Date"] && t2["Due Date"] < "2026-06-30");
        const riskByResidual = tally(risks.filter(r => r.Status !== "Closed"), "Residual Risk");
        const highRisks = risks.filter(r => ["Critical", "High"].includes(r["Residual Risk"]) && r.Status !== "Closed").length;

        // top attention items
        const sevRank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
        const attention = [
          ...openGaps.filter(g => ["Critical", "High"].includes(g.Severity)).map(g => ({ kind: "gap", title: g.Title, severity: g.Severity, owner: g.Owner, due: g["Due Date"], id: g["Gap ID"] })),
          ...overdueTasks.map(t2 => ({ kind: "task", title: t2.Title, severity: t2.Priority, owner: t2.Owner, due: t2["Due Date"], id: t2["Task ID"] })),
        ].sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9) || (a.due || "9") .localeCompare(b.due || "9")).slice(0, 8);

        // trend (snapshot, latest per month per framework averaged)
        const trendMap = {};
        for (const s of snaps) {
          const d = s["Snapshot Date"];
          (trendMap[d] ||= []).push(num(s["Readiness Percent"]));
        }
        const trend = Object.keys(trendMap).sort().map(d => ({ date: d, readiness: Math.round(trendMap[d].reduce((a, b) => a + b, 0) / trendMap[d].length) }));

        // owner workload
        const workload = {};
        for (const t2 of tasks.filter(x => x.Status !== "Complete")) workload[t2.Owner] = (workload[t2.Owner] || 0) + 1;

        return {
          tenant: {
            id: tid, name: t.Name, industry: t.Industry, health: t["Project Health"], color: t.Color,
            owner: t["Engagement Owner"], contact: t["Primary Contact"], email: t["Contact Email"],
            drivers: t["Regulatory Drivers"], contract: t["Contract Requirements"],
            auditDate: t["Audit Date"], lastReview: t["Last Review Date"], nextReview: t["Next Review Date"],
            readiness: num(t["Readiness Score"]), risk: num(t["Risk Score"]),
          },
          frameworks, overall, byFramework, byFamily,
          counts: { assessments: assess.length, evidence: evidence.length, gaps: openGaps.length, tasks: tasks.length, risks: risks.length, assets: assets.length, packets: packets.length },
          evidence: { byStatus: evByStatus, expiringSoon, expired, total: evidence.length, accepted: evByStatus.Accepted || 0 },
          gaps: { open: openGaps.length, bySeverity: gapBySeverity, critical: gapBySeverity.Critical || 0, high: gapBySeverity.High || 0 },
          tasks: { total: tasks.length, byStatus: taskByStatus, overdue: overdueTasks.length, complete: taskByStatus.Complete || 0 },
          risks: { byResidual: riskByResidual, high: highRisks, total: risks.length },
          assets: { total: assets.length, inScope: assets.filter(a => a["In Scope"] === "Yes").length, byType: tally(assets, "Type"), byClass: tally(assets.filter(a => a["In Scope"] === "Yes"), "Data Classification") },
          packets: packets.map(p => ({ id: p["Packet ID"], name: p.Name, framework: p.Framework, status: p.Status, auditDate: p["Audit Date"], auditor: p.Auditor, exceptions: num(p["Open Exceptions"]) })),
          attention, trend, workload,
        };
      });
      return done(res, jsonResp, data);
    }

    /* ───────── gap heatmap (family × severity) ───────── */
    if ((m = sub.match(/^\/heatmap\/([^/]+)$/)) && req.method === "GET") {
      const tid = decodeURIComponent(m[1]);
      const gaps = (await tq("gap", tid)).filter(g => !["Resolved", "Accepted"].includes(g.Status));
      const fams = [...new Set(gaps.map(g => g["Control Family"]))].sort();
      const sevs = ["Critical", "High", "Medium", "Low"];
      const cells = fams.map(fam => ({ family: fam, ...Object.fromEntries(sevs.map(s => [s, gaps.filter(g => g["Control Family"] === fam && g.Severity === s).length])) }));
      return done(res, jsonResp, { families: fams, severities: sevs, cells });
    }

    /* ───────── risk matrix (likelihood × impact) ───────── */
    if ((m = sub.match(/^\/riskmatrix\/([^/]+)$/)) && req.method === "GET") {
      const tid = decodeURIComponent(m[1]);
      const risks = (await tq("risk", tid)).filter(r => r.Status !== "Closed");
      const grid = {};
      for (const r of risks) {
        const k = `${num(r.Likelihood)}_${num(r.Impact)}`;
        (grid[k] ||= []).push({ id: r["Risk ID"], title: r.Title, owner: r.Owner, residual: r["Residual Risk"], category: r.Category });
      }
      return done(res, jsonResp, { grid, total: risks.length, byCategory: tally(risks, "Category") });
    }

    /* ───────── framework library (controls for a framework) ───────── */
    if ((m = sub.match(/^\/library\/([^/]+)$/)) && req.method === "GET") {
      const fw = decodeURIComponent(m[1]);
      const controls = await q("control", `values[Framework] = "${fw}"`, 6);
      const byFamily = tally(controls, "Control Family");
      return done(res, jsonResp, {
        framework: fw, count: controls.length, byFamily,
        controls: controls.map(c => ({ id: c["Control ID"], family: c["Control Family"], title: c.Title, plain: c["Plain English"], guidance: c["Implementation Guidance"], evidence: c["Evidence Examples"], testing: c["Testing Procedure"], owner: c["Default Owner"], cadence: c["Review Cadence"] })),
      });
    }

    /* ───────── my work queue ───────── */
    if (sub === "/mywork" && req.method === "GET") {
      const owner = decodeURIComponent(new URL(req.url, "http://x").searchParams.get("owner") || "");
      if (!owner) return done(res, jsonResp, { error: "owner required" }, 400);
      const data = await cached("mywork:" + owner, async () => {
        const [tasks, assess, evidence] = await Promise.all([
          q("task", `values[Owner] = "${owner}"`, 10),
          q("assessment", `values[Owner] = "${owner}"`, 12),
          q("evidence", `values[Owner] = "${owner}"`, 12),
        ]);
        const openTasks = tasks.filter(t => t.Status !== "Complete");
        const overdue = openTasks.filter(t => t["Due Date"] && t["Due Date"] < "2026-06-30");
        const rejected = evidence.filter(e => e.Status === "Rejected");
        const evReqs = evidence.filter(e => ["Requested", "Submitted", "Needs Review"].includes(e.Status));
        return {
          owner,
          summary: { tasks: openTasks.length, overdue: overdue.length, controls: assess.length, evidenceRequests: evReqs.length, rejected: rejected.length },
          tasks: openTasks.map(t => ({ id: t["Task ID"], title: t.Title, tenant: t.Tenant, priority: t.Priority, status: t.Status, due: t["Due Date"], pct: num(t["Percent Complete"]) })).sort((a, b) => (a.due || "9").localeCompare(b.due || "9")),
          evidenceRequests: evReqs.map(e => ({ id: e["Evidence ID"], title: e.Title, tenant: e.Tenant, status: e.Status, due: e["Expiration Date"] })),
          rejected: rejected.map(e => ({ id: e["Evidence ID"], title: e.Title, tenant: e.Tenant, notes: e["Review Notes"] })),
        };
      });
      return done(res, jsonResp, data);
    }

    /* ───────── owners list (for selector) ───────── */
    if (sub === "/owners" && req.method === "GET") {
      const tasks = await q("task", null, 16);
      const owners = [...new Set(tasks.map(t => t.Owner).filter(Boolean))].sort();
      return done(res, jsonResp, { owners });
    }

    /* ═══════════ INGESTION WEB APIs (external systems → GRC) ═══════════
       Demonstrates the integration surface: create/update assets, submit
       evidence, create gaps/tasks, update control status. Auth flows through. */
    const INGEST = {
      "/ingest/asset": "asset",
      "/ingest/evidence": "evidence",
      "/ingest/gap": "gap",
      "/ingest/task": "task",
      "/ingest/risk": "risk",
      "/ingest/vulnerability": "gap", // vuln import → creates a gap
    };
    if (INGEST[sub] && req.method === "POST") {
      const values = JSON.parse(await readBody(req) || "{}");
      const r = await kineticRequest("POST", `/kapps/${kapp}/forms/${INGEST[sub]}/submissions?completed=true`, { values, coreState: "Submitted" }, auth);
      cache.clear();
      return done(res, jsonResp, { ok: r.status < 300, status: r.status, id: r.data?.submission?.id, form: INGEST[sub] }, r.status < 300 ? 200 : 502);
    }
    // update control assessment status (the only path that can change compliance status — audited)
    if (sub === "/ingest/control-status" && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const { assessmentId, status, actor } = body;
      if (!assessmentId || !status) return done(res, jsonResp, { error: "assessmentId and status required" }, 400);
      const found = await q("assessment", `values[Assessment ID] = "${assessmentId}"`, 2);
      if (!found.length) return done(res, jsonResp, { error: "assessment not found" }, 404);
      const subId = found[0]._id;
      const r = await kineticRequest("PUT", `/submissions/${subId}`, { values: { Status: status, "Last Updated": "2026-06-30" } }, auth);
      // write an audit-trail activity
      await kineticRequest("POST", `/kapps/${kapp}/forms/activity/submissions?completed=true`, { values: { Tenant: found[0].Tenant, "Record Type": "assessment", "Record ID": assessmentId, Type: "Status Change", Summary: `Status → ${status}`, Detail: `Changed via API by ${actor || "system"}`, Actor: actor || "system", "Created Date": "2026-06-30" }, coreState: "Submitted" }, auth);
      cache.clear();
      return done(res, jsonResp, { ok: r.status < 300, status: r.status });
    }

    return false; // not handled by this app
  } catch (e) {
    jsonResp(res, 500, { error: e.message });
    return true;
  }
}

function done(res, jsonResp, data, status = 200) { jsonResp(res, status, data); return true; }
