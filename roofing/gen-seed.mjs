/**
 * gen-seed.mjs — generate coherent, linked Twin Cities seed data for the
 * Summit Ridge Roofing app. Writes seed-data.json keyed by form slug.
 * Deterministic (seeded PRNG) so re-runs produce identical data.
 *
 * Models a small crew: ~10 staff, ~18 jobs (so ~15/yr active), with materials,
 * invoices, customer feedback, a lead pipeline and marketing campaigns.
 */
import fs from "node:fs";
import path from "node:path";

// ---- deterministic PRNG (mulberry32) ----
let _s = 0x51ed270b;
function rnd() { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const rint = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const money = (n) => String(Math.round(n));
const chance = (p) => rnd() < p;
function dateStr(y, m, d) { return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
function addDays(iso, days) { const dt = new Date(iso + "T00:00:00Z"); dt.setUTCDate(dt.getUTCDate() + days); return dt.toISOString().slice(0, 10); }

const CITIES = ["Minneapolis", "St. Paul", "Bloomington", "Edina", "Plymouth", "Maple Grove", "Minnetonka", "Eden Prairie", "Woodbury", "Roseville", "St. Louis Park", "Maplewood", "Blaine", "Apple Valley", "Shakopee"];
const LAST = ["Johnson", "Anderson", "Nguyen", "Olson", "Peterson", "Carlson", "Hansen", "Larson", "Schmidt", "Patel", "Garcia", "Bergstrom", "Lindqvist", "Hoffman", "Reyes", "Novak", "Vang", "Erickson"];
const FIRST = ["Robert", "Mary", "James", "Linda", "John", "Patricia", "David", "Jennifer", "Kao", "Mai", "Diego", "Sofia", "Greg", "Karen", "Tony", "Beth", "Hassan", "Yer"];
const STREETS = ["Oak", "Maple", "Cedar", "Birch", "Linden", "Hennepin", "Grand", "Summit", "Lake", "Nicollet", "Como", "Snelling", "Excelsior", "France", "Lyndale", "Penn"];
const SUFFIX = ["Ave", "St", "Blvd", "Ln", "Rd", "Way", "Ct", "Ave N", "Ave S"];

// Roof types with per-square install pricing ($/square installed, incl. labor+materials)
const ROOF_TYPES = [
  { t: "Architectural Shingle", lo: 400, hi: 650, w: 5 },
  { t: "3-Tab Shingle", lo: 300, hi: 480, w: 2 },
  { t: "Designer Shingle", lo: 600, hi: 900, w: 1 },
  { t: "Standing Seam Metal", lo: 900, hi: 1500, w: 2 },
  { t: "Cedar Shake", lo: 800, hi: 1300, w: 1 },
  { t: "Flat / EPDM", lo: 500, hi: 850, w: 1 },
];
function pickRoofType() {
  const bag = ROOF_TYPES.flatMap(r => Array(r.w).fill(r));
  return pick(bag);
}

const LEAD_SOURCES = ["Storm Canvass", "Referral", "Door Knock", "Google Ads", "Facebook", "Yard Sign", "Home Show", "Website", "Nextdoor"];

// ---------- CREW (10 staff: seasonal/temporary roofers + sales) ----------
const crew = [];
const CREW_FIRST = ["Mike", "Sarah", "Dave", "Jenny", "Tom", "Carlos", "Erik", "Brian", "Sven", "Maria", "Jon", "Nina", "Pete", "Luis"];
const FIXED_ROLES = ["Project Manager", "Crew Lead", "Crew Lead", "Roofer", "Roofer", "Laborer", "Laborer", "Sales Rep", "Sales Rep", "Estimator"];
const CERTS = {
  "Crew Lead": "OSHA-30, GAF Master Elite",
  "Roofer": "OSHA-10, Fall Protection",
  "Laborer": "OSHA-10",
  "Sales Rep": "HAAG Certified Inspector",
  "Estimator": "HAAG Certified, Xactimate",
  "Project Manager": "OSHA-30, MN Residential Builder",
};
for (let i = 0; i < 10; i++) {
  const first = CREW_FIRST[i];
  const name = `${first} ${pick(LAST)}`;
  const role = FIXED_ROLES[i];
  const empType = role === "Project Manager" ? "Full-Time"
    : ["Sales Rep", "Estimator"].includes(role) ? (chance(0.5) ? "Full-Time" : "Subcontractor")
    : pick(["Seasonal", "Seasonal", "Temporary"]);
  const rate = role === "Project Manager" ? rint(38, 52)
    : role === "Crew Lead" ? rint(30, 42)
    : role === "Estimator" ? rint(32, 45)
    : role === "Sales Rep" ? rint(22, 30)
    : role === "Roofer" ? rint(24, 34) : rint(18, 26);
  crew.push({
    "Employee ID": `SRR-${String(i + 1).padStart(3, "0")}`,
    "Name": name, "Role": role,
    "Email": `${first.toLowerCase()}@summitridgeroof.com`,
    "Phone": `612-555-${String(rint(1000, 9999))}`,
    "Hourly Rate": money(rate),
    "Employment Type": empType,
    "Status": empType === "Seasonal" && chance(0.25) ? "Seasonal" : chance(0.08) ? "Inactive" : "Active",
    "Hire Date": dateStr(rint(2019, 2025), rint(1, 12), rint(1, 28)),
    "Certifications": CERTS[role] || "",
    "Notes": "",
  });
}
const crewLeads = crew.filter(c => ["Crew Lead", "Project Manager"].includes(c.Role)).map(c => c.Name);
const salesReps = crew.filter(c => ["Sales Rep", "Estimator", "Project Manager"].includes(c.Role)).map(c => c.Name);

// ---------- CAMPAIGNS (marketing process) ----------
const CAMPAIGN_DEFS = [
  { name: "Spring Storm Response 2026", channel: "Storm Canvass", budget: 12000, status: "Active" },
  { name: "Google Search — Roof Replacement", channel: "Google Ads", budget: 9000, status: "Active" },
  { name: "Facebook Lead Gen Q2", channel: "Facebook", budget: 5000, status: "Active" },
  { name: "Neighborhood Yard Signs", channel: "Yard Signs", budget: 1500, status: "Active" },
  { name: "Twin Cities Home & Garden Show", channel: "Home Show", budget: 4000, status: "Completed" },
  { name: "Referral Rewards Program", channel: "Referral Program", budget: 3000, status: "Active" },
  { name: "Spring Direct Mail Drop", channel: "Direct Mail", budget: 3500, status: "Completed" },
  { name: "Nextdoor Neighborhood Sponsorship", channel: "Nextdoor", budget: 2000, status: "Paused" },
];
const campaigns = CAMPAIGN_DEFS.map((c) => {
  const spendPct = c.status === "Completed" ? 0.9 + rnd() * 0.15 : c.status === "Paused" ? 0.3 + rnd() * 0.3 : 0.4 + rnd() * 0.4;
  const spend = Math.round(Math.min(c.budget, c.budget * spendPct));
  // Small-shop scale: a few dozen leads and a handful of jobs per channel at most.
  const cpl = c.channel === "Storm Canvass" ? rint(180, 320) : c.channel === "Google Ads" ? rint(220, 400)
    : c.channel === "Home Show" ? rint(150, 280) : c.channel === "Direct Mail" ? rint(160, 300) : rint(120, 260);
  const leadsGen = Math.min(38, Math.max(3, Math.round(spend / cpl)));
  const closeRate = c.channel === "Referral Program" ? 0.30 + rnd() * 0.2 : 0.08 + rnd() * 0.17;
  const jobsWon = Math.min(6, Math.max(0, Math.round(leadsGen * closeRate)));
  const avgJob = rint(11000, 19000);
  const start = dateStr(2026, rint(1, 3), rint(1, 28));
  return {
    "Campaign Name": c.name, "Channel": c.channel, "Status": c.status,
    "Start Date": start, "End Date": c.status === "Completed" ? addDays(start, rint(20, 60)) : addDays(start, 120),
    "Budget": money(c.budget), "Spend": money(spend),
    "Leads Generated": String(leadsGen), "Jobs Won": String(jobsWon),
    "Revenue": money(jobsWon * avgJob),
    "Owner": pick(salesReps), "Notes": "",
  };
});
const campaignNames = campaigns.map(c => c["Campaign Name"]);

// ---------- JOBS + linked materials / invoices / feedback ----------
const projects = [], materials = [], invoices = [], feedback = [];

const MAT_CATS = {
  Shingles: ["Architectural Shingles", "3-Tab Shingles", "Designer Shingles", "Metal Panels", "Ridge Cap Shingles"],
  Underlayment: ["Synthetic Underlayment", "Ice & Water Shield", "30lb Felt", "Starter Strip"],
  Ventilation: ["Ridge Vent", "Box Vents", "Soffit Vents", "Power Attic Fan"],
  Flashing: ["Step Flashing", "Drip Edge", "Pipe Boots", "Chimney Flashing Kit", "Valley Flashing"],
  Fasteners: ["Roofing Nails (50lb)", "Cap Nails (box)", "Roofing Cement"],
  Decking: ["7/16 OSB Sheathing", "1/2 Plywood Sheet"],
  Disposal: ["30yd Dumpster", "Tear-off Disposal"],
};
const MAT_UNITS = { Shingles: "square", Underlayment: "roll", Ventilation: "ea", Flashing: "ea", Fasteners: "box", Decking: "sheet", Disposal: "ea" };
const SUPPLIERS = ["ABC Supply", "SRS Distribution", "Beacon Building Products", "Menards", "Home Depot Pro", "Spec Building Materials"];
const PAY_METHODS = ["Check", "ACH Transfer", "Credit Card", "Insurance Check", "Financing"];

const FB_SOURCES = ["Google", "Facebook", "Angi", "Direct", "Nextdoor", "BBB"];
const FB_POS = [
  "Crew showed up on time and finished our reroof in a single day. Yard was spotless afterward.",
  "Handled the entire insurance claim for us after the June hail storm. Couldn't be easier.",
  "Great communication from estimate through final inspection. New roof looks fantastic.",
  "Fair price, no surprises, and the crew lead walked us through everything. Highly recommend.",
  "Best contractor we've worked with in the Twin Cities. Cleaned up every last nail.",
  "Quick turnaround and the metal roof looks incredible. Worth every penny.",
];
const FB_MIX = [
  "Job was solid overall, though the dumpster sat in the driveway a few extra days.",
  "Good work on the roof. Took a little longer than quoted because of weather.",
  "Happy with the result. Wish the office had returned calls a bit faster.",
];
const FB_NEG = [
  "Roof is fine but there was a mix-up on the shingle color we had to sort out.",
  "Crew did good work but left some debris in the gutters we had to clean.",
];

let inv = 5000, leadIdCounter = 1;

// Status mix tuned for a small shop: a healthy backlog plus a year of completed work.
const STATUS_BAG = ["Sold", "Scheduled", "In Progress", "In Progress", "Completed", "Completed", "Completed", "Completed", "Warranty", "Cancelled"];

const NUM_JOBS = 18;
for (let i = 0; i < NUM_JOBS; i++) {
  const last = LAST[i % LAST.length];
  const rt = pickRoofType();
  const city = pick(CITIES);
  const crewLead = pick(crewLeads);
  const squares = rint(14, 42);
  const perSq = rint(rt.lo, rt.hi);
  const value = squares * perSq;
  const status = pick(STATUS_BAG);
  const stories = pick(["1", "1", "2", "2", "3"]);
  const tearOff = chance(0.8) ? "Yes" : "No";
  const insurance = chance(0.55) ? "Yes" : "No";
  const leadSource = insurance === "Yes" && chance(0.6) ? "Storm Canvass" : pick(LEAD_SOURCES);

  const soldM = rint(1, 6);
  const sold = dateStr(2026, soldM, rint(1, 28));
  const start = addDays(sold, rint(7, 35));
  const durDays = rint(1, 6); // roofs go fast
  const target = addDays(start, durDays);
  const isDone = ["Completed", "Warranty"].includes(status);
  const health = ["Cancelled"].includes(status) ? "Red"
    : status === "Completed" || status === "Warranty" ? "Green"
    : chance(0.7) ? "Green" : chance(0.6) ? "Yellow" : "Red";
  const pid = `JOB-${String(i + 1).padStart(3, "0")}`;
  const projName = `${last} Residence Reroof`;
  const customer = `${pick(FIRST)} ${last}`;

  projects.push({
    "Project ID": pid, "Project Name": projName, "Customer Name": customer,
    "Customer Email": `${customer.split(" ")[0].toLowerCase()}.${last.toLowerCase()}@gmail.com`,
    "Customer Phone": `651-555-${String(rint(1000, 9999))}`,
    "Address": `${rint(100, 9999)} ${pick(STREETS)} ${pick(SUFFIX)}`,
    "City": city, "Roof Type": rt.t, "Roof Squares": String(squares), "Stories": stories,
    "Tear Off": tearOff, "Status": status, "Health": health,
    "Contract Value": money(value), "Crew Lead": crewLead, "Lead Source": leadSource,
    "Insurance Claim": insurance,
    "Sold Date": sold, "Start Date": status === "Sold" ? "" : start,
    "Target End Date": target, "Actual End Date": isDone ? addDays(target, rint(-1, 3)) : "",
    "Scope Summary": `${tearOff === "Yes" ? "Full tear-off" : "Overlay"} and replacement of ${squares} sq ${rt.t.toLowerCase()} roof on a ${stories}-story home in ${city}.${insurance === "Yes" ? " Insurance claim (storm/hail damage)." : ""}`,
    "Notes": "",
  });

  if (status === "Cancelled") continue;

  // overrun ~15% of jobs into thin margin
  const overrun = chance(0.15) ? 1.2 + rnd() * 0.3 : 1;
  const progress = isDone ? 1 : status === "Scheduled" ? 0.1 : status === "Sold" ? 0 : 0.5 + rnd() * 0.4;
  const matBudget = value * (0.32 + rnd() * 0.08) * overrun;

  // ----- materials (4-7), distributed across material budget -----
  const nm = rint(4, 7);
  const cats = Object.keys(MAT_CATS);
  // always include shingles + underlayment + disposal
  const chosenCats = ["Shingles", "Underlayment", "Disposal"];
  while (chosenCats.length < nm) { const c = pick(cats); if (!chosenCats.includes(c)) chosenCats.push(c); }
  const weights = chosenCats.map(c => c === "Shingles" ? 3 + rnd() : c === "Disposal" ? 0.4 : 0.6 + rnd());
  const wsum = weights.reduce((a, b) => a + b, 0);
  chosenCats.forEach((cat, idx) => {
    const item = cat === "Shingles" ? (MAT_CATS.Shingles.find(s => rt.t.includes(s.split(" ")[0])) || pick(MAT_CATS[cat])) : pick(MAT_CATS[cat]);
    const lineTotal = Math.max(60, Math.round(matBudget * weights[idx] / wsum));
    const qty = cat === "Shingles" ? squares + rint(1, 3) : cat === "Disposal" ? 1 : rint(2, 30);
    const unit = Math.max(1, Math.round(lineTotal / qty));
    const mstatus = isDone ? "Installed" : status === "Sold" ? "Needed" : pick(["Ordered", "Delivered", "Delivered", "Backordered", "Installed"]);
    const ordered = ["Ordered", "Delivered", "Backordered", "Installed"].includes(mstatus);
    const oDate = ordered ? addDays(start, rint(-7, 2)) : "";
    materials.push({
      "Project": projName, "Item": item, "Category": cat, "Supplier": pick(SUPPLIERS),
      "Quantity": String(qty), "Unit": MAT_UNITS[cat], "Unit Cost": money(unit), "Total Cost": money(qty * unit),
      "Status": mstatus, "Order Date": oDate,
      "Delivery Date": ["Delivered", "Installed"].includes(mstatus) && oDate ? addDays(oDate, rint(1, 5)) : "",
      "Notes": mstatus === "Backordered" ? "Color backordered — ETA 1 week." : "",
    });
  });

  // ----- invoices: deposit + final (+ insurance supplement) -----
  const deposit = Math.round(value * (insurance === "Yes" ? 0.0 : 0.3));
  const invList = [];
  if (deposit > 0) invList.push({ type: "Deposit", amt: deposit, frac: 0 });
  if (insurance === "Yes") {
    // ACV check, then final / supplement
    invList.push({ type: "Progress", amt: Math.round(value * 0.6), frac: 0 });
    if (chance(0.5)) invList.push({ type: "Supplement", amt: Math.round(value * 0.15), frac: 1 });
    invList.push({ type: "Final", amt: value - invList.reduce((s, x) => s + x.amt, 0), frac: 1 });
  } else {
    invList.push({ type: "Final", amt: value - deposit, frac: 1 });
  }
  invList.forEach((row, n) => {
    if (row.amt <= 0) return;
    const issueDate = addDays(start, row.type === "Deposit" ? -3 : row.frac ? durDays + rint(0, 5) : n * 5);
    const dueDate = addDays(issueDate, 15);
    let istatus = "Draft", paidDate = "";
    if (status === "Sold") istatus = row.type === "Deposit" ? "Sent" : "Draft";
    else if (isDone) { istatus = "Paid"; paidDate = addDays(dueDate, -rint(0, 12)); }
    else if (row.type === "Deposit") { istatus = "Paid"; paidDate = addDays(issueDate, rint(1, 7)); }
    else istatus = pick(["Sent", "Sent", "Partial", "Draft"]);
    invoices.push({
      "Invoice Number": `INV-${inv++}`, "Project": projName, "Customer Name": customer,
      "Amount": money(row.amt), "Type": row.type, "Status": istatus,
      "Issue Date": issueDate, "Due Date": dueDate, "Paid Date": paidDate,
      "Payment Method": paidDate ? (insurance === "Yes" ? pick(["Insurance Check", "Check", "ACH Transfer"]) : pick(PAY_METHODS)) : "",
      "Insurance Claim": insurance, "Notes": row.type === "Supplement" ? "Insurance supplement — additional storm damage." : "",
    });
  });

  // ----- feedback for completed jobs -----
  if (isDone && chance(0.8)) {
    const rating = chance(0.65) ? 5 : chance(0.7) ? 4 : chance(0.6) ? 3 : 2;
    const comment = rating >= 5 ? pick(FB_POS) : rating >= 4 ? pick(FB_MIX) : pick(FB_NEG);
    const fbDate = addDays(target, rint(3, 30));
    const recommend = rating >= 4 ? "Yes" : chance(0.4) ? "Yes" : "No";
    feedback.push({
      "Project": projName, "Customer Name": customer, "Rating": String(rating),
      "Would Recommend": recommend, "Review Source": pick(FB_SOURCES), "Crew Lead": crewLead,
      "Status": rating <= 3 ? pick(["Follow Up Needed", "Responded"]) : pick(["Reviewed", "Responded", "Resolved"]),
      "Date": fbDate, "Comments": comment,
      "Response": rating <= 3 ? "Thanks for the feedback — our PM reached out to make it right." : (chance(0.5) ? "Thank you for trusting Summit Ridge with your roof!" : ""),
      "Notes": "",
    });
  }
}

// ---------- LEADS (marketing/sales pipeline) ----------
const leads = [];
const LEAD_STATUS_BAG = ["New", "New", "Contacted", "Contacted", "Inspection Scheduled", "Estimate Sent", "Estimate Sent", "Won", "Won", "Lost"];
const NUM_LEADS = 28;
for (let i = 0; i < NUM_LEADS; i++) {
  const last = pick(LAST);
  const name = `${pick(FIRST)} ${last}`;
  const source = pick(LEAD_SOURCES);
  const storm = ["Storm Canvass"].includes(source) ? "Yes" : chance(0.35) ? "Yes" : "No";
  const status = pick(LEAD_STATUS_BAG);
  const rt = pickRoofType();
  const est = rint(14, 40) * rint(rt.lo, rt.hi);
  const leadDate = dateStr(2026, rint(1, 6), rint(1, 28));
  const campaign = pick([...campaignNames.filter(c => {
    // loosely match campaign channel to lead source
    return true;
  })]);
  leads.push({
    "Lead ID": `LEAD-${String(leadIdCounter++).padStart(4, "0")}`,
    "Name": name,
    "Email": `${name.split(" ")[0].toLowerCase()}.${last.toLowerCase()}@gmail.com`,
    "Phone": `763-555-${String(rint(1000, 9999))}`,
    "Address": `${rint(100, 9999)} ${pick(STREETS)} ${pick(SUFFIX)}`,
    "City": pick(CITIES), "Source": source, "Status": status,
    "Roof Type": rt.t, "Estimated Value": money(est),
    "Assigned To": pick(salesReps), "Storm Related": storm, "Campaign": campaign,
    "Lead Date": leadDate, "Last Contact": status === "New" ? "" : addDays(leadDate, rint(1, 21)),
    "Notes": status === "Lost" ? pick(["Went with a cheaper bid.", "Decided to wait until next year.", "Insurance denied the claim."]) : storm === "Yes" ? "Hail damage reported — free inspection scheduled." : "",
  });
}

// Guarantee a small but realistic A/R aging picture: flip a few unpaid
// invoices on active (non-completed) jobs to Overdue with a past due date.
const completedNames = new Set(projects.filter(p => ["Completed", "Warranty"].includes(p.Status)).map(p => p["Project Name"]));
const flippable = invoices.filter(i => ["Sent", "Partial"].includes(i.Status) && !completedNames.has(i.Project));
for (let i = 0; i < Math.min(3, flippable.length); i++) {
  const target = flippable[(i * 2) % flippable.length] || flippable[i];
  target.Status = "Overdue";
  target["Due Date"] = dateStr(2026, rint(1, 3), rint(1, 28));
  target["Paid Date"] = "";
}

const out = { crew, campaigns, projects, materials, invoices, feedback, leads };
const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "seed-data.json"), JSON.stringify(out, null, 2));
console.log("Wrote seed-data.json:", JSON.stringify(counts));
