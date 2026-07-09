/**
 * gen-seed.mjs — deterministic seed generator for RoamCare Workforce Hub.
 * Writes seed-data.json keyed by form slug. Re-runs are stable (seeded PRNG).
 * Pre-computes Match Recommendations with the real match-engine so explanations
 * in seed data match what the live server produces.
 *
 * Usage: node gen-seed.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { scoreMatch, explain } from "./match-engine.mjs";

const DIR = path.dirname(new URL(import.meta.url).pathname);

// ── Deterministic PRNG (mulberry32) ───────────────────────────────────
let _s = 0x9e3779b9;
function rnd() {
  _s |= 0;
  _s = (_s + 0x6d2b79f5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];
const picks = (a, n) => {
  const c = [...a];
  const out = [];
  for (let i = 0; i < n && c.length; i++) out.push(c.splice(Math.floor(rnd() * c.length), 1)[0]);
  return out;
};
const chance = (p) => rnd() < p;
const intIn = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pad = (n, w = 4) => String(n).padStart(w, "0");

// ── Date helpers (anchored, deterministic — no Date.now dependency) ────
const TODAY = new Date("2026-06-10T00:00:00Z");
const dayMs = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const isoT = (d) => new Date(d).toISOString().slice(0, 16).replace("T", " ");
const offsetDays = (n) => iso(TODAY.getTime() + n * dayMs);
const offsetDaysT = (n, hour = 7) =>
  isoT(TODAY.getTime() + n * dayMs + hour * 3600000);

// ── Reference data ────────────────────────────────────────────────────
const FACILITIES = [
  { name: "Riverside Medical Center", campus: "Main Campus", city: "Minneapolis", state: "MN", region: "Metro Core", contact: "Dana Whitfield" },
  { name: "Lakeshore Children's Hospital", campus: "Pediatric Campus", city: "St. Paul", state: "MN", region: "Metro East", contact: "Marcus Bell" },
  { name: "Summit Heart & Vascular Institute", campus: "Specialty Campus", city: "Edina", state: "MN", region: "Metro South", contact: "Priya Raman" },
  { name: "Northgate Community Hospital", campus: "North Campus", city: "Blaine", state: "MN", region: "Metro North", contact: "Helen Ortiz" },
  { name: "Westview Behavioral Health", campus: "Behavioral Campus", city: "Plymouth", state: "MN", region: "Metro West", contact: "Sam Okafor" },
];
const FAC_NAMES = FACILITIES.map((f) => f.name);

// role -> { family, requiredCreds, skills }
const ROLES = {
  "Registered Nurse": { family: "Nursing", creds: ["RN License", "BLS"], skills: ["IV Therapy", "Medication Administration", "Wound Care", "Triage", "Telemetry", "ICU"] },
  "CNA": { family: "Nursing Support", creds: ["CNA Certification", "BLS"], skills: ["Patient Hygiene", "Vital Signs", "Mobility Assistance", "Wound Care"] },
  "Respiratory Therapist": { family: "Allied Health", creds: ["Respiratory Therapist License", "BLS", "ACLS"], skills: ["Ventilator Management", "Airway Management", "Oxygen Therapy"] },
  "Radiology Tech": { family: "Allied Health", creds: ["Radiology Certification", "BLS"], skills: ["X-Ray", "CT Imaging", "Patient Positioning"] },
  "Pharmacist": { family: "Pharmacy", creds: ["Pharmacist License", "BLS"], skills: ["Medication Review", "Sterile Compounding", "Clinical Consult"] },
  "Pharmacy Tech": { family: "Pharmacy", creds: ["Pharmacy Technician License"], skills: ["Medication Dispensing", "Inventory", "Sterile Compounding"] },
  "Patient Access Representative": { family: "Administrative", creds: ["HIPAA Training"], skills: ["Registration", "Insurance Verification", "Scheduling"] },
  "Transport Aide": { family: "Support Services", creds: ["BLS"], skills: ["Patient Transport", "Bariatric Transport", "Wheelchair Safety"] },
  "Environmental Services Tech": { family: "Support Services", creds: ["Bloodborne Pathogens"], skills: ["Terminal Cleaning", "Infection Control", "Floor Care"] },
  "Security Officer": { family: "Support Services", creds: ["Workplace Violence Prevention"], skills: ["Behavioral De-escalation", "Access Control", "Incident Response"] },
  "Unit Coordinator": { family: "Administrative", creds: ["HIPAA Training"], skills: ["Order Entry", "Scheduling", "Coordination"] },
  "Medical Assistant": { family: "Allied Health", creds: ["BLS", "HIPAA Training"], skills: ["Phlebotomy", "EKG", "Specimen Collection", "Vital Signs"] },
};
const ROLE_NAMES = Object.keys(ROLES);

const DEPARTMENTS = [
  "Emergency Department", "ICU", "Med/Surg", "Pediatrics", "Labor & Delivery",
  "Respiratory Therapy", "Radiology", "Pharmacy", "Patient Registration",
  "Environmental Services", "Transport", "Food Services", "Security", "Supply Chain",
  "Outpatient Surgery", "Behavioral Health", "Cardiac Cath Lab", "Telemetry",
  "Oncology", "NICU", "Float Pool", "Post-Anesthesia Care", "Wound Care Clinic",
  "Sterile Processing", "Case Management",
];
const DEPT_TYPE = {
  "Emergency Department": "Emergency", "ICU": "Clinical", "Med/Surg": "Clinical",
  "Pediatrics": "Clinical", "Labor & Delivery": "Clinical", "Respiratory Therapy": "Clinical",
  "Radiology": "Specialty", "Pharmacy": "Specialty", "Patient Registration": "Administrative",
  "Environmental Services": "Support Services", "Transport": "Support Services",
  "Food Services": "Support Services", "Security": "Support Services", "Supply Chain": "Support Services",
  "Outpatient Surgery": "Specialty", "Behavioral Health": "Clinical", "Cardiac Cath Lab": "Specialty",
  "Telemetry": "Clinical", "Oncology": "Specialty", "NICU": "Clinical", "Float Pool": "Clinical",
  "Post-Anesthesia Care": "Clinical", "Wound Care Clinic": "Specialty",
  "Sterile Processing": "Support Services", "Case Management": "Administrative",
};

const CERTS = [
  { name: "BLS", type: "Certification", org: "American Heart Association", years: 2 },
  { name: "ACLS", type: "Certification", org: "American Heart Association", years: 2 },
  { name: "PALS", type: "Certification", org: "American Heart Association", years: 2 },
  { name: "NIHSS", type: "Certification", org: "AHA/ASA", years: 2 },
  { name: "RN License", type: "License", org: "MN Board of Nursing", years: 2 },
  { name: "CNA Certification", type: "Certification", org: "MN Dept of Health", years: 2 },
  { name: "Respiratory Therapist License", type: "License", org: "MN Board of RT", years: 2 },
  { name: "Radiology Certification", type: "Certification", org: "ARRT", years: 2 },
  { name: "Pharmacist License", type: "License", org: "MN Board of Pharmacy", years: 2 },
  { name: "Pharmacy Technician License", type: "License", org: "MN Board of Pharmacy", years: 2 },
  { name: "HIPAA Training", type: "Training", org: "Compliance Office", years: 1 },
  { name: "Bloodborne Pathogens", type: "Training", org: "Employee Health", years: 1 },
  { name: "Workplace Violence Prevention", type: "Training", org: "Safety & Security", years: 1 },
];
const CERT_BY_NAME = Object.fromEntries(CERTS.map((c) => [c.name, c]));

const FIRST = ["Olivia", "Liam", "Emma", "Noah", "Ava", "Ethan", "Sophia", "Mason", "Isabella", "Lucas", "Mia", "Logan", "Amelia", "Jackson", "Harper", "Aiden", "Evelyn", "Elijah", "Abigail", "James", "Maria", "David", "Grace", "Daniel", "Chloe", "Carlos", "Fatima", "Wei", "Priya", "Kwame", "Sofia", "Hassan", "Nia", "Diego", "Yuki", "Aaliyah", "Omar", "Leila", "Tariq", "Ingrid"];
const LAST = ["Anderson", "Nguyen", "Patel", "Johnson", "Garcia", "Smith", "Lee", "Brown", "Martinez", "Davis", "Rodriguez", "Wilson", "Hernandez", "Khan", "Okafor", "Olsen", "Larson", "Schmidt", "Torres", "Reyes", "Chen", "Abebe", "Novak", "Fischer", "Mbeki", "Kowalski", "Petrov", "Singh", "Costa", "Hughes"];

const SHIFTS = ["Day", "Evening", "Night", "Weekend", "Holiday", "On-call"];
const OPP_TYPES = ["Open shift", "Urgent coverage", "Surge staffing", "Float assignment", "Internal gig", "Training opportunity", "Development rotation", "Special project", "Emergency response", "Cross-campus support"];
const URGENCY = ["Routine", "High", "Critical", "Emergency"];
const PCI = ["Low", "Medium", "High", "Critical"];

const out = {};

// ── Facilities ────────────────────────────────────────────────────────
out.facilities = FACILITIES.map((f) => ({
  "Facility Name": f.name,
  Campus: f.campus,
  Address: `${intIn(100, 9999)} ${pick(["Riverside", "Lakeshore", "Summit", "Northgate", "Westview", "Cedar", "Hennepin"])} ${pick(["Ave", "Blvd", "Pkwy", "Dr"])}`,
  City: f.city,
  State: f.state,
  Region: f.region,
  "Time Zone": "America/Chicago",
  "Parking Instructions": "Staff parking in Ramp B; roaming staff use visitor badge for Ramp A.",
  "Badge Access Requirements": "Active hospital badge + receiving-unit access grant.",
  "Orientation Requirements": "60-minute unit safety orientation for first-time roamers.",
  "Contact Person": f.contact,
  Notes: "",
}));

// ── Departments (25, distributed across facilities) ───────────────────
out.departments = DEPARTMENTS.map((d, i) => {
  const loc = FAC_NAMES[i % FAC_NAMES.length];
  const type = DEPT_TYPE[d];
  const clinical = ["Clinical", "Emergency", "Specialty"].includes(type);
  const roleSet = clinical
    ? picks(["Registered Nurse", "CNA", "Respiratory Therapist", "Medical Assistant", "Unit Coordinator"], 3)
    : picks(["Environmental Services Tech", "Transport Aide", "Security Officer", "Patient Access Representative", "Pharmacy Tech"], 2);
  const minStaff = intIn(6, 18);
  return {
    "Department Name": d,
    "Department Type": type,
    "Cost Center": `CC-${pad(4000 + i, 4)}`,
    Location: loc,
    "Department Manager": `${pick(FIRST)} ${pick(LAST)}`,
    "Backup Manager": `${pick(FIRST)} ${pick(LAST)}`,
    "Required Skills": clinical ? picks(["IV Therapy", "Telemetry", "Triage", "Medication Administration"], 2).join(", ") : "",
    "Required Certifications": clinical ? "BLS" : "",
    "Allowed Floating Roles": roleSet.join(", "),
    "Can Release Staff": chance(0.8) ? "Yes" : "No",
    "Can Receive Staff": chance(0.85) ? "Yes" : "No",
    "Staffing Minimum": String(minStaff),
    "Current Staffing": String(minStaff + intIn(-2, 5)),
    Notes: "",
  };
});

// ── Employees (100) ───────────────────────────────────────────────────
const employees = [];
for (let i = 1; i <= 100; i++) {
  const role = pick(ROLE_NAMES);
  const def = ROLES[role];
  const homeLoc = pick(FAC_NAMES);
  const homeDept = pick(DEPARTMENTS);
  const first = pick(FIRST);
  const last = pick(LAST);
  const empId = `E-${pad(1000 + i, 4)}`;
  // credentials the employee holds — always required ones, sometimes extras
  const held = [...def.creds];
  if (chance(0.4) && def.family === "Nursing") held.push("ACLS");
  if (chance(0.2)) held.push("PALS");
  const primarySkills = picks(def.skills, Math.min(3, def.skills.length));
  const secondarySkills = picks(def.skills.filter((s) => !primarySkills.includes(s)), 1);
  const fatigue = intIn(5, 95);
  const union = ["Registered Nurse", "CNA", "Respiratory Therapist"].includes(role) && chance(0.7);
  let elig = "Eligible";
  const r = rnd();
  if (r < 0.06) elig = "Suspended from roaming";
  else if (r < 0.12) elig = "Pending Review";
  const status = elig === "Suspended from roaming" ? "Active" : pick(["Active", "Active", "Active", "Active", "Leave"]);
  const prefLocs = picks(FAC_NAMES, intIn(1, 3));
  if (!prefLocs.includes(homeLoc)) prefLocs.unshift(homeLoc);
  employees.push({
    "Employee ID": empId,
    "First Name": first,
    "Last Name": last,
    "Preferred Name": chance(0.15) ? first.slice(0, 3) : "",
    Email: `${first.toLowerCase()}.${last.toLowerCase()}@roamcarehealth.org`,
    Phone: `612-${intIn(200, 989)}-${pad(intIn(0, 9999), 4)}`,
    "Home Department": homeDept,
    "Home Location": homeLoc,
    "Primary Manager": `${pick(FIRST)} ${pick(LAST)}`,
    "Job Title": role,
    "Job Family": def.family,
    "Employment Type": pick(["Full-time", "Full-time", "Part-time", "Per-diem", "Temporary", "Retired pool"]),
    FTE: pick(["1.0", "1.0", "0.9", "0.8", "0.6", "0.5"]),
    "Union Status": union ? "Union" : "Non-union",
    "Bargaining Unit": union ? pick(["MNA Local 12", "SEIU 113", "Teamsters 320"]) : "",
    "Seniority Date": offsetDays(-intIn(200, 5000)),
    "Hire Date": offsetDays(-intIn(200, 6000)),
    Status: status,
    "Primary Skills": primarySkills.join(", "),
    "Secondary Skills": secondarySkills.join(", "),
    Certifications: held.filter((c) => CERT_BY_NAME[c]?.type !== "License").join(", "),
    Licenses: held.filter((c) => CERT_BY_NAME[c]?.type === "License").join(", "),
    Languages: picks(["English", "Spanish", "Hmong", "Somali", "Vietnamese", "ASL"], chance(0.4) ? 2 : 1).join(", "),
    "Preferred Locations": prefLocs.join(", "),
    "Travel Radius": `${pick([10, 15, 20, 25, 40])} mi`,
    "Willing to Float": chance(0.78) ? "Yes" : "No",
    "Willing to Work Overtime": chance(0.55) ? "Yes" : "No",
    "Willing to Work Weekends": chance(0.6) ? "Yes" : "No",
    "Willing to Work Nights": chance(0.45) ? "Yes" : "No",
    "Development Interests": picks([...DEPARTMENTS, "Leadership", "Charge Nurse", "Preceptor"], chance(0.5) ? 2 : 0).join(", "),
    "Fatigue Risk Score": String(fatigue),
    "Last Roaming Assignment Date": chance(0.6) ? offsetDays(-intIn(2, 120)) : "",
    "Roaming Eligibility Status": elig,
    Notes: "",
    // transient helper (not persisted) — which depts they've worked
    _priorDepts: picks(DEPARTMENTS, intIn(0, 3)),
    _held: held,
  });
}

// ── Credentials (2-4 per employee) ────────────────────────────────────
const credentials = [];
let credN = 0;
for (const e of employees) {
  for (const cn of e._held) {
    const def = CERT_BY_NAME[cn];
    if (!def) continue;
    credN++;
    // ~8% expired/expiring to drive compliance demos
    const roll = rnd();
    let expOffset, verify;
    if (roll < 0.05) {
      expOffset = -intIn(5, 90); // expired
      verify = "Expired";
    } else if (roll < 0.12) {
      expOffset = intIn(5, 30); // expiring soon
      verify = "Verified";
    } else {
      expOffset = intIn(120, def.years * 365);
      verify = chance(0.92) ? "Verified" : "Pending";
    }
    credentials.push({
      "Credential ID": `CR-${pad(credN, 5)}`,
      Employee: e["Employee ID"],
      "Employee Name": `${e["First Name"]} ${e["Last Name"]}`,
      "Credential Type": def.type,
      "Credential Name": cn,
      "Issuing Organization": def.org,
      "License Number": def.type === "License" ? `${e["State"] || "MN"}-${intIn(100000, 999999)}` : "",
      State: "MN",
      "Effective Date": offsetDays(expOffset - def.years * 365),
      "Expiration Date": offsetDays(expOffset),
      "Verification Status": verify,
      Notes: verify === "Expired" ? "Renewal required before next roaming assignment." : "",
    });
  }
}
out.credentials = credentials;

// quick lookup: employee -> expiring/expired cred name (for match ctx)
const expiringByEmp = {};
for (const c of credentials) {
  const exp = new Date(c["Expiration Date"]).getTime();
  const days = (exp - TODAY.getTime()) / dayMs;
  if (days < 30) expiringByEmp[c.Employee] = c["Credential Name"];
}

// ── Opportunities (50) ────────────────────────────────────────────────
const STATUS_DIST = [
  ...Array(20).fill("Open"),
  ...Array(6).fill("Matched"),
  ...Array(5).fill("Offered"),
  ...Array(4).fill("In Progress"),
  ...Array(7).fill("Completed"),
  ...Array(3).fill("Filled"),
  ...Array(2).fill("Draft"),
  ...Array(2).fill("Pending Approval"),
  ...Array(1).fill("Cancelled"),
];
const opportunities = [];
for (let i = 1; i <= 50; i++) {
  const role = pick(ROLE_NAMES);
  const def = ROLES[role];
  const loc = pick(FAC_NAMES);
  const dept = pick(DEPARTMENTS);
  const type = pick(OPP_TYPES);
  const urgency = (() => {
    const r = rnd();
    if (type === "Emergency response" || type === "Urgent coverage") return r < 0.6 ? "Critical" : "Emergency";
    if (type === "Surge staffing") return r < 0.5 ? "High" : "Critical";
    return pick(["Routine", "Routine", "High", "Critical"]);
  })();
  const status = STATUS_DIST[(i - 1) % STATUS_DIST.length];
  const start = intIn(-20, 25);
  const shift = pick(SHIFTS);
  const need = intIn(1, type === "Surge staffing" ? 6 : 3);
  const reqCerts = picks(def.creds.filter((c) => CERT_BY_NAME[c]?.type !== "License"), Math.min(2, def.creds.length));
  const reqLic = def.creds.filter((c) => CERT_BY_NAME[c]?.type === "License");
  const reqSkills = picks(def.skills, intIn(1, 2));
  const filled = ["Completed", "Filled"].includes(status) ? need : ["In Progress"].includes(status) ? Math.max(1, need - 1) : status === "Offered" || status === "Matched" ? intIn(0, Math.max(1, need - 1)) : 0;
  const oppId = `OPP-${pad(2000 + i, 4)}`;
  opportunities.push({
    "Opportunity ID": oppId,
    "Opportunity Title": `${role} — ${dept} (${shift})`,
    "Opportunity Type": type,
    Status: status,
    "Requesting Department": dept,
    "Requesting Location": loc,
    "Requesting Manager": `${pick(FIRST)} ${pick(LAST)}`,
    "Needed Role": role,
    "Job Family": def.family,
    "Required Skills": reqSkills.join(", "),
    "Preferred Skills": picks(def.skills.filter((s) => !reqSkills.includes(s)), 1).join(", "),
    "Required Certifications": reqCerts.join(", "),
    "Required Licenses": reqLic.join(", "),
    "Number of People Needed": String(need),
    "Start Date": offsetDaysT(start, shift === "Night" ? 19 : 7),
    "End Date": offsetDaysT(start + (def.family === "Nursing" ? 0 : 0), shift === "Night" ? 31 : 19),
    Duration: pick(["8 hours", "12 hours", "4 hours", "10 hours"]),
    "Shift Type": shift,
    Urgency: urgency,
    "Patient Care Impact": ["Clinical", "Emergency", "Specialty"].includes(DEPT_TYPE[dept]) ? pick(["High", "Critical", "Medium"]) : pick(["Low", "Medium"]),
    "Orientation Required": chance(0.4) ? "Yes" : "No",
    "Badge Access Required": "Yes",
    "Premium Pay Offered": urgency === "Critical" || urgency === "Emergency" ? `$${pick([8, 10, 12, 15])}/hr` : chance(0.3) ? `$${pick([4, 5, 6])}/hr` : "",
    "Overtime Allowed": chance(0.5) ? "Yes" : "No",
    "Cost Center": `CC-${pad(4000 + intIn(0, 24), 4)}`,
    "Budget Approval Required": urgency === "Routine" ? "No" : chance(0.5) ? "Yes" : "No",
    "Compliance Review Required": ["Clinical", "Emergency", "Specialty"].includes(DEPT_TYPE[dept]) ? "Yes" : "No",
    Description: `${type} need for ${need} ${role}${need > 1 ? "s" : ""} in ${dept} at ${loc}. ${urgency} priority.`,
    Instructions: "Report to the charge desk 15 minutes before shift for unit handoff.",
    "Application Deadline": offsetDays(start - 1),
    "Auto-Match Enabled": chance(0.7) ? "Yes" : "No",
    "Filled Count": String(filled),
    "Created By": `${pick(FIRST)} ${pick(LAST)}`,
    "Created Date": offsetDays(start - intIn(2, 10)),
    "Filled Date": ["Completed", "Filled"].includes(status) ? offsetDays(start) : "",
    "Cancelled Reason": status === "Cancelled" ? "Census dropped; need no longer required." : "",
    Notes: "",
  });
}
out.opportunities = opportunities;

// ── Matches (use the real engine on Open/Matched opportunities) ───────
const matches = [];
const openOpps = opportunities.filter((o) => ["Open", "Matched", "Offered", "Pending Approval"].includes(o.Status));
for (const opp of openOpps) {
  // candidate pool: mostly exact-role matches, plus a couple of family floaters
  const exact = employees.filter(
    (e) => e["Job Title"] === opp["Needed Role"] && e["Roaming Eligibility Status"] !== "Suspended from roaming"
  );
  const family = employees.filter(
    (e) => e["Job Title"] !== opp["Needed Role"] && e["Job Family"] === opp["Job Family"]
  );
  const candidates = [
    ...picks(exact, Math.min(intIn(3, 5), exact.length)),
    ...picks(family, Math.min(intIn(0, 2), family.length)),
  ];
  for (const e of candidates) {
    const ctx = {
      priorInDept: e._priorDepts.includes(opp["Requesting Department"]),
      homeStaffingRisk: chance(0.15),
      expiringCred: expiringByEmp[e["Employee ID"]] || null,
      unionConflict: e["Union Status"] === "Union" && chance(0.12),
      managerReleaseRequired: chance(0.5),
    };
    const res = scoreMatch(e, opp, ctx);
    matches.push({
      Opportunity: opp["Opportunity ID"],
      "Opportunity Title": opp["Opportunity Title"],
      Employee: e["Employee ID"],
      "Employee Name": `${e["First Name"]} ${e["Last Name"]}`,
      "Match Score": String(res.score),
      "Match Reason": explain(res, e, opp) + (res.reasons.length ? " " + res.reasons.join("; ") + "." : ""),
      "Missing Requirements": res.missing.join("; "),
      "Risk Flags": res.risks.join("; "),
      "Skill Match": res.skillMatch,
      "Certification Match": res.certMatch,
      "Location Match": res.locationMatch,
      "Schedule Match": res.scheduleMatch,
      "Overtime Risk": res.overtimeRisk,
      "Fatigue Risk": res.fatigueRisk,
      "Recommendation Status": res.status,
      "Generated Date": offsetDays(-intIn(0, 3)),
    });
  }
}
out.matches = matches;

// ── Applications (100) ────────────────────────────────────────────────
const APP_STATUS = ["Interested", "Applied", "Awaiting Home Manager Approval", "Awaiting Receiving Manager Approval", "Awaiting Compliance Review", "Approved", "Offered", "Accepted", "Declined", "Withdrawn", "Rejected", "Completed"];
const applications = [];
const acceptedPairs = [];
for (let i = 1; i <= 100; i++) {
  const opp = pick(opportunities.filter((o) => o.Status !== "Draft"));
  const pool = employees.filter((e) => e["Job Family"] === opp["Job Family"]);
  const e = pick(pool.length ? pool : employees);
  let st = pick(APP_STATUS);
  if (opp.Status === "Completed") st = pick(["Completed", "Accepted", "Declined"]);
  const applied = -intIn(1, 20);
  const matchObj = matches.find((m) => m.Opportunity === opp["Opportunity ID"] && m.Employee === e["Employee ID"]);
  const ms = matchObj ? matchObj["Match Score"] : String(intIn(45, 95));
  if (st === "Accepted" || st === "Completed") acceptedPairs.push({ opp, e, st });
  applications.push({
    "Application ID": `APP-${pad(3000 + i, 4)}`,
    Opportunity: opp["Opportunity ID"],
    "Opportunity Title": opp["Opportunity Title"],
    Employee: e["Employee ID"],
    "Employee Name": `${e["First Name"]} ${e["Last Name"]}`,
    "Application Status": st,
    "Match Score": ms,
    "Employee Message": chance(0.4) ? pick(["Happy to help cover this shift.", "I've floated to this unit before.", "Available and interested in cross-training here.", "Can start early if needed."]) : "",
    "Manager Comments": ["Approved", "Offered", "Accepted", "Completed", "Awaiting Receiving Manager Approval"].includes(st) ? "Home unit can release." : "",
    "Compliance Comments": st === "Awaiting Compliance Review" ? "Verifying credential currency." : st === "Rejected" ? "Required certification expired." : "",
    "Applied Date": offsetDaysT(applied, 9),
    "Approval Date": ["Approved", "Offered", "Accepted", "Completed"].includes(st) ? offsetDays(applied + 1) : "",
    "Offer Date": ["Offered", "Accepted", "Completed"].includes(st) ? offsetDays(applied + 2) : "",
    "Acceptance Date": ["Accepted", "Completed"].includes(st) ? offsetDays(applied + 2) : "",
    "Decline Reason": st === "Declined" ? pick(["Schedule conflict", "Distance too far", "Found other coverage", "Not enough notice"]) : st === "Withdrawn" ? "No longer available" : "",
  });
}
out.applications = applications;

// ── Assignments (40) ──────────────────────────────────────────────────
const assignments = [];
const asgPool = [...acceptedPairs];
// top up to 40 from completed/filled opportunities
const compl = opportunities.filter((o) => ["Completed", "Filled", "In Progress"].includes(o.Status));
while (asgPool.length < 40) {
  const opp = pick(compl.length ? compl : opportunities);
  const pool = employees.filter((e) => e["Job Family"] === opp["Job Family"]);
  asgPool.push({ opp, e: pick(pool.length ? pool : employees), st: "seed" });
}
for (let i = 0; i < 40; i++) {
  const { opp, e } = asgPool[i];
  const oppStatus = opp.Status;
  let st;
  if (oppStatus === "Completed") st = pick(["Completed", "Completed", "Completed", "No Show"]);
  else if (oppStatus === "In Progress") st = pick(["Checked In", "In Progress", "Confirmed"]);
  else st = pick(["Scheduled", "Confirmed", "Completed", "Checked In"]);
  const start = parseInt(opp["Start Date"]) || 0;
  const startOff = intIn(-25, 5);
  const hours = parseInt(opp.Duration) || 12;
  const ot = chance(0.25) ? intIn(1, 4) : 0;
  const completed = st === "Completed";
  assignments.push({
    "Assignment ID": `ASG-${pad(5000 + i + 1, 4)}`,
    Opportunity: opp["Opportunity ID"],
    "Opportunity Title": opp["Opportunity Title"],
    Employee: e["Employee ID"],
    "Employee Name": `${e["First Name"]} ${e["Last Name"]}`,
    "Assignment Status": st,
    "Start Date": offsetDaysT(startOff, 7),
    "End Date": offsetDaysT(startOff, 19),
    "Actual Start Time": completed || st === "Checked In" || st === "In Progress" ? offsetDaysT(startOff, 7) : "",
    "Actual End Time": completed ? offsetDaysT(startOff, 19 + (ot > 0 ? 1 : 0)) : "",
    "Home Department": e["Home Department"],
    "Receiving Department": opp["Requesting Department"],
    "Receiving Location": opp["Requesting Location"],
    "Cost Center": opp["Cost Center"],
    "Pay Code": opp["Premium Pay Offered"] ? "PREMIUM" : "STANDARD",
    "Premium Pay": opp["Premium Pay Offered"] || "",
    "Overtime Hours": String(ot),
    "Hours Worked": completed ? String(hours + ot) : "",
    "Manager Confirmation": completed || st === "Confirmed" ? "Confirmed" : "Pending",
    "Employee Confirmation": st === "Scheduled" ? "Pending" : "Confirmed",
    "Performance Rating": completed ? pick(["5 - Excellent", "4 - Strong", "4 - Strong", "3 - Met expectations"]) : "",
    "Completion Notes": completed ? pick(["Integrated quickly with the team.", "Strong clinical judgment under pressure.", "Reliable and professional.", "Would welcome back."]) : "",
    "Issue Reported": st === "No Show" ? "Yes" : chance(0.05) ? "Yes" : "No",
    "Follow-up Required": st === "No Show" ? "Yes" : "No",
  });
}
out.assignments = assignments;

// ── Availability (~120) ───────────────────────────────────────────────
const availability = [];
const availEmps = picks(employees, 40);
for (const e of availEmps) {
  for (let d = 0; d < intIn(2, 4); d++) {
    const day = intIn(0, 21);
    const type = pick(["Available", "Available", "Preferred", "Unavailable", "On-call", "PTO", "Already Scheduled"]);
    availability.push({
      Employee: e["Employee ID"],
      "Employee Name": `${e["First Name"]} ${e["Last Name"]}`,
      Date: offsetDays(day),
      "Start Time": pick(["07:00", "15:00", "19:00", "23:00"]),
      "End Time": pick(["19:00", "23:00", "07:00", "15:00"]),
      "Availability Type": type,
      Source: pick(["Employee entered", "Scheduling system", "HR system", "Manager entered"]),
      Notes: "",
    });
  }
}
out.availability = availability;

// ── Rules (25) ────────────────────────────────────────────────────────
const RULE_DEFS = [
  ["Active RN License Required", "Credentialing", "Registered Nurse roles", "License = RN License AND status = Verified", "Block", "Block"],
  ["Current BLS Required", "Credentialing", "All clinical roaming", "BLS not expired", "Block", "Block"],
  ["Max 60 Hours Per Week", "Overtime", "All employees", "Scheduled hours + assignment <= 60", "Require approval", "Warning"],
  ["No 4th Consecutive 12hr Shift", "Fatigue", "Clinical staff", "Consecutive 12hr shifts < 4", "Block", "Block"],
  ["10-Hour Rest Between Shifts", "Fatigue", "All employees", "Rest since last shift >= 10h", "Warn", "Warning"],
  ["Home Department Minimum Staffing", "Scheduling", "Releasing departments", "Home staffing > minimum", "Require approval", "Warning"],
  ["Senior Staff Offered First", "Union", "Union employees", "Offer by seniority within bargaining unit", "Require approval", "Warning"],
  ["Float Pool Opt-In Required", "Eligibility", "All employees", "Willing to Float = Yes", "Warn", "Info"],
  ["Suspended Staff Cannot Roam", "Eligibility", "All employees", "Roaming Eligibility = Eligible", "Block", "Block"],
  ["Pediatric Units Require PALS", "Credentialing", "Pediatrics, NICU", "Holds PALS", "Block", "Block"],
  ["ICU Float Requires ACLS", "Credentialing", "ICU, Cardiac Cath Lab", "Holds ACLS", "Block", "Block"],
  ["Orientation Before First Float", "Compliance", "First-time roamers", "Unit orientation complete", "Require approval", "Warning"],
  ["Badge Access Grant Required", "Location", "Cross-campus", "Receiving badge access active", "Block", "Block"],
  ["Travel Radius Respected", "Location", "All employees", "Distance <= travel radius", "Warn", "Info"],
  ["Premium Pay Budget Approval", "Cost Center", "Premium opportunities", "Budget approver sign-off", "Require approval", "Warning"],
  ["Overtime Requires Opt-In", "Overtime", "All employees", "Willing to Work Overtime = Yes", "Warn", "Warning"],
  ["Night Shift Opt-In", "Scheduling", "Night opportunities", "Willing to Work Nights = Yes", "Warn", "Info"],
  ["Weekend Differential Eligibility", "Scheduling", "Weekend opportunities", "Eligible for weekend differential", "Allow", "Info"],
  ["HIPAA Training Current", "Compliance", "All roles", "HIPAA Training not expired", "Block", "Block"],
  ["Bloodborne Pathogens Current", "Compliance", "Clinical & EVS", "BBP training not expired", "Warn", "Warning"],
  ["Workplace Violence Training (Security)", "Compliance", "Security roaming", "WVP training current", "Block", "Block"],
  ["Emergency Override Logging", "Emergency", "Command center", "Override reason captured + logged", "Allow", "Info"],
  ["Max 3 Roaming Assignments Per Week", "Fatigue", "All employees", "Roaming count this week < 3", "Warn", "Warning"],
  ["Retired Pool Hours Cap", "Eligibility", "Retired pool", "Monthly hours <= 80", "Require approval", "Warning"],
  ["Per-Diem Cancellation Window", "Scheduling", "Per-diem staff", "Cancellation notice >= 2h", "Warn", "Info"],
];
out.rules = RULE_DEFS.map((r, i) => ({
  "Rule Name": r[0],
  "Rule Type": r[1],
  "Applies To": r[2],
  Condition: r[3],
  Action: r[4],
  Severity: r[5],
  Active: i % 12 === 11 ? "No" : "Yes",
  "Effective Date": offsetDays(-intIn(60, 400)),
  "Expiration Date": "",
  Owner: pick(["Workforce Operations", "Compliance Office", "HR", "Labor Relations", "Patient Safety"]),
  Description: `${r[1]} rule — ${r[3]}.`,
  Notes: "",
}));

// ── Alerts (20) ───────────────────────────────────────────────────────
const ALERT_TYPES = ["Opportunity Available", "Approval Needed", "Offer Made", "Assignment Reminder", "Credential Expiring", "Urgent Staffing Need", "Compliance Block", "Manager Escalation"];
const alerts = [];
for (let i = 0; i < 20; i++) {
  const t = pick(ALERT_TYPES);
  const e = pick(employees);
  const opp = pick(opportunities);
  const st = pick(["Sent", "Sent", "Read", "Pending", "Failed"]);
  alerts.push({
    Recipient: `${e["First Name"]} ${e["Last Name"]}`,
    "Alert Type": t,
    Channel: pick(["Email", "SMS", "In-app", "Microsoft Teams"]),
    Message: {
      "Opportunity Available": `New ${opp["Needed Role"]} opportunity at ${opp["Requesting Location"]} matches your profile.`,
      "Approval Needed": `Release approval needed for ${e["First Name"]} on ${opp["Opportunity Title"]}.`,
      "Offer Made": `You've been offered ${opp["Opportunity Title"]}. Respond by ${opp["Application Deadline"]}.`,
      "Assignment Reminder": `Reminder: your assignment starts soon at ${opp["Requesting Location"]}.`,
      "Credential Expiring": `Your ${pick(["BLS", "ACLS", "RN License"])} expires within 30 days.`,
      "Urgent Staffing Need": `CRITICAL: ${opp["Requesting Department"]} needs coverage now.`,
      "Compliance Block": `Application blocked — required credential not current.`,
      "Manager Escalation": `Unfilled critical need escalated to staffing command center.`,
    }[t],
    Status: st,
    "Related Opportunity": opp["Opportunity ID"],
    "Related Assignment": "",
    "Created Date": offsetDaysT(-intIn(0, 14), intIn(6, 20)),
    "Sent Date": st === "Pending" ? "" : offsetDaysT(-intIn(0, 14), intIn(6, 20)),
  });
}
out.alerts = alerts;

// ── Strip transient helpers before writing ────────────────────────────
out.employees = employees.map(({ _priorDepts, _held, ...rest }) => rest);

// ── Write ─────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(DIR, "seed-data.json"), JSON.stringify(out, null, 2));
const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
console.log("✓ seed-data.json written:");
for (const [k, n] of Object.entries(counts)) console.log(`   ${k.padEnd(14)} ${n}`);
console.log(`   ${"TOTAL".padEnd(14)} ${Object.values(counts).reduce((a, b) => a + b, 0)} records`);
