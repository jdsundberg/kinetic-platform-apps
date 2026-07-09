/**
 * ServiceNow (Kinetic) — Custom API Handler
 *
 * Cross-domain dashboard aggregation over the servicenow kapp.
 * Everything else (list/detail/edit/activity-log) is plain Core API from the client.
 */

export const appId = "servicenow";
export const apiPrefix = "/api/servicenow";
export const kapp = "servicenow";

const OPEN = (s) => s && s !== "Closed" && s !== "Resolved" && s !== "Cancelled";

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, jsonResp, vf } = helpers;
  const KAPP = kapp;
  const collect = (slug, kql, pages = 8) => collectByQuery(KAPP, slug, kql, auth, pages);

  function tally(rows, field) {
    const m = {};
    for (const r of rows) { const k = vf(r, field) || "(none)"; m[k] = (m[k] || 0) + 1; }
    return m;
  }
  const top = (m, n = 8) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));

  if (pathname === "/api/servicenow/dashboard" && req.method === "GET") {
    try {
      const [incidents, changes, problems, cases, hr, sec, risks, vulns, cis, servers, kb, projects, reqs] = await Promise.all([
        collect("incident"), collect("change-request"), collect("problem"), collect("case"),
        collect("hr-case"), collect("security-incident"), collect("risk"), collect("vulnerable-item"),
        collect("ci"), collect("ci-server"), collect("kb-article"), collect("project"), collect("requested-item"),
      ]);

      const incOpen = incidents.filter(i => OPEN(vf(i, "State")));
      const incUnassigned = incidents.filter(i => OPEN(vf(i, "State")) && !vf(i, "Assignment Group"));
      const allCis = [...cis, ...servers];
      const cisDown = allCis.filter(c => (vf(c, "Operational Status") || "") !== "Operational").length;

      jsonResp(res, 200, {
        kpis: {
          incidentsOpen: incOpen.length,
          incidentsUnassigned: incUnassigned.length,
          changesOpen: changes.filter(c => OPEN(vf(c, "State"))).length,
          problemsOpen: problems.filter(p => OPEN(vf(p, "State"))).length,
          casesOpen: cases.filter(c => OPEN(vf(c, "State"))).length,
          hrOpen: hr.filter(h => OPEN(vf(h, "State"))).length,
          secOpen: sec.filter(s => OPEN(vf(s, "State"))).length,
          vulnsOpen: vulns.filter(x => OPEN(vf(x, "State"))).length,
          cisTotal: allCis.length,
          cisDown,
          kbActive: kb.filter(a => (vf(a, "Active") || "Yes") !== "No").length,
          projects: projects.length,
          requestsOpen: reqs.filter(r => OPEN(vf(r, "State"))).length,
        },
        incidentsByPriority: tally(incidents, "Priority"),
        incidentsByState: tally(incidents, "State"),
        incidentsByCategory: tally(incidents, "Category"),
        changesByRisk: tally(changes, "Risk"),
        secBySeverity: tally(sec, "Severity"),
        risksByResidual: tally(risks, "Residual Risk"),
        cisByStatus: tally(allCis, "Operational Status"),
        projectsByHealth: tally(projects, "Health"),
        topGroups: top(tally(incOpen, "Assignment Group")),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
