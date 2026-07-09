/**
 * Ironline CPQ — Custom API Handler (DISPLAY-ONLY aggregation).
 *
 * Provides read-side rollups for the money-flow visuals:
 *   • Pipeline funnel (stage value + stall detection)
 *   • Approval bottlenecks (aging, SLA breaches, by approver)
 *   • Revenue / margin waterfall (list → discount → net → cost → margin)
 *   • Cash conversion (won → ordered → invoiced → collected; AR aging)
 * plus quote-360 and customer-360 drill-downs and two reports.
 *
 * NO business process logic lives here — quote pricing, approval routing,
 * won→order conversion and expiration are Kinetic workflow TASK TREES.
 * Auto-discovered by apps/base/server.mjs (exports apiPrefix + handleAPI).
 */
export const appId = "cpq";
export const apiPrefix = "/api/cpq";
export const kapp = "cpq";

const num = (v) => { if (v == null) return 0; const n = parseFloat(String(v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
const TODAY = new Date("2026-06-18T00:00:00Z").getTime();
const DAY = 86400000;
const daysSince = (s) => { const t = new Date(s).getTime(); return isNaN(t) ? null : Math.round((TODAY - t) / DAY); };

// Pipeline order for the funnel. Won/Lost/Expired are terminal (off-funnel).
const FUNNEL = ["Draft", "Sent", "Negotiation", "Pending Approval", "Approved", "Won"];
const OPEN = ["Draft", "Sent", "Negotiation", "Pending Approval", "Approved"];
const STALL_DAYS = 30;

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, vf } = helpers;
  const KAPP = kapp;
  const collect = (formSlug, kql, maxPages = 20) => collectByQuery(KAPP, formSlug, kql, auth, maxPages);
  const groupSum = (rows, field, valField) => {
    const m = {};
    rows.forEach((r) => { const k = vf(r, field) || "Other"; if (!m[k]) m[k] = { count: 0, value: 0 }; m[k].count++; m[k].value += num(vf(r, valField)); });
    return Object.entries(m).map(([name, x]) => ({ name, count: x.count, value: Math.round(x.value) })).sort((a, b) => b.value - a.value);
  };

  // ── GET /api/cpq/dashboard ──────────────────────────────────────────
  if (pathname === "/api/cpq/dashboard" && req.method === "GET") {
    try {
      const [quotes, approvals, orders, invoices, payments] = await Promise.all([
        collect("quotes"), collect("approvals"), collect("orders"), collect("invoices"), collect("payments"),
      ]);

      const byStatus = (st) => quotes.filter((q) => vf(q, "Status") === st);
      const won = byStatus("Won"), lost = byStatus("Lost"), open = quotes.filter((q) => OPEN.includes(vf(q, "Status")));
      const openValue = open.reduce((s, q) => s + num(vf(q, "Net Total")), 0);
      const weighted = open.reduce((s, q) => s + num(vf(q, "Net Total")) * num(vf(q, "Win Probability")) / 100, 0);
      const wonValue = won.reduce((s, q) => s + num(vf(q, "Net Total")), 0);
      const winRate = (won.length + lost.length) ? Math.round(won.length / (won.length + lost.length) * 100) : 0;

      // ── 1. PIPELINE FUNNEL ──
      const pipeline = FUNNEL.map((stage) => {
        const rows = byStatus(stage);
        const ages = rows.map((q) => daysSince(vf(q, "Stage Entered Date"))).filter((d) => d != null);
        const stalled = rows.filter((q) => OPEN.includes(stage) && (daysSince(vf(q, "Stage Entered Date")) || 0) > STALL_DAYS);
        return {
          stage, count: rows.length,
          value: Math.round(rows.reduce((s, q) => s + num(vf(q, "Net Total")), 0)),
          avgAge: ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0,
          stalled: stalled.length,
          stalledValue: Math.round(stalled.reduce((s, q) => s + num(vf(q, "Net Total")), 0)),
        };
      });

      // ── 2. APPROVAL BOTTLENECKS ──
      const pending = approvals.filter((a) => vf(a, "Status") === "Pending");
      const breached = pending.filter((a) => { const d = new Date(vf(a, "SLA Due Date")).getTime(); return !isNaN(d) && d < TODAY; });
      const apprByApprover = {};
      pending.forEach((a) => {
        const k = vf(a, "Approver") || "Unassigned";
        if (!apprByApprover[k]) apprByApprover[k] = { name: k, role: vf(a, "Approver Role"), count: 0, value: 0, ageSum: 0, breached: 0 };
        const o = apprByApprover[k]; o.count++; o.value += num(vf(a, "Net Total")); o.ageSum += num(vf(a, "Aging Days"));
        if (new Date(vf(a, "SLA Due Date")).getTime() < TODAY) o.breached++;
      });
      const agingBuckets = [["0-2 days", 0], ["3-5 days", 0], ["6-10 days", 0], ["10+ days", 0]];
      pending.forEach((a) => { const d = num(vf(a, "Aging Days")); if (d <= 2) agingBuckets[0][1]++; else if (d <= 5) agingBuckets[1][1]++; else if (d <= 10) agingBuckets[2][1]++; else agingBuckets[3][1]++; });

      // ── 3. REVENUE / MARGIN WATERFALL (realized = Won) ──
      const w = won.reduce((a, q) => {
        a.list += num(vf(q, "List Total")); a.discount += num(vf(q, "Discount Total"));
        a.net += num(vf(q, "Net Total")); a.cost += num(vf(q, "Cost Total")); a.margin += num(vf(q, "Margin Amount"));
        return a;
      }, { list: 0, discount: 0, net: 0, cost: 0, margin: 0 });
      Object.keys(w).forEach((k) => (w[k] = Math.round(w[k])));
      w.marginPct = w.net ? Math.round(w.margin / w.net * 100) : 0;
      w.discountPct = w.list ? Math.round(w.discount / w.list * 100) : 0;

      // open-pipeline leakage (discount already applied on open quotes)
      const openLeak = open.reduce((a, q) => { a.list += num(vf(q, "List Total")); a.discount += num(vf(q, "Discount Total")); return a; }, { list: 0, discount: 0 });

      // ── 4. CASH CONVERSION ──
      const orderedValue = orders.reduce((s, o) => s + num(vf(o, "Order Total")), 0);
      const invoicedValue = invoices.reduce((s, i) => s + num(vf(i, "Amount")), 0);
      const collectedValue = invoices.reduce((s, i) => s + num(vf(i, "Amount Paid")), 0);
      const outstanding = invoices.reduce((s, i) => s + num(vf(i, "Balance")), 0);
      const unconverted = won.filter((q) => !vf(q, "Order Number"));
      const unconvertedValue = unconverted.reduce((s, q) => s + num(vf(q, "Net Total")), 0);
      const openInv = invoices.filter((i) => num(vf(i, "Balance")) > 0);
      const arAging = [["Current", 0], ["1-30 days", 0], ["31-60 days", 0], ["61-90 days", 0], ["90+ days", 0]];
      openInv.forEach((i) => {
        const due = daysSince(vf(i, "Due Date")); const bal = num(vf(i, "Balance"));
        if (due == null || due <= 0) arAging[0][1] += bal; else if (due <= 30) arAging[1][1] += bal;
        else if (due <= 60) arAging[2][1] += bal; else if (due <= 90) arAging[3][1] += bal; else arAging[4][1] += bal;
      });

      jsonResp(res, 200, {
        kpis: {
          openValue: Math.round(openValue), weightedValue: Math.round(weighted), openCount: open.length,
          wonValue: Math.round(wonValue), wonCount: won.length, winRate,
          avgMargin: w.marginPct, avgDiscount: w.discountPct,
          pendingApprovals: pending.length, breachedApprovals: breached.length,
          outstanding: Math.round(outstanding), collected: Math.round(collectedValue),
          unconvertedWins: unconverted.length, unconvertedValue: Math.round(unconvertedValue),
          totalStalled: pipeline.reduce((s, p) => s + p.stalled, 0),
        },
        pipeline,
        approvals: {
          pending: pending.length, breached: breached.length,
          pendingValue: Math.round(pending.reduce((s, a) => s + num(vf(a, "Net Total")), 0)),
          byApprover: Object.values(apprByApprover).map((o) => ({ ...o, value: Math.round(o.value), avgAge: o.count ? Math.round(o.ageSum / o.count) : 0 })).sort((a, b) => b.breached - a.breached || b.value - a.value),
          aging: agingBuckets.map(([bucket, count]) => ({ bucket, count })),
          list: pending.sort((a, b) => num(vf(b, "Aging Days")) - num(vf(a, "Aging Days"))).slice(0, 12).map((a) => ({
            id: a.id, aid: vf(a, "Approval ID"), quote: vf(a, "Quote Number"), customer: vf(a, "Customer Name"),
            type: vf(a, "Approval Type"), approver: vf(a, "Approver"), discount: vf(a, "Discount Pct"),
            margin: vf(a, "Margin Pct"), net: vf(a, "Net Total"), age: num(vf(a, "Aging Days")), priority: vf(a, "Priority"),
            breached: new Date(vf(a, "SLA Due Date")).getTime() < TODAY,
          })),
        },
        waterfall: w, openLeak: { list: Math.round(openLeak.list), discount: Math.round(openLeak.discount) },
        cash: {
          wonValue: Math.round(wonValue), orderedValue: Math.round(orderedValue), invoicedValue: Math.round(invoicedValue),
          collectedValue: Math.round(collectedValue), outstanding: Math.round(outstanding),
          unconvertedValue: Math.round(unconvertedValue), unconvertedCount: unconverted.length,
          arAging: arAging.map(([bucket, amount]) => ({ bucket, amount: Math.round(amount) })),
          overdueInvoices: invoices.filter((i) => vf(i, "Status") === "Overdue").length,
        },
        bySegment: groupSum(quotes, "Segment", "Net Total"),
        byOwner: groupSum(won, "Owner", "Net Total").slice(0, 8),
        topOpen: open.slice().sort((a, b) => num(vf(b, "Net Total")) - num(vf(a, "Net Total"))).slice(0, 8).map((q) => ({
          id: q.id, qn: vf(q, "Quote Number"), customer: vf(q, "Customer Name"), owner: vf(q, "Owner"),
          status: vf(q, "Status"), net: vf(q, "Net Total"), margin: vf(q, "Margin Pct"), age: daysSince(vf(q, "Stage Entered Date")), prob: vf(q, "Win Probability"),
        })),
        stalledList: open.filter((q) => (daysSince(vf(q, "Stage Entered Date")) || 0) > STALL_DAYS)
          .sort((a, b) => (daysSince(vf(b, "Stage Entered Date")) || 0) - (daysSince(vf(a, "Stage Entered Date")) || 0)).slice(0, 10)
          .map((q) => ({ id: q.id, qn: vf(q, "Quote Number"), customer: vf(q, "Customer Name"), status: vf(q, "Status"), net: vf(q, "Net Total"), age: daysSince(vf(q, "Stage Entered Date")), owner: vf(q, "Owner") })),
        unconvertedList: unconverted.sort((a, b) => num(vf(b, "Net Total")) - num(vf(a, "Net Total"))).map((q) => ({
          id: q.id, qn: vf(q, "Quote Number"), customer: vf(q, "Customer Name"), net: vf(q, "Net Total"), owner: vf(q, "Owner"), decided: vf(q, "Decision Date"),
        })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/cpq/quote/:id — Quote 360 ──────────────────────────────
  const qm = pathname.match(/^\/api\/cpq\/quote\/(.+)$/);
  if (qm && req.method === "GET") {
    const id = decodeURIComponent(qm[1]);
    try {
      const r = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const q = r.data?.submission;
      if (!q) { jsonResp(res, 404, { error: "Quote not found" }); return true; }
      const qnum = vf(q, "Quote Number"); const esc = (s) => String(s).replace(/"/g, '\\"');
      const qf = `values[Quote Number]="${esc(qnum)}"`;
      const [lines, appr, ord] = await Promise.all([collect("quote-lines", qf), collect("approvals", qf), collect("orders", qf)]);
      const ordNum = ord[0] ? vf(ord[0], "Order Number") : vf(q, "Order Number");
      const [inv] = await Promise.all([ordNum ? collect("invoices", `values[Order Number]="${esc(ordNum)}"`) : Promise.resolve([])]);
      const invNums = inv.map((i) => vf(i, "Invoice Number"));
      // one collect per invoice (usually 1) — avoids relying on KQL OR support
      const payArrs = await Promise.all(invNums.map((n) => collect("payments", `values[Invoice Number]="${esc(n)}"`)));
      const pays = payArrs.flat();
      jsonResp(res, 200, {
        quote: q,
        summary: {
          list: num(vf(q, "List Total")), discount: num(vf(q, "Discount Total")), net: num(vf(q, "Net Total")),
          cost: num(vf(q, "Cost Total")), margin: num(vf(q, "Margin Amount")), marginPct: num(vf(q, "Margin Pct")),
          discountPct: num(vf(q, "Discount Pct")), lineCount: lines.length, ageDays: daysSince(vf(q, "Stage Entered Date")),
        },
        lines: lines.sort((a, b) => num(vf(a, "Line Number")) - num(vf(b, "Line Number"))).map((l) => ({
          line: vf(l, "Line Number"), sku: vf(l, "Product SKU"), name: vf(l, "Product Name"), category: vf(l, "Category"),
          qty: vf(l, "Quantity"), unitList: vf(l, "Unit List Price"), options: vf(l, "Options Summary"),
          discount: vf(l, "Discount Pct"), unitNet: vf(l, "Unit Net Price"), extList: vf(l, "Extended List"),
          extNet: vf(l, "Extended Net"), margin: vf(l, "Margin Amount"), marginPct: vf(l, "Margin Pct"),
        })),
        approvals: appr.map((a) => ({ aid: vf(a, "Approval ID"), type: vf(a, "Approval Type"), approver: vf(a, "Approver"), status: vf(a, "Status"), age: vf(a, "Aging Days"), reason: vf(a, "Reason"), priority: vf(a, "Priority") })),
        order: ord[0] ? { num: ordNum, status: vf(ord[0], "Status"), date: vf(ord[0], "Order Date"), total: vf(ord[0], "Order Total"), fulfillment: vf(ord[0], "Fulfillment Status"), shipped: vf(ord[0], "Shipped Date"), promised: vf(ord[0], "Promised Ship Date") } : null,
        invoices: inv.map((i) => ({ num: vf(i, "Invoice Number"), status: vf(i, "Status"), amount: vf(i, "Amount"), paid: vf(i, "Amount Paid"), balance: vf(i, "Balance"), due: vf(i, "Due Date") })),
        payments: pays.map((p) => ({ pid: vf(p, "Payment ID"), amount: vf(p, "Amount"), method: vf(p, "Method"), date: vf(p, "Payment Date") })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/cpq/customer/:id — Customer 360 ────────────────────────
  const cm = pathname.match(/^\/api\/cpq\/customer\/(.+)$/);
  if (cm && req.method === "GET") {
    const id = decodeURIComponent(cm[1]);
    try {
      const r = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const c = r.data?.submission;
      if (!c) { jsonResp(res, 404, { error: "Customer not found" }); return true; }
      const cidv = vf(c, "Customer ID"); const esc = (s) => String(s).replace(/"/g, '\\"');
      const cf = `values[Customer ID]="${esc(cidv)}"`;
      const [quotes, orders, invoices] = await Promise.all([collect("quotes", cf), collect("orders", cf), collect("invoices", cf)]);
      const won = quotes.filter((q) => vf(q, "Status") === "Won");
      jsonResp(res, 200, {
        customer: c,
        summary: {
          quotes: quotes.length, won: won.length, openValue: Math.round(quotes.filter((q) => OPEN.includes(vf(q, "Status"))).reduce((s, q) => s + num(vf(q, "Net Total")), 0)),
          wonValue: Math.round(won.reduce((s, q) => s + num(vf(q, "Net Total")), 0)),
          outstanding: Math.round(invoices.reduce((s, i) => s + num(vf(i, "Balance")), 0)),
          lifetime: Math.round(invoices.reduce((s, i) => s + num(vf(i, "Amount Paid")), 0)),
        },
        quotes: quotes.sort((a, b) => (vf(b, "Created Date") || "").localeCompare(vf(a, "Created Date") || "")).map((q) => ({
          id: q.id, qn: vf(q, "Quote Number"), status: vf(q, "Status"), net: vf(q, "Net Total"), margin: vf(q, "Margin Pct"), owner: vf(q, "Owner"), created: vf(q, "Created Date"),
        })),
        orders: orders.map((o) => ({ num: vf(o, "Order Number"), status: vf(o, "Status"), total: vf(o, "Order Total"), date: vf(o, "Order Date") })),
        invoices: invoices.map((i) => ({ num: vf(i, "Invoice Number"), status: vf(i, "Status"), amount: vf(i, "Amount"), balance: vf(i, "Balance"), due: vf(i, "Due Date") })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/cpq/reports/win-loss ───────────────────────────────────
  if (pathname === "/api/cpq/reports/win-loss" && req.method === "GET") {
    try {
      const quotes = await collect("quotes");
      const reps = {};
      quotes.forEach((q) => {
        const k = vf(q, "Owner") || "Unassigned"; const st = vf(q, "Status");
        if (!reps[k]) reps[k] = { owner: k, open: 0, won: 0, lost: 0, wonValue: 0, openValue: 0, avgDiscount: 0, dCount: 0 };
        const o = reps[k];
        if (st === "Won") { o.won++; o.wonValue += num(vf(q, "Net Total")); }
        else if (st === "Lost") o.lost++;
        else if (OPEN.includes(st)) { o.open++; o.openValue += num(vf(q, "Net Total")); }
        o.avgDiscount += num(vf(q, "Discount Pct")); o.dCount++;
      });
      const rows = Object.values(reps).map((o) => ({
        owner: o.owner, open: o.open, won: o.won, lost: o.lost,
        winRate: (o.won + o.lost) ? Math.round(o.won / (o.won + o.lost) * 100) : 0,
        wonValue: Math.round(o.wonValue), openValue: Math.round(o.openValue),
        avgDiscount: o.dCount ? Math.round(o.avgDiscount / o.dCount * 10) / 10 : 0,
      })).sort((a, b) => b.wonValue - a.wonValue);
      const lostReasons = {};
      quotes.filter((q) => vf(q, "Status") === "Lost").forEach((q) => { const r = vf(q, "Lost Reason") || "Unknown"; lostReasons[r] = (lostReasons[r] || 0) + 1; });
      jsonResp(res, 200, { reps: rows, lostReasons: Object.entries(lostReasons).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/cpq/reports/ar-aging ───────────────────────────────────
  if (pathname === "/api/cpq/reports/ar-aging" && req.method === "GET") {
    try {
      const invoices = await collect("invoices");
      const open = invoices.filter((i) => num(vf(i, "Balance")) > 0)
        .map((i) => ({ num: vf(i, "Invoice Number"), customer: vf(i, "Customer Name"), order: vf(i, "Order Number"), amount: num(vf(i, "Amount")), paid: num(vf(i, "Amount Paid")), balance: num(vf(i, "Balance")), due: vf(i, "Due Date"), status: vf(i, "Status"), daysPastDue: Math.max(0, daysSince(vf(i, "Due Date")) || 0) }))
        .sort((a, b) => b.daysPastDue - a.daysPastDue || b.balance - a.balance);
      jsonResp(res, 200, { invoices: open });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
