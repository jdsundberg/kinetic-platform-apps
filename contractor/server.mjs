/**
 * Northstar Contracting — Custom API Handler
 * Server-side aggregation for the dashboard, project 360, and reports.
 * Twin Cities home-improvement contractor management.
 */

export const appId = "contractor";
export const apiPrefix = "/api/contractor";
export const kapp = "contractor";

const num = (v) => parseFloat(v) || 0;

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, vf } = helpers;
  const KAPP = kapp;

  // ALWAYS use this shorthand — collectByQuery needs kapp as first arg
  async function collect(formSlug, kql, maxPages = 6) {
    return collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  }

  const ACTIVE = ["Quoted", "Scheduled", "In Progress", "On Hold"];

  // ── GET /api/contractor/dashboard ─────────────────────────────────────
  if (pathname === "/api/contractor/dashboard" && req.method === "GET") {
    try {
      const [projects, quotes, schedules, employees, permits, materials, invoices, receipts] = await Promise.all([
        collect("projects"), collect("quotes"), collect("schedules"), collect("employees"),
        collect("permits"), collect("materials"), collect("invoices"), collect("receipts"),
      ]);

      const active = projects.filter(p => ACTIVE.includes(vf(p, "Status")));
      const inProgress = projects.filter(p => vf(p, "Status") === "In Progress");
      const completed = projects.filter(p => vf(p, "Status") === "Completed");
      const leads = projects.filter(p => vf(p, "Status") === "Lead");
      const atRisk = projects.filter(p => vf(p, "Health") === "Red" && vf(p, "Status") !== "Cancelled" && vf(p, "Status") !== "Completed");

      const backlogValue = active.concat(completed).reduce((s, p) => s + num(vf(p, "Contract Value")), 0);
      const activeValue = active.reduce((s, p) => s + num(vf(p, "Contract Value")), 0);

      // Invoicing / cash
      const invoiced = invoices.reduce((s, i) => s + num(vf(i, "Amount")), 0);
      const paid = invoices.filter(i => vf(i, "Status") === "Paid").reduce((s, i) => s + num(vf(i, "Amount")), 0);
      const outstanding = invoices.filter(i => ["Sent", "Partial", "Overdue"].includes(vf(i, "Status"))).reduce((s, i) => s + num(vf(i, "Amount")), 0);
      const overdue = invoices.filter(i => vf(i, "Status") === "Overdue").reduce((s, i) => s + num(vf(i, "Amount")), 0);

      // Costs
      const materialCost = materials.reduce((s, m) => s + num(vf(m, "Total Cost")), 0);
      const receiptCost = receipts.reduce((s, r) => s + num(vf(r, "Amount")), 0);
      const reimbursable = receipts.filter(r => vf(r, "Reimbursable") === "Yes").reduce((s, r) => s + num(vf(r, "Amount")), 0);

      // Permits
      const permitsPending = permits.filter(p => ["Applied", "Inspection Scheduled"].includes(vf(p, "Status"))).length;
      const permitsIssued = permits.filter(p => ["Issued", "Approved"].includes(vf(p, "Status"))).length;

      // Quotes pipeline
      const quotesOpen = quotes.filter(q => ["Draft", "Sent"].includes(vf(q, "Status")));
      const quotePipeline = quotesOpen.reduce((s, q) => s + num(vf(q, "Total Amount")), 0);
      const quotesAccepted = quotes.filter(q => vf(q, "Status") === "Accepted").length;
      const winRate = (() => {
        const decided = quotes.filter(q => ["Accepted", "Rejected"].includes(vf(q, "Status"))).length;
        return decided ? Math.round(quotesAccepted / decided * 100) : 0;
      })();

      // Schedule
      const today = new Date().toISOString().slice(0, 10);
      const delayed = schedules.filter(s => vf(s, "Status") === "Delayed").length;
      const activePhases = schedules.filter(s => vf(s, "Status") === "In Progress");

      // Materials needing attention
      const backordered = materials.filter(m => vf(m, "Status") === "Backordered").length;
      const toOrder = materials.filter(m => vf(m, "Status") === "Needed").length;

      // Type distribution (by value)
      const byType = {};
      projects.forEach(p => { const t = vf(p, "Project Type") || "Other"; byType[t] = (byType[t] || 0) + num(vf(p, "Contract Value")); });

      // Materials by category (cost)
      const matByCat = {};
      materials.forEach(m => { const c = vf(m, "Category") || "Other"; matByCat[c] = (matByCat[c] || 0) + num(vf(m, "Total Cost")); });

      jsonResp(res, 200, {
        kpis: {
          activeProjects: active.length, inProgress: inProgress.length, completed: completed.length,
          leads: leads.length, atRisk: atRisk.length,
          activeCrew: employees.filter(e => vf(e, "Status") === "Active").length,
          activeValue, backlogValue,
          invoiced, paid, outstanding, overdue,
          materialCost, receiptCost, reimbursable,
          permitsPending, permitsIssued,
          quotePipeline, winRate, openQuotes: quotesOpen.length,
          delayedPhases: delayed, activePhases: activePhases.length, backordered, toOrder,
        },
        byType, matByCat,
        healthDist: {
          Green: projects.filter(p => vf(p, "Health") === "Green").length,
          Yellow: projects.filter(p => vf(p, "Health") === "Yellow").length,
          Red: projects.filter(p => vf(p, "Health") === "Red").length,
        },
        activeProjects: active
          .sort((a, b) => num(vf(b, "Contract Value")) - num(vf(a, "Contract Value")))
          .slice(0, 12)
          .map(p => ({
            id: p.id, name: vf(p, "Project Name"), client: vf(p, "Client Name"),
            city: vf(p, "City"), type: vf(p, "Project Type"), status: vf(p, "Status"),
            health: vf(p, "Health"), value: vf(p, "Contract Value"), pm: vf(p, "Project Manager"),
            end: vf(p, "Target End Date"),
          })),
        atRiskProjects: atRisk.map(p => ({
          id: p.id, name: vf(p, "Project Name"), client: vf(p, "Client Name"),
          status: vf(p, "Status"), pm: vf(p, "Project Manager"), value: vf(p, "Contract Value"),
        })),
        activePhasesList: activePhases.slice(0, 12).map(s => ({
          project: vf(s, "Project"), task: vf(s, "Task"), assigned: vf(s, "Assigned To"),
          start: vf(s, "Start Date"), end: vf(s, "End Date"), status: vf(s, "Status"),
        })),
        overdueInvoices: invoices.filter(i => vf(i, "Status") === "Overdue").map(i => ({
          number: vf(i, "Invoice Number"), project: vf(i, "Project"), client: vf(i, "Client Name"),
          amount: vf(i, "Amount"), due: vf(i, "Due Date"),
        })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/contractor/project/:id — Project 360 ─────────────────────
  const pm = pathname.match(/^\/api\/contractor\/project\/(.+)$/);
  if (pm && req.method === "GET") {
    const id = decodeURIComponent(pm[1]);
    try {
      const pr = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const proj = pr.data?.submission;
      if (!proj) { jsonResp(res, 404, { error: "Project not found" }); return true; }
      const name = vf(proj, "Project Name");
      const q = `values[Project]="${name.replace(/"/g, '\\"')}"`;

      const [quotes, schedules, permits, materials, invoices, receipts] = await Promise.all([
        collect("quotes", q), collect("schedules", q), collect("permits", q),
        collect("materials", q), collect("invoices", q), collect("receipts", q),
      ]);

      const contract = num(vf(proj, "Contract Value"));
      const matCost = materials.reduce((s, m) => s + num(vf(m, "Total Cost")), 0);
      const recCost = receipts.reduce((s, r) => s + num(vf(r, "Amount")), 0);
      const totalCost = matCost + recCost;
      const invoiced = invoices.reduce((s, i) => s + num(vf(i, "Amount")), 0);
      const paid = invoices.filter(i => vf(i, "Status") === "Paid").reduce((s, i) => s + num(vf(i, "Amount")), 0);
      const phasesDone = schedules.filter(s => vf(s, "Status") === "Completed").length;

      jsonResp(res, 200, {
        project: proj,
        quotes: quotes.map(s => ({ id: s.id, number: vf(s, "Quote Number"), total: vf(s, "Total Amount"), status: vf(s, "Status"), issued: vf(s, "Issue Date"), valid: vf(s, "Valid Until") })),
        schedules: schedules.map(s => ({ id: s.id, task: vf(s, "Task"), assigned: vf(s, "Assigned To"), crew: vf(s, "Crew Size"), start: vf(s, "Start Date"), end: vf(s, "End Date"), status: vf(s, "Status") })),
        permits: permits.map(s => ({ id: s.id, number: vf(s, "Permit Number"), type: vf(s, "Permit Type"), city: vf(s, "Issuing City"), status: vf(s, "Status"), issue: vf(s, "Issue Date"), fee: vf(s, "Fee") })),
        materials: materials.map(s => ({ id: s.id, item: vf(s, "Item"), category: vf(s, "Category"), supplier: vf(s, "Supplier"), qty: vf(s, "Quantity"), total: vf(s, "Total Cost"), status: vf(s, "Status") })),
        invoices: invoices.map(s => ({ id: s.id, number: vf(s, "Invoice Number"), amount: vf(s, "Amount"), status: vf(s, "Status"), issue: vf(s, "Issue Date"), due: vf(s, "Due Date"), paid: vf(s, "Paid Date") })),
        receipts: receipts.map(s => ({ id: s.id, vendor: vf(s, "Vendor"), category: vf(s, "Category"), amount: vf(s, "Amount"), date: vf(s, "Date"), reimbursable: vf(s, "Reimbursable") })),
        summary: {
          contract, matCost, recCost, totalCost, invoiced, paid, outstanding: invoiced - paid,
          grossMargin: contract > 0 ? Math.round((contract - totalCost) / contract * 100) : 0,
          phasesDone, totalPhases: schedules.length,
          collectedPct: contract > 0 ? Math.round(paid / contract * 100) : 0,
        },
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/contractor/reports/financials ────────────────────────────
  if (pathname === "/api/contractor/reports/financials" && req.method === "GET") {
    try {
      const [projects, materials, receipts, invoices] = await Promise.all([
        collect("projects"), collect("materials"), collect("receipts"), collect("invoices"),
      ]);
      const sumBy = (rows, key, amtField) => {
        const m = {};
        rows.forEach(r => { const k = vf(r, key); if (!k) return; m[k] = (m[k] || 0) + num(vf(r, amtField)); });
        return m;
      };
      const matByProj = sumBy(materials, "Project", "Total Cost");
      const recByProj = sumBy(receipts, "Project", "Amount");
      const invByProj = sumBy(invoices, "Project", "Amount");
      const paidByProj = (() => {
        const m = {};
        invoices.filter(i => vf(i, "Status") === "Paid").forEach(i => { const k = vf(i, "Project"); m[k] = (m[k] || 0) + num(vf(i, "Amount")); });
        return m;
      })();

      const rows = projects
        .filter(p => !["Lead", "Cancelled"].includes(vf(p, "Status")))
        .map(p => {
          const name = vf(p, "Project Name");
          const contract = num(vf(p, "Contract Value"));
          const cost = (matByProj[name] || 0) + (recByProj[name] || 0);
          const margin = contract > 0 ? Math.round((contract - cost) / contract * 100) : 0;
          return {
            name, client: vf(p, "Client Name"), type: vf(p, "Project Type"), status: vf(p, "Status"),
            contract, cost, margin, invoiced: invByProj[name] || 0, paid: paidByProj[name] || 0,
            outstanding: (invByProj[name] || 0) - (paidByProj[name] || 0),
          };
        })
        .sort((a, b) => a.margin - b.margin);
      jsonResp(res, 200, { projects: rows });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/contractor/reports/permits ───────────────────────────────
  if (pathname === "/api/contractor/reports/permits" && req.method === "GET") {
    try {
      const permits = await collect("permits");
      const byCity = {};
      permits.forEach(p => {
        const c = vf(p, "Issuing City") || "Unknown";
        if (!byCity[c]) byCity[c] = { city: c, total: 0, issued: 0, pending: 0, fees: 0 };
        byCity[c].total++;
        byCity[c].fees += num(vf(p, "Fee"));
        const st = vf(p, "Status");
        if (["Issued", "Approved"].includes(st)) byCity[c].issued++;
        else if (["Applied", "Inspection Scheduled"].includes(st)) byCity[c].pending++;
      });
      jsonResp(res, 200, {
        cities: Object.values(byCity).sort((a, b) => b.total - a.total),
        open: permits.filter(p => ["Applied", "Inspection Scheduled"].includes(vf(p, "Status"))).map(p => ({
          number: vf(p, "Permit Number"), project: vf(p, "Project"), type: vf(p, "Permit Type"),
          city: vf(p, "Issuing City"), status: vf(p, "Status"), applied: vf(p, "Application Date"),
        })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
