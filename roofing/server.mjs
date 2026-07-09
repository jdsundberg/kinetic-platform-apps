/**
 * Summit Ridge Roofing — Custom API Handler
 * Server-side aggregation for the dashboard, job 360, financials and marketing reports.
 * Small Twin Cities roof-replacement crew.
 */

export const appId = "roofing";
export const apiPrefix = "/api/roofing";
export const kapp = "roofing";

const num = (v) => parseFloat(v) || 0;

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, vf } = helpers;
  const KAPP = kapp;

  // collectByQuery needs kapp as first arg — always go through this shorthand
  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  const ACTIVE = ["Sold", "Scheduled", "In Progress"];
  const OPEN_LEAD = ["New", "Contacted", "Inspection Scheduled", "Estimate Sent"];

  // ── GET /api/roofing/dashboard ────────────────────────────────────────
  if (pathname === "/api/roofing/dashboard" && req.method === "GET") {
    try {
      const [projects, materials, invoices, feedback, leads, campaigns, crew] = await Promise.all([
        collect("projects"), collect("materials"), collect("invoices"),
        collect("feedback"), collect("leads"), collect("campaigns"), collect("crew"),
      ]);

      const active = projects.filter(p => ACTIVE.includes(vf(p, "Status")));
      const inProgress = projects.filter(p => vf(p, "Status") === "In Progress");
      const completed = projects.filter(p => ["Completed", "Warranty"].includes(vf(p, "Status")));
      const atRisk = projects.filter(p => vf(p, "Health") === "Red" && !["Cancelled", "Completed", "Warranty"].includes(vf(p, "Status")));

      const activeValue = active.reduce((s, p) => s + num(vf(p, "Contract Value")), 0);
      const backlogValue = active.concat(completed).reduce((s, p) => s + num(vf(p, "Contract Value")), 0);
      const sqInstalled = completed.reduce((s, p) => s + num(vf(p, "Roof Squares")), 0);

      // Cash
      const invoiced = invoices.reduce((s, i) => s + num(vf(i, "Amount")), 0);
      const paid = invoices.filter(i => vf(i, "Status") === "Paid").reduce((s, i) => s + num(vf(i, "Amount")), 0);
      const outstanding = invoices.filter(i => ["Sent", "Partial", "Overdue"].includes(vf(i, "Status"))).reduce((s, i) => s + num(vf(i, "Amount")), 0);
      const overdue = invoices.filter(i => vf(i, "Status") === "Overdue").reduce((s, i) => s + num(vf(i, "Amount")), 0);

      // Materials
      const materialCost = materials.reduce((s, m) => s + num(vf(m, "Total Cost")), 0);
      const backordered = materials.filter(m => vf(m, "Status") === "Backordered").length;
      const toOrder = materials.filter(m => vf(m, "Status") === "Needed").length;

      // Leads / pipeline
      const openLeads = leads.filter(l => OPEN_LEAD.includes(vf(l, "Status")));
      const leadPipeline = openLeads.reduce((s, l) => s + num(vf(l, "Estimated Value")), 0);
      const won = leads.filter(l => vf(l, "Status") === "Won").length;
      const lost = leads.filter(l => vf(l, "Status") === "Lost").length;
      const winRate = (won + lost) ? Math.round(won / (won + lost) * 100) : 0;

      // Marketing spend
      const mktSpend = campaigns.reduce((s, c) => s + num(vf(c, "Spend")), 0);
      const mktLeads = campaigns.reduce((s, c) => s + num(vf(c, "Leads Generated")), 0);
      const cpl = mktLeads ? Math.round(mktSpend / mktLeads) : 0;
      const mktRevenue = campaigns.reduce((s, c) => s + num(vf(c, "Revenue")), 0);
      const roas = mktSpend ? Math.round(mktRevenue / mktSpend * 10) / 10 : 0;

      // Feedback
      const rated = feedback.filter(f => num(vf(f, "Rating")) > 0);
      const avgRating = rated.length ? Math.round(rated.reduce((s, f) => s + num(vf(f, "Rating")), 0) / rated.length * 10) / 10 : 0;
      const recYes = feedback.filter(f => vf(f, "Would Recommend") === "Yes").length;
      const recPct = feedback.length ? Math.round(recYes / feedback.length * 100) : 0;
      const followUp = feedback.filter(f => vf(f, "Status") === "Follow Up Needed").length;

      // Distributions
      const byRoofType = {};
      projects.forEach(p => { const t = vf(p, "Roof Type") || "Other"; byRoofType[t] = (byRoofType[t] || 0) + num(vf(p, "Contract Value")); });
      const leadsBySource = {};
      leads.forEach(l => { const s = vf(l, "Source") || "Other"; leadsBySource[s] = (leadsBySource[s] || 0) + 1; });

      jsonResp(res, 200, {
        kpis: {
          activeJobs: active.length, inProgress: inProgress.length, completed: completed.length,
          atRisk: atRisk.length, activeCrew: crew.filter(c => vf(c, "Status") === "Active").length,
          activeValue, backlogValue, sqInstalled,
          invoiced, paid, outstanding, overdue,
          materialCost, backordered, toOrder,
          openLeads: openLeads.length, leadPipeline, won, lost, winRate,
          mktSpend, mktLeads, cpl, roas,
          avgRating, recPct, ratedCount: rated.length, followUp,
        },
        byRoofType, leadsBySource,
        healthDist: {
          Green: projects.filter(p => vf(p, "Health") === "Green").length,
          Yellow: projects.filter(p => vf(p, "Health") === "Yellow").length,
          Red: projects.filter(p => vf(p, "Health") === "Red").length,
        },
        activeJobs: active
          .sort((a, b) => num(vf(b, "Contract Value")) - num(vf(a, "Contract Value")))
          .slice(0, 12)
          .map(p => ({
            id: p.id, name: vf(p, "Project Name"), customer: vf(p, "Customer Name"),
            city: vf(p, "City"), roof: vf(p, "Roof Type"), status: vf(p, "Status"),
            health: vf(p, "Health"), value: vf(p, "Contract Value"), crew: vf(p, "Crew Lead"),
            end: vf(p, "Target End Date"),
          })),
        atRiskJobs: atRisk.map(p => ({
          id: p.id, name: vf(p, "Project Name"), customer: vf(p, "Customer Name"),
          status: vf(p, "Status"), crew: vf(p, "Crew Lead"), value: vf(p, "Contract Value"),
        })),
        recentFeedback: rated
          .sort((a, b) => String(vf(b, "Date")).localeCompare(String(vf(a, "Date"))))
          .slice(0, 8)
          .map(f => ({
            customer: vf(f, "Customer Name"), project: vf(f, "Project"), rating: vf(f, "Rating"),
            source: vf(f, "Review Source"), recommend: vf(f, "Would Recommend"),
            comments: vf(f, "Comments"), date: vf(f, "Date"),
          })),
        overdueInvoices: invoices.filter(i => vf(i, "Status") === "Overdue").map(i => ({
          number: vf(i, "Invoice Number"), project: vf(i, "Project"), customer: vf(i, "Customer Name"),
          amount: vf(i, "Amount"), due: vf(i, "Due Date"),
        })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/roofing/project/:id — Job 360 ────────────────────────────
  const pm = pathname.match(/^\/api\/roofing\/project\/(.+)$/);
  if (pm && req.method === "GET") {
    const id = decodeURIComponent(pm[1]);
    try {
      const pr = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const proj = pr.data?.submission;
      if (!proj) { jsonResp(res, 404, { error: "Job not found" }); return true; }
      const name = vf(proj, "Project Name");
      const q = `values[Project]="${name.replace(/"/g, '\\"')}"`;

      const [materials, invoices, feedback] = await Promise.all([
        collect("materials", q), collect("invoices", q), collect("feedback", q),
      ]);

      const contract = num(vf(proj, "Contract Value"));
      const matCost = materials.reduce((s, m) => s + num(vf(m, "Total Cost")), 0);
      const invoiced = invoices.reduce((s, i) => s + num(vf(i, "Amount")), 0);
      const paid = invoices.filter(i => vf(i, "Status") === "Paid").reduce((s, i) => s + num(vf(i, "Amount")), 0);

      jsonResp(res, 200, {
        project: proj,
        materials: materials.map(s => ({ id: s.id, item: vf(s, "Item"), category: vf(s, "Category"), supplier: vf(s, "Supplier"), qty: vf(s, "Quantity"), unit: vf(s, "Unit"), total: vf(s, "Total Cost"), status: vf(s, "Status") })),
        invoices: invoices.map(s => ({ id: s.id, number: vf(s, "Invoice Number"), amount: vf(s, "Amount"), type: vf(s, "Type"), status: vf(s, "Status"), issue: vf(s, "Issue Date"), due: vf(s, "Due Date"), paid: vf(s, "Paid Date") })),
        feedback: feedback.map(s => ({ id: s.id, customer: vf(s, "Customer Name"), rating: vf(s, "Rating"), source: vf(s, "Review Source"), recommend: vf(s, "Would Recommend"), comments: vf(s, "Comments"), date: vf(s, "Date") })),
        summary: {
          contract, matCost, invoiced, paid, outstanding: invoiced - paid,
          grossMargin: contract > 0 ? Math.round((contract - matCost) / contract * 100) : 0,
          collectedPct: contract > 0 ? Math.round(paid / contract * 100) : 0,
        },
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/roofing/reports/financials ───────────────────────────────
  if (pathname === "/api/roofing/reports/financials" && req.method === "GET") {
    try {
      const [projects, materials, invoices] = await Promise.all([
        collect("projects"), collect("materials"), collect("invoices"),
      ]);
      const sumBy = (rows, key, amtField) => {
        const m = {};
        rows.forEach(r => { const k = vf(r, key); if (!k) return; m[k] = (m[k] || 0) + num(vf(r, amtField)); });
        return m;
      };
      const matByProj = sumBy(materials, "Project", "Total Cost");
      const invByProj = sumBy(invoices, "Project", "Amount");
      const paidByProj = (() => {
        const m = {};
        invoices.filter(i => vf(i, "Status") === "Paid").forEach(i => { const k = vf(i, "Project"); m[k] = (m[k] || 0) + num(vf(i, "Amount")); });
        return m;
      })();

      const rows = projects
        .filter(p => !["Lead", "Estimating", "Cancelled"].includes(vf(p, "Status")))
        .map(p => {
          const name = vf(p, "Project Name");
          const contract = num(vf(p, "Contract Value"));
          const cost = matByProj[name] || 0;
          const margin = contract > 0 ? Math.round((contract - cost) / contract * 100) : 0;
          return {
            name, customer: vf(p, "Customer Name"), roof: vf(p, "Roof Type"), status: vf(p, "Status"),
            squares: vf(p, "Roof Squares"), contract, cost, margin,
            invoiced: invByProj[name] || 0, paid: paidByProj[name] || 0,
            outstanding: (invByProj[name] || 0) - (paidByProj[name] || 0),
          };
        })
        .sort((a, b) => a.margin - b.margin);
      jsonResp(res, 200, { projects: rows });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/roofing/reports/marketing ────────────────────────────────
  if (pathname === "/api/roofing/reports/marketing" && req.method === "GET") {
    try {
      const [leads, campaigns, feedback] = await Promise.all([
        collect("leads"), collect("campaigns"), collect("feedback"),
      ]);

      // Funnel by lead source
      const bySource = {};
      leads.forEach(l => {
        const s = vf(l, "Source") || "Other";
        if (!bySource[s]) bySource[s] = { source: s, total: 0, won: 0, lost: 0, open: 0, value: 0 };
        bySource[s].total++;
        bySource[s].value += num(vf(l, "Estimated Value"));
        const st = vf(l, "Status");
        if (st === "Won") bySource[s].won++;
        else if (st === "Lost") bySource[s].lost++;
        else bySource[s].open++;
      });
      const sources = Object.values(bySource).map(s => ({
        ...s, conversion: (s.won + s.lost) ? Math.round(s.won / (s.won + s.lost) * 100) : 0,
      })).sort((a, b) => b.total - a.total);

      // Campaign ROI
      const camps = campaigns.map(c => {
        const spend = num(vf(c, "Spend")), budget = num(vf(c, "Budget"));
        const cleads = num(vf(c, "Leads Generated")), jobs = num(vf(c, "Jobs Won"));
        const revenue = num(vf(c, "Revenue"));
        return {
          name: vf(c, "Campaign Name"), channel: vf(c, "Channel"), status: vf(c, "Status"),
          owner: vf(c, "Owner"), budget, spend, leads: cleads, jobs, revenue,
          cpl: cleads ? Math.round(spend / cleads) : 0,
          roas: spend ? Math.round(revenue / spend * 10) / 10 : 0,
        };
      }).sort((a, b) => b.roas - a.roas);

      // Feedback summary
      const rated = feedback.filter(f => num(vf(f, "Rating")) > 0);
      const avgRating = rated.length ? Math.round(rated.reduce((s, f) => s + num(vf(f, "Rating")), 0) / rated.length * 10) / 10 : 0;
      const fbBySource = {};
      feedback.forEach(f => {
        const s = vf(f, "Review Source") || "Other";
        if (!fbBySource[s]) fbBySource[s] = { source: s, count: 0, ratingSum: 0, recommend: 0 };
        fbBySource[s].count++;
        fbBySource[s].ratingSum += num(vf(f, "Rating"));
        if (vf(f, "Would Recommend") === "Yes") fbBySource[s].recommend++;
      });
      const fbSources = Object.values(fbBySource).map(s => ({
        source: s.source, count: s.count,
        avg: s.count ? Math.round(s.ratingSum / s.count * 10) / 10 : 0,
        recPct: s.count ? Math.round(s.recommend / s.count * 100) : 0,
      })).sort((a, b) => b.count - a.count);

      const totals = {
        spend: camps.reduce((s, c) => s + c.spend, 0),
        budget: camps.reduce((s, c) => s + c.budget, 0),
        leads: camps.reduce((s, c) => s + c.leads, 0),
        jobs: camps.reduce((s, c) => s + c.jobs, 0),
        revenue: camps.reduce((s, c) => s + c.revenue, 0),
      };
      totals.cpl = totals.leads ? Math.round(totals.spend / totals.leads) : 0;
      totals.roas = totals.spend ? Math.round(totals.revenue / totals.spend * 10) / 10 : 0;

      jsonResp(res, 200, { sources, campaigns: camps, totals, avgRating, fbSources, ratedCount: rated.length });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
