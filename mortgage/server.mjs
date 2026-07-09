/**
 * Meridian Capital — Custom API Handler
 * Server-side aggregation for the fund dashboard, loan 360, investor 360,
 * and portfolio / investor reports. Private-mortgage debt fund.
 *
 * Auto-discovered by apps/base/server.mjs (exports apiPrefix + handleAPI).
 */
export const appId = "mortgage";
export const apiPrefix = "/api/mortgage";
export const kapp = "mortgage";

// parse "$1,250.50", "12.5%", "1.0%" → number
const num = (v) => {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
};
const TODAY = new Date("2026-06-11T00:00:00Z").getTime();
const DAY = 86400000;
const daysFromToday = (s) => { const t = new Date(s).getTime(); return isNaN(t) ? null : Math.round((t - TODAY) / DAY); };

const ACTIVE = ["Performing", "Watch", "Delinquent", "Default", "Foreclosure"];
const AT_RISK = ["Watch", "Delinquent", "Default", "Foreclosure"];
const DISTRESSED = ["Delinquent", "Default", "Foreclosure"];

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, vf } = helpers;
  const KAPP = kapp;
  const collect = (formSlug, kql, maxPages = 12) => collectByQuery(KAPP, formSlug, kql, auth, maxPages);

  const groupCount = (rows, field) => {
    const m = {};
    rows.forEach((r) => { const k = vf(r, field) || "Other"; m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  };

  // ── GET /api/mortgage/dashboard ─────────────────────────────────────
  if (pathname === "/api/mortgage/dashboard" && req.method === "GET") {
    try {
      const [loans, investors, parts, payments, fees, complaints] = await Promise.all([
        collect("loans"), collect("investors"), collect("participations"),
        collect("payments"), collect("fees"), collect("complaints"),
      ]);

      const active = loans.filter((l) => ACTIVE.includes(vf(l, "Status")));
      const paidOff = loans.filter((l) => vf(l, "Status") === "Paid Off");
      const funding = loans.filter((l) => vf(l, "Status") === "Funding");
      const distressed = loans.filter((l) => DISTRESSED.includes(vf(l, "Status")));

      const principalOutstanding = active.reduce((s, l) => s + num(vf(l, "Principal Balance")), 0);
      const originatedTotal = loans.reduce((s, l) => s + num(vf(l, "Loan Amount")), 0);

      // weighted avg yield + avg LTV over active loans
      const wAmt = active.reduce((s, l) => s + num(vf(l, "Loan Amount")), 0) || 1;
      const wYield = active.reduce((s, l) => s + num(vf(l, "Loan Amount")) * num(vf(l, "Interest Rate")), 0) / wAmt;
      const avgLTV = active.length ? active.reduce((s, l) => s + num(vf(l, "LTV")), 0) / active.length : 0;

      const committed = investors.reduce((s, i) => s + num(vf(i, "Committed Capital")), 0);
      const deployed = investors.reduce((s, i) => s + num(vf(i, "Deployed Capital")), 0);
      const available = investors.reduce((s, i) => s + num(vf(i, "Available Capital")), 0);

      const borrowerPays = payments.filter((p) => vf(p, "Payment Type") === "Borrower Payment");
      const interestCollected = borrowerPays.filter((p) => ["Paid", "Late"].includes(vf(p, "Status")))
        .reduce((s, p) => s + num(vf(p, "Interest Portion")), 0);
      const distributions = payments.filter((p) => vf(p, "Payment Type") === "Investor Distribution" && vf(p, "Status") === "Paid")
        .reduce((s, p) => s + num(vf(p, "Amount")), 0);
      const missed = borrowerPays.filter((p) => ["Missed", "Late"].includes(vf(p, "Status"))).length;

      const feesCollected = fees.filter((f) => vf(f, "Status") === "Collected").reduce((s, f) => s + num(vf(f, "Amount")), 0);
      const feesOutstanding = fees.filter((f) => vf(f, "Status") === "Outstanding").reduce((s, f) => s + num(vf(f, "Amount")), 0);

      const openComplaints = complaints.filter((c) => !["Resolved", "Closed"].includes(vf(c, "Status"))).length;

      const delinquencyRate = active.length ? Math.round(distressed.length / active.length * 100) : 0;

      // upcoming maturities (next 90 days)
      const maturing = active
        .map((l) => ({ l, d: daysFromToday(vf(l, "Maturity Date")) }))
        .filter((x) => x.d != null && x.d >= 0 && x.d <= 90)
        .sort((a, b) => a.d - b.d);

      // capital by investor (top)
      const invDeploy = investors
        .map((i) => ({ name: vf(i, "Name"), count: num(vf(i, "Deployed Capital")) }))
        .sort((a, b) => b.count - a.count);

      jsonResp(res, 200, {
        kpis: {
          aum: principalOutstanding,
          activeLoans: active.length,
          paidOff: paidOff.length,
          funding: funding.length,
          originatedTotal,
          committed, deployed, available,
          deploymentRate: committed ? Math.round(deployed / committed * 100) : 0,
          weightedYield: +wYield.toFixed(2),
          avgLTV: Math.round(avgLTV),
          delinquencyRate,
          distressed: distressed.length,
          interestCollected, distributions, feesCollected, feesOutstanding,
          missedPayments: missed,
          openComplaints,
          investorCount: investors.length,
        },
        byStatus: groupCount(loans, "Status"),
        byState: groupCount(loans, "State").slice(0, 10),
        byPropertyType: groupCount(loans, "Property Type"),
        byLoanType: groupCount(loans, "Loan Type"),
        capitalByInvestor: invDeploy,
        atRisk: distressed.concat(loans.filter((l) => vf(l, "Status") === "Watch"))
          .map((l) => ({
            id: l.id, lid: vf(l, "Loan ID"), name: vf(l, "Loan Name"), state: vf(l, "State"),
            status: vf(l, "Status"), amount: vf(l, "Loan Amount"), rate: vf(l, "Interest Rate"),
            borrower: vf(l, "Borrower"), ltv: vf(l, "LTV"),
          })),
        maturing: maturing.slice(0, 10).map((x) => ({
          id: x.l.id, lid: vf(x.l, "Loan ID"), name: vf(x.l, "Loan Name"),
          maturity: vf(x.l, "Maturity Date"), daysLeft: x.d, amount: vf(x.l, "Loan Amount"), status: vf(x.l, "Status"),
        })),
        topLoans: active.slice().sort((a, b) => num(vf(b, "Loan Amount")) - num(vf(a, "Loan Amount"))).slice(0, 10)
          .map((l) => ({
            id: l.id, lid: vf(l, "Loan ID"), name: vf(l, "Loan Name"), state: vf(l, "State"),
            type: vf(l, "Loan Type"), amount: vf(l, "Loan Amount"), rate: vf(l, "Interest Rate"),
            ltv: vf(l, "LTV"), status: vf(l, "Status"), investors: vf(l, "Investor Count"),
          })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/mortgage/loan/:id — Loan 360 ───────────────────────────
  const lm = pathname.match(/^\/api\/mortgage\/loan\/(.+)$/);
  if (lm && req.method === "GET") {
    const id = decodeURIComponent(lm[1]);
    try {
      const r = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const loan = r.data?.submission;
      if (!loan) { jsonResp(res, 404, { error: "Loan not found" }); return true; }
      const lid = vf(loan, "Loan ID");
      const q = `values[Loan]="${lid.replace(/"/g, '\\"')}"`;
      const ql = `values[Related Loan]="${lid.replace(/"/g, '\\"')}"`;
      const [parts, payments, fees, contracts, complaints] = await Promise.all([
        collect("participations", q), collect("payments", q), collect("fees", q),
        collect("contracts", ql), collect("complaints", ql),
      ]);
      const interestPaid = payments.filter((p) => vf(p, "Payment Type") === "Borrower Payment" && ["Paid", "Late"].includes(vf(p, "Status")))
        .reduce((s, p) => s + num(vf(p, "Interest Portion")), 0);
      const principalPaid = payments.filter((p) => vf(p, "Payment Type") === "Borrower Payment")
        .reduce((s, p) => s + num(vf(p, "Principal Portion")), 0);
      const feesCharged = fees.reduce((s, f) => s + num(vf(f, "Amount")), 0);
      jsonResp(res, 200, {
        loan,
        summary: {
          funded: num(vf(loan, "Total Funded")) || num(vf(loan, "Loan Amount")),
          investorCount: parts.length,
          interestPaid, principalPaid, feesCharged,
          monthlyPayment: num(vf(loan, "Monthly Payment")),
          balance: num(vf(loan, "Principal Balance")),
        },
        capStack: parts.sort((a, b) => num(vf(b, "Amount")) - num(vf(a, "Amount"))).map((p) => ({
          investor: vf(p, "Investor Name"), amount: vf(p, "Amount"), pct: vf(p, "Ownership Percentage"),
          expected: vf(p, "Expected Return Rate"), distributions: vf(p, "Distributions Paid"), status: vf(p, "Status"),
        })),
        payments: payments.sort((a, b) => (vf(b, "Due Date") || "").localeCompare(vf(a, "Due Date") || "")).slice(0, 30).map((p) => ({
          pid: vf(p, "Payment ID"), type: vf(p, "Payment Type"), party: vf(p, "Investor Name") || vf(p, "Loan Name"),
          amount: vf(p, "Amount"), interest: vf(p, "Interest Portion"), principal: vf(p, "Principal Portion"),
          due: vf(p, "Due Date"), status: vf(p, "Status"),
        })),
        fees: fees.map((f) => ({ type: vf(f, "Fee Type"), amount: vf(f, "Amount"), status: vf(f, "Status"), date: vf(f, "Charged Date") })),
        contracts: contracts.map((c) => ({ type: vf(c, "Contract Type"), party: vf(c, "Party"), status: vf(c, "Status"), effective: vf(c, "Effective Date") })),
        complaints: complaints.map((c) => ({ cid: vf(c, "Complaint ID"), category: vf(c, "Category"), severity: vf(c, "Severity"), status: vf(c, "Status"), desc: vf(c, "Description") })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/mortgage/investor/:id — Investor 360 ───────────────────
  const im = pathname.match(/^\/api\/mortgage\/investor\/(.+)$/);
  if (im && req.method === "GET") {
    const id = decodeURIComponent(im[1]);
    try {
      const r = await kineticRequest("GET", `/submissions/${id}?include=values`, null, auth);
      const inv = r.data?.submission;
      if (!inv) { jsonResp(res, 404, { error: "Investor not found" }); return true; }
      const iid = vf(inv, "Investor ID");
      const q = `values[Investor]="${iid.replace(/"/g, '\\"')}"`;
      const [parts, payments, contracts] = await Promise.all([
        collect("participations", q), collect("payments", q),
        collect("contracts", `values[Related Investor]="${iid.replace(/"/g, '\\"')}"`),
      ]);
      const distributions = payments.filter((p) => vf(p, "Payment Type") === "Investor Distribution" && vf(p, "Status") === "Paid")
        .reduce((s, p) => s + num(vf(p, "Amount")), 0);
      const interestDist = payments.filter((p) => vf(p, "Payment Type") === "Investor Distribution" && vf(p, "Status") === "Paid")
        .reduce((s, p) => s + num(vf(p, "Interest Portion")), 0);
      const activeParts = parts.filter((p) => vf(p, "Status") === "Active");
      const avgReturn = parts.length ? parts.reduce((s, p) => s + num(vf(p, "Expected Return Rate")), 0) / parts.length : 0;
      jsonResp(res, 200, {
        investor: inv,
        summary: {
          committed: num(vf(inv, "Committed Capital")),
          deployed: num(vf(inv, "Deployed Capital")),
          available: num(vf(inv, "Available Capital")),
          loans: parts.length, activeLoans: activeParts.length,
          distributions, interestEarned: interestDist,
          avgReturn: +avgReturn.toFixed(2),
        },
        participations: parts.sort((a, b) => num(vf(b, "Amount")) - num(vf(a, "Amount"))).map((p) => ({
          loan: vf(p, "Loan Name"), loanId: vf(p, "Loan"), amount: vf(p, "Amount"), pct: vf(p, "Ownership Percentage"),
          expected: vf(p, "Expected Return Rate"), distributions: vf(p, "Distributions Paid"), status: vf(p, "Status"),
        })),
        distributionsList: payments.filter((p) => vf(p, "Payment Type") === "Investor Distribution")
          .sort((a, b) => (vf(b, "Paid Date") || "").localeCompare(vf(a, "Paid Date") || "")).slice(0, 20)
          .map((p) => ({ loan: vf(p, "Loan Name"), amount: vf(p, "Amount"), date: vf(p, "Paid Date"), status: vf(p, "Status") })),
        contracts: contracts.map((c) => ({ type: vf(c, "Contract Type"), status: vf(c, "Status"), effective: vf(c, "Effective Date"), amount: vf(c, "Amount") })),
      });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/mortgage/reports/portfolio ─────────────────────────────
  if (pathname === "/api/mortgage/reports/portfolio" && req.method === "GET") {
    try {
      const [loans, payments] = await Promise.all([collect("loans"), collect("payments")]);
      const interestByLoan = {};
      payments.filter((p) => vf(p, "Payment Type") === "Borrower Payment" && ["Paid", "Late"].includes(vf(p, "Status")))
        .forEach((p) => { const l = vf(p, "Loan"); interestByLoan[l] = (interestByLoan[l] || 0) + num(vf(p, "Interest Portion")); });
      const rows = loans.map((l) => ({
        lid: vf(l, "Loan ID"), id: l.id, name: vf(l, "Loan Name"), state: vf(l, "State"),
        type: vf(l, "Loan Type"), propertyType: vf(l, "Property Type"),
        amount: num(vf(l, "Loan Amount")), balance: num(vf(l, "Principal Balance")),
        rate: num(vf(l, "Interest Rate")), ltv: num(vf(l, "LTV")), status: vf(l, "Status"),
        investors: num(vf(l, "Investor Count")), interestPaid: Math.round(interestByLoan[vf(l, "Loan ID")] || 0),
      })).sort((a, b) => b.amount - a.amount);
      jsonResp(res, 200, { loans: rows });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  // ── GET /api/mortgage/reports/investors ─────────────────────────────
  if (pathname === "/api/mortgage/reports/investors" && req.method === "GET") {
    try {
      const [investors, parts, payments] = await Promise.all([
        collect("investors"), collect("participations"), collect("payments"),
      ]);
      const distByInv = {};
      payments.filter((p) => vf(p, "Payment Type") === "Investor Distribution" && vf(p, "Status") === "Paid")
        .forEach((p) => { const i = vf(p, "Investor"); distByInv[i] = (distByInv[i] || 0) + num(vf(p, "Amount")); });
      const loansByInv = {};
      parts.forEach((p) => { const i = vf(p, "Investor"); (loansByInv[i] = loansByInv[i] || new Set()).add(vf(p, "Loan")); });
      const rows = investors.map((iv) => {
        const iid = vf(iv, "Investor ID");
        const committed = num(vf(iv, "Committed Capital")), deployed = num(vf(iv, "Deployed Capital"));
        return {
          iid, id: iv.id, name: vf(iv, "Name"), entity: vf(iv, "Entity Type"), state: vf(iv, "State"),
          committed, deployed, available: num(vf(iv, "Available Capital")),
          utilization: committed ? Math.round(deployed / committed * 100) : 0,
          loans: (loansByInv[iid] || new Set()).size,
          distributions: Math.round(distByInv[iid] || 0),
          status: vf(iv, "Status"),
        };
      }).sort((a, b) => b.deployed - a.deployed);
      jsonResp(res, 200, { investors: rows });
    } catch (e) { jsonResp(res, 500, { error: e.message }); }
    return true;
  }

  return false;
}
