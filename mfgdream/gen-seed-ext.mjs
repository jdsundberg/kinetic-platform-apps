/**
 * MfgDream — connected seed generator for the extension forms
 * (inspections, nonconformances, corrective-actions, shipments, invoices, engineering-changes).
 * Reads the existing seed-data.json so every new record links to a real order/product/supplier/WO.
 * Deterministic (seeded LCG) so re-runs are stable. Writes seed-data-ext.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(fs.readFileSync(path.join(__dir, "seed-data.json"), "utf-8"));
const orders = base.orders, products = base.products, suppliers = base.suppliers, workOrders = base["work-orders"], parts = base.parts;

// deterministic RNG
let _s = 987654321;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const TODAY = new Date("2026-07-21T00:00:00Z");
const dstr = (d) => d.toISOString().slice(0, 10);
const addDays = (base, n) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + n); return d; };
const dateOffset = (n) => dstr(addDays(TODAY, n));

const DEFECTS = ["Dimensional out of tolerance", "Cosmetic scratch", "Solder bridge", "Missing component", "Wrong revision", "Contamination", "Cold solder joint", "Bent lead", "Cracked housing", "Incorrect marking", "Porosity", "Warpage"];
const CARRIERS = ["FedEx Freight", "UPS Ground", "XPO Logistics", "Old Dominion", "R+L Carriers", "FedEx Express"];
const INSPECTORS = ["Grace Liang", "Marcus Webb", "Priya Shah", "Tom Delgado", "Yuki Tanaka", "Dana Ruiz"];
const QE = ["Elena Vasquez", "Raj Kapoor", "Sam Okafor"];
const ECO_REASONS = ["Cost reduction", "Supplier obsolescence", "Customer request", "Quality improvement", "Regulatory compliance", "Design defect fix", "Second-source qualification"];

const num = (x) => { const n = parseFloat(String(x).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
const prodBySku = {}; products.forEach((p) => (prodBySku[p.SKU] = p));

const out = { inspections: [], nonconformances: [], "corrective-actions": [], shipments: [], invoices: [], "engineering-changes": [] };

let ncrSeq = 1, capaSeq = 1;
const ncrQueue = [];   // NCRs spawned from failed inspections

// ── INSPECTIONS ──────────────────────────────────────────────
let insSeq = 1;
// incoming inspections against purchased parts / suppliers
for (let i = 0; i < 16; i++) {
  const part = pick(parts);
  const fail = chance(0.22);
  const qty = ri(50, 800), rej = fail ? ri(2, Math.max(3, Math.floor(qty * 0.15))) : (chance(0.3) ? ri(1, 3) : 0);
  const id = `INS-${String(insSeq++).padStart(4, "0")}`;
  const result = fail ? "Fail" : (rej > 0 ? "Conditional" : "Pass");
  let ncr = "";
  if (result === "Fail") { ncr = `NCR-${String(ncrSeq).padStart(3, "0")}`; ncrQueue.push({ id: ncr, source: "Incoming", supplier: part.Supplier, part: part["Part Number"], sku: "", product: part["Part Name"], defect: pick(DEFECTS), qty: rej }); ncrSeq++; }
  out.inspections.push({ "Inspection ID": id, Type: "Incoming", "Product SKU": "", "Product Name": part["Part Name"], Supplier: part.Supplier, "Work Order": "", "PO Number": "", Inspector: pick(INSPECTORS), "Inspection Date": dateOffset(-ri(1, 120)), "Qty Inspected": String(qty), "Qty Rejected": String(rej), Result: result, "NCR ID": ncr, Status: "Complete", Notes: fail ? pick(DEFECTS) : "" });
}
// in-process & final against work orders
for (const wo of workOrders) {
  const types = chance(0.5) ? ["In-Process"] : ["In-Process", "Final"];
  for (const t of types) {
    const fail = chance(t === "Final" ? 0.18 : 0.12);
    const qty = num(wo.Quantity) || ri(50, 500), rej = fail ? ri(2, Math.max(3, Math.floor(qty * 0.08))) : (chance(0.25) ? ri(1, 4) : 0);
    const id = `INS-${String(insSeq++).padStart(4, "0")}`;
    const result = fail ? "Fail" : (rej > 0 ? "Conditional" : "Pass");
    let ncr = "";
    if (result === "Fail") { ncr = `NCR-${String(ncrSeq).padStart(3, "0")}`; ncrQueue.push({ id: ncr, source: t, supplier: "", part: "", sku: wo["Product SKU"], product: wo["Product Name"], defect: pick(DEFECTS), qty: rej, wo: wo["WO Number"] }); ncrSeq++; }
    out.inspections.push({ "Inspection ID": id, Type: t, "Product SKU": wo["Product SKU"], "Product Name": wo["Product Name"], Supplier: "", "Work Order": wo["WO Number"], "PO Number": "", Inspector: pick(INSPECTORS), "Inspection Date": dateOffset(-ri(1, 90)), "Qty Inspected": String(qty), "Qty Rejected": String(rej), Result: result, "NCR ID": ncr, Status: "Complete", Notes: fail ? pick(DEFECTS) : "" });
  }
}
// first-article inspections for products in NPI
for (let i = 0; i < 8; i++) {
  const p = pick(products);
  const result = chance(0.7) ? "Pass" : (chance(0.5) ? "Conditional" : "Fail");
  const id = `INS-${String(insSeq++).padStart(4, "0")}`;
  let ncr = "";
  if (result === "Fail") { ncr = `NCR-${String(ncrSeq).padStart(3, "0")}`; ncrQueue.push({ id: ncr, source: "Final", supplier: "", part: "", sku: p.SKU, product: p["Product Name"], defect: pick(DEFECTS), qty: ri(1, 5) }); ncrSeq++; }
  out.inspections.push({ "Inspection ID": id, Type: "First Article", "Product SKU": p.SKU, "Product Name": p["Product Name"], Supplier: "", "Work Order": "", "PO Number": "", Inspector: pick(INSPECTORS), "Inspection Date": dateOffset(-ri(5, 150)), "Qty Inspected": "5", "Qty Rejected": result === "Pass" ? "0" : "1", Result: result, "NCR ID": ncr, Status: "Complete", Notes: "FAI per PPAP" });
}

// ── NONCONFORMANCES ──────────────────────────────────────────
// from failed inspections
const capaQueue = [];
for (const q of ncrQueue) {
  const sev = q.source === "Incoming" ? pick(["Minor", "Major", "Major", "Critical"]) : pick(["Minor", "Minor", "Major", "Critical"]);
  const disp = pick(["Rework", "Scrap", "Return to Supplier", "Use As Is", "Rework"]);
  const cost = disp === "Scrap" ? ri(2000, 25000) : disp === "Return to Supplier" ? ri(500, 8000) : ri(200, 6000);
  const needsCapa = sev === "Critical" || (sev === "Major" && chance(0.7));
  let capa = "";
  if (needsCapa) { capa = `CAPA-${String(capaSeq).padStart(3, "0")}`; capaQueue.push({ id: capa, ncr: q.id, supplier: q.supplier, sev, product: q.product, defect: q.defect }); capaSeq++; }
  const open = chance(0.45);
  out.nonconformances.push({ "NCR ID": q.id, Source: q.source, "Product SKU": q.sku || "", "Product Name": q.product, "Part Number": q.part || "", Supplier: q.supplier || "", "Work Order": q.wo || "", Severity: sev, "Defect Type": q.defect, "Qty Affected": String(q.qty), Disposition: disp, "Cost Impact": String(cost), "CAPA ID": capa, Owner: pick(QE), "Opened Date": dateOffset(-ri(1, 110)), Status: open ? pick(["Open", "In Review"]) : "Closed", Description: `${q.defect} identified during ${q.source.toLowerCase()} inspection.` });
}
// a couple of customer-return NCRs (field failures)
for (let i = 0; i < 3; i++) {
  const o = pick(orders); const sev = pick(["Major", "Critical"]);
  const capa = `CAPA-${String(capaSeq).padStart(3, "0")}`; capaQueue.push({ id: capa, ncr: `NCR-${String(ncrSeq).padStart(3, "0")}`, supplier: "", sev, product: o["Product Name"], defect: pick(DEFECTS) });
  const id = `NCR-${String(ncrSeq++).padStart(3, "0")}`;
  out.nonconformances.push({ "NCR ID": id, Source: "Customer", "Product SKU": "", "Product Name": o["Product Name"], "Part Number": "", Supplier: "", "Work Order": "", Severity: sev, "Defect Type": pick(DEFECTS), "Qty Affected": String(ri(1, 12)), Disposition: pick(["Return to Supplier", "Rework", "Scrap"]), "Cost Impact": String(ri(4000, 40000)), "CAPA ID": capa, Owner: pick(QE), "Opened Date": dateOffset(-ri(3, 80)), Status: pick(["Open", "In Review"]), Description: `Field return from ${o.Customer} — ${pick(DEFECTS).toLowerCase()}.` });
  capaSeq++;
}

// ── CORRECTIVE ACTIONS ───────────────────────────────────────
for (const c of capaQueue) {
  const overdue = chance(0.3);
  const due = overdue ? dateOffset(-ri(2, 30)) : dateOffset(ri(3, 45));
  const status = overdue ? "Overdue" : pick(["Open", "In Progress", "In Progress", "Verify", "Closed"]);
  out["corrective-actions"].push({ "CAPA ID": c.id, "NCR ID": c.ncr, Title: `${c.defect} — root cause & containment`, Type: c.supplier ? "SCAR" : pick(["Corrective", "Corrective", "Preventive"]), Supplier: c.supplier || "", Owner: pick(QE), "Opened Date": dateOffset(-ri(5, 90)), "Due Date": due, Status: status, "Root Cause": pick(["Tooling wear", "Operator error", "Supplier process drift", "Inadequate work instruction", "Material variation", "Fixture misalignment"]), "Action Plan": pick(["Update control plan and re-train", "Add incoming inspection gate", "Requalify second source", "Poka-yoke the fixture", "Tighten supplier PPAP"]), Effectiveness: status === "Closed" ? pick(["Verified Effective", "Verified Effective", "Monitoring"]) : "" });
}

// ── SHIPMENTS ────────────────────────────────────────────────
let shpSeq = 1;
// ship every order that's past NPI (In Production or Shipped); split ~40% into partial shipments
const shippableOrders = orders.filter((o) => ["In Production", "Shipped"].includes(o.Stage));
const mkShipment = (o, qty, forceStatus, lateFlag) => {
  const status = forceStatus || (o.Stage === "Shipped" ? pick(["Shipped", "Delivered", "Delivered"]) : pick(["Staged", "Packed", "Shipped", "Shipped"]));
  const posted = ["Shipped", "Delivered"].includes(status);
  const late = lateFlag != null ? lateFlag : chance(0.32);
  const shipDate = posted ? dateOffset(-ri(1, 60)) : "";
  out.shipments.push({ "Shipment ID": `SHP-${String(shpSeq++).padStart(4, "0")}`, Order: o["Order ID"], Customer: o.Customer, "Product Name": o["Product Name"], Quantity: String(qty), "Requested Date": o["Requested Delivery"], "Ship Date": shipDate, Carrier: pick(CARRIERS), Tracking: shipDate ? "1Z" + String(ri(100000, 999999)) + ri(1000, 9999) : "", "Freight Cost": String(ri(400, 6500)), "On Time": posted ? (late ? "No" : "Yes") : "", Status: status, Notes: late && posted ? pick(["Delayed — material shortage", "Delayed — carrier exception", "Delayed — final inspection hold"]) : "" });
};
shippableOrders.forEach((o, i) => {
  const totQty = num(o.Quantity) || ri(100, 2000);
  if (chance(0.4)) { // partial shipments
    mkShipment(o, Math.round(totQty * 0.6), "Delivered", i % 3 === 0);
    mkShipment(o, Math.round(totQty * 0.4), o.Stage === "Shipped" ? "Shipped" : "Packed", null);
  } else {
    mkShipment(o, totQty, null, i % 4 === 0 ? true : null);
  }
});
// one RMA / return
const rmaOrder = pick(shippableOrders);
out.shipments.push({ "Shipment ID": `SHP-${String(shpSeq++).padStart(4, "0")}`, Order: rmaOrder["Order ID"], Customer: rmaOrder.Customer, "Product Name": rmaOrder["Product Name"], Quantity: "5", "Requested Date": rmaOrder["Requested Delivery"], "Ship Date": dateOffset(-ri(5, 25)), Carrier: pick(CARRIERS), Tracking: "RMA" + ri(10000, 99999), "Freight Cost": "0", "On Time": "", Status: "Returned", Notes: "RMA — customer reported defect, replacement in process" });

// ── INVOICES ─────────────────────────────────────────────────
let invSeq = 1;
const invoicedShipments = out.shipments.filter((s) => ["Shipped", "Delivered"].includes(s.Status));
invoicedShipments.forEach((s, i) => {
  const o = orders.find((x) => x["Order ID"] === s.Order);
  const shipQty = num(s.Quantity), ordQty = o ? num(o.Quantity) : shipQty;
  const frac = ordQty ? shipQty / ordQty : 1;
  const amount = Math.round((o ? num(o["Order Value"]) : ri(50000, 800000)) * frac);
  const cost = Math.round(amount * (0.58 + rnd() * 0.14));
  const margin = amount - cost;
  const invDate = s["Ship Date"] || dateOffset(-ri(5, 45));
  const due = dstr(addDays(new Date(invDate), 45));
  const naturallyOverdue = new Date(due) < TODAY;
  // force a healthy spread: paid / sent / overdue
  const bucket = i % 5;
  let status, paidDate = "";
  if (bucket < 2) { status = "Paid"; paidDate = dateOffset(-ri(1, 20)); }
  else if (bucket < 3 && naturallyOverdue) { status = "Overdue"; }
  else if (naturallyOverdue && chance(0.5)) { status = "Overdue"; }
  else { status = "Sent"; }
  out.invoices.push({ "Invoice ID": `INV-${String(invSeq++).padStart(4, "0")}`, Order: s.Order, "Shipment ID": s["Shipment ID"], Customer: s.Customer, Amount: String(amount), Cost: String(cost), Margin: String(margin), "Invoice Date": invDate, "Due Date": due, "Paid Date": paidDate, Status: status, Notes: "" });
});

// ── ENGINEERING CHANGES ──────────────────────────────────────
let ecoSeq = 1;
// one URGENT change (Critical, Under Review) — required scenario
const urgentP = pick(products);
out["engineering-changes"].push({ "ECO ID": `ECO-${String(ecoSeq++).padStart(4, "0")}`, Type: "ECR", "Product SKU": urgentP.SKU, "Product Name": urgentP["Product Name"], Reason: "Design defect fix", "Requested By": pick(QE), Priority: "Critical", "Cost Impact": String(ri(15000, 90000)), "Affected Orders": String(ri(2, 6)), "Effective Date": dateOffset(ri(5, 20)), Owner: pick(INSPECTORS), "Opened Date": dateOffset(-ri(1, 10)), Status: "Under Review", Description: "URGENT: field-reported failure requires immediate design change and inventory disposition." });
for (let i = 0; i < 10; i++) {
  const p = pick(products);
  const status = pick(["Draft", "Under Review", "Approved", "Approved", "Implemented", "Rejected"]);
  out["engineering-changes"].push({ "ECO ID": `ECO-${String(ecoSeq++).padStart(4, "0")}`, Type: pick(["ECR", "ECO", "ECO", "Deviation", "Waiver"]), "Product SKU": p.SKU, "Product Name": p["Product Name"], Reason: pick(ECO_REASONS), "Requested By": pick([...QE, ...INSPECTORS]), Priority: pick(["High", "Medium", "Medium", "Low"]), "Cost Impact": String(ri(-20000, 60000)), "Affected Orders": String(ri(0, 5)), "Effective Date": dateOffset(ri(-30, 60)), Owner: pick(INSPECTORS), "Opened Date": dateOffset(-ri(5, 120)), Status: status, Description: pick(ECO_REASONS) + " — see attached impact analysis." });
}

fs.writeFileSync(path.join(__dir, "seed-data-ext.json"), JSON.stringify(out, null, 2));
const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
console.log("Wrote seed-data-ext.json:", JSON.stringify(counts));
