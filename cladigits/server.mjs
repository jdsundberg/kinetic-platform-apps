/**
 * CLADigits Orchestration — Custom API Handler
 *
 * Server-side aggregation for the Migration Command Center: the single
 * dashboard endpoint that composes all five forms (client migrations, PBC
 * requests, cross-practice exceptions, advisory deliverables, system
 * connections) into the KPIs, wave pipeline, exception board and
 * orchestration-layer view.
 *
 * Story: Digits handles the ledger. Kinetic handles the work around it.
 * Auto-discovered by apps/base/server.mjs (exports apiPrefix + handleAPI).
 */

export const appId = "cladigits";
export const apiPrefix = "/api/cladigits";
export const kapp = "cladigits";

const num = (v) => {
  const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
};

// Canonical migration stage order — the pipeline the ledger does not run.
const STAGES = [
  "Intake",
  "KYC & Engagement",
  "Chart Mapping",
  "Historical Recon",
  "Parallel Run",
  "Go-Live",
  "Complete",
];
const PRACTICES = ["Tax", "Audit", "Wealth", "Advisory"];
const OPEN_EXCEPTION = ["Open", "Routed", "In Review"];
const OPEN_PBC = ["Requested", "Received", "In Review", "Overdue"];

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, jsonResp, vf } = helpers;
  const KAPP = kapp;
  const collect = (formSlug, kql = "", maxPages = 12) =>
    collectByQuery(KAPP, formSlug, kql, auth, maxPages);

  // ── GET /api/cladigits/dashboard — Migration Command Center ──────────
  if (pathname === "/api/cladigits/dashboard" && req.method === "GET") {
    try {
      const [clients, pbc, exceptions, deliverables, connections] = await Promise.all([
        collect("client-migrations"),
        collect("pbc-requests"),
        collect("exceptions"),
        collect("deliverables"),
        collect("connections"),
      ]);

      const migrating = clients.filter((c) => vf(c, "Target Path") === "Migrate to Digits");
      const staying = clients.filter((c) => vf(c, "Target Path") === "Stay on Current");
      const live = clients.filter((c) =>
        ["Go-Live", "Complete"].includes(vf(c, "Stage"))
      );
      const inFlight = clients.filter(
        (c) => vf(c, "Target Path") === "Migrate to Digits" && vf(c, "Stage") !== "Complete"
      );
      const atRisk = clients.filter((c) => vf(c, "Health") === "At Risk");
      const blocked = clients.filter((c) => vf(c, "Health") === "Blocked");

      // KPI: managed ARR under orchestration
      const managedARR = clients.reduce((s, c) => s + num(vf(c, "ARR")), 0);

      // Stage pipeline (only migrating clients move through it)
      const stagePipeline = STAGES.map((stage) => ({
        stage,
        count: migrating.filter((c) => vf(c, "Stage") === stage).length,
      }));

      // Wave progress
      const waveMap = {};
      for (const c of migrating) {
        const w = vf(c, "Migration Wave") || "Unassigned";
        if (!waveMap[w]) waveMap[w] = { wave: w, total: 0, complete: 0, pct: 0 };
        waveMap[w].total++;
        waveMap[w].pct += num(vf(c, "Percent Complete"));
        if (vf(c, "Stage") === "Complete") waveMap[w].complete++;
      }
      const waves = Object.values(waveMap)
        .map((w) => ({ ...w, pct: w.total ? Math.round(w.pct / w.total) : 0 }))
        .sort((a, b) => a.wave.localeCompare(b.wave));

      // Exceptions — the cross-practice routing board
      const openExceptions = exceptions.filter((e) => OPEN_EXCEPTION.includes(vf(e, "Status")));
      const critical = openExceptions.filter((e) => vf(e, "Priority") === "Critical");
      const routingMatrix = {};
      for (const e of openExceptions) {
        const from = vf(e, "Originating Practice") || "?";
        const to = vf(e, "Routed To") || "?";
        const key = `${from}→${to}`;
        routingMatrix[key] = (routingMatrix[key] || 0) + 1;
      }
      const routes = Object.entries(routingMatrix)
        .map(([k, count]) => {
          const [from, to] = k.split("→");
          return { from, to, count };
        })
        .sort((a, b) => b.count - a.count);

      // PBC document collection
      const openPBC = pbc.filter((p) => OPEN_PBC.includes(vf(p, "Status")));
      const overduePBC = pbc.filter((p) => vf(p, "Status") === "Overdue");
      const signedPBC = pbc.filter((p) => vf(p, "Status") === "Signed Off");
      const pbcCompletion = pbc.length ? Math.round((signedPBC.length / pbc.length) * 100) : 0;

      // Advisory deliverables — value above the ledger
      const openDeliverables = deliverables.filter((d) =>
        ["Drafting", "In Review"].includes(vf(d, "Status"))
      );
      const deliveredCount = deliverables.filter((d) =>
        ["Delivered", "Approved"].includes(vf(d, "Status"))
      ).length;

      // Practice load — how many in-flight clients touch each practice
      const practiceLoad = PRACTICES.map((p) => ({
        practice: p,
        clients: clients.filter((c) => (vf(c, "Practices Involved") || "").includes(p)).length,
      }));

      // System connections — the integration layer
      const connectionSummary = connections.map((c) => ({
        name: vf(c, "System Name"),
        type: vf(c, "System Type"),
        direction: vf(c, "Direction"),
        status: vf(c, "Status"),
        purpose: vf(c, "Purpose"),
        lastSync: vf(c, "Last Sync"),
        records: num(vf(c, "Records Synced")),
      }));

      // Attention list — the clients Kinetic is actively unblocking
      const attention = clients
        .filter((c) => ["At Risk", "Blocked"].includes(vf(c, "Health")))
        .map((c) => ({
          clientId: vf(c, "Client ID"),
          name: vf(c, "Client Name"),
          stage: vf(c, "Stage"),
          wave: vf(c, "Migration Wave"),
          health: vf(c, "Health"),
          partner: vf(c, "Lead Partner"),
          pct: num(vf(c, "Percent Complete")),
        }))
        .sort((a, b) => (a.health === "Blocked" ? -1 : 1) - (b.health === "Blocked" ? -1 : 1));

      jsonResp(res, 200, {
        kpis: {
          totalClients: clients.length,
          migrating: migrating.length,
          staying: staying.length,
          liveOnDigits: live.length,
          inFlight: inFlight.length,
          atRisk: atRisk.length,
          blocked: blocked.length,
          managedARR,
          openExceptions: openExceptions.length,
          criticalExceptions: critical.length,
          openPBC: openPBC.length,
          overduePBC: overduePBC.length,
          pbcCompletion,
          openDeliverables: openDeliverables.length,
          deliveredDeliverables: deliveredCount,
          connectionsOnline: connections.filter((c) => vf(c, "Status") === "Connected").length,
          connectionsTotal: connections.length,
        },
        stagePipeline,
        waves,
        routes,
        practiceLoad,
        connections: connectionSummary,
        attention,
        recordsSynced: connectionSummary.reduce((s, c) => s + c.records, 0),
      });
      return true;
    } catch (e) {
      jsonResp(res, 500, { error: String(e && e.message ? e.message : e) });
      return true;
    }
  }

  return false; // not handled — let base server fall through
}
