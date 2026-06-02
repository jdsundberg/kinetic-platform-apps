/**
 * ServicePro — Custom API Handler
 * Server-side aggregation for dashboards, project detail, customer 360, and reports.
 */

export const appId = "service-pro";
export const apiPrefix = "/api/servicepro";
export const kapp = "service-pro";

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  const KAPP = kapp;

  async function collect(formSlug, kql, maxPages = 4) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  // GET /api/servicepro/dashboard — Executive KPIs
  if (pathname === "/api/servicepro/dashboard" && req.method === "GET") {
    try {
      const [projects, customers, timeEntries, costs, feedback, risksIssues, milestones, checkouts] = await Promise.all([
        collect("projects"), collect("customers"), collect("time-entries"),
        collect("costs"), collect("feedback"), collect("risks-issues"),
        collect("milestones"), collect("checkouts")
      ]);

      const active = projects.filter(p => ["In Progress", "Planning", "Approved"].includes(vf(p, "Status")));
      const atRisk = projects.filter(p => vf(p, "Health") === "Red" || vf(p, "Health") === "Yellow");
      const completed = projects.filter(p => vf(p, "Status") === "Completed");

      const totalBudget = projects.reduce((s, p) => s + (parseFloat(vf(p, "Budget")) || 0), 0);
      const totalActual = projects.reduce((s, p) => s + (parseFloat(vf(p, "Actual Cost")) || 0), 0);
      const totalForecast = projects.reduce((s, p) => s + (parseFloat(vf(p, "Forecast Cost")) || 0), 0);
      const totalPlannedHrs = projects.reduce((s, p) => s + (parseFloat(vf(p, "Planned Hours")) || 0), 0);
      const totalActualHrs = projects.reduce((s, p) => s + (parseFloat(vf(p, "Actual Hours")) || 0), 0);

      const pendingCosts = costs.filter(c => vf(c, "Status") === "Pending").reduce((s, c) => s + (parseFloat(vf(c, "Amount")) || 0), 0);
      const avgRating = feedback.length ? feedback.reduce((s, f) => s + (parseFloat(vf(f, "Overall Rating")) || 0), 0) / feedback.length : 0;
      const openRisks = risksIssues.filter(r => vf(r, "Status") === "Open").length;
      const escalated = risksIssues.filter(r => vf(r, "Escalated") === "Yes" && vf(r, "Status") === "Open").length;

      // Health distribution
      const healthDist = { Green: 0, Yellow: 0, Red: 0 };
      active.forEach(p => { const h = vf(p, "Health"); if (healthDist[h] !== undefined) healthDist[h]++; });

      // Phase distribution
      const phaseDist = {};
      projects.forEach(p => { const ph = vf(p, "Phase") || "Unknown"; phaseDist[ph] = (phaseDist[ph] || 0) + 1; });

      // Overdue milestones
      const today = new Date().toISOString().slice(0, 10);
      const overdueMilestones = milestones.filter(m => {
        const planned = vf(m, "Planned Date");
        const status = vf(m, "Status");
        return planned && planned < today && status !== "Completed";
      });

      // Checkout compliance
      const completedNeedCheckout = completed.length;
      const checkoutsCompleted = checkouts.filter(c => vf(c, "Status") === "Completed").length;

      // Projects needing status update this week
      const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

      // Utilization by employee
      const empHours = {};
      timeEntries.forEach(t => {
        const emp = vf(t, "Employee");
        if (!empHours[emp]) empHours[emp] = { total: 0, billable: 0 };
        const hrs = parseFloat(vf(t, "Hours")) || 0;
        empHours[emp].total += hrs;
        if (vf(t, "Billable") === "Yes") empHours[emp].billable += hrs;
      });

      jsonResp(res, 200, {
        kpis: {
          activeProjects: active.length, completedProjects: completed.length,
          atRiskProjects: atRisk.length, totalProjects: projects.length,
          totalBudget, totalActual, totalForecast, portfolioMargin: totalBudget > 0 ? Math.round((1 - totalForecast / totalBudget) * 100) : 0,
          totalPlannedHrs, totalActualHrs,
          activeCustomers: customers.filter(c => vf(c, "Status") === "Active").length,
          pendingCosts, avgRating: Math.round(avgRating * 10) / 10,
          openRisks, escalated, overdueMilestones: overdueMilestones.length,
          checkoutCompliance: completedNeedCheckout > 0 ? Math.round(checkoutsCompleted / completedNeedCheckout * 100) : 100
        },
        healthDist, phaseDist,
        atRiskProjects: atRisk.map(p => ({
          id: p.id, name: vf(p, "Project Name"), customer: vf(p, "Customer"),
          health: vf(p, "Health"), status: vf(p, "Status"), pm: vf(p, "Project Manager"),
          budgetHealth: vf(p, "Budget Health"), scheduleHealth: vf(p, "Schedule Health"),
          budget: vf(p, "Budget"), forecast: vf(p, "Forecast Cost"), actual: vf(p, "Actual Cost")
        })),
        activeProjects: active.map(p => ({
          id: p.id, name: vf(p, "Project Name"), customer: vf(p, "Customer"),
          health: vf(p, "Health"), status: vf(p, "Status"), phase: vf(p, "Phase"),
          pm: vf(p, "Project Manager"), budget: vf(p, "Budget"), actual: vf(p, "Actual Cost"),
          plannedHrs: vf(p, "Planned Hours"), actualHrs: vf(p, "Actual Hours"),
          endDate: vf(p, "Target End Date"), priority: vf(p, "Priority")
        })),
        overdueMilestones: overdueMilestones.map(m => ({
          project: vf(m, "Project"), name: vf(m, "Milestone Name"),
          planned: vf(m, "Planned Date"), owner: vf(m, "Owner"), status: vf(m, "Status")
        })),
        recentFeedback: feedback.slice(0, 5).map(f => ({
          customer: vf(f, "Customer"), project: vf(f, "Project"),
          rating: vf(f, "Overall Rating"), type: vf(f, "Type"),
          nps: vf(f, "NPS"), followUp: vf(f, "Follow Up Required")
        })),
        utilization: empHours
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/servicepro/project/:id — Project detail with all related data
  const projMatch = pathname.match(/^\/api\/servicepro\/project\/(.+)$/);
  if (projMatch && req.method === "GET") {
    const projId = decodeURIComponent(projMatch[1]);
    try {
      const projRes = await kineticRequest("GET", `/submissions/${projId}?include=values`, null, auth);
      const proj = projRes.data?.submission;
      if (!proj) { jsonResp(res, 404, { error: "Project not found" }); return true; }
      const projName = vf(proj, "Project Name");

      const [milestones, risks, time, costs, status, team, deliverables, feedback] = await Promise.all([
        collect("milestones", `values[Project]="${projName}"`),
        collect("risks-issues", `values[Project]="${projName}"`),
        collect("time-entries", `values[Project]="${projName}"`),
        collect("costs", `values[Project]="${projName}"`),
        collect("status-updates", `values[Project]="${projName}"`),
        collect("team-assignments", `values[Project]="${projName}"`),
        collect("deliverables", `values[Project]="${projName}"`),
        collect("feedback", `values[Project]="${projName}"`)
      ]);

      const totalTime = time.reduce((s, t) => s + (parseFloat(vf(t, "Hours")) || 0), 0);
      const billableTime = time.filter(t => vf(t, "Billable") === "Yes").reduce((s, t) => s + (parseFloat(vf(t, "Hours")) || 0), 0);
      const totalCosts = costs.reduce((s, c) => s + (parseFloat(vf(c, "Amount")) || 0), 0);
      const approvedCosts = costs.filter(c => vf(c, "Status") === "Approved").reduce((s, c) => s + (parseFloat(vf(c, "Amount")) || 0), 0);

      jsonResp(res, 200, {
        project: proj,
        milestones: milestones.map(m => ({ id: m.id, name: vf(m, "Milestone Name"), planned: vf(m, "Planned Date"), actual: vf(m, "Actual Date"), status: vf(m, "Status"), owner: vf(m, "Owner"), delay: vf(m, "Delay Reason") })),
        risks: risks.map(r => ({ id: r.id, type: vf(r, "Type"), title: vf(r, "Title"), severity: vf(r, "Severity"), status: vf(r, "Status"), owner: vf(r, "Owner"), escalated: vf(r, "Escalated") })),
        statusUpdates: status.map(s => ({ id: s.id, week: vf(s, "Week"), health: vf(s, "Overall Health"), schedule: vf(s, "Schedule Health"), budget: vf(s, "Budget Health"), scope: vf(s, "Scope Health"), accomplishments: vf(s, "Accomplishments"), blockers: vf(s, "Blockers"), execAttention: vf(s, "Exec Attention") })),
        team: team.map(t => ({ employee: vf(t, "Employee"), role: vf(t, "Role"), allocation: vf(t, "Allocation"), rate: vf(t, "Hourly Rate"), status: vf(t, "Status") })),
        deliverables: deliverables.map(d => ({ id: d.id, name: vf(d, "Deliverable Name"), due: vf(d, "Due Date"), owner: vf(d, "Owner"), status: vf(d, "Status"), ack: vf(d, "Customer Acknowledged") })),
        feedback: feedback.map(f => ({ customer: vf(f, "Customer"), rating: vf(f, "Overall Rating"), type: vf(f, "Type"), comments: vf(f, "Comments"), date: vf(f, "Date") })),
        summary: { totalTime, billableTime, billablePct: totalTime > 0 ? Math.round(billableTime / totalTime * 100) : 0, totalCosts, approvedCosts, openRisks: risks.filter(r => vf(r, "Status") === "Open").length, openIssues: risks.filter(r => vf(r, "Type") === "Issue" && vf(r, "Status") === "Open").length, completedMilestones: milestones.filter(m => vf(m, "Status") === "Completed").length, totalMilestones: milestones.length }
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/servicepro/customer/:name — Customer 360
  const custMatch = pathname.match(/^\/api\/servicepro\/customer\/(.+)$/);
  if (custMatch && req.method === "GET") {
    const custName = decodeURIComponent(custMatch[1]);
    try {
      const [customers, projects, contacts, feedback] = await Promise.all([
        collect("customers", `values[Company Name]="${custName}"`),
        collect("projects", `values[Customer]="${custName}"`),
        collect("contacts", `values[Customer]="${custName}"`),
        collect("feedback", `values[Customer]="${custName}"`)
      ]);

      const cust = customers[0] || { values: {} };
      const totalRevenue = projects.reduce((s, p) => s + (parseFloat(vf(p, "Budget")) || 0), 0);
      const totalActual = projects.reduce((s, p) => s + (parseFloat(vf(p, "Actual Cost")) || 0), 0);
      const avgRating = feedback.length ? feedback.reduce((s, f) => s + (parseFloat(vf(f, "Overall Rating")) || 0), 0) / feedback.length : 0;

      jsonResp(res, 200, {
        customer: cust,
        projects: projects.map(p => ({ id: p.id, name: vf(p, "Project Name"), status: vf(p, "Status"), health: vf(p, "Health"), phase: vf(p, "Phase"), budget: vf(p, "Budget"), actual: vf(p, "Actual Cost"), pm: vf(p, "Project Manager") })),
        contacts: contacts.map(c => ({ name: vf(c, "Full Name"), title: vf(c, "Title"), email: vf(c, "Email"), phone: vf(c, "Phone"), role: vf(c, "Role"), primary: vf(c, "Primary") })),
        feedback: feedback.map(f => ({ project: vf(f, "Project"), rating: vf(f, "Overall Rating"), type: vf(f, "Type"), nps: vf(f, "NPS"), comments: vf(f, "Comments"), date: vf(f, "Date") })),
        summary: { totalRevenue, totalActual, avgRating: Math.round(avgRating * 10) / 10, activeProjects: projects.filter(p => ["In Progress", "Planning", "Approved"].includes(vf(p, "Status"))).length, completedProjects: projects.filter(p => vf(p, "Status") === "Completed").length, totalProjects: projects.length }
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/servicepro/reports/profitability — Project profitability report
  if (pathname === "/api/servicepro/reports/profitability" && req.method === "GET") {
    try {
      const projects = await collect("projects");
      const report = projects.map(p => {
        const budget = parseFloat(vf(p, "Budget")) || 0;
        const forecast = parseFloat(vf(p, "Forecast Cost")) || 0;
        const actual = parseFloat(vf(p, "Actual Cost")) || 0;
        const margin = budget > 0 ? Math.round((budget - forecast) / budget * 100) : 0;
        return { name: vf(p, "Project Name"), customer: vf(p, "Customer"), status: vf(p, "Status"), budget, forecast, actual, margin, health: vf(p, "Health"), pm: vf(p, "Project Manager") };
      }).sort((a, b) => a.margin - b.margin);
      jsonResp(res, 200, { projects: report });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // GET /api/servicepro/reports/utilization — Team utilization report
  if (pathname === "/api/servicepro/reports/utilization" && req.method === "GET") {
    try {
      const [time, assignments] = await Promise.all([collect("time-entries"), collect("team-assignments")]);
      const empData = {};
      time.forEach(t => {
        const emp = vf(t, "Employee");
        if (!empData[emp]) empData[emp] = { total: 0, billable: 0, projects: new Set(), byCategory: {} };
        const hrs = parseFloat(vf(t, "Hours")) || 0;
        empData[emp].total += hrs;
        if (vf(t, "Billable") === "Yes") empData[emp].billable += hrs;
        empData[emp].projects.add(vf(t, "Project"));
        const cat = vf(t, "Category") || "Other";
        empData[emp].byCategory[cat] = (empData[emp].byCategory[cat] || 0) + hrs;
      });
      const report = Object.entries(empData).map(([emp, d]) => ({
        employee: emp, totalHours: d.total, billableHours: d.billable,
        billablePct: d.total > 0 ? Math.round(d.billable / d.total * 100) : 0,
        projectCount: d.projects.size, byCategory: d.byCategory
      })).sort((a, b) => b.totalHours - a.totalHours);
      jsonResp(res, 200, { employees: report });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
