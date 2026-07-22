/**
 * MfgDream — Custom API Handler (read-side aggregation for the executive command center).
 *
 * Rolls the connected manufacturing lifecycle up into pictures:
 *   Customer order → NPI stage-gate → Product/BOM → Parts/Suppliers/POs → Work orders
 *
 * Endpoints:
 *   GET /api/mfgdream/dashboard              — executive command center (health, funnels, heat maps, exceptions)
 *   GET /api/mfgdream/npi/:id                — NPI 360 (gates, order, product, BOM, POs, work orders)
 *   GET /api/mfgdream/customer/:id           — Customer 360 (orders, NPI programs)
 *   GET /api/mfgdream/supplier/:id           — Supplier 360 (scorecard, parts, POs)
 *   GET /api/mfgdream/product/:id            — Product + multi-line BOM rollup
 *   GET /api/mfgdream/reports/supplier-scorecard
 *   GET /api/mfgdream/reports/mrp            — MRP shortage report
 *
 * NO business process logic — that belongs in Kinetic workflow task trees.
 * Auto-discovered by apps/base/server.mjs (exports apiPrefix + handleAPI).
 */
export const appId = "mfgdream";
export const apiPrefix = "/api/mfgdream";
export const kapp = "mfgdream";

const num = (x) => { if (x == null) return 0; const n = parseFloat(String(x).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
const TODAY = new Date("2026-07-21T00:00:00Z").getTime();
const DAY = 86400000;
const daysUntil = (s) => { const t = new Date(s).getTime(); return isNaN(t) ? null : Math.round((t - TODAY) / DAY); };
const daysSince = (s) => { const t = new Date(s).getTime(); return isNaN(t) ? null : Math.round((TODAY - t) / DAY); };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// NPI phase order (stage-gate)
const PHASES = ["Concept", "Feasibility", "Design", "Prototype", "Validation", "Launch"];
const GATES = ["G0 Concept", "G1 Feasibility", "G2 Design", "G3 Prototype", "G4 Validation", "G5 Launch"];
const ORDER_STAGES = ["In NPI", "In Production", "Shipped"];
const SHORT_STATES = ["Stockout", "Reorder", "Low"];

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, vf } = helpers;
  const collect = (formSlug, kql, maxPages = 12) => collectByQuery(kapp, formSlug, kql, auth, maxPages);
  const esc = (s) => String(s).replace(/"/g, '\\"');

  const groupCount = (rows, field) => {
    const m = {};
    rows.forEach((r) => { const k = vf(r, field) || "Other"; m[k] = (m[k] || 0) + 1; });
    return m;
  };
  const sumBy = (rows, valField, pred) => rows.reduce((s, r) => (!pred || pred(r)) ? s + num(vf(r, valField)) : s, 0);

  // ── GET /api/mfgdream/dashboard ─────────────────────────────────────
  if (pathname === "/api/mfgdream/dashboard" && req.method === "GET") {
    try {
      const [customers, orders, npis, gates, products, boms, parts, suppliers, pos, wos,
             inspections, ncrs, capas, shipments, invoices, ecos] = await Promise.all([
        collect("customers"), collect("orders"), collect("npi-projects"), collect("gate-reviews"),
        collect("products"), collect("boms"), collect("parts"), collect("suppliers"),
        collect("purchase-orders"), collect("work-orders"),
        collect("inspections"), collect("nonconformances"), collect("corrective-actions"),
        collect("shipments"), collect("invoices"), collect("engineering-changes"),
      ]);

      // ── Order backlog / lifecycle value flow ──
      const backlog = sumBy(orders, "Order Value");
      const valByStage = (stage) => sumBy(orders, "Order Value", (o) => vf(o, "Stage") === stage);
      const inNpiVal = valByStage("In NPI"), inProdVal = valByStage("In Production"), shippedVal = valByStage("Shipped");
      const lifecycle = {
        booked: Math.round(backlog),
        released: Math.round(inProdVal + shippedVal),   // past NPI, on/through the floor
        shipped: Math.round(shippedVal),
        heldNpi: Math.round(inNpiVal),
        wip: Math.round(inProdVal),
      };

      // ── NPI health ──
      const npiGate = groupCount(npis, "Gate Status");   // Blocked / On Track / At Risk / Approved
      const blocked = npis.filter((n) => vf(n, "Gate Status") === "Blocked");
      const atRisk = npis.filter((n) => vf(n, "Gate Status") === "At Risk");
      const onTrack = npis.filter((n) => ["On Track", "Approved"].includes(vf(n, "Gate Status")));
      const overBudget = npis.filter((n) => num(vf(n, "Spend")) > num(vf(n, "Budget")));
      const lateLaunch = npis.filter((n) => { const d = daysUntil(vf(n, "Target Launch")); return d != null && d < 0; });
      const npiBudget = sumBy(npis, "Budget"), npiSpend = sumBy(npis, "Spend");
      const phaseFunnel = PHASES.map((p) => {
        const rows = npis.filter((n) => vf(n, "Phase") === p);
        return { name: p, count: rows.length, value: Math.round(sumBy(rows, "Budget")) };
      });
      // NPI risk heat map: Risk Level × Gate Status
      const RISK = ["Low", "Medium", "High"], GSTAT = ["On Track", "At Risk", "Blocked"];
      const heat = RISK.map((r) => ({ risk: r, cells: GSTAT.map((g) => ({ gate: g, count: npis.filter((n) => vf(n, "Risk Level") === r && vf(n, "Gate Status") === g).length })) }));

      // ── Gate review decisions ──
      const gateDecision = groupCount(gates, "Decision");   // Go / Conditional Go / Hold
      const gateByGate = GATES.map((g) => {
        const rows = gates.filter((x) => vf(x, "Gate") === g);
        return {
          name: g, count: rows.length,
          go: rows.filter((x) => vf(x, "Decision") === "Go").length,
          cond: rows.filter((x) => vf(x, "Decision") === "Conditional Go").length,
          hold: rows.filter((x) => vf(x, "Decision") === "Hold").length,
        };
      });

      // ── Inventory / MRP ──
      const invValue = parts.reduce((s, p) => s + num(vf(p, "On Hand")) * num(vf(p, "Unit Cost")), 0);
      const stockStatus = groupCount(parts, "Stock Status");
      const stockouts = parts.filter((p) => vf(p, "Stock Status") === "Stockout");
      const reorder = parts.filter((p) => vf(p, "Stock Status") === "Reorder");
      const short = parts.filter((p) => SHORT_STATES.includes(vf(p, "Stock Status")));
      const shortList = short
        .map((p) => ({ id: p.id, pn: vf(p, "Part Number"), name: vf(p, "Part Name"), supplier: vf(p, "Supplier"), status: vf(p, "Stock Status"), onHand: num(vf(p, "On Hand")), onOrder: num(vf(p, "On Order")), rop: num(vf(p, "Reorder Point")), lead: num(vf(p, "Lead Time Days")) }))
        .sort((a, b) => SHORT_STATES.indexOf(a.status) - SHORT_STATES.indexOf(b.status) || a.onHand - b.onHand)
        .slice(0, 12);

      // ── Suppliers / delivery ──
      const supScores = suppliers.map((s) => ({
        id: s.id, name: vf(s, "Supplier Name"), category: vf(s, "Category"), region: vf(s, "Region"),
        onTime: num(vf(s, "On Time Percent")), quality: num(vf(s, "Quality Score")), lead: num(vf(s, "Lead Time Days")),
        status: vf(s, "Status"),
      }));
      const avgOnTime = supScores.length ? Math.round(supScores.reduce((s, x) => s + x.onTime, 0) / supScores.length) : 0;
      const poByStatus = groupCount(pos, "Status");
      const latePOs = pos.filter((p) => vf(p, "Status") === "Late");
      const poCommitted = sumBy(pos, "PO Value", (p) => !["Received"].includes(vf(p, "Status")));

      // ── Production ──
      const woByStatus = groupCount(wos, "Status");
      const woActive = wos.filter((w) => ["Released", "In Progress"].includes(vf(w, "Status")));
      const woComplete = wos.filter((w) => vf(w, "Status") === "Complete");
      const woUnits = sumBy(wos, "Quantity");
      const woDoneUnits = sumBy(woComplete, "Quantity");
      const byWorkCenter = Object.entries(groupCount(wos, "Work Center")).map(([name, count]) => {
        const rows = wos.filter((w) => vf(w, "Work Center") === name);
        const avg = rows.length ? Math.round(rows.reduce((s, w) => s + num(vf(w, "Percent Complete")), 0) / rows.length) : 0;
        return { name, count, avg };
      }).sort((a, b) => b.count - a.count);

      // ── Quality ──
      const insTotal = inspections.length;
      const insPass = inspections.filter((x) => vf(x, "Result") === "Pass").length;
      const insFail = inspections.filter((x) => vf(x, "Result") === "Fail").length;
      const fpy = insTotal ? Math.round(insPass / insTotal * 100) : 100;
      const openNcrs = ncrs.filter((n) => ["Open", "In Review"].includes(vf(n, "Status")));
      const critNcrs = openNcrs.filter((n) => vf(n, "Severity") === "Critical");
      const scrapCost = ncrs.reduce((s, n) => s + (vf(n, "Disposition") === "Scrap" ? num(vf(n, "Cost Impact")) : 0), 0);
      const copq = ncrs.reduce((s, n) => s + num(vf(n, "Cost Impact")), 0);
      const overdueCapa = capas.filter((c) => vf(c, "Status") === "Overdue");
      const ncrBySeverity = groupCount(ncrs, "Severity");
      const defectsByType = Object.entries(groupCount(ncrs, "Defect Type")).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 6);
      // defects by supplier (feeds supplier quality)
      const ncrBySupplier = {};
      ncrs.forEach((n) => { const s = vf(n, "Supplier"); if (s) ncrBySupplier[s] = (ncrBySupplier[s] || 0) + 1; });

      // ── Shipping / on-time delivery ──
      const posted = shipments.filter((s) => ["Shipped", "Delivered"].includes(vf(s, "Status")));
      const onTimeShip = posted.filter((s) => vf(s, "On Time") === "Yes").length;
      const lateShip = posted.filter((s) => vf(s, "On Time") === "No").length;
      const otdPct = (onTimeShip + lateShip) ? Math.round(onTimeShip / (onTimeShip + lateShip) * 100) : 100;
      const shipByStatus = groupCount(shipments, "Status");
      const freightCost = sumBy(shipments, "Freight Cost");

      // ── Finance ──
      const revenue = sumBy(invoices, "Amount");
      const invCost = sumBy(invoices, "Cost");
      const invMargin = sumBy(invoices, "Margin");
      const marginPct = revenue ? Math.round(invMargin / revenue * 100) : 0;
      const arOutstanding = sumBy(invoices, "Amount", (i) => ["Sent", "Overdue"].includes(vf(i, "Status")));
      const arOverdue = sumBy(invoices, "Amount", (i) => vf(i, "Status") === "Overdue");
      const invByStatus = groupCount(invoices, "Status");

      // ── Engineering change ──
      const openEco = ecos.filter((e) => ["Draft", "Under Review"].includes(vf(e, "Status")));
      const critEco = openEco.filter((e) => vf(e, "Priority") === "Critical");
      const ecoByStatus = groupCount(ecos, "Status");

      // ── Business-health scorecard (each sub-score 0-100) ──
      const npiScore = npis.length ? Math.round(onTrack.length / npis.length * 100) : 100;
      const supplyScore = parts.length ? Math.round((parts.length - short.length) / parts.length * 100) : 100;
      const deliveryScore = otdPct;
      const budgetScore = npis.length ? Math.round((npis.length - overBudget.length) / npis.length * 100) : 100;
      const scheduleScore = npis.length ? Math.round((npis.length - lateLaunch.length) / npis.length * 100) : 100;
      const qualityScore = fpy;
      const supplierScore = avgOnTime;
      const health = Math.round(npiScore * 0.2 + supplyScore * 0.15 + deliveryScore * 0.15 + qualityScore * 0.15 + budgetScore * 0.1 + scheduleScore * 0.1 + supplierScore * 0.15);
      const healthColor = health >= 80 ? "green" : health >= 60 ? "amber" : "red";

      // ── Exception feeds (what needs an exec in 30 seconds) ──
      const exNpi = [...blocked, ...atRisk].slice(0, 10).map((n) => ({
        id: n.id, npi: vf(n, "NPI ID"), name: vf(n, "Product Name"), customer: vf(n, "Customer"),
        phase: vf(n, "Phase"), gate: vf(n, "Gate Status"), risk: vf(n, "Risk Level"),
        pct: num(vf(n, "Percent Complete")), launch: vf(n, "Target Launch"),
        launchIn: daysUntil(vf(n, "Target Launch")), overBudget: num(vf(n, "Spend")) > num(vf(n, "Budget")),
        budget: num(vf(n, "Budget")), spend: num(vf(n, "Spend")),
      })).sort((a, b) => (a.gate === "Blocked" ? 0 : 1) - (b.gate === "Blocked" ? 0 : 1));

      const exOrders = orders.filter((o) => {
        const npi = npis.find((n) => vf(n, "NPI ID") === vf(o, "NPI ID"));
        return vf(o, "Priority") === "Critical" || (npi && vf(npi, "Gate Status") === "Blocked");
      }).slice(0, 8).map((o) => ({
        id: o.id, order: vf(o, "Order ID"), customer: vf(o, "Customer"), product: vf(o, "Product Name"),
        value: num(vf(o, "Order Value")), stage: vf(o, "Stage"), priority: vf(o, "Priority"),
        due: vf(o, "Requested Delivery"), dueIn: daysUntil(vf(o, "Requested Delivery")),
      }));

      jsonResp(res, 200, {
        kpis: {
          backlog: Math.round(backlog), orderCount: orders.length, customerCount: customers.length,
          activeNpi: npis.length, blockedNpi: blocked.length, atRiskNpi: atRisk.length,
          npiBudget: Math.round(npiBudget), npiSpend: Math.round(npiSpend),
          invValue: Math.round(invValue), stockouts: stockouts.length, shortParts: short.length,
          avgOnTime, latePOs: latePOs.length, poCommitted: Math.round(poCommitted),
          woActive: woActive.length, woUnits: Math.round(woUnits), woDoneUnits: Math.round(woDoneUnits),
          supplierCount: suppliers.length, productCount: products.length,
          overBudget: overBudget.length, lateLaunch: lateLaunch.length,
          fpy, openNcrs: openNcrs.length, critNcrs: critNcrs.length, overdueCapa: overdueCapa.length,
          scrapCost: Math.round(scrapCost), copq: Math.round(copq),
          otdPct, shippedCount: posted.length, lateShip, freightCost: Math.round(freightCost),
          revenue: Math.round(revenue), invMargin: Math.round(invMargin), marginPct,
          arOutstanding: Math.round(arOutstanding), arOverdue: Math.round(arOverdue),
          openEco: openEco.length, critEco: critEco.length,
        },
        health: {
          score: health, color: healthColor,
          subs: [
            { label: "NPI On-Track", score: npiScore },
            { label: "Material Supply", score: supplyScore },
            { label: "On-Time Ship", score: deliveryScore },
            { label: "Quality (FPY)", score: qualityScore },
            { label: "Supplier On-Time", score: supplierScore },
            { label: "Budget Control", score: budgetScore },
            { label: "Schedule", score: scheduleScore },
          ],
        },
        quality: {
          fpy, insTotal, insPass, insFail,
          openNcrs: openNcrs.length, critNcrs: critNcrs.length, overdueCapa: overdueCapa.length,
          scrapCost: Math.round(scrapCost), copq: Math.round(copq),
          bySeverity: ncrBySeverity, defectsByType,
          ncrBySupplier: Object.entries(ncrBySupplier).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        },
        shipping: { otdPct, onTimeShip, lateShip, posted: posted.length, byStatus: shipByStatus, freightCost: Math.round(freightCost) },
        finance: {
          revenue: Math.round(revenue), cost: Math.round(invCost), margin: Math.round(invMargin), marginPct,
          arOutstanding: Math.round(arOutstanding), arOverdue: Math.round(arOverdue), byStatus: invByStatus,
        },
        engChange: { open: openEco.length, critical: critEco.length, byStatus: ecoByStatus },
        lifecycle,
        phaseFunnel, npiGate, heat,
        gateDecision, gateByGate,
        inventory: { stockStatus, shortList, invValue: Math.round(invValue) },
        suppliers: { avgOnTime, poByStatus, latePOs: latePOs.length, scores: supScores.slice().sort((a, b) => a.onTime - b.onTime) },
        production: { woByStatus, byWorkCenter, units: Math.round(woUnits), done: Math.round(woDoneUnits) },
        exceptions: { npi: exNpi, orders: exOrders },
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/mfgdream/npi/:id — NPI 360 ─────────────────────────────
  const nm = pathname.match(/^\/api\/mfgdream\/npi\/(.+)$/);
  if (nm && req.method === "GET") {
    const id = decodeURIComponent(nm[1]);
    try {
      const r = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const n = r.data?.submission;
      if (!n) { jsonResp(res, 404, { error: "NPI not found" }); return true; }
      const npiId = vf(n, "NPI ID"), orderId = vf(n, "Order");
      const nf = `values[NPI ID]="${esc(npiId)}"`;
      const [gates, gproducts, pos, wos] = await Promise.all([
        collect("gate-reviews", nf), collect("products", nf), collect("purchase-orders", nf), collect("work-orders", nf),
      ]);
      let order = null, boms = [];
      // orders form has no index on Order ID — link via the indexed NPI ID field (1:1 with the program)
      { const o = await collect("orders", `values[NPI ID]="${esc(npiId)}"`); order = o.find((x) => vf(x, "Order ID") === orderId) || o[0] || null; }
      const product = gproducts[0] || null;
      if (product) boms = await collect("boms", `values[Product SKU]="${esc(vf(product, "SKU"))}"`);
      const budget = num(vf(n, "Budget")), spend = num(vf(n, "Spend"));
      jsonResp(res, 200, {
        npi: n,
        summary: {
          phase: vf(n, "Phase"), gate: vf(n, "Gate Status"), risk: vf(n, "Risk Level"),
          pct: num(vf(n, "Percent Complete")), budget, spend, budgetPct: budget ? Math.round(spend / budget * 100) : 0,
          overBudget: spend > budget, launch: vf(n, "Target Launch"), launchIn: daysUntil(vf(n, "Target Launch")),
          owner: vf(n, "Owner"),
        },
        order: order ? { id: order.id, oid: vf(order, "Order ID"), customer: vf(order, "Customer"), value: vf(order, "Order Value"), qty: vf(order, "Quantity"), stage: vf(order, "Stage"), due: vf(order, "Requested Delivery"), priority: vf(order, "Priority") } : null,
        product: product ? { id: product.id, sku: vf(product, "SKU"), name: vf(product, "Product Name"), lifecycle: vf(product, "Lifecycle"), cost: vf(product, "Unit Cost"), price: vf(product, "Target Price"), lead: vf(product, "Lead Time Days") } : null,
        gates: gates.sort((a, b) => GATES.indexOf(vf(a, "Gate")) - GATES.indexOf(vf(b, "Gate"))).map((g) => ({ gate: vf(g, "Gate"), decision: vf(g, "Decision"), date: vf(g, "Review Date"), reviewer: vf(g, "Reviewer"), score: vf(g, "Score"), risk: vf(g, "Risk Notes"), actions: vf(g, "Action Items") })),
        boms: boms.map((b) => ({ part: vf(b, "Part Number"), name: vf(b, "Part Name"), qty: vf(b, "Qty Per"), cost: vf(b, "Unit Cost"), ext: vf(b, "Ext Cost"), makeBuy: vf(b, "Make or Buy") })),
        pos: pos.map((p) => ({ po: vf(p, "PO Number"), supplier: vf(p, "Supplier"), part: vf(p, "Part Name"), value: vf(p, "PO Value"), due: vf(p, "Due Date"), status: vf(p, "Status") })),
        wos: wos.map((w) => ({ wo: vf(w, "WO Number"), qty: vf(w, "Quantity"), pct: vf(w, "Percent Complete"), wc: vf(w, "Work Center"), status: vf(w, "Status"), start: vf(w, "Scheduled Start"), end: vf(w, "Scheduled End") })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/mfgdream/customer/:id — Customer 360 ───────────────────
  const cm = pathname.match(/^\/api\/mfgdream\/customer\/(.+)$/);
  if (cm && req.method === "GET") {
    const id = decodeURIComponent(cm[1]);
    try {
      const r = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const c = r.data?.submission;
      if (!c) { jsonResp(res, 404, { error: "Customer not found" }); return true; }
      const company = vf(c, "Company");
      const [orders, npis, shipments, invoices] = await Promise.all([
        collect("orders", `values[Customer]="${esc(company)}"`), collect("npi-projects", `values[Customer]="${esc(company)}"`),
        collect("shipments", `values[Customer]="${esc(company)}"`), collect("invoices", `values[Customer]="${esc(company)}"`),
      ]);
      jsonResp(res, 200, {
        customer: c,
        summary: {
          orders: orders.length, backlog: Math.round(sumBy(orders, "Order Value")),
          npis: npis.length, blocked: npis.filter((n) => vf(n, "Gate Status") === "Blocked").length,
          atRisk: npis.filter((n) => vf(n, "Gate Status") === "At Risk").length,
          shipments: shipments.length, invoices: invoices.length,
          outstanding: Math.round(sumBy(invoices, "Amount", (i) => ["Sent", "Overdue"].includes(vf(i, "Status")))),
        },
        orders: orders.map((o) => ({ id: o.id, oid: vf(o, "Order ID"), product: vf(o, "Product Name"), value: vf(o, "Order Value"), stage: vf(o, "Stage"), priority: vf(o, "Priority"), due: vf(o, "Requested Delivery") })),
        npis: npis.map((n) => ({ id: n.id, npi: vf(n, "NPI ID"), name: vf(n, "Product Name"), phase: vf(n, "Phase"), gate: vf(n, "Gate Status"), risk: vf(n, "Risk Level"), pct: vf(n, "Percent Complete"), launch: vf(n, "Target Launch") })),
        shipments: shipments.map((s) => ({ id: vf(s, "Shipment ID"), order: vf(s, "Order"), product: vf(s, "Product Name"), qty: vf(s, "Quantity"), ship: vf(s, "Ship Date"), status: vf(s, "Status"), onTime: vf(s, "On Time"), carrier: vf(s, "Carrier") })),
        invoices: invoices.map((i) => ({ id: vf(i, "Invoice ID"), order: vf(i, "Order"), amount: vf(i, "Amount"), due: vf(i, "Due Date"), status: vf(i, "Status") })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/mfgdream/supplier/:id — Supplier 360 ───────────────────
  const sm = pathname.match(/^\/api\/mfgdream\/supplier\/(.+)$/);
  if (sm && req.method === "GET") {
    const id = decodeURIComponent(sm[1]);
    try {
      const r = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const s = r.data?.submission;
      if (!s) { jsonResp(res, 404, { error: "Supplier not found" }); return true; }
      const name = vf(s, "Supplier Name");
      const [parts, pos, ncrs, capas] = await Promise.all([
        collect("parts", `values[Supplier]="${esc(name)}"`), collect("purchase-orders", `values[Supplier]="${esc(name)}"`),
        collect("nonconformances", `values[Supplier]="${esc(name)}"`), collect("corrective-actions", `values[Supplier]="${esc(name)}"`),
      ]);
      jsonResp(res, 200, {
        supplier: s,
        summary: {
          onTime: num(vf(s, "On Time Percent")), quality: num(vf(s, "Quality Score")), lead: num(vf(s, "Lead Time Days")),
          parts: parts.length, openPOs: pos.filter((p) => !["Received"].includes(vf(p, "Status"))).length,
          latePOs: pos.filter((p) => vf(p, "Status") === "Late").length, poValue: Math.round(sumBy(pos, "PO Value")),
          shortParts: parts.filter((p) => SHORT_STATES.includes(vf(p, "Stock Status"))).length,
          ncrs: ncrs.length, openScars: capas.filter((c) => vf(c, "Status") !== "Closed").length,
        },
        parts: parts.map((p) => ({ pn: vf(p, "Part Number"), name: vf(p, "Part Name"), status: vf(p, "Stock Status"), onHand: vf(p, "On Hand"), rop: vf(p, "Reorder Point"), lead: vf(p, "Lead Time Days") })),
        pos: pos.sort((a, b) => (vf(a, "Due Date") || "").localeCompare(vf(b, "Due Date") || "")).map((p) => ({ po: vf(p, "PO Number"), part: vf(p, "Part Name"), qty: vf(p, "Quantity"), value: vf(p, "PO Value"), due: vf(p, "Due Date"), status: vf(p, "Status") })),
        ncrs: ncrs.map((n) => ({ id: vf(n, "NCR ID"), product: vf(n, "Product Name"), severity: vf(n, "Severity"), defect: vf(n, "Defect Type"), disposition: vf(n, "Disposition"), status: vf(n, "Status"), cost: vf(n, "Cost Impact") })),
        capas: capas.map((c) => ({ id: vf(c, "CAPA ID"), title: vf(c, "Title"), type: vf(c, "Type"), status: vf(c, "Status"), due: vf(c, "Due Date") })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/mfgdream/product/:id — Product + BOM ────────────────────
  const pm = pathname.match(/^\/api\/mfgdream\/product\/(.+)$/);
  if (pm && req.method === "GET") {
    const id = decodeURIComponent(pm[1]);
    try {
      const r = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const p = r.data?.submission;
      if (!p) { jsonResp(res, 404, { error: "Product not found" }); return true; }
      const sku = vf(p, "SKU");
      const [boms, wos, ecos, inspections] = await Promise.all([
        collect("boms", `values[Product SKU]="${esc(sku)}"`), collect("work-orders", `values[Product SKU]="${esc(sku)}"`),
        collect("engineering-changes", `values[Product SKU]="${esc(sku)}"`), collect("inspections", `values[Product SKU]="${esc(sku)}"`),
      ]);
      const bomCost = boms.reduce((s, b) => s + num(vf(b, "Ext Cost")), 0);
      jsonResp(res, 200, {
        product: p,
        summary: {
          bomLines: boms.length, bomCost: Math.round(bomCost),
          make: boms.filter((b) => vf(b, "Make or Buy") === "Make").length,
          buy: boms.filter((b) => vf(b, "Make or Buy") === "Buy").length,
          cost: num(vf(p, "Unit Cost")), price: num(vf(p, "Target Price")),
          margin: num(vf(p, "Target Price")) ? Math.round((num(vf(p, "Target Price")) - num(vf(p, "Unit Cost"))) / num(vf(p, "Target Price")) * 100) : 0,
        },
        boms: boms.sort((a, b) => num(vf(b, "Ext Cost")) - num(vf(a, "Ext Cost"))).map((b) => ({ part: vf(b, "Part Number"), name: vf(b, "Part Name"), qty: vf(b, "Qty Per"), cost: vf(b, "Unit Cost"), ext: vf(b, "Ext Cost"), makeBuy: vf(b, "Make or Buy") })),
        wos: wos.map((w) => ({ wo: vf(w, "WO Number"), qty: vf(w, "Quantity"), pct: vf(w, "Percent Complete"), wc: vf(w, "Work Center"), status: vf(w, "Status") })),
        ecos: ecos.map((e) => ({ id: vf(e, "ECO ID"), type: vf(e, "Type"), reason: vf(e, "Reason"), priority: vf(e, "Priority"), status: vf(e, "Status"), cost: vf(e, "Cost Impact") })),
        inspections: inspections.map((x) => ({ id: vf(x, "Inspection ID"), type: vf(x, "Type"), result: vf(x, "Result"), qtyRej: vf(x, "Qty Rejected"), date: vf(x, "Inspection Date") })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/mfgdream/reports/supplier-scorecard ────────────────────
  if (pathname === "/api/mfgdream/reports/supplier-scorecard" && req.method === "GET") {
    try {
      const [suppliers, pos, ncrs] = await Promise.all([collect("suppliers"), collect("purchase-orders"), collect("nonconformances")]);
      const rows = suppliers.map((s) => {
        const name = vf(s, "Supplier Name");
        const sp = pos.filter((p) => vf(p, "Supplier") === name);
        const late = sp.filter((p) => vf(p, "Status") === "Late").length;
        const ncr = ncrs.filter((n) => vf(n, "Supplier") === name).length;
        const onTime = num(vf(s, "On Time Percent")), quality = num(vf(s, "Quality Score"));
        const rating = Math.max(0, Math.round(onTime * 0.5 + quality * 20 * 0.5 - ncr * 3));
        return {
          id: s.id, name, category: vf(s, "Category"), region: vf(s, "Region"),
          onTime, quality, lead: num(vf(s, "Lead Time Days")), pos: sp.length, late, ncr,
          poValue: Math.round(sumBy(sp, "PO Value")), rating,
          risk: onTime < 85 || quality < 4 || late > 0 || ncr > 1 ? (onTime < 80 || late > 1 || ncr > 2 ? "High" : "Medium") : "Low",
        };
      }).sort((a, b) => b.rating - a.rating);
      jsonResp(res, 200, { suppliers: rows });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/mfgdream/reports/mrp — shortage report ─────────────────
  if (pathname === "/api/mfgdream/reports/mrp" && req.method === "GET") {
    try {
      const parts = await collect("parts");
      const rows = parts.filter((p) => SHORT_STATES.includes(vf(p, "Stock Status")))
        .map((p) => ({
          pn: vf(p, "Part Number"), name: vf(p, "Part Name"), category: vf(p, "Category"), supplier: vf(p, "Supplier"),
          status: vf(p, "Stock Status"), onHand: num(vf(p, "On Hand")), onOrder: num(vf(p, "On Order")),
          rop: num(vf(p, "Reorder Point")), lead: num(vf(p, "Lead Time Days")), unitCost: num(vf(p, "Unit Cost")),
          net: num(vf(p, "Reorder Point")) - num(vf(p, "On Hand")) - num(vf(p, "On Order")),
        }))
        .sort((a, b) => SHORT_STATES.indexOf(a.status) - SHORT_STATES.indexOf(b.status) || b.net - a.net);
      jsonResp(res, 200, { parts: rows, total: rows.length });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
