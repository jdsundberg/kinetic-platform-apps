/**
 * gen-seed.mjs — deterministic seed generator for Meridian Capital.
 * Builds a coherent private-mortgage fund: investors fund loans via a cap stack
 * of participations (50K–500K each, ownership % summing to 100), borrowers make
 * P&I payments, investors receive pro-rata distributions, plus fees, contracts
 * and complaints. Re-runs are stable (seeded PRNG). Writes seed-data.json.
 *
 * Usage: node gen-seed.mjs
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);

// ── Deterministic PRNG (mulberry32) ───────────────────────────────────
let _s = 0x1a2b3c4d;
function rnd() {
  _s |= 0; _s = (_s + 0x6d2b79f5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];
const picks = (a, n) => { const c = [...a], o = []; for (let i = 0; i < n && c.length; i++) o.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return o; };
const chance = (p) => rnd() < p;
const intIn = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const round = (n, to) => Math.round(n / to) * to;
const pad = (n, w = 4) => String(n).padStart(w, "0");
const money = (n) => Math.round(n * 100) / 100;

// ── Dates (anchored, deterministic) ───────────────────────────────────
const TODAY = new Date("2026-06-11T00:00:00Z");
const dayMs = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const offD = (n) => iso(TODAY.getTime() + n * dayMs);
const addMonths = (dateStr, m) => { const d = new Date(dateStr); d.setUTCMonth(d.getUTCMonth() + m); return iso(d); };

// ── Reference data ────────────────────────────────────────────────────
const STATES = ["TX", "FL", "CA", "AZ", "GA", "NC", "CO", "TN", "OH", "NV", "WA", "UT", "SC", "ID", "PA"];
const CITY = {
  TX: ["Austin", "Dallas", "Houston", "San Antonio"], FL: ["Miami", "Tampa", "Orlando", "Jacksonville"],
  CA: ["Sacramento", "Riverside", "Fresno", "Oakland"], AZ: ["Phoenix", "Mesa", "Tucson"], GA: ["Atlanta", "Savannah", "Augusta"],
  NC: ["Charlotte", "Raleigh", "Durham"], CO: ["Denver", "Aurora", "Colorado Springs"], TN: ["Nashville", "Memphis", "Knoxville"],
  OH: ["Columbus", "Cleveland", "Cincinnati"], NV: ["Las Vegas", "Reno", "Henderson"], WA: ["Seattle", "Tacoma", "Spokane"],
  UT: ["Salt Lake City", "Provo", "Ogden"], SC: ["Charleston", "Columbia", "Greenville"], ID: ["Boise", "Meridian", "Nampa"],
  PA: ["Philadelphia", "Pittsburgh", "Allentown"],
};
const STREETS = ["Oak", "Maple", "Cedar", "Sunset", "Lakeview", "Highland", "Magnolia", "Birch", "Willow", "Summit", "Park", "River", "Ridge", "Crestview", "Aspen"];
const STYPE = ["St", "Ave", "Dr", "Ln", "Ct", "Blvd", "Way", "Pl"];
const PROP_TYPES = ["Single Family", "Multi-Family", "Townhome", "Condominium", "Mixed-Use", "Commercial Retail", "Office", "Industrial", "Land"];
const LOAN_TYPES = ["Fix & Flip", "Bridge", "Ground-Up Construction", "Rental / DSCR", "Commercial", "Cash-Out Refinance"];
const FIRST = ["James", "Maria", "David", "Sofia", "Daniel", "Grace", "Carlos", "Aisha", "Robert", "Wei", "Priya", "Marcus", "Elena", "Tomás", "Hannah", "Omar", "Linda", "Kevin", "Rachel", "Andre"];
const LAST = ["Whitman", "Castellano", "Okafor", "Bergström", "Nakamura", "Delgado", "Harrington", "Petrov", "Mensah", "Caldwell", "Romano", "Abadi", "Sørensen", "Vance", "Larkin", "Okonkwo", "Ferraro", "Beaumont", "Holt", "Reyes"];
const FUND = "Meridian Capital Partners, LLC";

const out = {};

// ── Investors (10) ────────────────────────────────────────────────────
const INV_NAMES = [
  ["Ironwood Family Office", "Trust"], ["Beacon Hill Capital LLC", "LLC"], ["Pelham Holdings", "LLC"],
  ["R. Castellano IRA", "IRA"], ["Sutter Creek Partners", "Partnership"], ["Harborview Trust", "Trust"],
  ["D. Whitman Revocable Trust", "Trust"], ["Cobalt Lane Investments", "LLC"], ["Meridian GP Co-Invest", "Partnership"],
  ["Stonebridge Ventures", "LLC"],
];
const investors = INV_NAMES.map((n, i) => {
  const committed = round(intIn(4500000, 9000000), 50000);
  return {
    _id: `INV-${pad(101 + i, 3)}`,
    "Investor ID": `INV-${pad(101 + i, 3)}`,
    Name: n[0], "Entity Type": n[1],
    "Contact Name": `${pick(FIRST)} ${pick(LAST)}`,
    Email: `partners@${n[0].toLowerCase().replace(/[^a-z]+/g, "").slice(0, 14)}.com`,
    Phone: `${intIn(201, 989)}-${intIn(200, 989)}-${pad(intIn(0, 9999), 4)}`,
    State: pick(STATES), Accredited: "Yes",
    "Committed Capital": String(committed),
    "Deployed Capital": "0", "Available Capital": String(committed),
    "Target Return": `${intIn(8, 11)}%`,
    Status: "Active", "Join Date": offD(-intIn(120, 1500)),
    Notes: "",
    _committed: committed, _available: committed, _deployed: 0,
  };
});

// ── Loans (50) ────────────────────────────────────────────────────────
const STATUS_DIST = [
  ...Array(28).fill("Performing"), ...Array(4).fill("Watch"), ...Array(3).fill("Delinquent"),
  ...Array(2).fill("Default"), ...Array(1).fill("Foreclosure"), ...Array(8).fill("Paid Off"),
  ...Array(4).fill("Funding"),
];
const loans = [];
for (let i = 1; i <= 50; i++) {
  const st = STATUS_DIST[(i - 1) % STATUS_DIST.length];
  const state = pick(STATES);
  const city = pick(CITY[state]);
  const ptype = pick(PROP_TYPES);
  const ltype = pick(LOAN_TYPES);
  const amount = round(intIn(150000, 2000000), 5000);
  const ltv = intIn(58, 75);
  const value = round(amount / (ltv / 100), 5000);
  const rate = +(intIn(85, 130) / 10).toFixed(2); // 8.5–13.0%
  const term = pick([6, 9, 12, 12, 18, 24]);
  const ageMonths = st === "Funding" ? 0 : intIn(1, Math.min(term, 10));
  const orig = addMonths(offD(0), -ageMonths);
  const maturity = addMonths(orig, term);
  const monthly = money(amount * (rate / 100) / 12); // interest-only
  const paidOff = st === "Paid Off";
  const balance = paidOff ? 0 : amount; // interest-only → principal constant until payoff
  const origFeePts = +(intIn(15, 30) / 10).toFixed(1); // 1.5–3.0 points
  loans.push({
    _id: `ML-${pad(2000 + i, 4)}`,
    "Loan ID": `ML-${pad(2000 + i, 4)}`,
    "Loan Name": `${city} ${ptype} — ${pick(STREETS)} ${pick(STYPE)}`,
    Borrower: `${pick(FIRST)} ${pick(LAST)}`,
    "Borrower Entity": chance(0.6) ? `${pick(["Summit", "Apex", "Cornerstone", "Vanguard", "Lone Star", "Blue Sky", "Redstone"])} ${pick(["Homes", "Holdings", "Developments", "Capital", "Properties"])} LLC` : "",
    "Property Address": `${intIn(100, 9899)} ${pick(STREETS)} ${pick(STYPE)}`,
    City: city, State: state, "Property Type": ptype, "Loan Type": ltype,
    "Loan Amount": String(amount), "Property Value": String(value), LTV: `${ltv}%`,
    "Interest Rate": `${rate}%`, "Term Months": String(term),
    "Origination Date": orig, "Maturity Date": maturity, Status: st,
    "Lien Position": chance(0.85) ? "1st Lien" : "2nd Lien",
    "Payment Type": chance(0.8) ? "Interest Only" : "Amortizing",
    "Monthly Payment": String(monthly), "Principal Balance": String(balance),
    "Total Funded": String(st === "Funding" ? 0 : amount),
    "Origination Fee": String(money(amount * origFeePts / 100)),
    "Servicing Fee Rate": `${(intIn(5, 15) / 10).toFixed(1)}%`,
    "Investor Count": "0",
    Notes: "",
    _amount: amount, _rate: rate, _orig: orig, _ageMonths: ageMonths, _status: st,
    _monthly: monthly, _origFeePts: origFeePts, _parts: [], _funding: st === "Funding",
  });
}

// ── Participations (cap stack per funded loan) ────────────────────────
const participations = [];
let partN = 0;
// Split a loan amount into k chunks each in [50K,500K], rounded to 5K, summing exactly.
function capStack(amount) {
  const MAXC = 500000, MINC = 50000;
  let k = Math.max(1, Math.ceil(amount / MAXC));
  while (amount / k < MINC && k > 1) k--; // don't force sub-50K chunks
  const chunks = [];
  let left = amount;
  for (let j = 0; j < k - 1; j++) {
    let c = round(amount / k, 5000);
    c = Math.min(MAXC, Math.max(MINC, c));
    c = Math.min(c, left - MINC * (k - 1 - j)); // leave room for remaining chunks
    chunks.push(c); left -= c;
  }
  chunks.push(left); // last chunk absorbs rounding; bounded by construction
  return chunks;
}
for (const loan of loans) {
  if (loan._funding) continue; // not yet funded
  const chunks = capStack(loan._amount).sort((a, b) => b - a); // largest first
  for (const amt of chunks) {
    // pick the investor with the most available capital that can cover this chunk
    // and isn't already in this loan's stack
    const used = new Set(loan._parts.map((p) => p.iv._id));
    const cand = investors
      .filter((iv) => !used.has(iv._id) && iv._available >= amt)
      .sort((a, b) => b._available - a._available)[0];
    if (!cand) continue; // (won't happen with sufficient committed capital)
    cand._available -= amt; cand._deployed += amt;
    loan._parts.push({ iv: cand, amt });
  }
  loan["Investor Count"] = String(loan._parts.length);
  const total = loan._parts.reduce((s, p) => s + p.amt, 0) || 1;
  for (const p of loan._parts) {
    partN++;
    const pct = +(p.amt / total * 100).toFixed(2);
    const pStatus = loan._status === "Paid Off" ? "Repaid" : ["Default", "Foreclosure"].includes(loan._status) ? "Defaulted" : "Active";
    const partObj = {
      "Participation ID": `PART-${pad(partN, 5)}`,
      Investor: p.iv["Investor ID"], "Investor Name": p.iv.Name,
      Loan: loan["Loan ID"], "Loan Name": loan["Loan Name"],
      Amount: String(p.amt), "Ownership Percentage": `${pct}%`,
      "Expected Return Rate": `${(loan._rate - 1).toFixed(2)}%`,
      "Funded Date": loan._orig, Status: pStatus, "Distributions Paid": "0", Notes: "",
    };
    p._partObj = partObj; p._pct = pct / 100;
    participations.push(partObj);
  }
}
out.participations = participations;

// ── Payments: borrower P&I + investor distributions ───────────────────
const payments = [];
let payN = 0;
for (const loan of loans) {
  if (loan._funding || !loan._parts.length) continue;
  const monthsPaid = loan._status === "Paid Off" ? loan._ageMonths : Math.max(0, loan._ageMonths - (["Delinquent", "Default", "Foreclosure"].includes(loan._status) ? intIn(1, 2) : 0));
  for (let m = 1; m <= monthsPaid; m++) {
    const due = addMonths(loan._orig, m);
    const interest = loan._monthly;
    payN++;
    const late = chance(0.06);
    payments.push({
      "Payment ID": `PMT-${pad(payN, 6)}`, "Payment Type": "Borrower Payment", Direction: "Inbound",
      Loan: loan["Loan ID"], "Loan Name": loan["Loan Name"], Investor: "", "Investor Name": "",
      Amount: String(interest), "Principal Portion": "0", "Interest Portion": String(interest), "Fee Portion": late ? String(money(interest * 0.05)) : "0",
      "Due Date": due, "Paid Date": late ? addMonths(due, 0) : due, Status: late ? "Late" : "Paid", Method: pick(["ACH", "Wire", "ACH", "Check"]), Notes: late ? "Late fee applied" : "",
    });
    // distributions to investors pro-rata
    for (const p of loan._parts) {
      payN++;
      const dist = money(interest * p._pct);
      p._partObj["Distributions Paid"] = String(money(parseFloat(p._partObj["Distributions Paid"]) + dist));
      payments.push({
        "Payment ID": `PMT-${pad(payN, 6)}`, "Payment Type": "Investor Distribution", Direction: "Outbound",
        Loan: loan["Loan ID"], "Loan Name": loan["Loan Name"], Investor: p.iv["Investor ID"], "Investor Name": p.iv.Name,
        Amount: String(dist), "Principal Portion": "0", "Interest Portion": String(dist), "Fee Portion": "0",
        "Due Date": due, "Paid Date": due, Status: "Paid", Method: "ACH", Notes: "",
      });
    }
  }
  // payoff principal return on Paid Off loans
  if (loan._status === "Paid Off") {
    const due = addMonths(loan._orig, loan._ageMonths);
    payN++;
    payments.push({
      "Payment ID": `PMT-${pad(payN, 6)}`, "Payment Type": "Borrower Payment", Direction: "Inbound",
      Loan: loan["Loan ID"], "Loan Name": loan["Loan Name"], Investor: "", "Investor Name": "",
      Amount: String(loan._amount), "Principal Portion": String(loan._amount), "Interest Portion": "0", "Fee Portion": "0",
      "Due Date": due, "Paid Date": due, Status: "Paid", Method: "Wire", Notes: "Loan payoff — principal returned",
    });
    for (const p of loan._parts) {
      payN++;
      payments.push({
        "Payment ID": `PMT-${pad(payN, 6)}`, "Payment Type": "Investor Distribution", Direction: "Outbound",
        Loan: loan["Loan ID"], "Loan Name": loan["Loan Name"], Investor: p.iv["Investor ID"], "Investor Name": p.iv.Name,
        Amount: String(p.amt), "Principal Portion": String(p.amt), "Interest Portion": "0", "Fee Portion": "0",
        "Due Date": due, "Paid Date": due, Status: "Paid", Method: "Wire", Notes: "Principal return on payoff",
      });
    }
  }
  // a missed/scheduled upcoming payment for delinquents
  if (["Delinquent", "Default", "Foreclosure"].includes(loan._status)) {
    payN++;
    payments.push({
      "Payment ID": `PMT-${pad(payN, 6)}`, "Payment Type": "Borrower Payment", Direction: "Inbound",
      Loan: loan["Loan ID"], "Loan Name": loan["Loan Name"], Investor: "", "Investor Name": "",
      Amount: String(loan._monthly), "Principal Portion": "0", "Interest Portion": String(loan._monthly), "Fee Portion": "0",
      "Due Date": addMonths(loan._orig, loan._ageMonths), "Paid Date": "", Status: "Missed", Method: "", Notes: "Payment past due",
    });
  }
}
out.payments = payments;

// ── Fees ──────────────────────────────────────────────────────────────
const fees = [];
let feeN = 0;
for (const loan of loans) {
  if (loan._funding) continue;
  feeN++;
  fees.push({
    "Fee ID": `FEE-${pad(feeN, 5)}`, "Fee Type": "Origination", Loan: loan["Loan ID"], "Loan Name": loan["Loan Name"],
    Amount: String(money(loan._amount * loan._origFeePts / 100)), "Charged Date": loan._orig,
    Status: "Collected", Beneficiary: "Fund", Notes: `${loan._origFeePts} points`,
  });
  if (loan._ageMonths >= 2) {
    feeN++;
    fees.push({
      "Fee ID": `FEE-${pad(feeN, 5)}`, "Fee Type": "Servicing", Loan: loan["Loan ID"], "Loan Name": loan["Loan Name"],
      Amount: String(money(loan._amount * 0.01 / 12 * loan._ageMonths)), "Charged Date": offD(-intIn(1, 30)),
      Status: "Collected", Beneficiary: "Servicer", Notes: "Accrued servicing fee",
    });
  }
  if (["Delinquent", "Default", "Foreclosure"].includes(loan._status)) {
    feeN++;
    fees.push({
      "Fee ID": `FEE-${pad(feeN, 5)}`, "Fee Type": pick(["Late", "Default Interest"]), Loan: loan["Loan ID"], "Loan Name": loan["Loan Name"],
      Amount: String(money(loan._monthly * pick([0.05, 0.1, 0.5]))), "Charged Date": offD(-intIn(1, 25)),
      Status: "Outstanding", Beneficiary: "Fund", Notes: "Past-due charge",
    });
  }
  if (loan._status === "Paid Off" && chance(0.4)) {
    feeN++;
    fees.push({
      "Fee ID": `FEE-${pad(feeN, 5)}`, "Fee Type": "Exit / Prepayment", Loan: loan["Loan ID"], "Loan Name": loan["Loan Name"],
      Amount: String(money(loan._amount * 0.01)), "Charged Date": addMonths(loan._orig, loan._ageMonths),
      Status: "Collected", Beneficiary: "Fund", Notes: "1% exit fee",
    });
  }
}
out.fees = fees;

// ── Contracts ─────────────────────────────────────────────────────────
const contracts = [];
let conN = 0;
for (const loan of loans) {
  const types = loan._funding
    ? [["Loan Agreement", "Draft"]]
    : [["Promissory Note", "Executed"], ["Deed of Trust", "Executed"], ...(chance(0.7) ? [["Personal Guaranty", "Executed"]] : [])];
  for (const [t, stt] of types) {
    conN++;
    contracts.push({
      "Contract ID": `CTR-${pad(3000 + conN, 5)}`, "Contract Type": t, "Related Loan": loan["Loan ID"], "Related Investor": "",
      Party: loan["Borrower Entity"] || loan.Borrower, Status: stt, "Effective Date": loan._orig,
      "Expiration Date": loan["Maturity Date"], Amount: String(loan._amount), "Document Link": `https://docs.meridiancap.example/${loan["Loan ID"]}/${t.replace(/\W+/g, "-").toLowerCase()}.pdf`, Notes: "",
    });
  }
}
for (const iv of investors) {
  conN++;
  contracts.push({
    "Contract ID": `CTR-${pad(3000 + conN, 5)}`, "Contract Type": "Subscription Agreement", "Related Loan": "", "Related Investor": iv["Investor ID"],
    Party: iv.Name, Status: "Executed", "Effective Date": iv["Join Date"], "Expiration Date": "",
    Amount: iv["Committed Capital"], "Document Link": `https://docs.meridiancap.example/${iv["Investor ID"]}/subscription.pdf`, Notes: "Fund subscription",
  });
}
out.contracts = contracts;

// ── Complaints (15) ───────────────────────────────────────────────────
const CMP = [
  ["Borrower", "Payment Dispute", "Borrower disputes a late fee assessment on the monthly interest payment."],
  ["Investor", "Returns", "Investor inquiry on lower-than-projected distribution for the quarter."],
  ["Borrower", "Servicing", "Borrower reports a delayed payoff statement from the servicer."],
  ["Investor", "Communication", "Investor requests more frequent reporting on a watch-list loan."],
  ["Borrower", "Foreclosure", "Borrower contests foreclosure timeline and requests forbearance."],
  ["Investor", "Disclosure", "Investor asks for updated LTV and appraisal documentation."],
  ["Borrower", "Fees", "Borrower questions the default-interest calculation."],
  ["Regulator", "Disclosure", "State regulator routine inquiry on lending disclosures."],
  ["Investor", "Returns", "Investor seeks clarification on principal return timing for a paid-off loan."],
  ["Borrower", "Communication", "Borrower could not reach the servicing line for two days."],
  ["Investor", "Servicing", "Investor flags a distribution that posted a day late."],
  ["Borrower", "Payment Dispute", "Borrower claims a wire payment was not credited."],
  ["Investor", "Disclosure", "Investor requests the deed of trust copy for a participation."],
  ["Borrower", "Fees", "Borrower disputes an extension fee."],
  ["Third Party", "Other", "Title company requests payoff confirmation."],
];
const fundedLoans = loans.filter((l) => !l._funding);
out.complaints = CMP.map((c, i) => {
  const open = -intIn(1, 120);
  const resolved = chance(0.6);
  const stt = resolved ? pick(["Resolved", "Closed"]) : pick(["Open", "Investigating", "Escalated"]);
  const loan = c[0] === "Borrower" ? pick(fundedLoans) : null;
  const inv = c[0] === "Investor" ? pick(investors) : null;
  const sev = c[1] === "Foreclosure" || c[0] === "Regulator" ? "High" : pick(["Low", "Medium", "Medium", "High"]);
  return {
    "Complaint ID": `CMP-${pad(4000 + i + 1, 5)}`, Source: c[0],
    Complainant: c[0] === "Borrower" ? (loan?.Borrower || "Borrower") : c[0] === "Investor" ? (inv?.Name || "Investor") : c[0],
    "Related Loan": loan?.["Loan ID"] || "", "Related Investor": inv?.["Investor ID"] || "",
    Category: c[1], Severity: sev, Status: stt,
    "Opened Date": offD(open), "Resolved Date": resolved ? offD(open + intIn(2, 20)) : "",
    "Assigned To": pick(["A. Reyes (Servicing)", "M. Holt (Compliance)", "Investor Relations", "L. Vance (Legal)"]),
    Description: c[2], Resolution: resolved ? "Reviewed and resolved with the complainant; documented in the loan file." : "", Notes: "",
  };
});

// ── Finalize investors (deployed/available rounded) ───────────────────
out.investors = investors.map((iv) => ({
  "Investor ID": iv["Investor ID"], Name: iv.Name, "Entity Type": iv["Entity Type"],
  "Contact Name": iv["Contact Name"], Email: iv.Email, Phone: iv.Phone, State: iv.State, Accredited: iv.Accredited,
  "Committed Capital": String(iv._committed), "Deployed Capital": String(iv._deployed),
  "Available Capital": String(Math.max(0, iv._committed - iv._deployed)),
  "Target Return": iv["Target Return"],
  Status: iv._deployed >= iv._committed * 0.95 ? "Fully Deployed" : "Active",
  "Join Date": iv["Join Date"], Notes: "",
}));
out.loans = loans.map(({ _id, _amount, _rate, _orig, _ageMonths, _status, _monthly, _origFeePts, _parts, _funding, ...rest }) => rest);

// ── Write ─────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(DIR, "seed-data.json"), JSON.stringify(out, null, 2));
const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
console.log("✓ seed-data.json written:");
for (const [k, n] of Object.entries(counts)) console.log(`   ${k.padEnd(15)} ${n}`);
console.log(`   ${"TOTAL".padEnd(15)} ${Object.values(counts).reduce((a, b) => a + b, 0)} records`);
// sanity: total deployed vs funded loans
const deployed = out.investors.reduce((s, i) => s + (+i["Deployed Capital"]), 0);
const fundedAmt = out.loans.filter((l) => l.Status !== "Funding").reduce((s, l) => s + (+l["Loan Amount"]), 0);
console.log(`   deployed=$${deployed.toLocaleString()} vs funded-loan principal=$${fundedAmt.toLocaleString()}`);
