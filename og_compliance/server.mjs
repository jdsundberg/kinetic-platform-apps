/**
 * og_compliance — Custom API Handler
 */

export const appId = "og-compliance";
export const apiPrefix = "/api/ogc";
export const kapp = "og-compliance";

// ─── App-specific helpers ──────────────────────────────────────────────────

function nowISO() { return new Date().toISOString(); }
const EVENT_TRANSITIONS = {
  "New": ["Triaged", "Suppressed"],
  "Triaged": ["Correlated", "Case Created", "Suppressed"],
  "Correlated": ["Case Created", "Suppressed"],
  "Case Created": [],
  "Suppressed": [],
};
const CASE_TRANSITIONS = {
  "New": ["Triage"],
  "Triage": ["Investigation", "Closed"],
  "Investigation": ["Remediation", "Closed"],
  "Remediation": ["Validation", "Investigation"],
  "Validation": ["Closure Pending", "Remediation"],
  "Closure Pending": ["Closed", "Validation"],
  "Closed": ["Reopened"],
  "Reopened": ["Triage"],
};
const CAPA_TRANSITIONS = {
  "Open": ["In Progress"],
  "In Progress": ["Pending Verification"],
  "Pending Verification": ["Verified", "In Progress"],
  "Verified": ["Closed", "In Progress"],
  "Closed": [],
};
const AUDIT_TRANSITIONS = {
  "Planned": ["In Progress"],
  "In Progress": ["Review"],
  "Review": ["Closed", "In Progress"],
  "Closed": [],
};

