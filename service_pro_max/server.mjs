/**
 * ServiceProMax — Custom API Handler
 *
 * Enterprise services delivery, quality, and management platform.
 * Exports a handler for the base server to auto-discover and mount.
 */

// ─── App metadata (used by base server auto-discovery) ─────────────────────
export const appId = "service-pro-max";
export const apiPrefix = "/api/spm";
export const kapp = "service-pro-max";

// ─── Helpers ───────────────────────────────────────────────────────────────

function pct(n, d) { return d ? Math.round(n / d * 100) : 0; }
function avg(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : 0; }
function sum(arr) { return arr.reduce((a, b) => a + (parseFloat(b) || 0), 0); }

// ─── API Handler ───────────────────────────────────────────────────────────

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  // ── GET /api/spm/dashboard — Executive dashboard KPIs ──────────────
  if (pathname === "/api/spm/dashboard" && req.method === "GET") {
    try {
      const [projects, statuses, customers, feedback, qualityReviews, correctiveActions, recoveryPlans, timeEntries, costEntries] = await Promise.all([
        collect("project"), collect("status-update"), collect("customer"),
        collect("customer-feedback"), collect("quality-review"),
        collect("corrective-action"), collect("recovery-plan"),
        collect("time-entry"), collect("cost-entry"),
      ]);

      const activeProjects = projects.filter(p => !["Completed", "Closed", "Archived"].includes(vf(p, "Stage")));
      const byHealth = { Green: 0, Yellow: 0, Red: 0 };
      activeProjects.forEach(p => { const h = vf(p, "Health"); if (byHealth[h] !== undefined) byHealth[h]++; });

      const byStage = {};
      activeProjects.forEach(p => { const s = vf(p, "Stage"); byStage[s] = (byStage[s] || 0) + 1; });

      const totalPlannedBudget = sum(projects.map(p => vf(p, "Planned Budget")));
      const totalActualCost = sum(projects.map(p => vf(p, "Actual Cost")));
      const totalPlannedHours = sum(projects.map(p => vf(p, "Planned Hours")));
      const totalActualHours = sum(projects.map(p => vf(p, "Actual Hours")));

      const avgQualityScore = avg(projects.filter(p => vf(p, "Quality Score") && vf(p, "Quality Score") !== "N/A").map(p => parseFloat(vf(p, "Quality Score"))));
      const inRecovery = recoveryPlans.filter(r => vf(r, "Status") === "Active").length;
      const openCorrectiveActions = correctiveActions.filter(c => vf(c, "Status") !== "Completed" && vf(c, "Status") !== "Closed").length;
      const overdueCAs = correctiveActions.filter(c => vf(c, "Status") !== "Completed" && vf(c, "Status") !== "Closed" && vf(c, "Due Date") && new Date(vf(c, "Due Date")) < new Date()).length;

      const feedbackScores = feedback.filter(f => vf(f, "Overall Score")).map(f => parseFloat(vf(f, "Overall Score")));
      const avgSatisfaction = avg(feedbackScores);

      const escalations = statuses.filter(s => vf(s, "Escalation Flag") === "Yes").length;

      const overBudget = activeProjects.filter(p => {
        const fc = parseFloat(vf(p, "Forecast Cost")) || 0;
        const pb = parseFloat(vf(p, "Planned Budget")) || 0;
        return pb > 0 && fc > pb * 1.1;
      }).length;

      const pendingTimeApprovals = timeEntries.filter(t => vf(t, "Approval Status") === "Pending").length;
      const totalBillableHours = sum(timeEntries.filter(t => vf(t, "Billable") === "Yes").map(t => vf(t, "Hours")));
      const totalHoursLogged = sum(timeEntries.map(t => vf(t, "Hours")));
      const billablePercent = pct(totalBillableHours, totalHoursLogged);

      const followUpRequired = feedback.filter(f => vf(f, "Follow Up Required") === "Yes" && vf(f, "Follow Up Status") !== "Completed").length;

      jsonResp(res, 200, {
        portfolio: {
          total: projects.length,
          active: activeProjects.length,
          byHealth,
          byStage,
          overBudget,
          inRecovery,
          escalations,
        },
        financial: {
          totalPlannedBudget,
          totalActualCost,
          totalPlannedHours,
          totalActualHours,
          billablePercent,
        },
        quality: {
          avgScore: avgQualityScore,
          openCorrectiveActions,
          overdueCAs,
        },
        satisfaction: {
          avgScore: avgSatisfaction,
          followUpRequired,
        },
        time: {
          pendingApprovals: pendingTimeApprovals,
          totalHoursLogged,
          totalBillableHours,
        },
        customers: {
          total: customers.length,
          byHealth: {
            Green: customers.filter(c => vf(c, "Health") === "Green").length,
            Yellow: customers.filter(c => vf(c, "Health") === "Yellow").length,
            Red: customers.filter(c => vf(c, "Health") === "Red").length,
          },
        },
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/spm/projects/summary — Project portfolio summary ──────
  if (pathname === "/api/spm/projects/summary" && req.method === "GET") {
    try {
      const [projects, milestones, risks, issues] = await Promise.all([
        collect("project"), collect("milestone"), collect("risk"), collect("issue"),
      ]);

      const projectList = projects.map(p => {
        const pid = vf(p, "Project ID");
        const pMilestones = milestones.filter(m => vf(m, "Project ID") === pid);
        const pRisks = risks.filter(r => vf(r, "Project ID") === pid && vf(r, "Status") === "Open");
        const pIssues = issues.filter(i => vf(i, "Project ID") === pid && vf(i, "Status") !== "Resolved" && vf(i, "Status") !== "Closed");
        return {
          id: p.id,
          projectId: pid,
          name: vf(p, "Name"),
          customerName: vf(p, "Customer Name"),
          stage: vf(p, "Stage"),
          health: vf(p, "Health"),
          pm: vf(p, "Project Manager"),
          priority: vf(p, "Priority"),
          plannedEnd: vf(p, "Planned End"),
          plannedBudget: vf(p, "Planned Budget"),
          actualCost: vf(p, "Actual Cost"),
          forecastCost: vf(p, "Forecast Cost"),
          qualityScore: vf(p, "Quality Score"),
          openRisks: pRisks.length,
          openIssues: pIssues.length,
          milestonesTotal: pMilestones.length,
          milestonesComplete: pMilestones.filter(m => vf(m, "Status") === "Completed").length,
        };
      });

      jsonResp(res, 200, { projects: projectList });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/spm/quality/dashboard — Quality dashboard ─────────────
  if (pathname === "/api/spm/quality/dashboard" && req.method === "GET") {
    try {
      const [reviews, findings, actions, audits, recoveryPlans] = await Promise.all([
        collect("quality-review"), collect("quality-finding"),
        collect("corrective-action"), collect("delivery-audit"),
        collect("recovery-plan"),
      ]);

      const gatePassRate = pct(
        reviews.filter(r => vf(r, "Decision") === "Approved" || vf(r, "Decision") === "Milestone Approved").length,
        reviews.length
      );

      const byGateType = {};
      reviews.forEach(r => {
        const gt = vf(r, "Gate Type");
        if (!byGateType[gt]) byGateType[gt] = { total: 0, passed: 0 };
        byGateType[gt].total++;
        if (vf(r, "Decision") === "Approved" || vf(r, "Decision") === "Milestone Approved") byGateType[gt].passed++;
      });

      const findingsByCategory = {};
      findings.forEach(f => {
        const c = vf(f, "Category") || "Other";
        findingsByCategory[c] = (findingsByCategory[c] || 0) + 1;
      });

      const findingsBySeverity = {};
      findings.forEach(f => {
        const s = vf(f, "Severity") || "Unknown";
        findingsBySeverity[s] = (findingsBySeverity[s] || 0) + 1;
      });

      const openActions = actions.filter(a => vf(a, "Status") !== "Completed" && vf(a, "Status") !== "Closed");
      const overdueActions = openActions.filter(a => vf(a, "Due Date") && new Date(vf(a, "Due Date")) < new Date());

      const auditScores = audits.filter(a => vf(a, "Overall Score")).map(a => parseFloat(vf(a, "Overall Score")));
      const avgAuditScore = avg(auditScores);

      const activeRecoveries = recoveryPlans.filter(r => vf(r, "Status") === "Active").length;

      jsonResp(res, 200, {
        gatePassRate,
        byGateType,
        findings: {
          total: findings.length,
          open: findings.filter(f => vf(f, "Status") !== "Resolved" && vf(f, "Status") !== "Closed").length,
          byCategory: findingsByCategory,
          bySeverity: findingsBySeverity,
        },
        correctiveActions: {
          total: actions.length,
          open: openActions.length,
          overdue: overdueActions.length,
          byType: {
            Corrective: actions.filter(a => vf(a, "Type") === "Corrective").length,
            Preventive: actions.filter(a => vf(a, "Type") === "Preventive").length,
          },
        },
        audits: {
          total: audits.length,
          avgScore: avgAuditScore,
        },
        activeRecoveries,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/spm/time/dashboard — Time & utilization dashboard ─────
  if (pathname === "/api/spm/time/dashboard" && req.method === "GET") {
    try {
      const [timeEntries, projects] = await Promise.all([
        collect("time-entry"), collect("project"),
      ]);

      const byConsultant = {};
      const byProject = {};
      timeEntries.forEach(t => {
        const c = vf(t, "Consultant");
        const p = vf(t, "Project ID");
        const h = parseFloat(vf(t, "Hours")) || 0;
        const billable = vf(t, "Billable") === "Yes";
        if (!byConsultant[c]) byConsultant[c] = { total: 0, billable: 0, nonBillable: 0 };
        byConsultant[c].total += h;
        if (billable) byConsultant[c].billable += h; else byConsultant[c].nonBillable += h;
        if (!byProject[p]) byProject[p] = { total: 0, billable: 0 };
        byProject[p].total += h;
        if (billable) byProject[p].billable += h;
      });

      const consultantList = Object.entries(byConsultant).map(([name, data]) => ({
        name,
        totalHours: Math.round(data.total * 10) / 10,
        billableHours: Math.round(data.billable * 10) / 10,
        billablePercent: pct(data.billable, data.total),
      })).sort((a, b) => b.totalHours - a.totalHours);

      const projectTimeList = Object.entries(byProject).map(([pid, data]) => {
        const proj = projects.find(p => vf(p, "Project ID") === pid);
        return {
          projectId: pid,
          projectName: proj ? vf(proj, "Name") : pid,
          totalHours: Math.round(data.total * 10) / 10,
          plannedHours: proj ? parseFloat(vf(proj, "Planned Hours")) || 0 : 0,
          billableHours: Math.round(data.billable * 10) / 10,
        };
      }).sort((a, b) => b.totalHours - a.totalHours);

      const totalHours = sum(timeEntries.map(t => vf(t, "Hours")));
      const billableHours = sum(timeEntries.filter(t => vf(t, "Billable") === "Yes").map(t => vf(t, "Hours")));
      const pendingApprovals = timeEntries.filter(t => vf(t, "Approval Status") === "Pending").length;

      const byCategory = {};
      timeEntries.forEach(t => {
        const c = vf(t, "Work Category") || "Other";
        byCategory[c] = (byCategory[c] || 0) + (parseFloat(vf(t, "Hours")) || 0);
      });

      jsonResp(res, 200, {
        summary: { totalHours: Math.round(totalHours * 10) / 10, billableHours: Math.round(billableHours * 10) / 10, billablePercent: pct(billableHours, totalHours), pendingApprovals },
        byConsultant: consultantList,
        byProject: projectTimeList,
        byCategory,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/spm/cost/dashboard — Cost & margin dashboard ──────────
  if (pathname === "/api/spm/cost/dashboard" && req.method === "GET") {
    try {
      const [projects, costEntries] = await Promise.all([
        collect("project"), collect("cost-entry"),
      ]);

      const projectFinancials = projects.filter(p => !["Archived"].includes(vf(p, "Stage"))).map(p => {
        const pid = vf(p, "Project ID");
        const planned = parseFloat(vf(p, "Planned Budget")) || 0;
        const forecast = parseFloat(vf(p, "Forecast Cost")) || 0;
        const actual = parseFloat(vf(p, "Actual Cost")) || 0;
        const margin = vf(p, "Gross Margin");
        const variance = planned > 0 ? Math.round((forecast - planned) / planned * 100) : 0;
        const burnRate = planned > 0 ? pct(actual, planned) : 0;
        return {
          projectId: pid,
          name: vf(p, "Name"),
          customerName: vf(p, "Customer Name"),
          stage: vf(p, "Stage"),
          plannedBudget: planned,
          forecastCost: forecast,
          actualCost: actual,
          margin,
          variance,
          burnRate,
          overBudget: forecast > planned * 1.05,
        };
      });

      const costByCategory = {};
      costEntries.forEach(c => {
        const cat = vf(c, "Category") || "Other";
        costByCategory[cat] = (costByCategory[cat] || 0) + (parseFloat(vf(c, "Amount")) || 0);
      });

      const totalPlanned = sum(projects.map(p => vf(p, "Planned Budget")));
      const totalForecast = sum(projects.map(p => vf(p, "Forecast Cost")));
      const totalActual = sum(projects.map(p => vf(p, "Actual Cost")));

      jsonResp(res, 200, {
        summary: {
          totalPlanned: Math.round(totalPlanned),
          totalForecast: Math.round(totalForecast),
          totalActual: Math.round(totalActual),
          portfolioVariance: totalPlanned > 0 ? Math.round((totalForecast - totalPlanned) / totalPlanned * 100) : 0,
          overBudgetProjects: projectFinancials.filter(p => p.overBudget).length,
        },
        projects: projectFinancials,
        costByCategory,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/spm/customers/dashboard — Customer dashboard ──────────
  if (pathname === "/api/spm/customers/dashboard" && req.method === "GET") {
    try {
      const [customers, projects, feedback] = await Promise.all([
        collect("customer"), collect("project"), collect("customer-feedback"),
      ]);

      const customerList = customers.map(c => {
        const cid = vf(c, "Account ID");
        const cProjects = projects.filter(p => vf(p, "Customer ID") === cid);
        const activeProjs = cProjects.filter(p => !["Completed", "Closed", "Archived"].includes(vf(p, "Stage")));
        const cFeedback = feedback.filter(f => vf(f, "Customer ID") === cid);
        const scores = cFeedback.filter(f => vf(f, "Overall Score")).map(f => parseFloat(vf(f, "Overall Score")));

        return {
          id: c.id,
          accountId: cid,
          name: vf(c, "Name"),
          industry: vf(c, "Industry"),
          tier: vf(c, "Tier"),
          health: vf(c, "Health"),
          region: vf(c, "Region"),
          accountOwner: vf(c, "Account Owner"),
          totalProjects: cProjects.length,
          activeProjects: activeProjs.length,
          avgSatisfaction: avg(scores),
          feedbackCount: cFeedback.length,
        };
      });

      jsonResp(res, 200, { customers: customerList });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/spm/feedback/dashboard — Feedback dashboard ───────────
  if (pathname === "/api/spm/feedback/dashboard" && req.method === "GET") {
    try {
      const feedback = await collect("customer-feedback");

      const scores = feedback.filter(f => vf(f, "Overall Score")).map(f => parseFloat(vf(f, "Overall Score")));
      const deliveryScores = feedback.filter(f => vf(f, "Delivery Score")).map(f => parseFloat(vf(f, "Delivery Score")));
      const commScores = feedback.filter(f => vf(f, "Communication Score")).map(f => parseFloat(vf(f, "Communication Score")));
      const outcomeScores = feedback.filter(f => vf(f, "Outcome Score")).map(f => parseFloat(vf(f, "Outcome Score")));

      const followUpNeeded = feedback.filter(f => vf(f, "Follow Up Required") === "Yes");
      const followUpPending = followUpNeeded.filter(f => vf(f, "Follow Up Status") !== "Completed");

      const byType = {};
      feedback.forEach(f => { const t = vf(f, "Feedback Type") || "Other"; byType[t] = (byType[t] || 0) + 1; });

      const wouldRecommend = pct(
        feedback.filter(f => vf(f, "Would Recommend") === "Yes").length,
        feedback.length
      );

      jsonResp(res, 200, {
        summary: {
          total: feedback.length,
          avgOverall: avg(scores),
          avgDelivery: avg(deliveryScores),
          avgCommunication: avg(commScores),
          avgOutcome: avg(outcomeScores),
          wouldRecommendPct: wouldRecommend,
        },
        followUp: {
          total: followUpNeeded.length,
          pending: followUpPending.length,
        },
        byType,
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/spm/closeout/dashboard — Closeout dashboard ───────────
  if (pathname === "/api/spm/closeout/dashboard" && req.method === "GET") {
    try {
      const [closeouts, reviews, lessons, projects] = await Promise.all([
        collect("closeout-record"), collect("post-project-review"),
        collect("lessons-learned"), collect("project"),
      ]);

      const readyForCloseout = projects.filter(p => vf(p, "Stage") === "Ready for Closeout" || vf(p, "Stage") === "Completed").length;
      const inProgress = closeouts.filter(c => vf(c, "Status") === "In Progress").length;
      const complete = closeouts.filter(c => vf(c, "Status") === "Complete").length;

      const lessonsByCategory = {};
      lessons.forEach(l => { const c = vf(l, "Category") || "Other"; lessonsByCategory[c] = (lessonsByCategory[c] || 0) + 1; });
      const lessonsByTheme = {};
      lessons.forEach(l => { const t = vf(l, "Theme") || "Other"; lessonsByTheme[t] = (lessonsByTheme[t] || 0) + 1; });

      jsonResp(res, 200, {
        closeout: { readyForCloseout, inProgress, complete, total: closeouts.length },
        reviews: { total: reviews.length, completed: reviews.filter(r => vf(r, "Status") === "Completed").length },
        lessons: { total: lessons.length, byCategory: lessonsByCategory, byTheme: lessonsByTheme },
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/spm/reports/pm — PM-level summary ─────────────────────
  if (pathname === "/api/spm/reports/pm" && req.method === "GET") {
    try {
      const [projects, statuses, milestones, risks, issues, actions] = await Promise.all([
        collect("project"), collect("status-update"), collect("milestone"),
        collect("risk"), collect("issue"), collect("corrective-action"),
      ]);

      const pms = [...new Set(projects.map(p => vf(p, "Project Manager")).filter(Boolean))];
      const pmSummary = pms.map(pm => {
        const pmProjects = projects.filter(p => vf(p, "Project Manager") === pm);
        const active = pmProjects.filter(p => !["Completed", "Closed", "Archived"].includes(vf(p, "Stage")));
        const redYellow = active.filter(p => vf(p, "Health") === "Red" || vf(p, "Health") === "Yellow");
        const pmOpenRisks = risks.filter(r => {
          const pid = vf(r, "Project ID");
          return pmProjects.some(p => vf(p, "Project ID") === pid) && vf(r, "Status") === "Open";
        });
        const pmOpenIssues = issues.filter(i => {
          const pid = vf(i, "Project ID");
          return pmProjects.some(p => vf(p, "Project ID") === pid) && (vf(i, "Status") !== "Resolved" && vf(i, "Status") !== "Closed");
        });

        return {
          pm,
          totalProjects: pmProjects.length,
          activeProjects: active.length,
          atRisk: redYellow.length,
          openRisks: pmOpenRisks.length,
          openIssues: pmOpenIssues.length,
          avgQuality: avg(pmProjects.filter(p => vf(p, "Quality Score") && vf(p, "Quality Score") !== "N/A").map(p => parseFloat(vf(p, "Quality Score")))),
        };
      });

      jsonResp(res, 200, { pmSummary });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
