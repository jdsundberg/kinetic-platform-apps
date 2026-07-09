/**
 * gen-seed.mjs — deterministic seed generator for Ironline CPQ.
 *
 * Builds a coherent industrial-equipment quote-to-cash dataset:
 *   products (+ options) → price rules → customers → quotes (+ quote-lines)
 *   → approvals → orders → invoices → payments.
 *
 * Line items sum exactly to quote headers; approvals are created precisely for
 * quotes that breach a discount/margin threshold; won quotes chain into orders,
 * invoices and payments. The generator deliberately seeds BLOCKAGES so the
 * money-flow visuals have something to show:
 *   • quotes left to rot in a pipeline stage (Stage Entered Date far in past)
 *   • approvals aged past their SLA (the approval bottleneck)
 *   • won quotes never converted to orders (cash-conversion leak)
 *   • invoices past due and unpaid (aging receivables)
 *
 * Re-runs are stable (seeded PRNG). Writes seed-data.json keyed by form slug.
 * Usage: node gen-seed.mjs
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────
let _s = 0x51f2c3a7;
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
const money = (n) => Math.round(n);
const pct = (n) => Math.round(n * 10) / 10;
const pad = (n, w = 4) => String(n).padStart(w, "0");

// ── Dates (anchored, deterministic) ──────────────────────────────────
const TODAY = new Date("2026-06-18T00:00:00Z");
const dayMs = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const offD = (n) => iso(TODAY.getTime() + n * dayMs);   // n days from today (neg = past)
const addDays = (dateStr, n) => iso(new Date(dateStr).getTime() + n * dayMs);

// ── Reference data ───────────────────────────────────────────────────
const CATEGORIES = {
  "Conveyor Systems":        { fam: "Material Handling", lo: 18000, hi: 240000, cm: [0.30, 0.42], lt: [45, 120] },
  "Pumps & Compressors":     { fam: "Fluid Power",       lo: 6000,  hi: 95000,  cm: [0.28, 0.40], lt: [21, 70] },
  "Hydraulic Power Units":   { fam: "Fluid Power",       lo: 9000,  hi: 120000, cm: [0.26, 0.38], lt: [30, 90] },
  "Control Panels":          { fam: "Automation",        lo: 4000,  hi: 60000,  cm: [0.34, 0.48], lt: [25, 75] },
  "Motors & Drives":         { fam: "Automation",        lo: 2500,  hi: 48000,  cm: [0.30, 0.44], lt: [14, 56] },
  "Sensors & Instrumentation":{ fam: "Automation",       lo: 800,   hi: 22000,  cm: [0.38, 0.55], lt: [10, 35] },
  "Robotic Cells":           { fam: "Material Handling", lo: 65000, hi: 480000, cm: [0.24, 0.36], lt: [60, 150] },
  "Safety Systems":          { fam: "EHS",               lo: 3000,  hi: 55000,  cm: [0.36, 0.50], lt: [20, 60] },
};
const CAT_NAMES = Object.keys(CATEGORIES);
const PRODUCT_NOUNS = {
  "Conveyor Systems": ["Belt Conveyor", "Roller Conveyor", "Spiral Conveyor", "Sortation Module", "Accumulation Line", "Overhead Conveyor"],
  "Pumps & Compressors": ["Centrifugal Pump", "Rotary Screw Compressor", "Diaphragm Pump", "Vacuum Pump", "Reciprocating Compressor"],
  "Hydraulic Power Units": ["HPU 30HP", "HPU 60HP", "Compact Power Pack", "Servo Hydraulic Unit", "Mobile Power Unit"],
  "Control Panels": ["PLC Control Panel", "Motor Control Center", "HMI Operator Station", "Distribution Panel", "VFD Cabinet"],
  "Motors & Drives": ["AC Induction Motor", "Servo Drive", "Gear Motor", "Variable Frequency Drive", "Brake Motor"],
  "Sensors & Instrumentation": ["Flow Meter", "Pressure Transmitter", "Proximity Sensor Array", "Vision Sensor", "Level Probe"],
  "Robotic Cells": ["6-Axis Pick Cell", "Palletizing Cell", "Welding Cell", "Machine Tending Cell", "Assembly Robot Cell"],
  "Safety Systems": ["Light Curtain Set", "Safety PLC Bundle", "E-Stop Network", "Area Scanner", "Lockout Station Kit"],
};
const SERIES = ["IX", "PRO", "MAX", "HD", "EX", "S", "G3", "Ultra", "Compact", "Heavy"];

const OPTION_GROUPS = {
  Voltage: [["208V 3-Phase", 0, 0], ["480V 3-Phase", 1200, 700], ["600V 3-Phase", 2400, 1400]],
  Capacity: [["Standard Throughput", 0, 0], ["High Throughput +25%", 8500, 5200], ["Max Throughput +50%", 18000, 11500]],
  Controls: [["Basic PLC", 0, 0], ["Advanced PLC + HMI", 6500, 3800], ["SCADA Integration", 14000, 8600]],
  Finish: [["Powder Coat", 0, 0], ["Stainless 304", 4200, 2700], ["Washdown / Stainless 316", 9800, 6400]],
  Warranty: [["1-Year Standard", 0, 0], ["3-Year Extended", 3500, 900], ["5-Year Platinum", 7800, 2100]],
  Installation: [["Customer Install", 0, 0], ["Supervised Startup", 5500, 3400], ["Turnkey Installation", 16500, 11200]],
};
const OPT_GROUP_NAMES = Object.keys(OPTION_GROUPS);

const SEGMENTS = ["Enterprise", "Mid-Market", "SMB", "Government"];
const INDUSTRIES = ["Automotive", "Food & Beverage", "Pharmaceutical", "Oil & Gas", "Mining & Metals", "Logistics", "Aerospace", "Consumer Goods"];
const REGIONS = ["West", "Midwest", "Northeast", "Southeast", "Southwest"];
const REGION_STATES = {
  West: ["CA", "WA", "OR", "NV", "AZ"], Midwest: ["IL", "OH", "MI", "WI", "MN"],
  Northeast: ["NY", "PA", "MA", "NJ", "CT"], Southeast: ["FL", "GA", "NC", "TN", "SC"], Southwest: ["TX", "OK", "NM", "CO"],
};
const CITY = {
  CA: "Fresno", WA: "Tacoma", OR: "Portland", NV: "Reno", AZ: "Phoenix", IL: "Chicago", OH: "Toledo",
  MI: "Detroit", WI: "Milwaukee", MN: "Minneapolis", NY: "Buffalo", PA: "Pittsburgh", MA: "Worcester",
  NJ: "Newark", CT: "Hartford", FL: "Tampa", GA: "Atlanta", NC: "Charlotte", TN: "Memphis", SC: "Greenville",
  TX: "Houston", OK: "Tulsa", NM: "Albuquerque", CO: "Denver",
};
const CO_PREFIX = ["Apex", "Vertex", "Summit", "Ironclad", "Meridian", "Cascade", "Granite", "Pioneer", "Atlas", "Keystone", "Sterling", "Titan", "Vanguard", "Beacon", "Cardinal", "Monarch", "Pinnacle", "Redwood", "Sentinel", "Cobalt"];
const CO_SUFFIX = { Automotive: "Motors", "Food & Beverage": "Foods", Pharmaceutical: "Pharma", "Oil & Gas": "Energy", "Mining & Metals": "Metals", Logistics: "Logistics", Aerospace: "Aerospace", "Consumer Goods": "Products" };
const FIRST = ["James", "Maria", "Robert", "Linda", "David", "Patricia", "Michael", "Susan", "William", "Karen", "Richard", "Nancy", "Joseph", "Betty", "Thomas", "Sandra", "Carlos", "Aisha", "Wei", "Priya"];
const LAST = ["Carter", "Nguyen", "Patel", "Johnson", "Reyes", "Kim", "Brooks", "Foster", "Hughes", "Powell", "Ramirez", "Bennett", "Russo", "Coleman", "Sharma", "Walsh", "Diaz", "Olsen", "Tran", "Mercer"];
const REPS = ["Dana Whitfield", "Marcus Lee", "Sofia Alvarez", "Brian Tanaka", "Renee Okafor", "Tom Becker", "Priya Nair", "Greg Salinas"];
const APPROVERS = [
  { name: "Karen Doyle", role: "Sales Manager" },
  { name: "Victor Hale", role: "Regional VP" },
  { name: "Lena Forsythe", role: "Deal Desk" },
  { name: "Omar Haddad", role: "Finance Director" },
];
const LOST_REASONS = ["Price", "Lost to Competitor", "Lead Time", "No Budget", "Project Cancelled", "Lost to Incumbent"];

// ── Output buckets ───────────────────────────────────────────────────
const products = [], options = [], priceRules = [], customers = [],
  quotes = [], quoteLines = [], approvals = [], orders = [], invoices = [], payments = [];

// ── Products + Options ───────────────────────────────────────────────
let pid = 0, oid = 0;
const productList = [];
for (const cat of CAT_NAMES) {
  const meta = CATEGORIES[cat];
  const count = intIn(4, 7);
  for (let i = 0; i < count; i++) {
    pid++;
    const noun = pick(PRODUCT_NOUNS[cat]);
    const series = pick(SERIES);
    const list = round(meta.lo + rnd() * (meta.hi - meta.lo), 500);
    const marginPct = meta.cm[0] + rnd() * (meta.cm[1] - meta.cm[0]);
    const cost = money(list * (1 - marginPct));
    const configurable = chance(0.72);
    const sku = `${cat.split(" ")[0].slice(0, 3).toUpperCase()}-${series}-${pad(pid, 3)}`;
    const p = {
      "Product ID": `PRD-${pad(pid)}`, "SKU": sku, "Name": `${noun} ${series}`,
      "Category": cat, "Family": meta.fam,
      "Description": `${noun} (${series} series) for ${meta.fam.toLowerCase()} applications.`,
      "List Price": list, "Unit Cost": cost, "Margin Pct": pct((list - cost) / list * 100),
      "Unit of Measure": "Each", "Lead Time Days": intIn(meta.lt[0], meta.lt[1]),
      "Configurable": configurable ? "Yes" : "No", "Status": chance(0.92) ? "Active" : "Discontinued",
      "Notes": "",
    };
    products.push(p);
    productList.push({ sku, name: p.Name, cat, list, cost, configurable });

    if (configurable) {
      for (const g of picks(OPT_GROUP_NAMES, intIn(2, 4))) {
        const variants = OPTION_GROUPS[g];
        variants.forEach((vv, idx) => {
          oid++;
          options.push({
            "Option ID": `OPT-${pad(oid)}`, "Product SKU": sku, "Product Name": p.Name,
            "Option Group": g, "Name": vv[0],
            "Description": `${g} option for ${p.Name}`,
            "Price Delta": vv[1], "Cost Delta": vv[2],
            "Default Selected": idx === 0 ? "Yes" : "No", "Status": "Active",
          });
        });
      }
    }
  }
}

// ── Price Rules ──────────────────────────────────────────────────────
// MAX_DISCOUNT and MARGIN_FLOOR drive approval routing (mirrored in workflow).
const MAX_DISCOUNT = 15;   // discount % above this requires approval
const MARGIN_FLOOR = 22;   // margin % below this requires approval
let rid = 0;
const addRule = (o) => { rid++; priceRules.push({ "Rule ID": `RUL-${pad(rid, 3)}`, "Active": "Yes", "Effective Date": offD(-365), "Expiration Date": offD(365), "Notes": "", ...o }); };
[[1, 4, 0], [5, 9, 4], [10, 24, 8], [25, 999, 12]].forEach(([mn, mx, d], i) =>
  addRule({ "Name": `Volume Tier ${i + 1} (${mn}-${mx === 999 ? "+" : mx})`, "Rule Type": "Volume Tier", "Category": "All", "Customer Segment": "All", "Min Quantity": mn, "Max Quantity": mx === 999 ? "" : mx, "Discount Pct": d }));
addRule({ "Name": "Enterprise Account Discount", "Rule Type": "Segment Discount", "Category": "All", "Customer Segment": "Enterprise", "Discount Pct": 8, "Max Discount Pct": 30 });
addRule({ "Name": "Government Pricing", "Rule Type": "Segment Discount", "Category": "All", "Customer Segment": "Government", "Discount Pct": 5, "Max Discount Pct": 20 });
addRule({ "Name": "Mid-Market Discount", "Rule Type": "Segment Discount", "Category": "All", "Customer Segment": "Mid-Market", "Discount Pct": 4, "Max Discount Pct": 25 });
addRule({ "Name": "Standard Margin Floor", "Rule Type": "Margin Floor", "Category": "All", "Customer Segment": "All", "Margin Floor Pct": MARGIN_FLOOR });
addRule({ "Name": "Robotics Margin Floor", "Rule Type": "Margin Floor", "Category": "Robotic Cells", "Customer Segment": "All", "Margin Floor Pct": 20 });
addRule({ "Name": "Max Discount Without Approval", "Rule Type": "Approval Threshold", "Category": "All", "Customer Segment": "All", "Max Discount Pct": MAX_DISCOUNT });
addRule({ "Name": "Q3 Conveyor Promotion", "Rule Type": "Promotion", "Category": "Conveyor Systems", "Customer Segment": "All", "Discount Pct": 6, "Effective Date": offD(-30), "Expiration Date": offD(45) });
addRule({ "Name": "End-of-Quarter Push", "Rule Type": "Promotion", "Category": "All", "Customer Segment": "All", "Discount Pct": 5, "Effective Date": offD(-10), "Expiration Date": offD(12) });

// ── Customers ────────────────────────────────────────────────────────
let cid = 0;
const customerList = [];
for (let i = 0; i < 60; i++) {
  cid++;
  const seg = chance(0.18) ? "Enterprise" : chance(0.5) ? "Mid-Market" : chance(0.7) ? "SMB" : "Government";
  const ind = pick(INDUSTRIES);
  const region = pick(REGIONS);
  const state = pick(REGION_STATES[region]);
  const name = `${pick(CO_PREFIX)} ${CO_SUFFIX[ind]}`;
  const terms = seg === "Government" ? "Net 60" : seg === "Enterprise" ? pick(["Net 45", "Net 60"]) : pick(["Net 30", "Net 45"]);
  const c = {
    "Customer ID": `CUST-${pad(cid)}`, "Name": name, "Segment": seg, "Industry": ind,
    "Region": region, "City": CITY[state] || "Springfield", "State": state,
    "Contact Name": `${pick(FIRST)} ${pick(LAST)}`,
    "Email": `purchasing@${name.toLowerCase().replace(/[^a-z]/g, "")}.com`,
    "Phone": `(${intIn(200, 989)}) ${intIn(200, 989)}-${pad(intIn(0, 9999), 4)}`,
    "Credit Terms": terms, "Credit Limit": round(intIn(2, 30) * 50000, 1000),
    "Account Owner": pick(REPS), "Status": chance(0.93) ? "Active" : "Prospect", "Notes": "",
  };
  customers.push(c);
  customerList.push({ id: c["Customer ID"], name, seg, owner: c["Account Owner"] });
}

// ── Quotes + Lines + downstream ──────────────────────────────────────
// Pipeline distribution. Won/Lost/Expired are terminal; the rest are open.
const STAGE_PLAN = [
  ["Draft", 18], ["Sent", 22], ["Negotiation", 24], ["Pending Approval", 16],
  ["Approved", 12], ["Won", 48], ["Lost", 16], ["Expired", 10],
];
const WIN_PROB = { Draft: 15, Sent: 30, Negotiation: 50, "Pending Approval": 60, Approved: 80, Won: 100, Lost: 0, Expired: 0 };
let qn = 0, lid = 0, apprId = 0, ordId = 0, invId = 0, payId = 0;

function buildLines(qNumber) {
  const nLines = intIn(1, 6);
  const chosen = picks(productList, Math.min(nLines, productList.length));
  let listTot = 0, netTot = 0, costTot = 0;
  const lines = [];
  chosen.forEach((prod, idx) => {
    lid++;
    const qty = chance(0.5) ? 1 : chance(0.6) ? intIn(2, 9) : intIn(10, 40);
    // volume tier discount
    const volD = qty >= 25 ? 12 : qty >= 10 ? 8 : qty >= 5 ? 4 : 0;
    // optional add-ons
    let optDelta = 0, optCost = 0; const optNames = [];
    if (prod.configurable && chance(0.7)) {
      const myOpts = options.filter(o => o["Product SKU"] === prod.sku && o["Price Delta"] > 0);
      picks(myOpts, intIn(1, Math.min(2, myOpts.length || 1))).forEach(o => {
        if (!o) return; optDelta += o["Price Delta"]; optCost += o["Cost Delta"]; optNames.push(o["Name"]);
      });
    }
    // line discount = volume tier + negotiated extra
    const negotiated = chance(0.35) ? intIn(2, 16) : 0;
    const discPct = Math.min(volD + negotiated, 35);
    const unitList = prod.list + optDelta;
    const unitCost = prod.cost + optCost;
    const unitNet = money(unitList * (1 - discPct / 100));
    const extList = unitList * qty, extNet = unitNet * qty, extCost = unitCost * qty;
    listTot += extList; netTot += extNet; costTot += extCost;
    lines.push({
      "Line ID": `LIN-${pad(lid, 5)}`, "Quote Number": qNumber, "Line Number": idx + 1,
      "Product SKU": prod.sku, "Product Name": prod.name, "Category": prod.cat,
      "Quantity": qty, "Unit List Price": money(prod.list), "Unit Cost": money(prod.cost),
      "Options Summary": optNames.join(", "), "Option Price Delta": money(optDelta),
      "Discount Pct": discPct, "Unit Net Price": unitNet,
      "Extended List": money(extList), "Extended Net": money(extNet), "Extended Cost": money(extCost),
      "Margin Amount": money(extNet - extCost), "Margin Pct": pct(extNet ? (extNet - extCost) / extNet * 100 : 0),
    });
  });
  return { lines, listTot: money(listTot), netTot: money(netTot), costTot: money(costTot) };
}

for (const [status, n] of STAGE_PLAN) {
  for (let i = 0; i < n; i++) {
    qn++;
    const qNumber = `Q-2026-${pad(qn)}`;
    const cust = pick(customerList);
    const owner = cust.owner;
    const { lines, listTot, netTot, costTot } = buildLines(qNumber);
    quoteLines.push(...lines);

    const discountTotal = listTot - netTot;
    const discountPct = pct(listTot ? discountTotal / listTot * 100 : 0);
    const marginAmt = netTot - costTot;
    const marginPct = pct(netTot ? marginAmt / netTot * 100 : 0);

    // Age quotes so the pipeline shows movement AND stagnation.
    const isTerminal = ["Won", "Lost", "Expired"].includes(status);
    const ageBase = { Draft: 8, Sent: 20, Negotiation: 38, "Pending Approval": 30, Approved: 26, Won: 55, Lost: 50, Expired: 70 }[status];
    // Won deals span a wide age band so the cash cycle (ship→invoice→pay) fully matures.
    const created = status === "Won" ? -intIn(25, 320) : -ageBase - intIn(0, 45);
    // Some open quotes are deliberately stalled (stage entered long ago) → blockage.
    const stalled = !isTerminal && chance(0.3);
    const stageEntered = isTerminal ? created + intIn(2, Math.max(2, ageBase)) : (stalled ? -intIn(35, 75) : -intIn(1, 18));
    const decision = isTerminal ? Math.min(-1, created + intIn(3, 25)) : null;

    const needsApproval = discountPct > MAX_DISCOUNT || marginPct < MARGIN_FLOOR;
    let approvalStatus = "Not Required";
    if (status === "Pending Approval") approvalStatus = "Pending";
    else if (["Approved", "Won"].includes(status)) approvalStatus = needsApproval ? "Approved" : "Not Required";
    else if (status === "Negotiation" && needsApproval) approvalStatus = chance(0.5) ? "Pending" : "Not Required";

    // Won → maybe converted to an order. Recent wins often sit unconverted (blockage);
    // older wins are almost always converted.
    const wonAge = -created;
    const converted = status === "Won" && (wonAge > 55 ? chance(0.93) : chance(0.5));
    const orderNumber = converted ? `SO-2026-${pad(++ordId)}` : "";

    const q = {
      "Quote Number": qNumber, "Customer ID": cust.id, "Customer Name": cust.name, "Segment": cust.seg,
      "Owner": owner, "Status": status, "Stage": status,
      "List Total": listTot, "Discount Total": money(discountTotal), "Net Total": netTot,
      "Cost Total": costTot, "Margin Amount": money(marginAmt), "Margin Pct": marginPct, "Discount Pct": discountPct,
      "Line Count": lines.length, "Win Probability": WIN_PROB[status], "Approval Status": approvalStatus,
      "Created Date": offD(created), "Sent Date": status === "Draft" ? "" : offD(created + intIn(1, 6)),
      "Stage Entered Date": offD(stageEntered),
      "Expiration Date": status === "Expired" ? offD(created + 30) : offD(created + intIn(30, 50)),
      "Decision Date": decision != null ? offD(decision) : "",
      "Lost Reason": status === "Lost" ? pick(LOST_REASONS) : "",
      "Order Number": orderNumber, "Notes": stalled ? "Awaiting customer response." : "",
    };
    quotes.push(q);

    // ── Approvals ──────────────────────────────────────────────────
    if (approvalStatus === "Pending" || (needsApproval && ["Approved", "Won", "Lost"].includes(status))) {
      apprId++;
      const appr = pick(APPROVERS);
      const aType = marginPct < MARGIN_FLOOR ? "Margin Floor" : "Discount";
      const reqAge = approvalStatus === "Pending" ? (chance(0.45) ? -intIn(6, 20) : -intIn(1, 4)) : stageEntered - intIn(1, 5);
      const slaDays = discountPct > 25 || netTot > 150000 ? 2 : 3;
      const requested = offD(reqAge);
      const slaDue = addDays(requested, slaDays);
      let aStatus = "Pending", decisionDate = "", agingDays = Math.max(0, Math.round((TODAY.getTime() - new Date(requested).getTime()) / dayMs));
      if (status === "Approved" || status === "Won") { aStatus = "Approved"; decisionDate = offD(reqAge + intIn(1, 4)); agingDays = intIn(1, 4); }
      else if (status === "Lost") { aStatus = chance(0.5) ? "Rejected" : "Approved"; decisionDate = offD(reqAge + intIn(1, 5)); agingDays = intIn(1, 5); }
      const breachedSla = aStatus === "Pending" && new Date(slaDue).getTime() < TODAY.getTime();
      approvals.push({
        "Approval ID": `APR-${pad(apprId)}`, "Quote Number": qNumber, "Customer Name": cust.name,
        "Approval Type": aType, "Requested By": owner, "Approver": appr.name, "Approver Role": appr.role,
        "Status": aStatus, "Priority": breachedSla ? "High" : (discountPct > 25 ? "High" : netTot > 100000 ? "Medium" : "Low"),
        "Discount Pct": discountPct, "Margin Pct": marginPct, "Net Total": netTot,
        "Threshold": aType === "Margin Floor" ? `${MARGIN_FLOOR}% floor` : `${MAX_DISCOUNT}% max`,
        "Reason": aType === "Margin Floor" ? `Margin ${marginPct}% below ${MARGIN_FLOOR}% floor` : `Discount ${discountPct}% exceeds ${MAX_DISCOUNT}% limit`,
        "Requested Date": requested, "SLA Due Date": slaDue, "Decision Date": decisionDate,
        "Aging Days": agingDays,
        "Decision Notes": aStatus === "Approved" ? "Approved — strategic account." : aStatus === "Rejected" ? "Hold margin; renegotiate." : "",
      });
    }

    // ── Orders / Invoices / Payments (won + converted) ─────────────
    // Everything is computed in days-from-today so milestones mature naturally:
    // older orders ship, invoice, age past due and (mostly) collect.
    if (converted) {
      const orderDate = offD(decision);
      const lead = intIn(35, 95);
      const shipOff = decision + lead;                 // days-from-today of shipment
      const shipped = shipOff <= -1 ? offD(shipOff) : "";
      let ordStatus, fulfill;
      if (!shipped) { ordStatus = chance(0.5) ? "Open" : "In Production"; fulfill = ordStatus === "Open" ? "Pending" : "In Production"; }
      else {
        const sinceShip = -shipOff;
        ordStatus = sinceShip > 45 ? "Closed" : sinceShip > 14 ? "Delivered" : "Shipped";
        fulfill = ordStatus === "Closed" ? "Fulfilled" : ordStatus === "Delivered" ? "Delivered" : "In Transit";
      }
      const order = {
        "Order Number": orderNumber, "Quote Number": qNumber, "Customer ID": cust.id, "Customer Name": cust.name,
        "Owner": owner, "Status": ordStatus, "Order Date": orderDate,
        "Order Total": netTot, "Cost Total": costTot, "Margin Amount": money(marginAmt), "Margin Pct": marginPct,
        "Requested Ship Date": offD(decision + intIn(30, 55)), "Promised Ship Date": offD(decision + lead + intIn(-8, 12)),
        "Shipped Date": shipped, "Fulfillment Status": fulfill, "Invoiced Amount": 0, "Notes": "",
      };

      if (shipped) {
        invId++;
        const invNumber = `INV-2026-${pad(invId)}`;
        const invOff = shipOff + intIn(0, 5);
        const termsDays = cust.seg === "Government" ? 60 : cust.seg === "Enterprise" ? 45 : 30;
        const dueOff = invOff + termsDays;
        const amount = netTot;
        const overdue = dueOff < 0;
        let invStatus, paid, payOff = null;
        const roll = rnd();
        if (overdue) {                                         // past due: most collect, ~23% still outstanding
          if (roll < 0.65) { invStatus = "Paid"; paid = amount; payOff = Math.min(-1, dueOff + intIn(-12, 22)); }   // paid (some late)
          else if (roll < 0.77) { invStatus = "Partial"; paid = money(amount * (0.3 + rnd() * 0.4)); payOff = invOff + intIn(5, 25); }
          else { invStatus = "Overdue"; if (chance(0.35)) { paid = money(amount * (0.2 + rnd() * 0.3)); payOff = invOff + intIn(5, 30); } else paid = 0; }
        } else {                                               // not yet due
          if (roll < 0.30) { invStatus = "Partial"; paid = money(amount * (0.3 + rnd() * 0.4)); payOff = invOff + intIn(3, 15); }
          else if (roll < 0.52) { invStatus = "Paid"; paid = amount; payOff = invOff + intIn(3, 20); }
          else { invStatus = "Sent"; paid = 0; }
        }
        const balance = money(amount - paid);
        const daysOut = Math.max(0, -invOff);
        const paidDate = payOff != null ? offD(Math.min(payOff, -1)) : "";
        order["Invoiced Amount"] = amount;
        invoices.push({
          "Invoice Number": invNumber, "Order Number": orderNumber, "Quote Number": qNumber,
          "Customer ID": cust.id, "Customer Name": cust.name, "Status": invStatus,
          "Invoice Date": offD(invOff), "Due Date": offD(dueOff), "Terms": `Net ${termsDays}`,
          "Amount": money(amount), "Amount Paid": money(paid), "Balance": balance,
          "Paid Date": paidDate, "Days Outstanding": daysOut, "Notes": "",
        });

        if (paid > 0 && paidDate) {
          payId++;
          payments.push({
            "Payment ID": `PAY-${pad(payId)}`, "Invoice Number": invNumber, "Customer ID": cust.id,
            "Customer Name": cust.name, "Amount": money(paid), "Method": pick(["ACH", "Wire", "Check", "Card"]),
            "Status": "Cleared", "Payment Date": paidDate, "Reference": `RCPT-${pad(payId, 5)}`,
          });
        }
      }
      orders.push(order);
    }
  }
}

// ── Write ────────────────────────────────────────────────────────────
const seed = {
  products, options, "price-rules": priceRules, customers,
  quotes, "quote-lines": quoteLines, approvals, orders, invoices, payments,
};
fs.writeFileSync(path.join(DIR, "seed-data.json"), JSON.stringify(seed, null, 1));

const sum = (a, f) => a.reduce((s, x) => s + (+x[f] || 0), 0);
console.log("Ironline CPQ seed generated:");
for (const [k, v] of Object.entries(seed)) console.log(`  ${k.padEnd(14)} ${v.length}`);
console.log("\nBlockage checks:");
console.log(`  stalled open quotes (stage >30d): ${quotes.filter(q => !["Won","Lost","Expired"].includes(q.Status) && (TODAY.getTime()-new Date(q["Stage Entered Date"]).getTime())/dayMs>30).length}`);
console.log(`  pending approvals past SLA:        ${approvals.filter(a => a.Status==="Pending" && new Date(a["SLA Due Date"]).getTime()<TODAY.getTime()).length}`);
console.log(`  WON quotes NOT converted:          ${quotes.filter(q => q.Status==="Won" && !q["Order Number"]).length}`);
console.log(`  overdue invoices:                  ${invoices.filter(i => i.Status==="Overdue").length}`);
console.log(`  open AR balance: $${sum(invoices.filter(i=>i.Balance>0),"Balance").toLocaleString()}`);
console.log(`  won net value:   $${sum(quotes.filter(q=>q.Status==="Won"),"Net Total").toLocaleString()}`);