// ─── API Handler ───────────────────────────────────────────────────────────

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }


  // ─── 1. GET /api/ogc/dashboard ───
  if (pathname === "/api/ogc/dashboard" && req.method === "GET") {
    try {
      const [events, cases, capas, audits, sites, assets, controls, reportingCycles] =
        await Promise.all([
          collect("event", null, 8),
          collect("case", null, 8),
          collect("capa", null, 8),
          collect("audit", null, 4),
          collect("site", null, 4),
          collect("asset", null, 8),
          collect("control", null, 8),
          collect("reporting-cycle", null, 4),
        ]);

      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);

      // Events
      const newEvents = events.filter(s => vf(s, "Status") === "New").length;
      const recentEvents = events.filter(s => (vf(s, "Event Timestamp") || "") >= sevenDaysAgo).length;
      const eventsBySeverity = { Critical: 0, High: 0, Medium: 0, Low: 0 };
      for (const s of events) {
        const sev = vf(s, "Severity");
        if (sev in eventsBySeverity) eventsBySeverity[sev]++;
      }

      // Cases
      const openCases = cases.filter(s => !["Closed"].includes(vf(s, "Status"))).length;
      const criticalCases = cases.filter(s => vf(s, "Severity") === "Critical" && vf(s, "Status") !== "Closed").length;
      const casesByStatus = {};
      const casesByType = {};
      for (const s of cases) {
        const st = vf(s, "Status") || "Unknown";
        casesByStatus[st] = (casesByStatus[st] || 0) + 1;
        const tp = vf(s, "Case Type") || "Unknown";
        casesByType[tp] = (casesByType[tp] || 0) + 1;
      }

      // SLA at risk
      const slaAtRisk = cases.filter(s => {
        const sla = vf(s, "SLA Target Date");
        const thirtyDays = new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10);
        return sla && sla <= thirtyDays && sla >= todayStr && vf(s, "Status") !== "Closed";
      }).length;

      // CAPAs
      const openCAPAs = capas.filter(s => vf(s, "Status") !== "Closed").length;
      const overdueCAPAs = capas.filter(s => {
        const due = vf(s, "Due Date");
        return due && due < todayStr && vf(s, "Status") !== "Closed" && vf(s, "Status") !== "Verified";
      }).length;

      // Audits
      const activeAudits = audits.filter(s => vf(s, "Status") === "In Progress" || vf(s, "Status") === "Planned").length;
      const totalFindings = audits.reduce((sum, s) => sum + (parseInt(vf(s, "Findings Count")) || 0), 0);

      // Controls
      const controlsTotal = controls.length;
      const controlsEffective = controls.filter(s => vf(s, "Effectiveness Rating") === "Effective" || vf(s, "Effectiveness Rating") === "Strong").length;
      const controlHealth = controlsTotal > 0
        ? parseFloat((controlsEffective / controlsTotal * 100).toFixed(1))
        : 100;

      // Sites
      const activeSites = sites.filter(s => vf(s, "Status") === "Active").length;

      // Sustainability
      const activeCycles = reportingCycles.filter(s => vf(s, "Status") !== "Published" && vf(s, "Status") !== "Closed").length;

      // Recent cases (latest 10)
      const recentCases = cases
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, 10)
        .map(s => ({
          id: s.id,
          caseId: vf(s, "Case ID"),
          title: vf(s, "Title"),
          caseType: vf(s, "Case Type"),
          severity: vf(s, "Severity"),
          status: vf(s, "Status"),
          site: vf(s, "Site"),
          owner: vf(s, "Owner"),
          dueDate: vf(s, "Due Date"),
        }));

      // Recent events (latest 10)
      const recentEventsList = events
        .sort((a, b) => (vf(b, "Event Timestamp") || "").localeCompare(vf(a, "Event Timestamp") || ""))
        .slice(0, 10)
        .map(s => ({
          id: s.id,
          eventId: vf(s, "Event ID"),
          title: vf(s, "Title"),
          severity: vf(s, "Severity"),
          status: vf(s, "Status"),
          source: vf(s, "Source System"),
          site: vf(s, "Site"),
          timestamp: vf(s, "Event Timestamp"),
        }));

      jsonResp(res, 200, {
        newEvents, recentEvents, eventsBySeverity,
        openCases, criticalCases, casesByStatus, casesByType, slaAtRisk,
        openCAPAs, overdueCAPAs,
        activeAudits, totalFindings,
        controlHealth, controlsTotal, controlsEffective,
        activeSites, activeCycles,
        recentCases, recentEventsList,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 2. GET /api/ogc/stats/compliance ───
  if (pathname === "/api/ogc/stats/compliance" && req.method === "GET") {
    try {
      const [controls, requirements, policies] = await Promise.all([
        collect("control", null, 8),
        collect("requirement", null, 8),
        collect("policy", null, 4),
      ]);

      const controlsByStatus = {};
      const controlsByDomain = {};
      const controlsByEffectiveness = {};
      for (const s of controls) {
        const st = vf(s, "Status") || "Unknown";
        controlsByStatus[st] = (controlsByStatus[st] || 0) + 1;
        const dom = vf(s, "Domain") || "Unknown";
        controlsByDomain[dom] = (controlsByDomain[dom] || 0) + 1;
        const eff = vf(s, "Effectiveness Rating") || "Unknown";
        controlsByEffectiveness[eff] = (controlsByEffectiveness[eff] || 0) + 1;
      }

      const requirementsByDomain = {};
      const requirementsByStatus = {};
      for (const s of requirements) {
        const dom = vf(s, "Domain") || "Unknown";
        requirementsByDomain[dom] = (requirementsByDomain[dom] || 0) + 1;
        const st = vf(s, "Status") || "Unknown";
        requirementsByStatus[st] = (requirementsByStatus[st] || 0) + 1;
      }

      const policiesByStatus = {};
      for (const s of policies) {
        const st = vf(s, "Status") || "Unknown";
        policiesByStatus[st] = (policiesByStatus[st] || 0) + 1;
      }

      jsonResp(res, 200, {
        controlsByStatus, controlsByDomain, controlsByEffectiveness,
        requirementsByDomain, requirementsByStatus,
        policiesByStatus,
        totals: {
          controls: controls.length,
          requirements: requirements.length,
          policies: policies.length,
        },
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 3. GET /api/ogc/stats/sustainability ───
  if (pathname === "/api/ogc/stats/sustainability" && req.method === "GET") {
    try {
      const [cycles, attestations, evidence] = await Promise.all([
        collect("reporting-cycle", null, 4),
        collect("attestation", null, 8),
        collect("evidence", null, 8),
      ]);

      const cyclesByStatus = {};
      const cyclesByFramework = {};
      for (const s of cycles) {
        const st = vf(s, "Status") || "Unknown";
        cyclesByStatus[st] = (cyclesByStatus[st] || 0) + 1;
        const fw = vf(s, "Framework") || "Unknown";
        cyclesByFramework[fw] = (cyclesByFramework[fw] || 0) + 1;
      }

      const attestationsByStatus = {};
      for (const s of attestations) {
        const st = vf(s, "Status") || "Unknown";
        attestationsByStatus[st] = (attestationsByStatus[st] || 0) + 1;
      }

      const evidenceByType = {};
      for (const s of evidence) {
        const tp = vf(s, "Evidence Type") || "Unknown";
        evidenceByType[tp] = (evidenceByType[tp] || 0) + 1;
      }

      jsonResp(res, 200, {
        cyclesByStatus, cyclesByFramework,
        attestationsByStatus, evidenceByType,
        totals: {
          cycles: cycles.length,
          attestations: attestations.length,
          evidence: evidence.length,
        },
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 4. POST /api/ogc/events/:id/transition ───
  const eventTransMatch = pathname.match(/^\/api\/ogc\/events\/([^/]+)\/transition$/);
  if (eventTransMatch && req.method === "POST") {
    try {
      const submissionId = eventTransMatch[1];
      const body = JSON.parse(await readBody(req));
      const { newStatus, notes, user } = body;

      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};
      const currentStatus = vals["Status"];

      const allowed = EVENT_TRANSITIONS[currentStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${currentStatus}" to "${newStatus}"` });
        return true;
      }

      const updates = { Status: newStatus };
      if (notes) updates["Processing Notes"] = (vals["Processing Notes"] || "") + `\n${nowISO()} | ${user || "system"}: ${notes}`;

      await kineticRequest("PUT", `/submissions/${submissionId}/values`, updates, auth);
      jsonResp(res, 200, { success: true, previousStatus: currentStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 5. POST /api/ogc/cases/:id/transition ───
  const caseTransMatch = pathname.match(/^\/api\/ogc\/cases\/([^/]+)\/transition$/);
  if (caseTransMatch && req.method === "POST") {
    try {
      const submissionId = caseTransMatch[1];
      const body = JSON.parse(await readBody(req));
      const { newStatus, notes, user, rootCause, rootCauseCategory, remediationPlan, closureSummary } = body;

      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};
      const currentStatus = vals["Status"];

      const allowed = CASE_TRANSITIONS[currentStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${currentStatus}" to "${newStatus}"` });
        return true;
      }

      const updates = { Status: newStatus };
      if (newStatus === "Investigation" && rootCause) updates["Root Cause"] = rootCause;
      if (rootCauseCategory) updates["Root Cause Category"] = rootCauseCategory;
      if (newStatus === "Remediation" && remediationPlan) updates["Remediation Plan"] = remediationPlan;
      if (newStatus === "Closed") {
        updates["Closure Date"] = nowISO().slice(0, 10);
        updates["Closure Approved By"] = user || "";
        if (closureSummary) updates["Closure Summary"] = closureSummary;
      }
      if (newStatus === "Reopened" && notes) updates["Reopen Reason"] = notes;

      await kineticRequest("PUT", `/submissions/${submissionId}/values`, updates, auth);
      jsonResp(res, 200, { success: true, previousStatus: currentStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 6. POST /api/ogc/capas/:id/transition ───
  const capaTransMatch = pathname.match(/^\/api\/ogc\/capas\/([^/]+)\/transition$/);
  if (capaTransMatch && req.method === "POST") {
    try {
      const submissionId = capaTransMatch[1];
      const body = JSON.parse(await readBody(req));
      const { newStatus, notes, user, verificationNotes, effectivenessRating } = body;

      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};
      const currentStatus = vals["Status"];

      const allowed = CAPA_TRANSITIONS[currentStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${currentStatus}" to "${newStatus}"` });
        return true;
      }

      const updates = { Status: newStatus };
      if (newStatus === "Verified") {
        updates["Verification Date"] = nowISO().slice(0, 10);
        updates["Verified By"] = user || "";
        if (verificationNotes) updates["Verification Notes"] = verificationNotes;
        if (effectivenessRating) updates["Effectiveness Rating"] = effectivenessRating;
      }
      if (newStatus === "Closed") {
        updates["Completion Date"] = nowISO().slice(0, 10);
        if (notes) updates["Completion Notes"] = notes;
      }

      await kineticRequest("PUT", `/submissions/${submissionId}/values`, updates, auth);
      jsonResp(res, 200, { success: true, previousStatus: currentStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 7. POST /api/ogc/audits/:id/transition ───
  const auditTransMatch = pathname.match(/^\/api\/ogc\/audits\/([^/]+)\/transition$/);
  if (auditTransMatch && req.method === "POST") {
    try {
      const submissionId = auditTransMatch[1];
      const body = JSON.parse(await readBody(req));
      const { newStatus, notes, user } = body;

      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};
      const currentStatus = vals["Status"];

      const allowed = AUDIT_TRANSITIONS[currentStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${currentStatus}" to "${newStatus}"` });
        return true;
      }

      const updates = { Status: newStatus };
      if (newStatus === "Closed") {
        updates["Sign Off Date"] = nowISO().slice(0, 10);
        updates["Sign Off By"] = user || "";
        updates["Sign Off Status"] = "Approved";
      }
      if (notes) updates["Notes"] = (vals["Notes"] || "") + `\n${nowISO()} | ${user || "system"}: ${notes}`;

      await kineticRequest("PUT", `/submissions/${submissionId}/values`, updates, auth);
      jsonResp(res, 200, { success: true, previousStatus: currentStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 8. GET /api/ogc/report/:type ───
  const reportMatch = pathname.match(/^\/api\/ogc\/report\/([^/]+)$/);
  if (reportMatch && req.method === "GET") {
    try {
      const reportType = reportMatch[1];
      const generatedAt = nowISO();
      let data = {};

      if (reportType === "events-summary") {
        const events = await collect("event", null, 8);
        const byStatus = {}, bySeverity = {}, bySource = {}, bySite = {};
        for (const s of events) {
          const st = vf(s, "Status") || "Unknown"; byStatus[st] = (byStatus[st] || 0) + 1;
          const sev = vf(s, "Severity") || "Unknown"; bySeverity[sev] = (bySeverity[sev] || 0) + 1;
          const src = vf(s, "Source System") || "Unknown"; bySource[src] = (bySource[src] || 0) + 1;
          const site = vf(s, "Site") || "Unknown"; bySite[site] = (bySite[site] || 0) + 1;
        }
        data = { total: events.length, byStatus, bySeverity, bySource, bySite };

      } else if (reportType === "cases-summary") {
        const cases = await collect("case", null, 8);
        const byStatus = {}, byType = {}, bySeverity = {}, bySite = {};
        for (const s of cases) {
          const st = vf(s, "Status") || "Unknown"; byStatus[st] = (byStatus[st] || 0) + 1;
          const tp = vf(s, "Case Type") || "Unknown"; byType[tp] = (byType[tp] || 0) + 1;
          const sev = vf(s, "Severity") || "Unknown"; bySeverity[sev] = (bySeverity[sev] || 0) + 1;
          const site = vf(s, "Site") || "Unknown"; bySite[site] = (bySite[site] || 0) + 1;
        }
        data = {
          total: cases.length, byStatus, byType, bySeverity, bySite,
          cases: cases.map(s => ({
            id: s.id, caseId: vf(s, "Case ID"), title: vf(s, "Title"),
            caseType: vf(s, "Case Type"), severity: vf(s, "Severity"),
            status: vf(s, "Status"), site: vf(s, "Site"), owner: vf(s, "Owner"),
          })),
        };

      } else if (reportType === "capas-summary") {
        const capas = await collect("capa", null, 8);
        const byStatus = {}, byType = {}, bySite = {};
        const todayStr = nowISO().slice(0, 10);
        let overdueCount = 0;
        for (const s of capas) {
          const st = vf(s, "Status") || "Unknown"; byStatus[st] = (byStatus[st] || 0) + 1;
          const tp = vf(s, "Type") || "Unknown"; byType[tp] = (byType[tp] || 0) + 1;
          const site = vf(s, "Site") || "Unknown"; bySite[site] = (bySite[site] || 0) + 1;
          const due = vf(s, "Due Date");
          if (due && due < todayStr && st !== "Closed" && st !== "Verified") overdueCount++;
        }
        data = { total: capas.length, byStatus, byType, bySite, overdueCount };

      } else if (reportType === "audits-summary") {
        const [audits, findings] = await Promise.all([
          collect("audit", null, 4),
          collect("audit-finding", null, 8),
        ]);
        const auditsByStatus = {}, auditsByType = {};
        for (const s of audits) {
          const st = vf(s, "Status") || "Unknown"; auditsByStatus[st] = (auditsByStatus[st] || 0) + 1;
          const tp = vf(s, "Audit Type") || "Unknown"; auditsByType[tp] = (auditsByType[tp] || 0) + 1;
        }
        const findingsBySeverity = {};
        for (const s of findings) {
          const sev = vf(s, "Severity") || "Unknown"; findingsBySeverity[sev] = (findingsBySeverity[sev] || 0) + 1;
        }
        data = {
          totalAudits: audits.length, auditsByStatus, auditsByType,
          totalFindings: findings.length, findingsBySeverity,
        };

      } else if (reportType === "sustainability-summary") {
        const [cycles, attestations] = await Promise.all([
          collect("reporting-cycle", null, 4),
          collect("attestation", null, 8),
        ]);
        const cyclesByStatus = {};
        for (const s of cycles) {
          const st = vf(s, "Status") || "Unknown"; cyclesByStatus[st] = (cyclesByStatus[st] || 0) + 1;
        }
        const attestationsByStatus = {};
        for (const s of attestations) {
          const st = vf(s, "Status") || "Unknown"; attestationsByStatus[st] = (attestationsByStatus[st] || 0) + 1;
        }
        data = {
          totalCycles: cycles.length, cyclesByStatus,
          totalAttestations: attestations.length, attestationsByStatus,
          cycles: cycles.map(s => ({
            id: s.id, cycleId: vf(s, "Cycle ID"), title: vf(s, "Title"),
            period: vf(s, "Reporting Period"), framework: vf(s, "Framework"),
            status: vf(s, "Status"), deadline: vf(s, "Submission Deadline"),
            dataQuality: vf(s, "Data Quality Score"),
          })),
        };

      } else if (reportType === "controls-health") {
        const controls = await collect("control", null, 8);
        const byDomain = {}, byEffectiveness = {}, byStatus = {};
        const overdue = [];
        const todayStr = nowISO().slice(0, 10);
        for (const s of controls) {
          const dom = vf(s, "Domain") || "Unknown"; byDomain[dom] = (byDomain[dom] || 0) + 1;
          const eff = vf(s, "Effectiveness Rating") || "Unknown"; byEffectiveness[eff] = (byEffectiveness[eff] || 0) + 1;
          const st = vf(s, "Status") || "Unknown"; byStatus[st] = (byStatus[st] || 0) + 1;
          const nextTest = vf(s, "Next Test Date");
          if (nextTest && nextTest < todayStr) {
            overdue.push({
              id: s.id, controlId: vf(s, "Control ID"), name: vf(s, "Name"),
              domain: vf(s, "Domain"), nextTestDate: nextTest,
            });
          }
        }
        data = { total: controls.length, byDomain, byEffectiveness, byStatus, overdue };

      } else if (reportType === "site-registry") {
        const [sites, assets, vendors] = await Promise.all([
          collect("site", null, 4),
          collect("asset", null, 8),
          collect("vendor", null, 4),
        ]);
        const sitesByType = {}, sitesByStatus = {};
        for (const s of sites) {
          const tp = vf(s, "Site Type") || "Unknown"; sitesByType[tp] = (sitesByType[tp] || 0) + 1;
          const st = vf(s, "Status") || "Unknown"; sitesByStatus[st] = (sitesByStatus[st] || 0) + 1;
        }
        const assetsByCriticality = {};
        for (const s of assets) {
          const cr = vf(s, "Criticality") || "Unknown"; assetsByCriticality[cr] = (assetsByCriticality[cr] || 0) + 1;
        }
        data = {
          totalSites: sites.length, sitesByType, sitesByStatus,
          totalAssets: assets.length, assetsByCriticality,
          totalVendors: vendors.length,
        };

      } else if (reportType === "overdue-items") {
        const todayStr = nowISO().slice(0, 10);
        const [cases, capas, controls, audits] = await Promise.all([
          collect("case", null, 8),
          collect("capa", null, 8),
          collect("control", null, 8),
          collect("audit", null, 4),
        ]);

        const overdueCases = cases
          .filter(s => {
            const due = vf(s, "Due Date");
            return due && due < todayStr && vf(s, "Status") !== "Closed";
          })
          .map(s => ({
            id: s.id, caseId: vf(s, "Case ID"), title: vf(s, "Title"),
            severity: vf(s, "Severity"), dueDate: vf(s, "Due Date"), status: vf(s, "Status"),
          }));

        const overdueCAPAs = capas
          .filter(s => {
            const due = vf(s, "Due Date");
            return due && due < todayStr && vf(s, "Status") !== "Closed" && vf(s, "Status") !== "Verified";
          })
          .map(s => ({
            id: s.id, capaId: vf(s, "CAPA ID"), title: vf(s, "Title"),
            dueDate: vf(s, "Due Date"), status: vf(s, "Status"),
          }));

        const overdueControls = controls
          .filter(s => {
            const next = vf(s, "Next Test Date");
            return next && next < todayStr;
          })
          .map(s => ({
            id: s.id, controlId: vf(s, "Control ID"), name: vf(s, "Name"),
            domain: vf(s, "Domain"), nextTestDate: vf(s, "Next Test Date"),
          }));

        data = { overdueCases, overdueCAPAs, overdueControls };

      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${reportType}` });
        return true;
      }

      jsonResp(res, 200, { type: reportType, generatedAt, data });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 9. GET /api/ogc/site-summary?site=SiteName ───
  if (pathname === "/api/ogc/site-summary" && req.method === "GET") {
    try {
      const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
      const siteName = parsedUrl.searchParams.get("site");
      if (!siteName) {
        jsonResp(res, 400, { error: "Missing 'site' query parameter" });
        return true;
      }

      const kql = `values[Site]="${siteName}"`;
      const [events, cases, capas, assets, audits] = await Promise.all([
        collect("event", kql, 4),
        collect("case", kql, 4),
        collect("capa", kql, 4),
        collect("asset", kql, 4),
        collect("audit", kql, 2),
      ]);

      const openEvents = events.filter(s => vf(s, "Status") === "New" || vf(s, "Status") === "Triaged").length;
      const openCases = cases.filter(s => vf(s, "Status") !== "Closed").length;
      const openCAPAs = capas.filter(s => vf(s, "Status") !== "Closed" && vf(s, "Status") !== "Verified").length;

      const casesBySeverity = {};
      for (const s of cases.filter(c => vf(c, "Status") !== "Closed")) {
        const sev = vf(s, "Severity") || "Unknown";
        casesBySeverity[sev] = (casesBySeverity[sev] || 0) + 1;
      }

      jsonResp(res, 200, {
        site: siteName,
        events: { total: events.length, open: openEvents },
        cases: {
          total: cases.length, open: openCases, bySeverity: casesBySeverity,
          recent: cases.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 5).map(s => ({
            id: s.id, caseId: vf(s, "Case ID"), title: vf(s, "Title"),
            severity: vf(s, "Severity"), status: vf(s, "Status"),
          })),
        },
        capas: { total: capas.length, open: openCAPAs },
        assets: {
          total: assets.length,
          list: assets.map(s => ({
            id: s.id, assetId: vf(s, "Asset ID"), name: vf(s, "Name"),
            type: vf(s, "Asset Type"), criticality: vf(s, "Criticality"), status: vf(s, "Status"),
          })),
        },
        audits: {
          total: audits.length,
          list: audits.map(s => ({
            id: s.id, auditId: vf(s, "Audit ID"), title: vf(s, "Title"),
            type: vf(s, "Audit Type"), status: vf(s, "Status"),
          })),
        },
      });
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

  server.listen(PORT, () => console.log(`\n  og_compliance: http://localhost:${PORT}\n`));
}
