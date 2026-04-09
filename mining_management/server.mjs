/**
 * Mining Operations — Custom API Handler
 */

export const appId = "mining-ops";
export const apiPrefix = "/api/mining";
export const kapp = "mining-ops";

// ─── App-specific helpers ──────────────────────────────────────────────────

function nowISO() { return new Date().toISOString(); }
const ISSUE_TRANSITIONS = {
  "Open": ["Triage"],
  "Triage": ["Investigating", "Closed"],
  "Investigating": ["CAPA", "Closed"],
  "CAPA": ["Verify"],
  "Verify": ["Closed", "CAPA"],
};
const PERMIT_TRANSITIONS = {
  "Pending": ["Active"],
  "Active": ["Renewal Pending", "Suspended"],
  "Renewal Pending": ["Active"],
  "Suspended": ["Active", "Revoked"],
  "Expired": ["Renewal Pending"],
};

// ─── API Handler ───────────────────────────────────────────────────────────

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }


  // ─── 1. GET /api/mining/dashboard ───
  if (pathname === "/api/mining/dashboard" && req.method === "GET") {
    try {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);

      const [issues, permits, inspections, assets, productionLogs, envReadings, personnel, obligations] =
        await Promise.all([
          collect("issues", null, 8),
          collect("permits", null, 8),
          collect("inspections", null, 8),
          collect("assets", null, 8),
          collect("production-logs", null, 8),
          collect("environmental-readings", null, 8),
          collect("personnel", null, 8),
          collect("obligations", null, 8),
        ]);

      // Filter production/env to last 7 days client-side
      const recentProduction = productionLogs.filter(s => (vf(s, "Date") || "") >= sevenDaysAgo);
      const recentEnv = envReadings.filter(s => (vf(s, "Date") || "") >= sevenDaysAgo);

      // Open / critical issues
      const openIssues = issues.filter(s => vf(s, "Status") !== "Closed").length;
      const criticalIssues = issues.filter(s => vf(s, "Severity") === "Critical" && vf(s, "Status") !== "Closed").length;

      // Permits
      const activePermits = permits.filter(s => vf(s, "Status") === "Active").length;
      const thirtyDaysFromNow = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
      const sixtyDaysFromNow = new Date(now.getTime() + 60 * 86400000).toISOString().slice(0, 10);
      const todayStr = now.toISOString().slice(0, 10);
      const expiringPermits = permits.filter(s => {
        const exp = vf(s, "Expiry Date");
        return exp && exp >= todayStr && exp <= thirtyDaysFromNow;
      }).length;

      // Inspections
      const overdueInspections = inspections.filter(s => vf(s, "Status") === "Overdue").length;

      // Assets
      const assetsTotal = assets.length;
      const assetsOperational = assets.filter(s => vf(s, "Status") === "Operational").length;

      // Personnel
      const personnelActive = personnel.filter(s => vf(s, "Status") === "Active").length;

      // Obligations
      const obligationsTotal = obligations.length;
      const obligationsCompliant = obligations.filter(s => vf(s, "Status") === "Compliant").length;

      // Average inspection score (completed only)
      const completedInspections = inspections.filter(s => vf(s, "Status") === "Complete" && vf(s, "Score"));
      const avgInspectionScore = completedInspections.length > 0
        ? (completedInspections.reduce((sum, s) => sum + parseFloat(vf(s, "Score")) || 0, 0) / completedInspections.length).toFixed(1)
        : null;

      // Issues by severity
      const issuesBySeverity = { Critical: 0, High: 0, Medium: 0, Low: 0 };
      for (const s of issues) {
        const sev = vf(s, "Severity");
        if (sev in issuesBySeverity) issuesBySeverity[sev]++;
      }

      // Issues by category
      const issuesByCategory = { Safety: 0, Environmental: 0, Equipment: 0, Compliance: 0, Operational: 0 };
      for (const s of issues) {
        const cat = vf(s, "Category");
        if (cat in issuesByCategory) issuesByCategory[cat]++;
      }

      // Compliance rate
      const complianceRate = obligationsTotal > 0
        ? parseFloat((obligationsCompliant / obligationsTotal * 100).toFixed(1))
        : 100;

      // Recent issues (latest 10 by Reported Date desc)
      const recentIssues = issues
        .sort((a, b) => (vf(b, "Reported Date") || "").localeCompare(vf(a, "Reported Date") || ""))
        .slice(0, 10)
        .map(s => ({
          id: s.id,
          issueId: vf(s, "Issue ID"),
          title: vf(s, "Title"),
          severity: vf(s, "Severity"),
          category: vf(s, "Category"),
          status: vf(s, "Status"),
          site: vf(s, "Site"),
          reportedDate: vf(s, "Reported Date"),
          assignedTo: vf(s, "Assigned To"),
        }));

      // Expiring permits (within 60 days)
      const expiringPermitsList = permits
        .filter(s => {
          const exp = vf(s, "Expiry Date");
          return exp && exp >= todayStr && exp <= sixtyDaysFromNow;
        })
        .sort((a, b) => (vf(a, "Expiry Date") || "").localeCompare(vf(b, "Expiry Date") || ""))
        .map(s => ({
          id: s.id,
          permitId: vf(s, "Permit ID"),
          type: vf(s, "Permit Type"),
          site: vf(s, "Site"),
          expiryDate: vf(s, "Expiry Date"),
          status: vf(s, "Status"),
        }));

      // Production summary
      let totalExtracted = 0, totalProcessed = 0;
      for (const s of recentProduction) {
        totalExtracted += parseFloat(vf(s, "Tonnes Extracted")) || 0;
        totalProcessed += parseFloat(vf(s, "Tonnes Processed")) || 0;
      }
      const productionSummary = {
        totalExtracted: Math.round(totalExtracted),
        totalProcessed: Math.round(totalProcessed),
        logCount: recentProduction.length,
      };

      // Environmental exceedances
      const envExceedances = recentEnv.filter(s => {
        const st = vf(s, "Status");
        return st === "Exceedance" || st === "Critical";
      }).length;

      jsonResp(res, 200, {
        openIssues, criticalIssues, activePermits, expiringPermits,
        overdueInspections, assetsOperational, assetsTotal,
        personnelActive, obligationsCompliant, obligationsTotal,
        avgInspectionScore, issuesBySeverity, issuesByCategory,
        complianceRate, recentIssues, expiringPermitsList,
        productionSummary, envExceedances,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 2. GET /api/mining/stats/compliance ───
  if (pathname === "/api/mining/stats/compliance" && req.method === "GET") {
    try {
      const [permits, obligations] = await Promise.all([
        collect("permits", null, 8),
        collect("obligations", null, 8),
      ]);

      const permitsByStatus = {};
      const permitsByType = {};
      for (const s of permits) {
        const st = vf(s, "Status") || "Unknown";
        permitsByStatus[st] = (permitsByStatus[st] || 0) + 1;
        const tp = vf(s, "Permit Type") || "Unknown";
        permitsByType[tp] = (permitsByType[tp] || 0) + 1;
      }

      const obligationsByStatus = {};
      const obligationsByCategory = {};
      const overdueObligations = [];
      let compliantCount = 0;
      for (const s of obligations) {
        const st = vf(s, "Status") || "Unknown";
        obligationsByStatus[st] = (obligationsByStatus[st] || 0) + 1;
        if (st === "Compliant") compliantCount++;
        const cat = vf(s, "Category") || "Unknown";
        obligationsByCategory[cat] = (obligationsByCategory[cat] || 0) + 1;
        if (st === "Overdue" || st === "Non-Compliant") {
          overdueObligations.push({
            id: s.id,
            obligationId: vf(s, "Obligation ID"),
            title: vf(s, "Title"),
            category: vf(s, "Category"),
            dueDate: vf(s, "Due Date"),
            status: st,
            responsiblePerson: vf(s, "Responsible Person"),
          });
        }
      }

      const complianceRate = obligations.length > 0
        ? parseFloat((compliantCount / obligations.length * 100).toFixed(1))
        : 100;

      jsonResp(res, 200, {
        permitsByStatus, permitsByType,
        obligationsByStatus, obligationsByCategory,
        complianceRate, overdueObligations,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 3. GET /api/mining/stats/operations ───
  if (pathname === "/api/mining/stats/operations" && req.method === "GET") {
    try {
      const [assets, productionLogs, envReadings] = await Promise.all([
        collect("assets", null, 8),
        collect("production-logs", null, 8),
        collect("environmental-readings", null, 8),
      ]);

      const assetsByStatus = {};
      const assetsByCategory = {};
      const maintenanceDue = [];
      const now = new Date();
      const fourteenDaysFromNow = new Date(now.getTime() + 14 * 86400000).toISOString().slice(0, 10);
      const todayStr = now.toISOString().slice(0, 10);

      for (const s of assets) {
        const st = vf(s, "Status") || "Unknown";
        assetsByStatus[st] = (assetsByStatus[st] || 0) + 1;
        const cat = vf(s, "Category") || "Unknown";
        assetsByCategory[cat] = (assetsByCategory[cat] || 0) + 1;
        const nextMaint = vf(s, "Next Maintenance");
        if (nextMaint && nextMaint <= fourteenDaysFromNow) {
          maintenanceDue.push({
            id: s.id,
            assetId: vf(s, "Asset ID"),
            name: vf(s, "Name"),
            category: vf(s, "Category"),
            site: vf(s, "Site"),
            nextMaintenance: nextMaint,
            status: vf(s, "Status"),
          });
        }
      }

      const productionByMaterial = {};
      for (const s of productionLogs) {
        const mat = vf(s, "Material Type") || "Unknown";
        if (!productionByMaterial[mat]) productionByMaterial[mat] = { extracted: 0, processed: 0, count: 0 };
        productionByMaterial[mat].extracted += parseFloat(vf(s, "Tonnes Extracted")) || 0;
        productionByMaterial[mat].processed += parseFloat(vf(s, "Tonnes Processed")) || 0;
        productionByMaterial[mat].count++;
      }
      // Round totals
      for (const mat in productionByMaterial) {
        productionByMaterial[mat].extracted = Math.round(productionByMaterial[mat].extracted);
        productionByMaterial[mat].processed = Math.round(productionByMaterial[mat].processed);
      }

      const envByParameter = {};
      const envByStatus = {};
      for (const s of envReadings) {
        const param = vf(s, "Parameter") || "Unknown";
        envByParameter[param] = (envByParameter[param] || 0) + 1;
        const st = vf(s, "Status") || "Unknown";
        envByStatus[st] = (envByStatus[st] || 0) + 1;
      }

      jsonResp(res, 200, {
        assetsByStatus, assetsByCategory,
        productionByMaterial, envByParameter, envByStatus,
        maintenanceDue,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 4. POST /api/mining/issues/:id/transition ───
  const issueTransMatch = pathname.match(/^\/api\/mining\/issues\/([^/]+)\/transition$/);
  if (issueTransMatch && req.method === "POST") {
    try {
      const submissionId = issueTransMatch[1];
      const body = JSON.parse(await readBody(req));
      const { newStatus, notes, user, displayName, rootCause, capaDescription, capaDueDate, verificationNotes } = body;

      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};
      const currentStatus = vals["Status"];

      const allowed = ISSUE_TRANSITIONS[currentStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${currentStatus}" to "${newStatus}"` });
        return true;
      }

      const updates = { Status: newStatus };

      // Append to status history
      const history = vals["Status History"] || "";
      const historyEntry = `${nowISO()} | ${currentStatus} → ${newStatus} | ${user || "system"}: ${notes || ""}`;
      updates["Status History"] = history ? history + "\n" + historyEntry : historyEntry;

      // CAPA transition
      if (newStatus === "CAPA") {
        if (rootCause) updates["Root Cause"] = rootCause;
        if (capaDescription) updates["CAPA Description"] = capaDescription;
        if (capaDueDate) updates["CAPA Due Date"] = capaDueDate;
        updates["CAPA Status"] = "In Progress";
      }

      // Verify transition
      if (newStatus === "Verify") {
        updates["CAPA Status"] = "Complete";
        if (verificationNotes) updates["Verification Notes"] = verificationNotes;
      }

      // Closed transition
      if (newStatus === "Closed") {
        updates["Closed Date"] = nowISO();
        updates["Closed By"] = user || "";
        if (currentStatus === "CAPA" || currentStatus === "Verify") {
          updates["CAPA Status"] = "Complete";
        }
      }

      await kineticRequest("PUT", `/submissions/${submissionId}/values`, updates, auth);

      jsonResp(res, 200, { success: true, previousStatus: currentStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 5. POST /api/mining/permits/:id/transition ───
  const permitTransMatch = pathname.match(/^\/api\/mining\/permits\/([^/]+)\/transition$/);
  if (permitTransMatch && req.method === "POST") {
    try {
      const submissionId = permitTransMatch[1];
      const body = JSON.parse(await readBody(req));
      const { newStatus, notes, user } = body;

      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};
      const currentStatus = vals["Status"];

      const allowed = PERMIT_TRANSITIONS[currentStatus];
      if (!allowed || !allowed.includes(newStatus)) {
        jsonResp(res, 400, { error: `Cannot transition from "${currentStatus}" to "${newStatus}"` });
        return true;
      }

      const updates = { Status: newStatus };

      // Append to status history
      const history = vals["Status History"] || "";
      const historyEntry = `${nowISO()} | ${currentStatus} → ${newStatus} | ${user || "system"}: ${notes || ""}`;
      updates["Status History"] = history ? history + "\n" + historyEntry : historyEntry;

      await kineticRequest("PUT", `/submissions/${submissionId}/values`, updates, auth);

      jsonResp(res, 200, { success: true, previousStatus: currentStatus, newStatus });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 6. POST /api/mining/inspections/:id/complete ───
  const inspCompleteMatch = pathname.match(/^\/api\/mining\/inspections\/([^/]+)\/complete$/);
  if (inspCompleteMatch && req.method === "POST") {
    try {
      const submissionId = inspCompleteMatch[1];
      const body = JSON.parse(await readBody(req));
      const { score, findings, notes, inspector, criticalFindings } = body;

      const current = await kineticRequest("GET", `/submissions/${submissionId}?include=values`, null, auth);
      const vals = current.data?.submission?.values || {};

      const updates = {
        Status: "Complete",
        "Completed Date": nowISO(),
      };
      if (score !== undefined) updates["Score"] = String(score);
      if (findings) updates["Findings"] = findings;
      if (notes) updates["Notes"] = notes;
      if (inspector) updates["Inspector"] = inspector;
      if (criticalFindings !== undefined) updates["Critical Findings"] = String(criticalFindings);

      // Count total findings
      let findingsArr = [];
      try { findingsArr = JSON.parse(findings || "[]"); } catch {}
      updates["Findings Count"] = String(findingsArr.length);

      await kineticRequest("PUT", `/submissions/${submissionId}/values`, updates, auth);

      // Auto-create issues for critical/high findings
      let issuesCreated = 0;
      if (criticalFindings > 0 && findingsArr.length > 0) {
        const severeFindings = findingsArr.filter(f =>
          f.severity === "Critical" || f.severity === "High"
        );
        for (const finding of severeFindings) {
          const issueId = `ISS-AUTO-${Date.now()}-${issuesCreated + 1}`;
          await kineticRequest("POST", `/kapps/${KAPP}/forms/issues/submissions`, {
            values: {
              "Issue ID": issueId,
              "Title": finding.title || finding.description || `Finding from inspection ${vf(current.data?.submission, "Inspection ID")}`,
              "Description": finding.description || finding.title || "",
              "Type": "Non-Conformance",
              "Severity": finding.severity || "High",
              "Category": finding.category || "Safety",
              "Site": vals["Site"] || "",
              "Site ID": vals["Site ID"] || "",
              "Zone": vals["Zone"] || "",
              "Status": "Open",
              "Reported By": inspector || "",
              "Reported Date": nowISO().slice(0, 10),
              "Related Inspection ID": vals["Inspection ID"] || "",
            }
          }, auth);
          issuesCreated++;
        }
      }

      jsonResp(res, 200, { success: true, issuesCreated });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 7. GET /api/mining/report/:type ───
  const reportMatch = pathname.match(/^\/api\/mining\/report\/([^/]+)$/);
  if (reportMatch && req.method === "GET") {
    try {
      const reportType = reportMatch[1];
      const generatedAt = nowISO();
      let data = {};

      if (reportType === "issues-summary") {
        const issues = await collect("issues", null, 8);
        const byStatus = {}, bySeverity = {}, byCategory = {}, bySite = {};
        for (const s of issues) {
          const st = vf(s, "Status") || "Unknown";
          byStatus[st] = (byStatus[st] || 0) + 1;
          const sev = vf(s, "Severity") || "Unknown";
          bySeverity[sev] = (bySeverity[sev] || 0) + 1;
          const cat = vf(s, "Category") || "Unknown";
          byCategory[cat] = (byCategory[cat] || 0) + 1;
          const site = vf(s, "Site") || "Unknown";
          bySite[site] = (bySite[site] || 0) + 1;
        }
        data = {
          total: issues.length, byStatus, bySeverity, byCategory, bySite,
          issues: issues.map(s => ({
            id: s.id, issueId: vf(s, "Issue ID"), title: vf(s, "Title"),
            type: vf(s, "Type"), severity: vf(s, "Severity"), category: vf(s, "Category"),
            site: vf(s, "Site"), status: vf(s, "Status"), reportedDate: vf(s, "Reported Date"),
            assignedTo: vf(s, "Assigned To"), capaStatus: vf(s, "CAPA Status"),
          })),
        };

      } else if (reportType === "compliance-status") {
        const [permits, obligations] = await Promise.all([
          collect("permits", null, 8),
          collect("obligations", null, 8),
        ]);
        // Map obligations to their permits
        const permitMap = {};
        for (const p of permits) {
          const pid = vf(p, "Permit ID");
          permitMap[pid] = {
            id: p.id, permitId: pid, type: vf(p, "Permit Type"),
            site: vf(p, "Site"), status: vf(p, "Status"),
            expiryDate: vf(p, "Expiry Date"),
            obligations: [],
          };
        }
        for (const o of obligations) {
          const pid = vf(o, "Permit ID");
          if (permitMap[pid]) {
            permitMap[pid].obligations.push({
              id: o.id, obligationId: vf(o, "Obligation ID"), title: vf(o, "Title"),
              category: vf(o, "Category"), status: vf(o, "Status"), dueDate: vf(o, "Due Date"),
            });
          }
        }
        // Compliance rate by site
        const bySite = {};
        for (const o of obligations) {
          const site = permits.find(p => vf(p, "Permit ID") === vf(o, "Permit ID"));
          const siteName = site ? vf(site, "Site") : "Unknown";
          if (!bySite[siteName]) bySite[siteName] = { total: 0, compliant: 0 };
          bySite[siteName].total++;
          if (vf(o, "Status") === "Compliant") bySite[siteName].compliant++;
        }
        const complianceRateBySite = {};
        for (const site in bySite) {
          complianceRateBySite[site] = bySite[site].total > 0
            ? parseFloat((bySite[site].compliant / bySite[site].total * 100).toFixed(1))
            : 100;
        }
        const totalCompliant = obligations.filter(o => vf(o, "Status") === "Compliant").length;
        data = {
          permits: Object.values(permitMap),
          complianceRate: obligations.length > 0
            ? parseFloat((totalCompliant / obligations.length * 100).toFixed(1))
            : 100,
          complianceRateBySite,
        };

      } else if (reportType === "inspection-results") {
        const inspections = await collect("inspections", null, 8);
        const completed = inspections.filter(s => vf(s, "Status") === "Complete");
        const bySite = {};
        for (const s of completed) {
          const site = vf(s, "Site") || "Unknown";
          if (!bySite[site]) bySite[site] = { inspections: [], totalScore: 0, count: 0 };
          const score = parseFloat(vf(s, "Score")) || 0;
          bySite[site].totalScore += score;
          bySite[site].count++;
          bySite[site].inspections.push({
            id: s.id, inspectionId: vf(s, "Inspection ID"), type: vf(s, "Type"),
            completedDate: vf(s, "Completed Date"), score, inspector: vf(s, "Inspector"),
            findingsCount: parseInt(vf(s, "Findings Count")) || 0,
            criticalFindings: parseInt(vf(s, "Critical Findings")) || 0,
          });
        }
        for (const site in bySite) {
          bySite[site].avgScore = bySite[site].count > 0
            ? parseFloat((bySite[site].totalScore / bySite[site].count).toFixed(1))
            : 0;
        }
        data = { total: completed.length, bySite };

      } else if (reportType === "production-summary") {
        const logs = await collect("production-logs", null, 8);
        const bySite = {};
        for (const s of logs) {
          const site = vf(s, "Site") || "Unknown";
          const mat = vf(s, "Material Type") || "Unknown";
          if (!bySite[site]) bySite[site] = {};
          if (!bySite[site][mat]) bySite[site][mat] = { extracted: 0, processed: 0, count: 0 };
          bySite[site][mat].extracted += parseFloat(vf(s, "Tonnes Extracted")) || 0;
          bySite[site][mat].processed += parseFloat(vf(s, "Tonnes Processed")) || 0;
          bySite[site][mat].count++;
        }
        // Round
        for (const site in bySite) {
          for (const mat in bySite[site]) {
            bySite[site][mat].extracted = Math.round(bySite[site][mat].extracted);
            bySite[site][mat].processed = Math.round(bySite[site][mat].processed);
          }
        }
        let totalExtracted = 0, totalProcessed = 0;
        for (const s of logs) {
          totalExtracted += parseFloat(vf(s, "Tonnes Extracted")) || 0;
          totalProcessed += parseFloat(vf(s, "Tonnes Processed")) || 0;
        }
        data = {
          totalLogs: logs.length,
          totalExtracted: Math.round(totalExtracted),
          totalProcessed: Math.round(totalProcessed),
          bySite,
        };

      } else if (reportType === "environmental-summary") {
        const readings = await collect("environmental-readings", null, 8);
        const byParameter = {};
        const byStatus = {};
        const exceedances = [];
        for (const s of readings) {
          const param = vf(s, "Parameter") || "Unknown";
          byParameter[param] = (byParameter[param] || 0) + 1;
          const st = vf(s, "Status") || "Unknown";
          byStatus[st] = (byStatus[st] || 0) + 1;
          if (st === "Exceedance" || st === "Critical") {
            exceedances.push({
              id: s.id, site: vf(s, "Site"), monitoringPoint: vf(s, "Monitoring Point"),
              date: vf(s, "Date"), parameter: param, value: vf(s, "Value"),
              unit: vf(s, "Unit"), threshold: vf(s, "Threshold"), status: st,
            });
          }
        }
        data = { totalReadings: readings.length, byParameter, byStatus, exceedances };

      } else if (reportType === "asset-inventory") {
        const assets = await collect("assets", null, 8);
        const byCategory = {};
        const byStatus = {};
        for (const s of assets) {
          const cat = vf(s, "Category") || "Unknown";
          if (!byCategory[cat]) byCategory[cat] = [];
          byCategory[cat].push({
            id: s.id, assetId: vf(s, "Asset ID"), name: vf(s, "Name"),
            type: vf(s, "Type"), site: vf(s, "Site"), status: vf(s, "Status"),
            manufacturer: vf(s, "Manufacturer"), model: vf(s, "Model"),
            lastMaintenance: vf(s, "Last Maintenance"), nextMaintenance: vf(s, "Next Maintenance"),
            operatingHours: vf(s, "Operating Hours"),
          });
          const st = vf(s, "Status") || "Unknown";
          byStatus[st] = (byStatus[st] || 0) + 1;
        }
        data = { totalAssets: assets.length, byCategory, byStatus };

      } else if (reportType === "personnel-roster") {
        const personnel = await collect("personnel", null, 8);
        const bySite = {};
        const byRole = {};
        for (const s of personnel) {
          const site = vf(s, "Site") || "Unassigned";
          if (!bySite[site]) bySite[site] = [];
          bySite[site].push({
            id: s.id, employeeId: vf(s, "Employee ID"), fullName: vf(s, "Full Name"),
            role: vf(s, "Role"), department: vf(s, "Department"),
            employmentType: vf(s, "Employment Type"), status: vf(s, "Status"),
            startDate: vf(s, "Start Date"), email: vf(s, "Email"),
          });
          const role = vf(s, "Role") || "Unknown";
          byRole[role] = (byRole[role] || 0) + 1;
        }
        data = { totalPersonnel: personnel.length, bySite, byRole };

      } else if (reportType === "overdue-items") {
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);

        const [inspections, permits, obligations, issues] = await Promise.all([
          collect("inspections", null, 8),
          collect("permits", null, 8),
          collect("obligations", null, 8),
          collect("issues", null, 8),
        ]);

        const overdueInspections = inspections
          .filter(s => vf(s, "Status") === "Overdue")
          .map(s => ({
            id: s.id, inspectionId: vf(s, "Inspection ID"), type: vf(s, "Type"),
            site: vf(s, "Site"), scheduledDate: vf(s, "Scheduled Date"), status: vf(s, "Status"),
          }));

        const expiredPermits = permits
          .filter(s => {
            const exp = vf(s, "Expiry Date");
            return vf(s, "Status") === "Expired" || (exp && exp < todayStr && vf(s, "Status") === "Active");
          })
          .map(s => ({
            id: s.id, permitId: vf(s, "Permit ID"), type: vf(s, "Permit Type"),
            site: vf(s, "Site"), expiryDate: vf(s, "Expiry Date"), status: vf(s, "Status"),
          }));

        const thirtyDays = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
        const expiringPermits = permits
          .filter(s => {
            const exp = vf(s, "Expiry Date");
            return exp && exp >= todayStr && exp <= thirtyDays && vf(s, "Status") === "Active";
          })
          .map(s => ({
            id: s.id, permitId: vf(s, "Permit ID"), type: vf(s, "Permit Type"),
            site: vf(s, "Site"), expiryDate: vf(s, "Expiry Date"),
          }));

        const overdueObligations = obligations
          .filter(s => vf(s, "Status") === "Overdue" || vf(s, "Status") === "Non-Compliant")
          .map(s => ({
            id: s.id, obligationId: vf(s, "Obligation ID"), title: vf(s, "Title"),
            category: vf(s, "Category"), dueDate: vf(s, "Due Date"), status: vf(s, "Status"),
          }));

        const overdueCAPAs = issues
          .filter(s => vf(s, "CAPA Status") === "Overdue" || (
            vf(s, "Status") === "CAPA" && vf(s, "CAPA Due Date") && vf(s, "CAPA Due Date") < todayStr
          ))
          .map(s => ({
            id: s.id, issueId: vf(s, "Issue ID"), title: vf(s, "Title"),
            site: vf(s, "Site"), capaDueDate: vf(s, "CAPA Due Date"),
            capaStatus: vf(s, "CAPA Status"),
          }));

        data = { overdueInspections, expiredPermits, expiringPermits, overdueObligations, overdueCAPAs };

      } else {
        jsonResp(res, 400, { error: `Unknown report type: ${reportType}` });
        return true;
      }

      jsonResp(res, 200, { type: reportType, generatedAt, data });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ─── 8. GET /api/mining/site-summary?site=SiteName ───
  if (pathname === "/api/mining/site-summary" && req.method === "GET") {
    try {
      const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
      const siteName = parsedUrl.searchParams.get("site");
      if (!siteName) {
        jsonResp(res, 400, { error: "Missing 'site' query parameter" });
        return true;
      }

      const [permits, issues, inspections, assets, productionLogs, personnel] = await Promise.all([
        collect("permits", `values[Site]="${siteName}"`, 4),
        collect("issues", `values[Site]="${siteName}"`, 4),
        collect("inspections", `values[Site]="${siteName}"`, 4),
        collect("assets", `values[Site]="${siteName}"`, 4),
        collect("production-logs", `values[Site]="${siteName}"`, 4),
        collect("personnel", `values[Site]="${siteName}"`, 4),
      ]);

      // Permits summary
      const permitsByStatus = {};
      for (const s of permits) {
        const st = vf(s, "Status") || "Unknown";
        permitsByStatus[st] = (permitsByStatus[st] || 0) + 1;
      }

      // Issues summary
      const openIssues = issues.filter(s => vf(s, "Status") !== "Closed");
      const issuesBySeverity = {};
      for (const s of openIssues) {
        const sev = vf(s, "Severity") || "Unknown";
        issuesBySeverity[sev] = (issuesBySeverity[sev] || 0) + 1;
      }

      // Inspections summary
      const completedInspections = inspections.filter(s => vf(s, "Status") === "Complete");
      const avgScore = completedInspections.length > 0
        ? parseFloat((completedInspections.reduce((sum, s) => sum + (parseFloat(vf(s, "Score")) || 0), 0) / completedInspections.length).toFixed(1))
        : null;

      // Assets summary
      const assetsByStatus = {};
      for (const s of assets) {
        const st = vf(s, "Status") || "Unknown";
        assetsByStatus[st] = (assetsByStatus[st] || 0) + 1;
      }

      // Production totals
      let totalExtracted = 0, totalProcessed = 0;
      for (const s of productionLogs) {
        totalExtracted += parseFloat(vf(s, "Tonnes Extracted")) || 0;
        totalProcessed += parseFloat(vf(s, "Tonnes Processed")) || 0;
      }

      // Personnel by role
      const personnelByRole = {};
      for (const s of personnel) {
        const role = vf(s, "Role") || "Unknown";
        personnelByRole[role] = (personnelByRole[role] || 0) + 1;
      }

      jsonResp(res, 200, {
        site: siteName,
        permits: {
          total: permits.length,
          byStatus: permitsByStatus,
          list: permits.map(s => ({
            id: s.id, permitId: vf(s, "Permit ID"), type: vf(s, "Permit Type"),
            status: vf(s, "Status"), expiryDate: vf(s, "Expiry Date"),
          })),
        },
        issues: {
          total: issues.length,
          open: openIssues.length,
          bySeverity: issuesBySeverity,
          recent: issues
            .sort((a, b) => (vf(b, "Reported Date") || "").localeCompare(vf(a, "Reported Date") || ""))
            .slice(0, 10)
            .map(s => ({
              id: s.id, issueId: vf(s, "Issue ID"), title: vf(s, "Title"),
              severity: vf(s, "Severity"), status: vf(s, "Status"),
              reportedDate: vf(s, "Reported Date"),
            })),
        },
        inspections: {
          total: inspections.length,
          completed: completedInspections.length,
          avgScore,
          overdue: inspections.filter(s => vf(s, "Status") === "Overdue").length,
          recent: inspections
            .sort((a, b) => (vf(b, "Scheduled Date") || "").localeCompare(vf(a, "Scheduled Date") || ""))
            .slice(0, 10)
            .map(s => ({
              id: s.id, inspectionId: vf(s, "Inspection ID"), type: vf(s, "Type"),
              status: vf(s, "Status"), scheduledDate: vf(s, "Scheduled Date"),
              score: vf(s, "Score"),
            })),
        },
        assets: {
          total: assets.length,
          byStatus: assetsByStatus,
          list: assets.map(s => ({
            id: s.id, assetId: vf(s, "Asset ID"), name: vf(s, "Name"),
            category: vf(s, "Category"), status: vf(s, "Status"),
            nextMaintenance: vf(s, "Next Maintenance"),
          })),
        },
        production: {
          totalLogs: productionLogs.length,
          totalExtracted: Math.round(totalExtracted),
          totalProcessed: Math.round(totalProcessed),
        },
        personnel: {
          total: personnel.length,
          active: personnel.filter(s => vf(s, "Status") === "Active").length,
          byRole: personnelByRole,
          list: personnel.map(s => ({
            id: s.id, employeeId: vf(s, "Employee ID"), fullName: vf(s, "Full Name"),
            role: vf(s, "Role"), status: vf(s, "Status"),
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

  server.listen(PORT, () => console.log(`\n  Mining Operations: http://localhost:${PORT}\n`));
}
