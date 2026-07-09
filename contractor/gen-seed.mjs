/**
 * gen-seed.mjs — generate coherent, linked Twin Cities seed data for the
 * Northstar Contracting app. Writes seed-data.json keyed by form slug.
 * Deterministic (seeded PRNG) so re-runs produce identical data.
 */
import fs from "node:fs";
import path from "node:path";

// ---- deterministic PRNG (mulberry32) ----
let _s = 0x9e3779b9;
function rnd() { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const rint = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const money = (n) => String(Math.round(n));
const chance = (p) => rnd() < p;
function dateStr(y, m, d) { return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
function addDays(iso, days) { const dt = new Date(iso + "T00:00:00Z"); dt.setUTCDate(dt.getUTCDate() + days); return dt.toISOString().slice(0, 10); }

const CITIES = ["Minneapolis", "St. Paul", "Bloomington", "Edina", "Plymouth", "Maple Grove", "Minnetonka", "Eden Prairie", "Woodbury", "Roseville", "St. Louis Park", "Maplewood"];
const LAST = ["Johnson", "Anderson", "Nguyen", "Olson", "Peterson", "Carlson", "Hansen", "Larson", "Schmidt", "Patel", "Garcia", "Bergstrom", "Lindqvist", "Hoffman", "Reyes", "Novak"];
const STREETS = ["Oak", "Maple", "Cedar", "Birch", "Linden", "Hennepin", "Grand", "Summit", "Lake", "Nicollet", "Como", "Snelling", "Excelsior", "France"];
const SUFFIX = ["Ave", "St", "Blvd", "Ln", "Rd", "Way", "Ct"];

const PTYPES = [
  { t: "Kitchen Remodel", lo: 25000, hi: 85000 },
  { t: "Bathroom Remodel", lo: 12000, hi: 38000 },
  { t: "Basement Finish", lo: 30000, hi: 75000 },
  { t: "Home Addition", lo: 80000, hi: 200000 },
  { t: "Whole Home Renovation", lo: 120000, hi: 200000 },
  { t: "Roofing Replacement", lo: 9000, hi: 28000 },
  { t: "Siding Replacement", lo: 15000, hi: 45000 },
  { t: "Deck Build", lo: 8000, hi: 32000 },
  { t: "Window Replacement", lo: 6000, hi: 24000 },
  { t: "Garage Build", lo: 28000, hi: 60000 },
];

const ROLES = ["Project Manager", "Foreman", "Carpenter", "Electrician", "Plumber", "Painter", "Mason", "Roofer", "Laborer", "HVAC Tech"];
const LICENSE = { Electrician: "Master Electrician", Plumber: "Master Plumber", "HVAC Tech": "HVAC Contractor", Roofer: "Roofing License", "Project Manager": "MN Residential Builder", Foreman: "MN Residential Builder" };

// ---------- EMPLOYEES ----------
const employees = [];
const empNames = [];
for (let i = 0; i < 14; i++) {
  const first = pick(["Mike", "Sarah", "Dave", "Jenny", "Tom", "Lisa", "Carlos", "Erik", "Amy", "Brian", "Kayla", "Sven", "Maria", "Jon", "Nina", "Pete"]);
  const name = `${first} ${pick(LAST)}`;
  empNames.push(name);
  // Guarantee trade coverage across the crew, then randomize the rest
  const FIXED = ["Project Manager", "Project Manager", "Foreman", "Electrician", "Plumber", "Carpenter", "Painter", "Roofer", "HVAC Tech", "Mason"];
  const role = i < FIXED.length ? FIXED[i] : pick(ROLES);
  const rate = role === "Project Manager" ? rint(45, 65) : role === "Foreman" ? rint(38, 52) : ["Electrician", "Plumber", "HVAC Tech"].includes(role) ? rint(40, 58) : rint(24, 40);
  employees.push({
    "Employee ID": `EMP-${String(i + 1).padStart(3, "0")}`,
    "Name": name, "Role": role,
    "Email": `${first.toLowerCase()}@northstarbuild.com`,
    "Phone": `612-555-${String(rint(1000, 9999))}`,
    "Hourly Rate": money(rate),
    "License Type": LICENSE[role] || "",
    "License Number": LICENSE[role] ? `MN-${rint(10000, 99999)}` : "",
    "Status": chance(0.1) ? "On Leave" : "Active",
    "Hire Date": dateStr(rint(2015, 2024), rint(1, 12), rint(1, 28)),
    "Notes": "",
  });
}
const pms = employees.filter(e => ["Project Manager", "Foreman"].includes(e.Role)).map(e => e.Name);

// ---------- PROJECTS + linked records ----------
const projects = [], quotes = [], schedules = [], permits = [], materials = [], invoices = [], receipts = [];

const STATUS_FLOW = ["Lead", "Quoted", "Scheduled", "In Progress", "On Hold", "Completed", "Cancelled"];
const PHASES = ["Demolition", "Framing", "Rough Electrical", "Rough Plumbing", "HVAC", "Insulation", "Drywall", "Flooring", "Cabinetry", "Painting", "Trim & Finish", "Final Inspection", "Cleanup"];
const MAT_CATS = {
  Lumber: ["2x4 Studs (bundle)", "3/4\" Plywood Sheets", "LVL Beam", "Pressure-Treated Decking"],
  Electrical: ["Romex 12/2 (250ft)", "Recessed LED Cans", "200A Panel", "Outlet/Switch Kit"],
  Plumbing: ["PEX Tubing (300ft)", "Kohler Toilet", "Shower Valve Kit", "Sump Pump"],
  Fixtures: ["Pendant Lights", "Bath Vanity 48\"", "Kitchen Faucet", "Door Hardware Set"],
  Flooring: ["LVP Flooring (sq ft)", "Oak Hardwood (sq ft)", "Porcelain Tile (sq ft)", "Carpet Pad"],
  Drywall: ["1/2\" Drywall Sheets", "Joint Compound (5gal)", "Mesh Tape", "Corner Bead"],
  Cabinets: ["Shaker Wall Cabinets", "Base Cabinets", "Quartz Countertop", "Cabinet Pulls"],
  Roofing: ["Architectural Shingles (sq)", "Ice & Water Shield", "Drip Edge", "Ridge Vent"],
  Paint: ["Interior Paint (5gal)", "Primer (5gal)", "Exterior Paint (5gal)", "Trim Enamel"],
};
const SUPPLIERS = ["Menards", "Home Depot Pro", "Lyman Lumber", "Dakota County Lumber", "Ferguson Plumbing", "Border States Electric", "Hirshfield's Paint", "MSI Surfaces", "ABC Supply"];
const PERMIT_TYPES = ["Building", "Electrical", "Plumbing", "Mechanical", "Demolition", "Zoning"];
const PAY_METHODS = ["Company Card", "Check", "ACH Transfer", "Cash"];
const RECEIPT_CATS = ["Materials", "Equipment Rental", "Fuel", "Permits", "Subcontractor", "Tools", "Disposal", "Dumpster"];

let qn = 1000, inv = 5000, permn = 7000;

for (let i = 0; i < 14; i++) {
  const last = LAST[i % LAST.length];
  const pt = pick(PTYPES);
  const city = pick(CITIES);
  const pm = pick(pms);
  const value = rint(pt.lo, pt.hi);
  // weight statuses toward active work
  const status = pick(["Lead", "Quoted", "Scheduled", "In Progress", "In Progress", "In Progress", "On Hold", "Completed", "Completed", "Cancelled"]);
  const startY = 2026, startM = rint(1, 6);
  const start = dateStr(startY, startM, rint(1, 28));
  const durDays = rint(20, 120);
  const target = addDays(start, durDays);
  const isDone = status === "Completed";
  const health = status === "On Hold" ? "Red" : status === "Cancelled" ? "Red" : chance(0.7) ? "Green" : chance(0.6) ? "Yellow" : "Red";
  const pid = `PRJ-${String(i + 1).padStart(3, "0")}`;
  const projName = `${last} ${pt.t}`;
  const client = `${pick(["Robert", "Mary", "James", "Linda", "John", "Patricia", "David", "Jennifer", "Kao", "Mai", "Diego", "Sofia"])} ${last}`;

  projects.push({
    "Project ID": pid, "Project Name": projName, "Client Name": client,
    "Client Email": `${client.split(" ")[0].toLowerCase()}.${last.toLowerCase()}@gmail.com`,
    "Client Phone": `651-555-${String(rint(1000, 9999))}`,
    "Address": `${rint(100, 9999)} ${pick(STREETS)} ${pick(SUFFIX)}`,
    "City": city, "Project Type": pt.t, "Status": status, "Health": health,
    "Contract Value": money(value), "Project Manager": pm,
    "Start Date": start, "Target End Date": target,
    "Actual End Date": isDone ? addDays(target, rint(-5, 14)) : "",
    "Scope Summary": `${pt.t} at a single-family home in ${city}. ${pick(["Full gut and rebuild.", "Mid-grade finishes, homeowner-selected fixtures.", "Permit-required structural work included.", "High-end finishes with custom millwork.", "Includes demo, MEP rough-in, and finish work."])}`,
    "Notes": "",
  });

  // ----- quotes (1-2) -----
  const nq = rint(1, 2);
  for (let q = 0; q < nq; q++) {
    const labor = Math.round(value * (0.35 + rnd() * 0.1));
    const mat = Math.round(value * (0.3 + rnd() * 0.1));
    const permit = Math.round(value * 0.03);
    const cont = Math.round(value * 0.05);
    const total = q === 0 ? value : Math.round(value * (1.05 + rnd() * 0.1));
    const qstatus = status === "Lead" ? "Draft" : status === "Quoted" ? (q === nq - 1 ? "Sent" : "Expired") : status === "Cancelled" ? "Rejected" : "Accepted";
    const qissue = addDays(start, -rint(7, 30));
    quotes.push({
      "Quote Number": `Q-${qn++}`, "Project": projName, "Client Name": client, "Project Type": pt.t,
      "Labor Cost": money(labor), "Material Cost": money(mat), "Permit Cost": money(permit),
      "Contingency": money(cont), "Total Amount": money(total), "Status": qstatus,
      "Issue Date": qissue, "Valid Until": addDays(qissue, 30),
      "Scope": `${pt.t} — ${pick(["labor & materials", "turnkey", "labor only, owner-supplied fixtures", "design-build"])}.`,
      "Notes": q > 0 ? "Revised quote per change order." : "",
    });
  }

  if (status === "Lead") continue; // leads have no downstream work yet

  // Cost budgets as a realistic fraction of contract value. Most jobs land at
  // 30-55% gross margin; ~15% overrun into thin/negative margin for drama.
  const overrun = chance(0.15) ? 1.25 + rnd() * 0.45 : 1;
  // fraction of work complete drives cost-to-date for in-flight jobs
  const progress = status === "Completed" ? 1 : status === "Scheduled" ? 0.1 : status === "On Hold" ? 0.4 : 0.55 + rnd() * 0.35;
  let matBudget = value * (0.26 + rnd() * 0.12) * overrun * progress;
  let recBudget = value * (0.08 + rnd() * 0.08) * overrun * progress;

  // ----- permits (1-3) -----
  const np = rint(1, 3);
  const usedPT = new Set();
  for (let p = 0; p < np; p++) {
    let ptype = pick(PERMIT_TYPES); let guard = 0;
    while (usedPT.has(ptype) && guard++ < 6) ptype = pick(PERMIT_TYPES);
    usedPT.add(ptype);
    const appDate = addDays(start, -rint(0, 14));
    const pstatus = status === "Completed" ? "Approved" : pick(["Applied", "Issued", "Issued", "Inspection Scheduled", "Approved"]);
    const issued = ["Issued", "Inspection Scheduled", "Approved"].includes(pstatus);
    permits.push({
      "Permit Number": `${city.slice(0, 3).toUpperCase()}-${permn++}`, "Project": projName,
      "Permit Type": ptype, "Issuing City": city, "Status": pstatus,
      "Application Date": appDate, "Issue Date": issued ? addDays(appDate, rint(3, 14)) : "",
      "Expiration Date": issued ? addDays(appDate, 180) : "",
      "Fee": money(rint(120, 950)), "Inspector": issued ? `${pick(["Insp.", "Officer"])} ${pick(LAST)}` : "",
      "Notes": "",
    });
  }

  // ----- schedules (3-6 phases) -----
  const nph = rint(3, 6);
  let cur = start;
  const chosen = [...PHASES].sort(() => rnd() - 0.5).slice(0, nph).sort((a, b) => PHASES.indexOf(a) - PHASES.indexOf(b));
  chosen.forEach((task, idx) => {
    const len = rint(2, 12);
    const sStart = cur, sEnd = addDays(cur, len); cur = addDays(sEnd, rint(0, 3));
    let sstatus;
    if (status === "Completed") sstatus = "Completed";
    else if (status === "On Hold") sstatus = idx === 0 ? "Completed" : "Not Started";
    else if (status === "Scheduled") sstatus = "Not Started";
    else sstatus = idx < nph / 2 ? "Completed" : idx === Math.floor(nph / 2) ? "In Progress" : chance(0.2) ? "Delayed" : "Not Started";
    schedules.push({
      "Project": projName, "Task": task, "Assigned To": pick(empNames),
      "Crew Size": money(rint(1, 5)), "Start Date": sStart, "End Date": sEnd,
      "Status": sstatus, "Notes": sstatus === "Delayed" ? pick(["Waiting on material delivery.", "Inspection rescheduled.", "Weather delay."]) : "",
    });
  });

  // ----- materials (4-8), costs distributed across the material budget -----
  const nm = rint(4, 8);
  const matWeights = Array.from({ length: nm }, () => 0.5 + rnd());
  const matWsum = matWeights.reduce((a, b) => a + b, 0);
  for (let m = 0; m < nm; m++) {
    const cat = pick(Object.keys(MAT_CATS));
    const item = pick(MAT_CATS[cat]);
    const lineTotal = Math.max(40, Math.round(matBudget * matWeights[m] / matWsum));
    const qty = rint(1, 24);
    const unit = Math.max(1, Math.round(lineTotal / qty));
    const mstatus = status === "Completed" ? "Installed" : pick(["Needed", "Ordered", "Ordered", "Delivered", "Delivered", "Backordered", "Installed"]);
    const ordered = ["Ordered", "Delivered", "Backordered", "Installed"].includes(mstatus);
    const oDate = ordered ? addDays(start, rint(-7, 20)) : "";
    materials.push({
      "Project": projName, "Item": item, "Category": cat, "Supplier": pick(SUPPLIERS),
      "Quantity": money(qty), "Unit Cost": money(unit), "Total Cost": money(qty * unit),
      "Status": mstatus, "Order Date": oDate,
      "Delivery Date": ["Delivered", "Installed"].includes(mstatus) && oDate ? addDays(oDate, rint(2, 10)) : "",
      "Notes": mstatus === "Backordered" ? "ETA delayed 2 weeks." : "",
    });
  }

  // ----- invoices (1-3) -----
  const ni = status === "Scheduled" ? 1 : rint(1, 3);
  const deposit = Math.round(value * 0.3);
  for (let n = 0; n < ni; n++) {
    const isDeposit = n === 0;
    const amt = isDeposit ? deposit : Math.round((value - deposit) / Math.max(1, ni - 1));
    let istatus, paidDate = "";
    const issueDate = addDays(start, n * rint(15, 35) - 5);
    const dueDate = addDays(issueDate, 30);
    if (status === "Completed") { istatus = "Paid"; paidDate = addDays(dueDate, -rint(0, 20)); }
    else if (isDeposit) { istatus = "Paid"; paidDate = addDays(issueDate, rint(1, 10)); }
    else { istatus = pick(["Sent", "Sent", "Partial", "Overdue", "Draft"]); if (istatus === "Paid") paidDate = addDays(dueDate, -2); }
    invoices.push({
      "Invoice Number": `INV-${inv++}`, "Project": projName, "Client Name": client,
      "Amount": money(amt), "Status": istatus, "Issue Date": issueDate, "Due Date": dueDate,
      "Paid Date": paidDate, "Payment Method": paidDate ? pick(["Check", "ACH Transfer", "Credit Card"]) : "",
      "Notes": isDeposit ? "30% deposit." : `Progress billing #${n}.`,
    });
  }

  // ----- receipts (2-5), amounts distributed across the receipt budget -----
  const nr = rint(2, 5);
  const recWeights = Array.from({ length: nr }, () => 0.5 + rnd());
  const recWsum = recWeights.reduce((a, b) => a + b, 0);
  for (let r = 0; r < nr; r++) {
    const cat = pick(RECEIPT_CATS);
    const amt = Math.max(20, Math.round(recBudget * recWeights[r] / recWsum));
    const method = pick(PAY_METHODS);
    receipts.push({
      "Project": projName, "Vendor": pick(SUPPLIERS.concat(["Sunbelt Rentals", "Twin City Disposal", "Holiday Gas", "United Rentals"])),
      "Category": cat, "Amount": money(amt), "Date": addDays(start, rint(0, durDays)),
      "Paid By": pick(empNames), "Payment Method": method,
      "Reimbursable": method === "Cash" ? "Yes" : chance(0.15) ? "Yes" : "No", "Notes": "",
    });
  }
}

// Guarantee a few overdue invoices for a realistic A/R picture: flip several
// unpaid invoices to Overdue with a past due date.
const unpaid = invoices.filter(i => ["Sent", "Partial", "Draft"].includes(i.Status));
for (let i = 0; i < Math.min(4, unpaid.length); i++) {
  const inv = unpaid[i * 2 % unpaid.length] || unpaid[i];
  inv.Status = "Overdue";
  inv["Due Date"] = `2026-0${rint(1, 4)}-${String(rint(1, 28)).padStart(2, "0")}`;
  inv["Paid Date"] = "";
}

const out = { projects, quotes, schedules, employees, permits, materials, invoices, receipts };
const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "seed-data.json"), JSON.stringify(out, null, 2));
console.log("Wrote seed-data.json:", JSON.stringify(counts));
