/**
 * gen-seed.mjs — generate cross-linked seed data for Kinetic MedQMS (ncrmanager).
 *
 * Builds "Northstar Medical Systems" — a global medical-device manufacturer:
 *   reference data (sites, products, suppliers, equipment) + transactional
 *   quality records across every module, all cross-linked by ID, including a
 *   complete end-to-end showcase scenario and records in normal / overdue /
 *   escalated / rejected / reopened / effectiveness-failed states.
 *
 * Output: seed-data.json keyed by form slug. Pure Node built-ins.
 * Run: node gen-seed.mjs
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const TODAY = new Date("2026-06-27T00:00:00Z");
const DAY = 86400000;

// ── deterministic PRNG so re-runs are stable ────────────────────────────────
let _s = 1337;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const picks = (a, n) => { const c = [...a]; const o = []; while (o.length < n && c.length) o.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return o; };
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(TODAY.getTime() - n * DAY));
const daysAhead = (n) => iso(new Date(TODAY.getTime() + n * DAY));
const pad = (n, w = 4) => String(n).padStart(w, "0");

const out = {};
const add = (form, rec) => { (out[form] ||= []).push(rec); return rec; };

// ── people ──────────────────────────────────────────────────────────────────
const FIRST = ["Maria", "James", "Aisha", "Chen", "Priya", "David", "Sofia", "Liam", "Ingrid", "Omar", "Hannah", "Diego", "Yuki", "Noah", "Fatima", "Lucas", "Elena", "Marcus", "Nina", "Raj", "Clara", "Tomas", "Grace", "Ivan", "Leila", "Sean", "Wei", "Anya", "Pedro", "Hana"];
const LAST = ["Okafor", "Reyes", "Kim", "Patel", "Novak", "Schmidt", "Haddad", "Larsson", "Tanaka", "Rossi", "Mbeki", "Costa", "Nguyen", "Becker", "Andersson", "Silva", "Petrov", "Khan", "Murphy", "Sato", "Dubois", "Weber", "Lindqvist", "Cohen", "Park", "Flores", "Ali", "Jensen", "Romano", "Wu"];
const people = [];
for (let i = 0; i < 30; i++) people.push(`${FIRST[i]} ${LAST[i]}`);
const person = () => pick(people);
// role-aligned named users for personas
const QUALITY_MGRS = people.slice(0, 6);
const INVESTIGATORS = people.slice(6, 14);
const AUDITORS = people.slice(14, 18);
const SQE = people.slice(18, 22); // supplier quality engineers
const DOC_CTRL = people.slice(22, 24);

// ── 1. SITES (12) ────────────────────────────────────────────────────────────
const SITE_DEFS = [
  ["Plymouth MN", "Manufacturing", "USA", "North America", "Plymouth"],
  ["Memphis TN", "Manufacturing", "USA", "North America", "Memphis"],
  ["San José CR", "Manufacturing", "Costa Rica", "Latin America", "San José"],
  ["Galway IE", "Manufacturing", "Ireland", "Europe", "Galway"],
  ["Penang MY", "Manufacturing", "Malaysia", "Asia Pacific", "Penang"],
  ["Shanghai CN", "Manufacturing", "China", "Asia Pacific", "Shanghai"],
  ["Juárez MX", "Manufacturing", "Mexico", "Latin America", "Juárez"],
  ["Eindhoven NL", "Manufacturing", "Netherlands", "Europe", "Eindhoven"],
  ["Memphis DC", "Distribution", "USA", "North America", "Memphis"],
  ["Singapore DC", "Distribution", "Singapore", "Asia Pacific", "Singapore"],
  ["Venlo DC", "Distribution", "Netherlands", "Europe", "Venlo"],
  ["Sydney DC", "Distribution", "Australia", "Asia Pacific", "Sydney"],
];
const sites = [];
SITE_DEFS.forEach((s, i) => {
  const id = `SITE-${pad(i + 1, 3)}`;
  sites.push({ id, name: s[0], type: s[1], region: s[3] });
  add("sites", {
    "Site ID": id, "Name": s[0], "Type": s[1], "Country": s[2], "Region": s[3], "City": s[4],
    "Employees": String(s[1] === "Manufacturing" ? int(450, 1800) : int(80, 300)),
    "Mfg License": s[1] === "Manufacturing" ? `FDA-FEI-${int(1000000, 9999999)}` : "—",
    "Quality Manager": pick(QUALITY_MGRS), "Status": "Active",
    "Notes": s[1] === "Manufacturing" ? "ISO 13485:2016 certified; FDA registered establishment." : "GDP-compliant distribution center.",
  });
});
const mfgSites = sites.filter((s) => s.type === "Manufacturing");
const siteName = () => pick(sites).name;
const mfgSiteName = () => pick(mfgSites).name;

// ── 2. PRODUCTS (30) ──────────────────────────────────────────────────────────
const FAMILIES = [
  ["Infusion Systems", "II"], ["Cardiac Rhythm", "III"], ["Surgical Instruments", "II"],
  ["Orthopedic Implants", "III"], ["Patient Monitoring", "II"], ["Wound Care", "I"],
  ["Diagnostic Imaging", "II"], ["Respiratory", "II"], ["Neuromodulation", "III"], ["Diabetes Care", "II"],
];
const products = [];
let pn = 0;
FAMILIES.forEach(([fam, cls]) => {
  const n = int(2, 4);
  for (let k = 0; k < n; k++) {
    pn++;
    const id = `PRD-${pad(pn)}`;
    const name = `${fam.split(" ")[0]} ${pick(["Pro", "Flex", "Max", "Lite", "X", "Guardian", "Sentry", "Aera", "Vital", "Core"])} ${int(100, 900)}`;
    products.push({ id, name, family: fam, cls });
    add("products", {
      "Product ID": id, "Name": name, "Family": fam, "Device Class": `Class ${cls}`,
      "UDI DI": `00${int(10000000000, 99999999999)}`, "Site": mfgSiteName(),
      "Lifecycle Stage": pick(["Production", "Production", "Production", "Sustaining", "Phase-Out", "Transfer"]),
      "Risk Class": cls === "III" ? "High" : cls === "II" ? "Medium" : "Low",
      "Owner": person(), "Status": "Active",
      "Description": `${fam} device, ${cls === "III" ? "high" : cls === "II" ? "moderate" : "low"}-risk classification.`,
    });
  }
});
const product = () => pick(products);

// ── 3. SUPPLIERS (24) ─────────────────────────────────────────────────────────
const SUP_NAMES = ["Apex Polymers", "Meridian Electronics", "Tellus Metals", "BioCoat Labs", "Precision Molding", "NovaSensor", "Sterling Sterilization", "CleanRoom Systems", "Orbis Components", "Vanguard Plastics", "Helix Circuits", "Cardinal Castings", "PureFlow Tubing", "Quantum Optics", "Atlas Fasteners", "Veritas Calibration", "Summit Adhesives", "Ridgeline Packaging", "Cobalt Batteries", "Delphi Connectors", "Aurora Coatings", "Trellis Software", "Granite Machining", "Pinnacle Textiles"];
const suppliers = [];
SUP_NAMES.forEach((nm, i) => {
  const id = `SUP-${pad(i + 1, 3)}`;
  const risk = pick(["Critical", "Critical", "Major", "Major", "Major", "Minor"]);
  const score = risk === "Critical" ? int(72, 98) : int(80, 99);
  const approval = chance(0.08) ? "Conditional" : chance(0.05) ? "Disqualified" : "Approved";
  const openScars = chance(0.3) ? int(1, 3) : 0;
  suppliers.push({ id, name: nm, risk, approval });
  add("suppliers", {
    "Supplier ID": id, "Name": nm, "Category": pick(["Component", "Raw Material", "Contract Mfg", "Sterilization", "Service", "Software", "Packaging"]),
    "Risk Class": risk, "Approval Status": approval, "Country": pick(["USA", "Germany", "Japan", "Ireland", "Mexico", "China", "Switzerland"]),
    "Quality Agreement": chance(0.85) ? "Executed" : "Pending", "Certification": pick(["ISO 13485", "ISO 9001", "ISO 13485 + AS9100", "ISO 13485"]),
    "Cert Expiry": chance(0.15) ? daysAgo(int(5, 90)) : daysAhead(int(30, 700)),
    "Score": String(score), "On Time Pct": String(int(82, 100)), "PPM Defect": String(risk === "Critical" ? int(20, 900) : int(5, 300)),
    "Open SCARs": String(openScars), "Last Audit Date": daysAgo(int(30, 700)), "Next Review Date": chance(0.2) ? daysAgo(int(5, 60)) : daysAhead(int(20, 300)),
    "Contact Name": person(), "Contact Email": `quality@${nm.toLowerCase().replace(/[^a-z]/g, "")}.com`,
    "Owner": pick(SQE), "Status": approval === "Disqualified" ? "Inactive" : "Active",
    "Notes": risk === "Critical" ? "Critical-to-quality supplier; requires annual on-site audit." : "Periodic review per supplier management procedure.",
  });
});
const supplier = () => pick(suppliers);

// ── 4. EQUIPMENT (40) ────────────────────────────────────────────────────────
const EQ_TYPES = [["Gauge", "Caliper"], ["Gauge", "Micrometer"], ["Instrument", "CMM"], ["Instrument", "Tensile Tester"], ["Machine", "Injection Molder"], ["Machine", "Laser Welder"], ["Instrument", "Particle Counter"], ["Instrument", "Torque Analyzer"], ["Gauge", "Pressure Gauge"], ["Instrument", "Environmental Chamber"]];
for (let i = 0; i < 40; i++) {
  const [type, base] = pick(EQ_TYPES);
  const id = `EQP-${pad(i + 1)}`;
  const overdue = chance(0.18);
  const oot = chance(0.08);
  add("equipment", {
    "Equipment ID": id, "Name": `${base} ${int(10, 99)}`, "Type": type, "Site": mfgSiteName(),
    "Location": `Line ${int(1, 12)} / Bay ${int(1, 8)}`,
    "Status": oot ? "Out of Service" : "In Service",
    "Last Calibration": daysAgo(int(20, 360)), "Calibration Due": overdue ? daysAgo(int(2, 45)) : daysAhead(int(10, 300)),
    "Cal Interval Days": String(pick([90, 180, 365])), "Tolerance": pick(["±0.01 mm", "±0.5 N", "±2%", "±0.1 °C", "±1 psi"]),
    "Out Of Tolerance": oot ? "Yes" : "No", "Maintenance Due": chance(0.2) ? daysAgo(int(1, 30)) : daysAhead(int(15, 200)),
    "Production Restricted": oot ? "Yes" : "No", "Owner": person(),
    "Description": oot ? "Failed as-found calibration; affected-product assessment in progress." : "Within calibration interval.",
  });
}

// ── counters for transactional IDs ────────────────────────────────────────────
const ctr = {};
const nextId = (prefix, w = 4) => { ctr[prefix] = (ctr[prefix] || 0) + 1; return `${prefix}-${pad(ctr[prefix], w)}`; };

// audit-trail + esignature helpers ─────────────────────────────────────────────
let corr = 0;
const trail = (recType, recId, actor, action, field, oldV, newV, state, reason, when) => add("audit-trail", {
  "Entry ID": nextId("AT", 5), "Record Type": recType, "Record ID": recId, "Actor": actor, "Action": action,
  "Field": field || "—", "Old Value": oldV || "", "New Value": newV || "", "Reason": reason || "",
  "Workflow State": state || "", "Source": "MedQMS UI", "Correlation ID": `COR-${pad(++corr, 6)}`, "Timestamp": when || daysAgo(int(1, 200)),
});
const esign = (recType, recId, signer, meaning, reason, version, when) => add("esignatures", {
  "Signature ID": nextId("SIG", 5), "Record Type": recType, "Record ID": recId, "Signer": signer.toLowerCase().replace(/[^a-z]/g, ".").slice(0, 20),
  "Signer Name": signer, "Meaning": meaning, "Reason": reason || meaning, "Record Version": String(version || 1),
  "Auth Method": "Password Re-authentication", "Signed Date": when || daysAgo(int(1, 120)),
  "Hash": "sha256:" + Array.from({ length: 12 }, () => "0123456789abcdef"[int(0, 15)]).join(""), "Correlation ID": `COR-${pad(++corr, 6)}`,
});

// ──状態 helpers ───────────────────────────────────────────────────────────────
const openOrClosed = (statuses, closedStatuses) => pick(statuses);

// ════════════════════════════════════════════════════════════════════════════
//  SHOWCASE SCENARIO — fixed IDs, complete end-to-end chain
// ════════════════════════════════════════════════════════════════════════════
const SC = {};
(function showcase() {
  const prod = products.find((p) => p.family === "Infusion Systems") || products[0];
  const site = "Plymouth MN";
  const owner = "Maria Okafor"; const investigator = "David Schmidt"; const sqe = SQE[0];
  const cmpId = "CMP-0001", riskId = "RSK-0001", qeId = "QE-0001", ncId = "NC-0001",
    capaId = "CAPA-0001", chgId = "CHG-0001", mrId = "MR-2026-Q1";
  SC.ids = { cmpId, riskId, qeId, ncId, capaId, chgId, mrId, prod: prod.id };

  // 1. Complaint (received 95 days ago)
  add("complaints", {
    "Complaint ID": cmpId, "Title": "Infusion pump occlusion alarm delayed activation", "Product": `${prod.id} - ${prod.name}`,
    "UDI": `00${int(10000000000, 99999999999)}`, "Lot": "LOT-INF-22841", "Customer": "Mercy Regional Health System",
    "Site": site, "Severity": "High", "Patient Impact": "Potential under-infusion; no injury reported", "Adverse Event": "Yes",
    "Reportable": "Yes", "Report Type": "MDR", "Regulatory Due Date": daysAgo(65), "Owner": "Sofia Haddad",
    "Status": "Closed", "Received Date": daysAgo(95), "Closed Date": daysAgo(8),
    "Investigation Summary": "Returned device confirmed occlusion-sensor firmware threshold caused delayed alarm under low-flow conditions. Reportable per 21 CFR 803; MDR filed within 30 days.",
    "Returned Product": "Yes", "Duplicate Of": "", "Linked CAPA": capaId, "Linked Risk": riskId, "Linked Event": qeId,
    "Description": "Field complaint from clinical user: occlusion alarm activated later than specified at low infusion rates.",
  });
  // 2. Risk (linked from complaint)
  add("risks", {
    "Risk ID": riskId, "Title": "Delayed occlusion alarm under low-flow infusion", "Type": "Product", "Product": `${prod.id} - ${prod.name}`,
    "Process": "Firmware alarm logic", "Site": site, "Hazard": "Delayed therapy interruption", "Hazardous Situation": "Occlusion not annunciated within specified time at <5 mL/h flow",
    "Harm": "Under-infusion of critical medication", "Cause": "Alarm threshold insensitive at low flow", "Severity": "Serious", "Probability": "Occasional",
    "Risk Level": "High", "Control": "Firmware update lowering low-flow occlusion threshold; verification testing across flow range", "Verification": "V&V protocol VP-2287 passed",
    "Residual Severity": "Serious", "Residual Probability": "Improbable", "Residual Level": "Low", "Benefit Risk": "Acceptable — benefit outweighs residual risk",
    "Owner": "Priya Patel", "Status": "Controlled", "Linked CAPA": capaId, "Linked Complaint": cmpId,
    "Description": "Post-production signal from complaint CMP-0001 reassessed in product risk file per ISO 14971.",
  });
  // 3. Quality Event (intake that spawned NC + CAPA)
  add("quality-events", {
    "Event ID": qeId, "Title": "Occlusion alarm timing nonconformance signal", "Type": "Complaint", "Source": "Customer Complaint",
    "Severity": "High", "Risk Level": "High", "Site": site, "Product": `${prod.id} - ${prod.name}`, "Lot": "LOT-INF-22841", "Supplier": "",
    "Reported By": "Sofia Haddad", "Confidential": "No", "Anonymous": "No", "Owner": owner, "Status": "Closed", "Priority": "High",
    "Disposition": "Escalated to CAPA", "Reported Date": daysAgo(93), "Due Date": daysAgo(79), "Closed Date": daysAgo(8),
    "Linked CAPA": capaId, "Linked NC": ncId, "Linked Complaint": cmpId,
    "Description": "Complaint triaged; product/process nonconformance confirmed and escalated to CAPA per quality-event procedure QP-001.",
  });
  // 4. Nonconformance (containment)
  add("nonconformances", {
    "NC ID": ncId, "Title": "Occlusion alarm firmware out of specification", "Source Event": qeId, "Product": `${prod.id} - ${prod.name}`,
    "Lot": "LOT-INF-22841", "Serial": "Multiple", "Qty Affected": "1,420 units (field) + 380 units (DC inventory)", "Site": site,
    "Severity": "High", "Risk Level": "High", "Containment": "DC inventory placed on hold; field stock-recovery advisory issued", "Segregation": "380 units quarantined at Memphis DC",
    "Disposition": "Rework", "MRB Decision": "Rework via firmware update; field units corrected under change CHG-0001", "MRB Date": daysAgo(80),
    "Owner": investigator, "Status": "Closed", "Detected Date": daysAgo(92), "Due Date": daysAgo(78), "Closed Date": daysAgo(10),
    "Linked CAPA": capaId, "Linked Complaint": cmpId,
    "Description": "Firmware threshold confirmed out of specification; containment and disposition managed through MRB.",
  });
  // 5. CAPA (the spine) — Closed, effectiveness Passed
  add("capas", {
    "CAPA ID": capaId, "Title": "Correct low-flow occlusion alarm threshold (Infusion Systems)", "Type": "Corrective", "Source": "Complaint",
    "Source Event": qeId, "Risk Level": "High", "Priority": "High", "Site": site, "Product": `${prod.id} - ${prod.name}`, "Supplier": "",
    "Owner": owner, "Status": "Closed", "Investigation Method": "Five Whys + Fault Tree",
    "Root Cause Summary": "Occlusion-detection threshold validated only at nominal flow; low-flow regime not covered in original V&V.",
    "Root Causes": "1) Requirement gap: low-flow occlusion timing not specified. 2) Verification gap: test matrix omitted <5 mL/h flows.",
    "Containment": "Inventory hold + field advisory (see NC-0001).",
    "Effectiveness Criteria": "Zero recurrence of delayed-alarm complaints for 90 days post-deployment AND passing field-data trend review.",
    "Effectiveness Result": "Passed", "Opened Date": daysAgo(90), "Due Date": daysAgo(20), "Closed Date": daysAgo(6), "Reopened": "No",
    "Signature Status": "Signed", "Linked NC": ncId, "Linked Complaint": cmpId, "Linked Risk": riskId, "Linked Change": chgId, "Linked SCAR": "",
    "Description": "Root-cause-driven correction of occlusion alarm logic with verification, document/firmware change, training and effectiveness check.",
  });
  // CAPA actions
  const acts = [
    ["Update alarm-timing requirement spec for low-flow regime", "Corrective", "Closed", daysAgo(40)],
    ["Expand V&V test matrix to cover 1–5 mL/h flows", "Corrective", "Closed", daysAgo(35)],
    ["Deploy firmware update via change CHG-0001", "Corrective", "Closed", daysAgo(22)],
    ["Assign retraining on revised SOP to affected operators", "Preventive", "Closed", daysAgo(18)],
    ["90-day field-data effectiveness trend review", "Verification", "Closed", daysAgo(6)],
  ];
  acts.forEach(([t, ty, st, dd], i) => add("capa-actions", {
    "Action ID": `${capaId}-A${i + 1}`, "CAPA ID": capaId, "Title": t, "Type": ty, "Owner": i === 4 ? "Priya Patel" : investigator,
    "Status": st, "Due Date": dd, "Completed Date": dd, "Verification": ty === "Verification" ? "Trend review: 0 recurrences / 90 days" : "Reviewed and verified",
    "Evidence": pick(["VP-2287 report", "ECO-0001 record", "Training matrix export", "Field-data dashboard snapshot"]),
    "Description": t,
  }));
  // 6. Change request (firmware + SOP)
  add("change-requests", {
    "Change ID": chgId, "Title": "Firmware v4.2 — low-flow occlusion threshold + SOP-INF-014 rev", "Type": "Document + Design", "Document": "SOP-INF-014",
    "Risk Level": "High", "Impact Assessment": "Affects all Infusion Systems Class II products in production; requires V&V, DHF update and operator retraining.",
    "Validation Required": "Yes", "Status": "Closed", "Owner": "Chen Kim", "Site": site, "Requested Date": daysAgo(60), "Due Date": daysAgo(25),
    "Approved Date": daysAgo(30), "Training Impact": "Yes", "Linked CAPA": capaId, "Linked Product": `${prod.id} - ${prod.name}`,
    "Description": "Change implementing CAPA-0001 correction across firmware and controlled SOP.",
  });
  // 7. Training auto-assigned from the change (mix complete + the showcase shows compliance)
  ["Maria Okafor", "David Schmidt", "Lucas Silva", "Nina Andersson", "Diego Costa"].forEach((emp, i) => add("training-records", {
    "Training ID": nextId("TRN"), "Employee": emp, "Role": "Manufacturing Operator", "Curriculum": "SOP-INF-014 rev C — Occlusion alarm verification",
    "Document": "SOP-INF-014", "Source": "Document Revision", "Status": i === 4 ? "Completed" : "Completed", "Site": site,
    "Assigned Date": daysAgo(28), "Due Date": daysAgo(14), "Completed Date": daysAgo(i + 9), "Expiration Date": daysAhead(365 - i),
    "Score": String(int(88, 100)), "Linked CAPA": capaId, "Linked Change": chgId,
  }));
  // 8. Management review metric
  add("mgmt-reviews", {
    "Review ID": mrId, "Title": "Q1 2026 Management Review — Plymouth & Global QMS", "Period": "2026 Q1", "Site": "All Sites", "Status": "Approved",
    "Review Date": daysAgo(12), "Chair": "Maria Okafor", "Open CAPAs": "—", "Overdue Items": "—", "Complaint Trend": "Infusion occlusion signal closed via CAPA-0001 (effectiveness Passed)",
    "Supplier Performance": "2 critical suppliers below target; SCARs open", "Audit Results": "1 major finding (Galway) under remediation",
    "Training Compliance": "Global 94% on-time; Plymouth 98%",
    "Inputs Summary": "Complaint CMP-0001 → CAPA-0001 → CHG-0001 closed with effectiveness Passed; residual risk RSK-0001 reduced to Low. Reviewed audit results, supplier performance, training compliance and open quality records.",
    "Actions": "Approve closure of CAPA-0001; monitor Infusion occlusion trend a further 90 days; escalate critical-supplier SCARs.", "Owner": "Maria Okafor",
  });
  // audit-trail + esign for the spine
  trail("complaints", cmpId, "Sofia Haddad", "Created", "", "", "Open", "Intake", "Complaint logged from customer report", daysAgo(95));
  trail("complaints", cmpId, "Sofia Haddad", "Reportability Decision", "Reportable", "Undetermined", "Yes", "Investigation", "Meets MDR criteria per 21 CFR 803", daysAgo(88));
  trail("capas", capaId, owner, "Created", "", "", "Initiated", "Escalated from QE-0001", daysAgo(90));
  trail("capas", capaId, investigator, "Status Change", "Status", "Investigation", "Effectiveness", "Verification complete", daysAgo(20));
  trail("capas", capaId, owner, "Status Change", "Status", "Effectiveness", "Closed", "Effectiveness criteria met", daysAgo(6));
  esign("capas", capaId, "Priya Patel", "Effectiveness Approved", "90-day trend shows zero recurrence", 3, daysAgo(6));
  esign("capas", capaId, "Maria Okafor", "CAPA Closure Approved", "All actions verified and effective", 3, daysAgo(6));
  esign("change-requests", chgId, "Chen Kim", "Change Approved", "V&V complete; ready for deployment", 2, daysAgo(30));
})();

// ════════════════════════════════════════════════════════════════════════════
//  BULK transactional records (varied states)
// ════════════════════════════════════════════════════════════════════════════
const EVENT_TYPES = ["Deviation", "Nonconformance", "Complaint", "Audit Finding", "Supplier Issue", "Safety Signal", "Observation", "Service Finding"];
const SEV = ["Low", "Medium", "High", "Critical"];
const QE_STATUS = ["Open", "Triage", "Investigation", "Pending Approval", "Closed", "Closed", "Closed", "Rejected"];
const evTitles = ["Particulate observed in fill line", "Label print misregistration", "Sterilization cycle parameter excursion", "Incoming component dimensional reject", "Software alarm false-positive", "Packaging seal integrity variance", "Calibration overdue on torque analyzer", "Operator gowning deviation", "Supplier lot certificate mismatch", "Environmental monitoring excursion", "Bonding strength below spec", "Traceability gap in DHR", "Coating thickness out of range", "Connector mating force high", "Battery capacity drift"];

// Quality Events (bulk)
const eventIds = [SC.ids.qeId];
for (let i = 0; i < 64; i++) {
  const id = nextId("QE");
  const type = pick(EVENT_TYPES);
  const status = pick(QE_STATUS);
  const open = !["Closed", "Rejected"].includes(status);
  const sev = pick(SEV);
  const reported = daysAgo(int(2, 220));
  const due = iso(new Date(new Date(reported).getTime() + int(10, 40) * DAY));
  const overdue = open && new Date(due) < TODAY;
  const conf = chance(0.1);
  const sup = type === "Supplier Issue" ? supplier() : null;
  const prod = chance(0.7) ? product() : null;
  add("quality-events", {
    "Event ID": id, "Title": pick(evTitles), "Type": type, "Source": pick(["Production Floor", "Incoming Inspection", "Customer Complaint", "Internal Audit", "Supplier", "Field Service", "Employee Observation"]),
    "Severity": sev, "Risk Level": sev === "Critical" ? "High" : sev === "High" ? "High" : pick(["Low", "Medium"]),
    "Site": mfgSiteName(), "Product": prod ? `${prod.id} - ${prod.name}` : "", "Lot": chance(0.6) ? `LOT-${int(10000, 99999)}` : "",
    "Supplier": sup ? `${sup.id} - ${sup.name}` : "", "Reported By": conf ? "(confidential)" : person(),
    "Confidential": conf ? "Yes" : "No", "Anonymous": conf && chance(0.5) ? "Yes" : "No",
    "Owner": pick(QUALITY_MGRS.concat(INVESTIGATORS)), "Status": status, "Priority": sev === "Critical" ? "Critical" : pick(["Low", "Medium", "High"]),
    "Disposition": status === "Closed" ? pick(["Closed - No Action", "Escalated to CAPA", "Corrected", "Use As Is"]) : "",
    "Reported Date": reported, "Due Date": due, "Closed Date": open ? "" : daysAgo(int(1, 30)),
    "Linked CAPA": "", "Linked NC": "", "Linked Complaint": "",
    "Description": `${type} reported at ${siteName()}; under handling per quality-event procedure.`,
  });
  eventIds.push(id);
  trail("quality-events", id, person(), "Created", "", "", "Open", "Intake", "Event logged", reported);
  if (!open) trail("quality-events", id, person(), "Status Change", "Status", "Investigation", status, "Disposition reached", daysAgo(int(1, 20)));
  if (overdue) trail("quality-events", id, "system", "Escalation", "Status", "", "Escalated", "Due date exceeded", daysAgo(1));
}

// Nonconformances (bulk)
const NC_DISP = ["Use As Is", "Rework", "Scrap", "Return to Supplier", "Concession"];
const NC_STATUS = ["Open", "Containment", "MRB Review", "Disposition", "Closed", "Closed", "Reopened"];
for (let i = 0; i < 29; i++) {
  const id = nextId("NC");
  const status = pick(NC_STATUS);
  const open = !["Closed"].includes(status);
  const prod = product();
  const detected = daysAgo(int(3, 180));
  const due = iso(new Date(new Date(detected).getTime() + int(14, 45) * DAY));
  add("nonconformances", {
    "NC ID": id, "Title": pick(evTitles), "Source Event": chance(0.6) ? pick(eventIds) : "", "Product": `${prod.id} - ${prod.name}`,
    "Lot": `LOT-${int(10000, 99999)}`, "Serial": chance(0.3) ? `SN-${int(100000, 999999)}` : "Multiple", "Qty Affected": String(int(1, 2000)),
    "Site": mfgSiteName(), "Severity": pick(SEV), "Risk Level": pick(["Low", "Medium", "High"]),
    "Containment": pick(["Quarantine hold applied", "Line stopped", "Inventory segregated", "No containment required"]),
    "Segregation": chance(0.7) ? `${int(10, 800)} units quarantined` : "N/A",
    "Disposition": ["Closed", "Disposition", "Reopened"].includes(status) ? pick(NC_DISP) : "",
    "MRB Decision": status === "Closed" ? pick(["Approved rework per SOP", "Scrap approved", "Use-as-is with concession", "Return to supplier"]) : "",
    "MRB Date": status === "Closed" ? daysAgo(int(2, 60)) : "", "Owner": pick(INVESTIGATORS),
    "Status": status, "Detected Date": detected, "Due Date": due, "Closed Date": open ? "" : daysAgo(int(1, 30)),
    "Linked CAPA": "", "Linked Complaint": "", "Description": `Nonconformance on ${prod.name} pending material review.`,
  });
  trail("nonconformances", id, person(), "Created", "", "", "Open", "Intake", "NC raised", detected);
  if (status === "Reopened") trail("nonconformances", id, person(), "Reopened", "Status", "Closed", "Reopened", "New evidence on disposition", daysAgo(int(1, 15)));
}

// Suppliers issues drive SCARs ───────────────────────────────────────────────
const SCAR_STATUS = ["Issued", "Supplier Response", "Review", "Accepted", "Rejected", "Closed", "Closed", "Escalated"];
const scarIds = [];
for (let i = 0; i < 18; i++) {
  const id = nextId("SCAR");
  const sup = supplier();
  const status = pick(SCAR_STATUS);
  const open = !["Closed", "Accepted"].includes(status);
  const issued = daysAgo(int(5, 160));
  const respDue = iso(new Date(new Date(issued).getTime() + int(14, 30) * DAY));
  const overdue = open && new Date(respDue) < TODAY;
  add("scars", {
    "SCAR ID": id, "Title": `${pick(["Dimensional", "Documentation", "Contamination", "Late delivery", "Functional", "Labeling"])} nonconformance — ${sup.name}`,
    "Supplier": `${sup.id} - ${sup.name}`, "Source Event": chance(0.5) ? pick(eventIds) : "", "Issue Type": pick(["Dimensional", "Documentation", "Contamination", "Delivery", "Functional", "Labeling"]),
    "Severity": pick(SEV), "Status": status, "Owner": pick(SQE), "Supplier Contact": person(),
    "Issued Date": issued, "Response Due Date": respDue, "Response Date": ["Review", "Accepted", "Rejected", "Closed"].includes(status) ? daysAgo(int(1, 40)) : "",
    "Root Cause": ["Review", "Accepted", "Closed"].includes(status) ? pick(["Tooling wear", "Process drift", "Training gap", "Measurement system error"]) : "",
    "Containment": open ? pick(["Sort in progress", "Hold on incoming lots", "100% inspection"]) : "Containment verified",
    "Effectiveness": status === "Closed" ? pick(["Verified", "Verified", "Pending"]) : "", "Score Impact": String(-int(1, 8)),
    "Escalated": status === "Escalated" || overdue ? "Yes" : "No", "Linked CAPA": "",
    "Description": `Supplier corrective action requested from ${sup.name}.`,
  });
  scarIds.push({ id, sup });
  trail("scars", id, pick(SQE), "Issued", "", "", "Issued", "SCAR issued to supplier", issued);
  if (overdue) trail("scars", id, "system", "Escalation", "Status", "", "Escalated", "Supplier response overdue", daysAgo(1));
}

// CAPAs (bulk) ─────────────────────────────────────────────────────────────────
const CAPA_STATUS = ["Initiated", "Triage", "Investigation", "Action Planning", "Implementation", "Verification", "Effectiveness", "Closed", "Closed", "Reopened"];
const INV_METHODS = ["Five Whys", "Ishikawa (Fishbone)", "Fault Tree Analysis", "Is/Is-Not Analysis", "Human Factors Analysis", "Five Whys + Fault Tree"];
const capaIds = [SC.ids.capaId];
for (let i = 0; i < 27; i++) {
  const id = nextId("CAPA");
  const status = pick(CAPA_STATUS);
  const open = !["Closed"].includes(status);
  const risk = pick(["Low", "Medium", "High", "High"]);
  const opened = daysAgo(int(5, 200));
  const due = iso(new Date(new Date(opened).getTime() + int(30, 90) * DAY));
  const overdue = open && new Date(due) < TODAY;
  const effFailed = status === "Reopened" || (status === "Closed" && chance(0.12));
  const src = pick(["Complaint", "Nonconformance", "Audit Finding", "Deviation", "Supplier Issue", "Management Review", "Trend"]);
  const sup = src === "Supplier Issue" ? supplier() : null;
  const prod = chance(0.7) ? product() : null;
  add("capas", {
    "CAPA ID": id, "Title": `${pick(["Reduce", "Eliminate", "Correct", "Prevent recurrence of"])} ${pick(evTitles).toLowerCase()}`,
    "Type": chance(0.75) ? "Corrective" : "Preventive", "Source": src, "Source Event": chance(0.6) ? pick(eventIds) : "",
    "Risk Level": risk, "Priority": risk === "High" ? "High" : pick(["Low", "Medium"]), "Site": mfgSiteName(),
    "Product": prod ? `${prod.id} - ${prod.name}` : "", "Supplier": sup ? `${sup.id} - ${sup.name}` : "",
    "Owner": pick(QUALITY_MGRS.concat(INVESTIGATORS)), "Status": status, "Investigation Method": pick(INV_METHODS),
    "Root Cause Summary": ["Verification", "Effectiveness", "Closed", "Reopened"].includes(status) ? pick(["Process parameter drift outside validated range.", "Insufficient operator training on revised procedure.", "Supplier material variation not detected at incoming.", "Design tolerance stack-up under worst case.", "Inadequate preventive maintenance interval."]) : "",
    "Root Causes": ["Verification", "Effectiveness", "Closed", "Reopened"].includes(status) ? "Primary + contributing causes documented" : "",
    "Containment": pick(["Inventory hold", "Line stop", "100% inspection", "No containment required"]),
    "Effectiveness Criteria": ["Effectiveness", "Closed", "Reopened"].includes(status) ? "No recurrence over defined monitoring window + metric within target" : "",
    "Effectiveness Result": status === "Closed" ? (effFailed ? "Failed" : "Passed") : status === "Reopened" ? "Failed" : "",
    "Opened Date": opened, "Due Date": due, "Closed Date": open ? "" : daysAgo(int(1, 40)), "Reopened": status === "Reopened" ? "Yes" : "No",
    "Signature Status": status === "Closed" ? "Signed" : pick(["Pending", "Not Required", ""]),
    "Linked NC": "", "Linked Complaint": "", "Linked Risk": "", "Linked Change": "", "Linked SCAR": sup && chance(0.4) ? pick(scarIds).id : "",
    "Description": `CAPA addressing ${src.toLowerCase()} source.`,
  });
  capaIds.push(id);
  trail("capas", id, person(), "Created", "", "", "Initiated", "CAPA opened", opened);
  if (overdue) trail("capas", id, "system", "Escalation", "Due Date", "", "Overdue", "Past due date", daysAgo(1));
  if (status === "Reopened") trail("capas", id, person(), "Reopened", "Status", "Closed", "Reopened", "Effectiveness check failed", daysAgo(int(1, 20)));
  if (status === "Closed") { esign("capas", id, pick(QUALITY_MGRS), "CAPA Closure Approved", "Actions verified", int(2, 4), daysAgo(int(1, 40))); }
  // a few actions per CAPA
  const na = int(2, 4);
  for (let k = 0; k < na; k++) {
    const ast = open ? pick(["Open", "In Progress", "Completed"]) : "Completed";
    const adue = iso(new Date(new Date(opened).getTime() + int(20, 80) * DAY));
    add("capa-actions", {
      "Action ID": `${id}-A${k + 1}`, "CAPA ID": id, "Title": pick(["Update procedure", "Retrain operators", "Modify tooling", "Add inspection step", "Revise specification", "Implement poka-yoke", "Validate process change"]),
      "Type": pick(["Corrective", "Preventive", "Verification"]), "Owner": person(), "Status": ast,
      "Due Date": adue, "Completed Date": ast === "Completed" ? daysAgo(int(1, 60)) : "",
      "Verification": ast === "Completed" ? pick(["Verified effective", "Evidence reviewed", "Re-inspection passed"]) : "",
      "Evidence": ast === "Completed" ? pick(["Training record", "Updated SOP", "Inspection report", "Validation protocol"]) : "", "Description": "Action plan item",
    });
  }
}

// Complaints (bulk) ─────────────────────────────────────────────────────────────
const CMP_STATUS = ["Open", "Investigation", "Reportability Review", "Pending Closure", "Closed", "Closed", "Closed"];
for (let i = 0; i < 39; i++) {
  const id = nextId("CMP");
  const status = pick(CMP_STATUS);
  const open = status !== "Closed";
  const prod = product();
  const reportable = chance(0.22);
  const ae = reportable || chance(0.15);
  const received = daysAgo(int(2, 200));
  const regDue = reportable ? iso(new Date(new Date(received).getTime() + 30 * DAY)) : "";
  add("complaints", {
    "Complaint ID": id, "Title": pick(["Device alarm malfunction", "Unexpected shutdown", "Material degradation", "Inaccurate reading", "Connector failure", "Battery depletion", "Display fault", "Leakage observed", "Mechanical breakage", "Software freeze"]),
    "Product": `${prod.id} - ${prod.name}`, "UDI": `00${int(10000000000, 99999999999)}`, "Lot": `LOT-${int(10000, 99999)}`,
    "Customer": pick(["Mercy Regional", "St. Vincent Hospital", "Northwell Health", "Cleveland Clinic", "Kaiser West", "NHS Trust 7", "Apollo Hospitals", "Charité Berlin"]),
    "Site": mfgSiteName(), "Severity": pick(SEV), "Patient Impact": ae ? pick(["Minor injury", "No injury - potential harm", "Temporary harm"]) : "No patient impact",
    "Adverse Event": ae ? "Yes" : "No", "Reportable": reportable ? "Yes" : (status.includes("Reportability") ? "Undetermined" : "No"),
    "Report Type": reportable ? pick(["MDR", "MIR", "MDR"]) : "None", "Regulatory Due Date": regDue,
    "Owner": pick(QUALITY_MGRS.concat(["Sofia Haddad"])), "Status": status, "Received Date": received, "Closed Date": open ? "" : daysAgo(int(1, 40)),
    "Investigation Summary": open ? "" : pick(["Root cause confirmed; no trend.", "Use error; labeling adequate.", "Component fault traced to supplier lot.", "Could not duplicate; monitoring."]),
    "Returned Product": chance(0.5) ? "Yes" : "No", "Duplicate Of": chance(0.06) ? `CMP-${pad(int(2, 30))}` : "",
    "Linked CAPA": "", "Linked Risk": "", "Linked Event": "", "Description": "Product complaint received via customer care.",
  });
  trail("complaints", id, person(), "Created", "", "", "Open", "Intake", "Complaint logged", received);
  if (reportable) trail("complaints", id, "Sofia Haddad", "Reportability Decision", "Reportable", "Undetermined", "Yes", "Investigation", "Meets reporting criteria", daysAgo(int(1, 50)));
}

// Audits + findings ─────────────────────────────────────────────────────────────
const AUDIT_TYPES = ["Internal", "Supplier", "Regulatory", "Certification", "Process", "Product"];
const AUDIT_STATUS = ["Scheduled", "In Progress", "Reporting", "Closed", "Closed"];
const auditIds = [];
for (let i = 0; i < 16; i++) {
  const id = nextId("AUD");
  const type = pick(AUDIT_TYPES);
  const status = pick(AUDIT_STATUS);
  const closed = status === "Closed";
  const sup = type === "Supplier" ? supplier() : null;
  const planned = closed ? daysAgo(int(20, 300)) : chance(0.5) ? daysAhead(int(5, 90)) : daysAgo(int(1, 30));
  const major = closed ? int(0, 2) : 0, minor = closed ? int(0, 5) : 0;
  add("audits", {
    "Audit ID": id, "Title": `${type} audit — ${sup ? sup.name : mfgSiteName()}`, "Type": type, "Scope": pick(["Full QMS", "Production & Process Controls", "Document Control", "CAPA & Complaints", "Supplier Management", "Design Controls"]),
    "Standard": pick(["ISO 13485:2016", "21 CFR 820 QMSR", "ISO 13485 + MDR", "ISO 14971"]), "Site": sup ? "" : mfgSiteName(), "Supplier": sup ? `${sup.id} - ${sup.name}` : "",
    "Lead Auditor": pick(AUDITORS), "Status": status, "Result": closed ? (major > 0 ? "Findings - Major" : minor > 0 ? "Findings - Minor" : "Conforming") : "",
    "Planned Date": planned, "Completed Date": closed ? planned : "", "Findings Count": String(major + minor), "Major Count": String(major), "Minor Count": String(minor),
    "Owner": pick(AUDITORS), "Description": `${type} audit against ${pick(["ISO 13485", "QMSR", "MDR"])}.`,
  });
  auditIds.push(id);
  // findings
  const fc = major + minor;
  for (let k = 0; k < fc; k++) {
    const fid = nextId("FND");
    const cls = k < major ? "Major" : "Minor";
    const fstatus = pick(["Open", "Response Submitted", "Remediation", "Closed", "Closed"]);
    const fdue = daysAhead(int(-20, 60));
    add("audit-findings", {
      "Finding ID": fid, "Audit ID": id, "Title": pick(["Incomplete DHR records", "CAPA overdue beyond procedure", "Calibration records gap", "Training records not current", "Supplier requalification overdue", "Validation evidence missing", "Risk file not updated"]),
      "Classification": cls, "Clause": pick(["7.5.1", "8.2.2", "8.5.2", "7.6", "6.2", "7.3.7", "4.2.4"]), "Site": sup ? "" : mfgSiteName(), "Supplier": sup ? `${sup.id} - ${sup.name}` : "",
      "Owner": person(), "Status": fstatus, "Due Date": fdue, "Response": fstatus === "Open" ? "" : "Response submitted with action plan",
      "Remediation": fstatus === "Closed" ? "Verified effective" : "In progress", "Linked CAPA": cls === "Major" && chance(0.7) ? pick(capaIds) : "",
      "Description": `${cls} finding from ${id}.`,
    });
  }
}

// Documents + change requests ────────────────────────────────────────────────────
const DOC_TYPES = ["Policy", "SOP", "Work Instruction", "Specification", "Form", "Template"];
const DOC_STATUS = ["Draft", "In Review", "Approved", "Effective", "Effective", "Effective", "Obsolete"];
const docIds = [];
for (let i = 0; i < 36; i++) {
  const id = nextId("DOC");
  const type = pick(DOC_TYPES);
  const status = pick(DOC_STATUS);
  const reviewDue = chance(0.25) ? daysAgo(int(1, 60)) : daysAhead(int(20, 400));
  const prod = chance(0.4) ? product() : null;
  add("documents", {
    "Document ID": id, "Title": `${type} — ${pick(["Incoming Inspection", "Sterilization", "Device Assembly", "Complaint Handling", "CAPA", "Calibration", "Cleanroom Gowning", "Label Control", "Risk Management", "Design Review"])}`,
    "Type": type, "Revision": `${pick(["A", "B", "C", "D"])}${chance(0.3) ? "." + int(1, 5) : ""}`, "Status": status, "Owner": pick(DOC_CTRL.concat(QUALITY_MGRS)),
    "Site": chance(0.5) ? mfgSiteName() : "All Sites", "Effective Date": status === "Effective" ? daysAgo(int(10, 600)) : "", "Review Due Date": reviewDue,
    "Training Required": chance(0.5) ? "Yes" : "No", "Linked Process": pick(["Assembly", "Sterilization", "Inspection", "Packaging", "Labeling"]),
    "Linked Product": prod ? `${prod.id} - ${prod.name}` : "", "Description": `${type} controlled document.`,
  });
  docIds.push(id);
}
const CHG_STATUS = ["Draft", "Impact Assessment", "Approval", "Implementation", "Verification", "Closed", "Closed", "Rejected"];
for (let i = 0; i < 20; i++) {
  const id = nextId("CHG");
  const status = pick(CHG_STATUS);
  const open = !["Closed", "Rejected"].includes(status);
  const risk = pick(["Low", "Medium", "High"]);
  const requested = daysAgo(int(5, 160));
  const due = iso(new Date(new Date(requested).getTime() + int(20, 60) * DAY));
  add("change-requests", {
    "Change ID": id, "Title": `${pick(["Update", "Revise", "Replace", "Add"])} ${pick(["SOP", "spec", "supplier", "process step", "label", "material"])} — ${pick(["assembly", "inspection", "sterilization", "packaging"])}`,
    "Type": pick(["Document", "Process", "Document + Design", "Supplier", "Material"]), "Document": pick(docIds), "Risk Level": risk,
    "Impact Assessment": open && status === "Draft" ? "" : "Affected products, processes and documents assessed; training impact evaluated.",
    "Validation Required": risk === "High" ? "Yes" : pick(["Yes", "No"]), "Status": status, "Owner": pick(DOC_CTRL.concat(QUALITY_MGRS)),
    "Site": chance(0.5) ? mfgSiteName() : "All Sites", "Requested Date": requested, "Due Date": due, "Approved Date": ["Implementation", "Verification", "Closed"].includes(status) ? daysAgo(int(1, 40)) : "",
    "Training Impact": chance(0.5) ? "Yes" : "No", "Linked CAPA": chance(0.3) ? pick(capaIds) : "", "Linked Product": chance(0.4) ? (() => { const p = product(); return `${p.id} - ${p.name}`; })() : "",
    "Description": "Change request under document/change control.",
  });
  if (status === "Closed") esign("change-requests", id, pick(QUALITY_MGRS), "Change Approved", "Impact assessed and validated", 2, daysAgo(int(1, 40)));
}

// Training records (bulk) ────────────────────────────────────────────────────────
const TRN_STATUS = ["Assigned", "In Progress", "Completed", "Completed", "Completed", "Overdue"];
const ROLES = ["Manufacturing Operator", "Quality Engineer", "Process Owner", "Inspector", "Auditor", "Document Control", "Supplier Quality Engineer"];
for (let i = 0; i < 80; i++) {
  const id = nextId("TRN");
  const status = pick(TRN_STATUS);
  const done = status === "Completed";
  const assigned = daysAgo(int(5, 200));
  const due = iso(new Date(new Date(assigned).getTime() + int(14, 45) * DAY));
  const overdue = status === "Overdue" || (!done && new Date(due) < TODAY);
  add("training-records", {
    "Training ID": id, "Employee": person(), "Role": pick(ROLES), "Curriculum": pick(["SOP revision training", "Annual GMP refresher", "CAPA methodology", "Complaint handling", "Aseptic technique", "Risk management ISO 14971", "Calibration procedure"]),
    "Document": pick(docIds), "Source": pick(["Document Revision", "Role Change", "CAPA", "Quality Event", "Periodic"]), "Status": overdue ? "Overdue" : status,
    "Site": mfgSiteName(), "Assigned Date": assigned, "Due Date": due, "Completed Date": done ? daysAgo(int(1, 60)) : "",
    "Expiration Date": done ? (chance(0.15) ? daysAgo(int(1, 40)) : daysAhead(int(20, 365))) : "", "Score": done ? String(int(75, 100)) : "",
    "Linked CAPA": chance(0.15) ? pick(capaIds) : "", "Linked Change": "",
  });
}

// Risk register (bulk) ──────────────────────────────────────────────────────────
const RISK_LEVELS = ["Low", "Medium", "High"];
const HARMS = ["Infection", "Tissue damage", "Delayed therapy", "Electric shock", "Allergic reaction", "Inaccurate diagnosis", "Bleeding", "Burn"];
for (let i = 0; i < 30; i++) {
  const id = nextId("RSK");
  const type = chance(0.6) ? "Product" : "Process";
  const prod = type === "Product" ? product() : null;
  const level = pick(RISK_LEVELS.concat(["High"]));
  const residual = level === "High" ? pick(["Low", "Medium"]) : "Low";
  add("risks", {
    "Risk ID": id, "Title": `${pick(HARMS)} risk — ${type === "Product" ? prod.family : pick(["Sterilization", "Assembly", "Packaging", "Inspection"])}`,
    "Type": type, "Product": prod ? `${prod.id} - ${prod.name}` : "", "Process": type === "Process" ? pick(["Sterilization", "Assembly", "Packaging"]) : "", "Site": mfgSiteName(),
    "Hazard": pick(["Biological", "Chemical", "Electrical", "Mechanical", "Thermal", "Functional"]), "Hazardous Situation": "Use or process condition leading to potential harm",
    "Harm": pick(HARMS), "Cause": pick(["Material variation", "Use error", "Component failure", "Process drift", "Software defect"]),
    "Severity": pick(["Negligible", "Minor", "Serious", "Critical"]), "Probability": pick(["Improbable", "Remote", "Occasional", "Probable"]), "Risk Level": level,
    "Control": "Design/process control with verification", "Verification": pick(["V&V passed", "Inspection", "Validation report", "Test protocol"]),
    "Residual Severity": pick(["Negligible", "Minor", "Serious"]), "Residual Probability": pick(["Improbable", "Remote"]), "Residual Level": residual,
    "Benefit Risk": residual === "Low" ? "Acceptable" : "Acceptable with monitoring", "Owner": pick(QUALITY_MGRS.concat(INVESTIGATORS)), "Status": pick(["Open", "Controlled", "Controlled", "Monitoring"]),
    "Linked CAPA": chance(0.2) ? pick(capaIds) : "", "Linked Complaint": "", "Description": "Risk item in product/process risk file (ISO 14971).",
  });
}

// Management reviews (bulk) ───────────────────────────────────────────────────────
["2025 Q2", "2025 Q3", "2025 Q4", "2026 Q1"].forEach((per, i) => {
  if (per === "2026 Q1") return; // showcase already added MR-2026-Q1
  add("mgmt-reviews", {
    "Review ID": `MR-${per.replace(" ", "-")}`, "Title": `${per} Management Review — Global QMS`, "Period": per, "Site": "All Sites", "Status": "Approved",
    "Review Date": daysAgo((4 - i) * 90), "Chair": pick(QUALITY_MGRS), "Open CAPAs": String(int(15, 35)), "Overdue Items": String(int(3, 14)),
    "Complaint Trend": pick(["Stable", "Slight increase in Infusion family", "Decreasing"]), "Supplier Performance": pick(["On target", "2 suppliers below target"]),
    "Audit Results": pick(["No majors", "1 major under remediation"]), "Training Compliance": `${int(88, 97)}% on-time`,
    "Inputs Summary": "Reviewed audit results, complaints, CAPA performance, supplier performance, process metrics, regulatory changes, risks and prior actions.",
    "Actions": "Resource adjustments and continued monitoring of open quality signals.", "Owner": pick(QUALITY_MGRS),
  });
});

// ── write ─────────────────────────────────────────────────────────────────────
const totals = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
fs.writeFileSync(path.join(DIR, "seed-data.json"), JSON.stringify(out, null, 1));
console.log("seed-data.json written. Record counts:");
console.table(totals);
console.log("Total records:", Object.values(totals).reduce((a, b) => a + b, 0));
