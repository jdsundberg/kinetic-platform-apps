/**
 * gen-seed.mjs — cross-linked seed data for MfgDream.
 * Models the full flow: CRM order -> NPI stage-gate project -> product + BOM ->
 * MRP parts/suppliers/purchase-orders -> production work-orders.
 * Deterministic PRNG. Pure Node built-ins.   node gen-seed.mjs -> seed-data.json
 */
import fs from "node:fs";
import path from "node:path";
const DIR = path.dirname(new URL(import.meta.url).pathname);

let _s = 0x4d66d123;
function rnd() { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const wpick = (pairs) => { const tot = pairs.reduce((s, p) => s + p[1], 0); let r = rnd() * tot; for (const [v, w] of pairs) { if ((r -= w) < 0) return v; } return pairs[0][0]; };
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const pad = (n, w = 3) => String(n).padStart(w, "0");
const money = (n) => Math.round(n);
const dateStr = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(Math.min(28, d)).padStart(2, "0")}`;
const addDays = (base, days) => { const dt = new Date(base + days * 86400000); return dateStr(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()); };
const D2026 = Date.UTC(2026, 0, 1);

const FIRST = ["Amara", "Elena", "Marcus", "Priya", "David", "Sofia", "Kenji", "Lena", "Omar", "Grace", "Tobias", "Nadia", "Victor", "Mei", "Rahul", "Clara", "Diego", "Ingrid", "Sam", "Yara", "Noah", "Ava", "Leo", "Zoe", "Ethan", "Maya", "Owen", "Nina"];
const LAST = ["Chen", "Nakamura", "Okafor", "Petrov", "Reyes", "Kowalski", "Andersson", "Haddad", "Mbeki", "Rossi", "Nguyen", "Schmidt", "Patel", "Silva", "Yamamoto", "Novak", "Dubois", "Kim", "Larsen", "Costa", "Weber", "Tanaka", "Fischer", "Moreau"];
const name = () => `${pick(FIRST)} ${pick(LAST)}`;

const INDUSTRIES = ["Automotive", "Aerospace", "Medical Devices", "Industrial Automation", "Consumer Electronics", "Energy", "Telecom", "Defense"];
const REGIONS = ["North America", "EMEA", "APAC", "LATAM"];
const TIERS = ["Strategic", "Key", "Standard"];
const CATEGORIES = ["Sensors", "Actuators", "Controllers", "Power Systems", "Enclosures", "RF Modules", "Optics", "Assemblies"];
const PHASES = ["Concept", "Feasibility", "Design", "Prototype", "Validation", "Launch"];
const GATE_NAMES = ["G0 Concept", "G1 Feasibility", "G2 Design", "G3 Prototype", "G4 Validation", "G5 Launch"];
const WORK_CENTERS = ["SMT Line 1", "SMT Line 2", "Final Assembly", "Test & QA", "Machining", "Injection Molding"];
const CODENAMES = ["Vantage", "Apex", "Halo", "Titan", "Nimbus", "Quantum", "Orion", "Falcon", "Pulse", "Vertex", "Zenith", "Cobalt", "Aurora", "Helix", "Summit", "Delta", "Nova", "Forge", "Onyx", "Cirrus", "Ember", "Sable"];
const COMPANY_PRE = ["Meridian", "Northwind", "Apex", "Volt", "Cascade", "Ironclad", "Bluepeak", "Helios", "Vector", "Summit", "Aria", "Pinnacle", "Terra", "Quantum", "Corebridge", "Lumen", "Sterling", "Halcyon", "Draco", "Kestrel", "Monarch", "Zephyr", "Copperline", "Beacon"];
const COMPANY_SUF = ["Motors", "Aerospace", "MedTech", "Robotics", "Electronics", "Energy", "Systems", "Devices", "Instruments", "Dynamics", "Labs", "Industries"];
const PART_COMP = ["Resistor Array", "Ceramic Capacitor", "MCU 32-bit", "Board Connector", "Main PCB", "Alloy Housing", "Silicone Gasket", "Precision Bearing", "Wire Harness", "Power LED", "Sensor Die", "Copper Heatsink", "Fastener Kit", "Optical Lens", "Antenna Module", "Voltage Regulator", "Toroidal Transformer", "Signal Relay", "OLED Display", "Li-ion Cell", "Thermal Pad", "EMI Shield", "Flex Cable", "Crystal Oscillator"];
const SUPPLIER_PRE = ["Global", "Precision", "Apex", "Nihon", "Rhein", "Pacific", "Summit", "Vertex", "Fortis", "Bluegrass", "Cardinal", "Titan"];
const SUPPLIER_SUF = ["Components", "Fabrication", "Semiconductor", "Materials", "Electronics", "Metals", "Plastics", "Supply Co"];

const out = { customers: [], orders: [], "npi-projects": [], "gate-reviews": [], products: [], boms: [], parts: [], suppliers: [], "purchase-orders": [], "work-orders": [] };

// ── Suppliers ──────────────────────────────────────────────────────────────
const suppliers = [];
const usedSup = new Set();
for (let i = 0; i < 12; i++) {
  let nm; do { nm = `${pick(SUPPLIER_PRE)} ${pick(SUPPLIER_SUF)}`; } while (usedSup.has(nm)); usedSup.add(nm);
  const onTime = int(78, 99);
  const sup = { id: `SUP-${pad(i + 1)}`, name: nm, category: pick(CATEGORIES), region: pick(REGIONS), lead: int(7, 60), onTime, quality: (3.4 + rnd() * 1.6).toFixed(1) };
  suppliers.push(sup);
  out.suppliers.push({
    "Supplier ID": sup.id, "Supplier Name": nm, "Category": sup.category, "Region": sup.region,
    "Contact": name(), "Email": `sales@${nm.toLowerCase().replace(/[^a-z]+/g, "")}.com`,
    "Lead Time Days": String(sup.lead), "On Time Percent": String(onTime), "Quality Score": String(sup.quality),
    "Status": chance(0.92) ? "Approved" : "Probation",
  });
}

// ── Parts (MRP inventory) ───────────────────────────────────────────────────
const parts = [];
for (let i = 0; i < 44; i++) {
  const sup = pick(suppliers);
  const comp = PART_COMP[i % PART_COMP.length];
  const reorder = int(50, 400);
  const onHand = wpick([[0, 1], [int(1, reorder - 1), 3], [int(reorder, reorder * 2), 5], [int(reorder * 2, reorder * 4), 4]]);
  const onOrder = onHand < reorder ? int(reorder, reorder * 2) : (chance(0.4) ? int(50, 300) : 0);
  let stock = "In Stock";
  if (onHand === 0) stock = "Stockout";
  else if (onHand < reorder) stock = "Reorder";
  else if (onHand < reorder * 1.5) stock = "Low";
  const cost = +(0.2 + rnd() * 180).toFixed(2);
  const pn = `P-${1000 + i}`;
  parts.push({ pn, name: `${comp}`, category: sup.category, supplier: sup.name, cost, stock, buy: chance(0.82) });
  out.parts.push({
    "Part Number": pn, "Part Name": comp, "Category": sup.category, "Supplier": sup.name,
    "On Hand": String(onHand), "On Order": String(onOrder), "Reorder Point": String(reorder),
    "Lead Time Days": String(sup.lead + int(-3, 5) | 0), "Unit Cost": cost.toFixed(2),
    "Stock Status": stock, "Status": "Active",
  });
}

// ── Customers (CRM) ─────────────────────────────────────────────────────────
const customers = [];
const usedCo = new Set();
for (let i = 0; i < 24; i++) {
  let co; do { co = `${pick(COMPANY_PRE)} ${pick(COMPANY_SUF)}`; } while (usedCo.has(co)); usedCo.add(co);
  const tier = wpick([["Strategic", 2], ["Key", 3], ["Standard", 5]]);
  const cust = { id: `CUST-${pad(i + 1)}`, company: co, tier, region: pick(REGIONS), industry: pick(INDUSTRIES), owner: name() };
  customers.push(cust);
  out.customers.push({
    "Customer ID": cust.id, "Company": co, "Contact Name": name(),
    "Email": `procurement@${co.toLowerCase().replace(/[^a-z]+/g, "")}.com`, "Phone": `+1 (${int(200, 989)}) ${int(200, 989)}-${pad(int(0, 9999), 4)}`,
    "Industry": cust.industry, "Region": cust.region, "Tier": tier, "Account Owner": cust.owner,
    "Annual Revenue": `$${int(5, 900)}M`, "Status": chance(0.9) ? "Active" : "Prospect", "Notes": "",
  });
}

// phase distribution → nice descending NPI funnel when server computes cumulative-reached
const PHASE_PLAN = ["Concept", "Concept", "Concept", "Concept", "Concept", "Feasibility", "Feasibility", "Feasibility", "Feasibility", "Design", "Design", "Design", "Prototype", "Prototype", "Prototype", "Validation", "Validation", "Validation", "Launch", "Launch"];
const PCT_BY_PHASE = { Concept: [5, 15], Feasibility: [18, 32], Design: [35, 52], Prototype: [55, 72], Validation: [74, 90], Launch: [92, 99] };
const LIFECYCLE = { Concept: "Concept", Feasibility: "Development", Design: "Development", Prototype: "Pilot", Validation: "Production", Launch: "Production" };
const ORDER_STAGE = { Concept: "In NPI", Feasibility: "In NPI", Design: "In NPI", Prototype: "In Production", Validation: "In Production", Launch: "Shipped" };

let orderSeq = 0, bomSeq = 0, revSeq = 0, poSeq = 0, woSeq = 0;

// ── NPI projects + everything hanging off them ──────────────────────────────
for (let i = 0; i < PHASE_PLAN.length; i++) {
  const phase = PHASE_PLAN[i];
  const phaseIdx = PHASES.indexOf(phase);
  const code = CODENAMES[i];
  const cust = customers[i % customers.length];
  const category = pick(CATEGORIES);
  const model = `${pick(["X", "R", "M", "S", "Z"])}${int(100, 900)}`;
  const productName = `${code} ${category.replace(/s$/, "")} ${model}`;
  const npiId = `NPI-${pad(i + 1)}`;
  const sku = `SKU-${code.toUpperCase().slice(0, 4)}-${model}`;

  const risk = wpick([["Low", 4], ["Medium", 4], ["High", 2]]);
  let gate = wpick([["On Track", 5], ["At Risk", 3], ["Blocked", 1]]);
  if (phase === "Launch") gate = chance(0.7) ? "Approved" : "On Track";
  const [plo, phi] = PCT_BY_PHASE[phase];
  const pct = int(plo, phi);
  const budget = money(int(180, 1400) * 1000);
  const spend = money(budget * (pct / 100) * (0.82 + rnd() * 0.4));
  const startDays = -int(30, 400);
  const launchDays = startDays + int(180, 520);
  const owner = name();

  out["npi-projects"].push({
    "NPI ID": npiId, "Product Name": productName, "Order": `ORD-${1001 + i}`, "Customer": cust.company,
    "Category": category, "Phase": phase, "Gate Status": gate, "Owner": owner,
    "Start Date": addDays(D2026, startDays), "Target Launch": addDays(D2026, launchDays),
    "Percent Complete": String(pct), "Budget": String(budget), "Spend": String(spend),
    "Risk Level": risk, "Status": phase === "Launch" && chance(0.3) ? "Complete" : "Active", "Notes": "",
  });

  // ── CRM order (front door) ──
  orderSeq++;
  const qty = wpick([[int(100, 2000), 5], [int(2000, 20000), 3], [int(20000, 120000), 2]]);
  const unitPrice = +(spend / Math.max(qty, 1) * (1.3 + rnd() * 1.5)).toFixed(2);
  const orderValue = money(qty * unitPrice);
  const orderId = `ORD-${1000 + orderSeq}`;
  out.orders.push({
    "Order ID": orderId, "Customer": cust.company, "Product Name": productName, "Category": category,
    "Quantity": String(qty), "Unit Price": unitPrice.toFixed(2), "Order Value": String(orderValue),
    "Order Date": addDays(D2026, startDays - int(5, 30)), "Requested Delivery": addDays(D2026, launchDays + int(10, 60)),
    "NPI ID": npiId, "Priority": wpick([["Critical", 2], ["High", 3], ["Standard", 5]]),
    "Stage": ORDER_STAGE[phase], "Status": out["npi-projects"][i].Status === "Complete" ? "Fulfilled" : "Open", "Notes": "",
  });

  // ── BOM + product unit cost ──
  const nLines = int(4, 9);
  const bomParts = [];
  const usedParts = new Set();
  let unitCost = 0;
  for (let b = 0; b < nLines; b++) {
    let p; let guard = 0; do { p = pick(parts); guard++; } while (usedParts.has(p.pn) && guard < 20); usedParts.add(p.pn);
    const qtyPer = int(1, 12);
    const ext = +(qtyPer * p.cost).toFixed(2);
    unitCost += ext;
    bomParts.push(p);
    bomSeq++;
    out.boms.push({
      "BOM Line ID": `BOM-${pad(bomSeq, 4)}`, "Product SKU": sku, "Product Name": productName,
      "Part Number": p.pn, "Part Name": p.name, "Qty Per": String(qtyPer),
      "Unit Cost": p.cost.toFixed(2), "Ext Cost": ext.toFixed(2), "Make or Buy": p.buy ? "Buy" : "Make",
      "Status": "Released",
    });
  }
  unitCost = +unitCost.toFixed(2);
  out.products.push({
    "SKU": sku, "Product Name": productName, "Category": category, "NPI ID": npiId,
    "Lifecycle": LIFECYCLE[phase], "Unit Cost": unitCost.toFixed(2),
    "Target Price": (unitCost * (1.35 + rnd() * 0.6)).toFixed(2), "Lead Time Days": String(int(20, 90)),
    "Status": "Active", "Notes": "",
  });

  // ── Gate reviews for gates already passed (0..phaseIdx) ──
  for (let g = 0; g <= phaseIdx; g++) {
    revSeq++;
    const passed = g < phaseIdx;
    const decision = passed ? wpick([["Go", 7], ["Conditional Go", 3]]) : wpick([["Go", 4], ["Conditional Go", 3], ["Hold", 2], ["Kill", 1]]);
    out["gate-reviews"].push({
      "Review ID": `GR-${pad(revSeq, 4)}`, "NPI ID": npiId, "Product Name": productName, "Gate": GATE_NAMES[g],
      "Review Date": addDays(D2026, startDays + g * int(25, 60)), "Decision": decision, "Reviewer": name(),
      "Score": String(int(58, 98)),
      "Risk Notes": decision === "Hold" || decision === "Kill" ? pick(["Supplier lead time risk on long-lead parts.", "DFM concerns raised on the enclosure.", "Validation test coverage below target.", "Cost target exceeded by 14%."]) : "",
      "Action Items": passed ? "" : pick(["Close out open DFMEA items before next gate.", "Confirm second-source on critical parts.", "Re-run reliability at temperature extremes.", ""]),
      "Status": passed ? "Closed" : "Open",
    });
  }

  // ── Purchase orders for buy-parts on this NPI ──
  for (const p of bomParts) {
    if (!p.buy || chance(0.35)) continue;
    poSeq++;
    const q = int(200, 8000);
    const poVal = money(q * p.cost);
    const st = wpick([["Open", 3], ["Confirmed", 3], ["In Transit", 2], ["Received", 3], ["Late", 1]]);
    const orderD = startDays + int(20, 120);
    out["purchase-orders"].push({
      "PO Number": `PO-${pad(4000 + poSeq, 4)}`, "Supplier": p.supplier, "Part Number": p.pn, "Part Name": p.name,
      "Quantity": String(q), "Unit Cost": p.cost.toFixed(2), "PO Value": String(poVal),
      "Order Date": addDays(D2026, orderD), "Due Date": addDays(D2026, orderD + int(10, 70)),
      "Status": st, "NPI ID": npiId, "Notes": st === "Late" ? "Expedite — flagged in MRP." : "",
    });
  }

  // ── Work orders once we're producing (Prototype+) ──
  if (phaseIdx >= 3) {
    const nWO = phaseIdx >= 4 ? int(1, 3) : 1;
    for (let w = 0; w < nWO; w++) {
      woSeq++;
      const woStatus = phase === "Launch" ? wpick([["Complete", 4], ["In Progress", 3], ["Released", 1]])
        : phase === "Validation" ? wpick([["In Progress", 4], ["Released", 2], ["Planned", 1], ["On Hold", 1]])
          : wpick([["Planned", 3], ["Released", 2], ["In Progress", 1]]);
      const woPct = woStatus === "Complete" ? 100 : woStatus === "In Progress" ? int(30, 90) : woStatus === "Released" ? int(5, 25) : 0;
      const ss = launchDays - int(20, 120);
      out["work-orders"].push({
        "WO Number": `WO-${pad(5000 + woSeq, 4)}`, "Product SKU": sku, "Product Name": productName,
        "Order": orderId, "NPI ID": npiId, "Quantity": String(int(50, Math.max(60, Math.round(qty / 10)))),
        "Scheduled Start": addDays(D2026, ss), "Scheduled End": addDays(D2026, ss + int(10, 45)),
        "Percent Complete": String(woPct), "Work Center": pick(WORK_CENTERS),
        "Priority": wpick([["Critical", 2], ["High", 3], ["Standard", 5]]), "Status": woStatus, "Notes": "",
      });
    }
  }
}

fs.writeFileSync(path.join(DIR, "seed-data.json"), JSON.stringify(out, null, 2));
console.log("Wrote seed-data.json:", JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]))));
