// Generate command-center/seed-data.json — realistic, correlated GRC data.
//   node gen-seed.mjs
// Deterministic (seeded RNG) so re-runs are reproducible.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FRAMEWORKS, FAMILIES, TENANTS, OWNERS } from "./model.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── seeded RNG ── */
let _s = 1337;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pickW = (pairs) => { // weighted [[val,w],...]
  const t = pairs.reduce((s, p) => s + p[1], 0); let r = rnd() * t;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; } return pairs[0][0];
};
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;

/* ── dates relative to 2026-06-30 ── */
const TODAY = new Date("2026-06-30T12:00:00Z");
const dayMs = 86400000;
const dstr = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n) => dstr(new Date(TODAY.getTime() + n * dayMs));

const FAM_ABBR = ["AC", "AT", "AU", "CM", "IA", "IR", "MA", "MP", "PS", "PE", "RA", "CA", "SC", "SI"];
const famIdx = (f) => FAMILIES.indexOf(f);

// Title pools per family — short realistic control titles.
const TITLES = {
  "Access Control": ["Limit system access to authorized users", "Enforce least privilege", "Control CUI flow", "Separate duties", "Use session lock", "Control remote access", "Authorize wireless access", "Encrypt remote sessions"],
  "Awareness & Training": ["Security awareness training", "Insider threat awareness", "Role-based security training", "Phishing simulation program"],
  "Audit & Accountability": ["Create and retain audit logs", "Ensure individual accountability", "Review and update logged events", "Alert on audit logging failure", "Correlate audit records", "Protect audit information"],
  "Configuration Management": ["Establish baseline configurations", "Enforce security configuration settings", "Track and approve changes", "Restrict nonessential programs", "Apply least functionality", "Control user-installed software"],
  "Identification & Authentication": ["Identify users and devices", "Use multifactor authentication", "Enforce password complexity", "Protect authenticators", "Prevent authenticator reuse", "Obscure authentication feedback"],
  "Incident Response": ["Establish incident handling capability", "Track and report incidents", "Test incident response", "Detect and analyze events", "Coordinate with stakeholders"],
  "Maintenance": ["Perform system maintenance", "Control maintenance tools", "Sanitize equipment for off-site maintenance", "Supervise maintenance personnel"],
  "Media Protection": ["Protect media containing CUI", "Limit access to CUI on media", "Sanitize media before disposal", "Mark media with CUI markings", "Control removable media"],
  "Personnel Security": ["Screen individuals before access", "Protect CUI during personnel actions", "Revoke access on termination"],
  "Physical Protection": ["Limit physical access", "Escort visitors and monitor activity", "Maintain audit logs of physical access", "Protect and monitor the facility", "Enforce safeguarding at alternate sites"],
  "Risk Assessment": ["Assess risk to operations", "Scan for vulnerabilities", "Remediate vulnerabilities", "Perform periodic risk assessments"],
  "Security Assessment": ["Develop system security plans", "Assess security controls periodically", "Create plans of action (POA&M)", "Monitor security controls continuously"],
  "System & Communications Protection": ["Monitor and protect communications", "Separate user and management functions", "Deny network traffic by default", "Implement cryptographic key management", "Use FIPS-validated cryptography", "Terminate network connections"],
  "System & Information Integrity": ["Identify and correct flaws", "Protect against malicious code", "Monitor security alerts", "Perform system monitoring", "Update malicious code protection", "Identify unauthorized use"],
};
const titleFor = (fam, n) => TITLES[fam][(n - 1) % TITLES[fam].length];

/* ───────────────────────── build the control library ───────────────────────── */
const controls = []; // global library
const controlsByFw = {};
function addControl(fw, ctlId, family, title) {
  const key = `${fw}:${ctlId}`;
  const rec = {
    "Control Key": key, "Framework": fw, "Control ID": ctlId, "Control Family": family,
    "Title": title,
    "Requirement Text": `The organization shall ${title.toLowerCase()} in accordance with ${fw} requirements.`,
    "Plain English": `In plain terms: make sure you ${title.toLowerCase()} — and can show how.`,
    "Implementation Guidance": `Document the policy, configure the control, assign an owner, and collect evidence demonstrating ${title.toLowerCase()}.`,
    "Evidence Examples": "Policy document, configuration screenshot, system report, ticket, signed attestation.",
    "Testing Procedure": "Inspect configuration, interview owner, sample records, and confirm operating effectiveness.",
    "Mapped Controls": "", "Default Owner": pick(OWNERS),
    "Review Cadence": pickW([["Annual", 5], ["Semi-Annual", 2], ["Quarterly", 1]]),
  };
  controls.push(rec);
  (controlsByFw[fw] ||= []).push(rec);
}

// NIST 800-171 + CMMC-L2 share family/numbering (3.<fi>.<n>)
for (let fi = 0; fi < FAMILIES.length; fi++) {
  const fam = FAMILIES[fi]; const count = [8, 3, 6, 6, 6, 4, 3, 5, 3, 5, 4, 4, 6, 6][fi];
  for (let n = 1; n <= count; n++) {
    const id = `3.${fi + 1}.${n}`, title = titleFor(fam, n);
    addControl("NIST-800-171", id, fam, title);
    addControl("CMMC-L2", `${FAM_ABBR[fi]}.L2-${id}`, fam, title);
  }
}
// CMMC-L1 — 17-practice subset (first 1-2 of the basic families)
[["Access Control", 4], ["Identification & Authentication", 2], ["Media Protection", 1], ["Physical Protection", 4], ["System & Communications Protection", 2], ["System & Information Integrity", 4]]
  .forEach(([fam, c]) => { for (let n = 1; n <= c; n++) addControl("CMMC-L1", `${FAM_ABBR[famIdx(fam)]}.L1-3.${famIdx(fam) + 1}.${n}`, fam, titleFor(fam, n)); });

// SOC 2 — Common Criteria + categories
const SOC2 = [
  ["CC1.1", "Security Assessment", "COSO — integrity and ethical values"], ["CC1.2", "Security Assessment", "Board oversight of internal control"],
  ["CC2.1", "Audit & Accountability", "Quality information for internal control"], ["CC3.2", "Risk Assessment", "Identify and assess risks"],
  ["CC4.1", "Security Assessment", "Monitor controls via evaluations"], ["CC5.2", "Configuration Management", "Technology controls over infrastructure"],
  ["CC6.1", "Access Control", "Logical access security software"], ["CC6.2", "Identification & Authentication", "Register and authorize users"],
  ["CC6.3", "Access Control", "Role-based access provisioning"], ["CC6.6", "System & Communications Protection", "Boundary protection"],
  ["CC6.7", "Media Protection", "Restrict transmission and removal of data"], ["CC6.8", "System & Information Integrity", "Detect and prevent malicious software"],
  ["CC7.1", "Risk Assessment", "Detect configuration vulnerabilities"], ["CC7.2", "System & Information Integrity", "Monitor for anomalies"],
  ["CC7.3", "Incident Response", "Evaluate security events"], ["CC7.4", "Incident Response", "Respond to security incidents"],
  ["CC8.1", "Configuration Management", "Change management process"], ["CC9.2", "Risk Assessment", "Assess vendor and partner risk"],
  ["A1.2", "System & Communications Protection", "Environmental protections and recovery"], ["C1.1", "Media Protection", "Confidential information identification"],
];
SOC2.forEach(([id, fam, t]) => addControl("SOC2", id, fam, t));

// ISO 27001:2022 Annex A (themes)
const ISO = [
  ["A.5.1", "Security Assessment", "Policies for information security"], ["A.5.7", "Risk Assessment", "Threat intelligence"],
  ["A.5.9", "Configuration Management", "Inventory of information and assets"], ["A.5.15", "Access Control", "Access control policy"],
  ["A.5.17", "Identification & Authentication", "Authentication information"], ["A.5.23", "System & Communications Protection", "Information security for cloud services"],
  ["A.5.30", "Incident Response", "ICT readiness for business continuity"], ["A.6.3", "Awareness & Training", "Information security awareness"],
  ["A.7.2", "Physical Protection", "Physical entry controls"], ["A.8.2", "Access Control", "Privileged access rights"],
  ["A.8.5", "Identification & Authentication", "Secure authentication"], ["A.8.7", "System & Information Integrity", "Protection against malware"],
  ["A.8.8", "Risk Assessment", "Management of technical vulnerabilities"], ["A.8.12", "Media Protection", "Data leakage prevention"],
  ["A.8.15", "Audit & Accountability", "Logging"], ["A.8.16", "System & Information Integrity", "Monitoring activities"],
  ["A.8.24", "System & Communications Protection", "Use of cryptography"], ["A.8.32", "Configuration Management", "Change management"],
];
ISO.forEach(([id, fam, t]) => addControl("ISO-27001", id, fam, t));

// HIPAA Security Rule
const HIPAA = [
  ["164.308(a)(1)", "Risk Assessment", "Security management process / risk analysis"], ["164.308(a)(3)", "Access Control", "Workforce security"],
  ["164.308(a)(4)", "Access Control", "Information access management"], ["164.308(a)(5)", "Awareness & Training", "Security awareness and training"],
  ["164.308(a)(6)", "Incident Response", "Security incident procedures"], ["164.308(a)(7)", "Incident Response", "Contingency plan"],
  ["164.310(a)(1)", "Physical Protection", "Facility access controls"], ["164.310(d)(1)", "Media Protection", "Device and media controls"],
  ["164.312(a)(1)", "Access Control", "Access control (technical)"], ["164.312(b)", "Audit & Accountability", "Audit controls"],
  ["164.312(c)(1)", "System & Information Integrity", "Integrity controls"], ["164.312(d)", "Identification & Authentication", "Person or entity authentication"],
  ["164.312(e)(1)", "System & Communications Protection", "Transmission security"], ["164.316(a)", "Security Assessment", "Policies, procedures and documentation"],
];
HIPAA.forEach(([id, fam, t]) => addControl("HIPAA", id, fam, t));

// CIS Controls v8 (18)
const CIS_C = ["Inventory of enterprise assets", "Inventory of software assets", "Data protection", "Secure configuration", "Account management", "Access control management", "Continuous vulnerability management", "Audit log management", "Email and web browser protections", "Malware defenses", "Data recovery", "Network infrastructure management", "Network monitoring and defense", "Security awareness and skills training", "Service provider management", "Application software security", "Incident response management", "Penetration testing"];
const CIS_FAM = ["Configuration Management", "Configuration Management", "Media Protection", "Configuration Management", "Identification & Authentication", "Access Control", "Risk Assessment", "Audit & Accountability", "System & Information Integrity", "System & Information Integrity", "Incident Response", "System & Communications Protection", "System & Communications Protection", "Awareness & Training", "Risk Assessment", "System & Information Integrity", "Incident Response", "Security Assessment"];
CIS_C.forEach((t, i) => addControl("CIS", `CIS-${i + 1}`, CIS_FAM[i], t));

// NIST CSF 2.0 functions
const CSF = [
  ["GV.OC", "Security Assessment", "Organizational context"], ["GV.RM", "Risk Assessment", "Risk management strategy"], ["GV.SC", "Risk Assessment", "Supply chain risk management"],
  ["ID.AM", "Configuration Management", "Asset management"], ["ID.RA", "Risk Assessment", "Risk assessment"],
  ["PR.AA", "Identification & Authentication", "Identity management and authentication"], ["PR.AC", "Access Control", "Access control"], ["PR.DS", "Media Protection", "Data security"], ["PR.PS", "Configuration Management", "Platform security"],
  ["DE.CM", "System & Information Integrity", "Continuous monitoring"], ["DE.AE", "Audit & Accountability", "Adverse event analysis"],
  ["RS.MA", "Incident Response", "Incident management"], ["RS.AN", "Incident Response", "Incident analysis"], ["RC.RP", "Incident Response", "Incident recovery plan execution"],
];
CSF.forEach(([id, fam, t]) => addControl("NIST-CSF", id, fam, t));

/* ── cross-framework mappings (evidence reuse) ── */
const mappings = [];
for (const c of controlsByFw["NIST-800-171"]) {
  const l2 = controlsByFw["CMMC-L2"].find(x => x["Control ID"].endsWith(c["Control ID"]));
  if (l2) mappings.push({ "Source Framework": "NIST-800-171", "Source Control": c["Control ID"], "Target Framework": "CMMC-L2", "Target Control": l2["Control ID"], "Relationship": "Equivalent", "Notes": "CMMC L2 practice derives directly from this 800-171 requirement." });
}
// 800-171 <-> ISO / SOC2 by family (sample)
for (const fam of FAMILIES) {
  const a = controlsByFw["NIST-800-171"].find(x => x["Control Family"] === fam);
  const iso = controlsByFw["ISO-27001"].find(x => x["Control Family"] === fam);
  const soc = controlsByFw["SOC2"].find(x => x["Control Family"] === fam);
  if (a && iso) mappings.push({ "Source Framework": "NIST-800-171", "Source Control": a["Control ID"], "Target Framework": "ISO-27001", "Target Control": iso["Control ID"], "Relationship": "Partial", "Notes": `Both address ${fam}.` });
  if (a && soc) mappings.push({ "Source Framework": "NIST-800-171", "Source Control": a["Control ID"], "Target Framework": "SOC2", "Target Control": soc["Control ID"], "Relationship": "Supports", "Notes": `Evidence for ${fam} can be reused.` });
}

/* ───────────────────────── tenant-scoped data ───────────────────────── */
const seed = {
  framework: FRAMEWORKS.map(f => ({ "Framework ID": f.id, "Name": f.name, "Version": f.version, "Category": f.category, "Description": `${f.name} (${f.version}) — ${f.category} framework.`, "Control Count": String((controlsByFw[f.id] || []).length), "Status": "Active" })),
  control: controls,
  "control-mapping": mappings,
  tenant: [], asset: [], vendor: [], policy: [], assessment: [], evidence: [],
  gap: [], task: [], risk: [], "audit-packet": [], "audit-finding": [],
  "ai-recommendation": [], activity: [], engagement: [], snapshot: [],
};

// health → assessment status distribution
const STATUS_DIST = {
  Green: [["Implemented", 62], ["Partially Implemented", 14], ["Not Started", 4], ["Not Implemented", 4], ["In Progress", 10], ["Not Applicable", 6]],
  Yellow: [["Implemented", 42], ["Partially Implemented", 22], ["Not Started", 8], ["Not Implemented", 12], ["In Progress", 12], ["Not Applicable", 4]],
  Red: [["Implemented", 24], ["Partially Implemented", 22], ["Not Started", 16], ["Not Implemented", 24], ["In Progress", 10], ["Not Applicable", 4]],
};
const SEV_BY_FAM = (fam) => ["Access Control", "Identification & Authentication", "System & Communications Protection", "Incident Response", "Risk Assessment"].includes(fam) ? [["Critical", 3], ["High", 4], ["Medium", 2], ["Low", 1]] : [["Critical", 1], ["High", 3], ["Medium", 4], ["Low", 2]];

let seq = { asset: 0, vendor: 0, policy: 0, assess: 0, ev: 0, gap: 0, task: 0, risk: 0, pkt: 0, find: 0, ai: 0, act: 0, eng: 0, snap: 0 };
const pad = (n, w = 4) => String(n).padStart(w, "0");

const ASSET_NAMES = {
  Application: ["ERP Platform", "Payroll App", "CAD/PLM System", "Customer Portal", "HR Suite", "Billing System", "Quoting App"],
  Server: ["DC-PRIMARY", "APP-NODE-01", "FILE-SRV-02", "JUMP-HOST", "BACKUP-SRV", "DB-CLUSTER-A"],
  "Cloud Service": ["Microsoft 365", "Azure Tenant", "AWS Prod Account", "Google Workspace", "Salesforce Org", "GitHub Enterprise"],
  Database: ["CUI-DB", "Customer-DB", "Finance-DB", "EHR-DB", "Inventory-DB"],
  "End-User Device": ["Engineering Laptops", "Executive Laptops", "Shop-Floor Tablets", "Clinical Workstations"],
  "Network Device": ["Edge Firewall", "Core Switch Stack", "VPN Concentrator", "Wireless Controller"],
  Facility: ["HQ Data Center", "Manufacturing Floor", "Branch Office", "Clinic Site A", "Colo Cage"],
  Person: ["Privileged Admins", "Engineering Team", "Finance Staff", "Clinical Staff", "Contractors"],
  Vendor: ["MSP Partner", "Cloud Provider", "Payroll Processor", "Pen-Test Firm"],
  "Data Type": ["CUI", "ePHI", "Customer PII", "Financial Records", "Source Code"],
  "Business Process": ["Order-to-Cash", "Patient Intake", "Trade Settlement", "Production Scheduling"],
  Policy: ["Information Security Policy", "Access Control Policy", "Incident Response Plan"],
  Procedure: ["Onboarding Procedure", "Backup & Recovery Procedure", "Change Management Procedure"],
  "Security Tool": ["CrowdStrike Falcon", "Tenable Nessus", "Splunk SIEM", "Okta SSO", "Intune MDM", "Microsoft Defender"],
};
const VENDORS = [["CrowdStrike", "EDR / managed detection"], ["Microsoft", "Cloud productivity & identity"], ["AWS", "Cloud infrastructure"], ["Okta", "Identity provider"], ["Tenable", "Vulnerability management"], ["ADP", "Payroll processing"], ["Datto", "Backup / BCDR"], ["Proofpoint", "Email security"]];
const POLICIES = ["Information Security Policy", "Access Control Policy", "Acceptable Use Policy", "Incident Response Plan", "Business Continuity Plan", "Data Classification Policy", "Vendor Risk Policy", "System Security Plan", "Backup & Recovery Procedure", "Change Management Procedure"];

for (const t of TENANTS) {
  const tid = t.id;
  // tenant record (rollups filled after generation)
  const tRec = {
    "Tenant ID": tid, "Name": t.name, "Industry": t.industry, "Regulatory Drivers": t.drivers,
    "Contract Requirements": t.contract, "Frameworks": t.frameworks.join(", "),
    "Engagement Owner": t.owner, "Primary Contact": t.contact, "Contact Email": t.email,
    "Project Health": t.health, "Color": t.color, "Status": "Active",
    "Last Review Date": daysFromNow(-int(20, 60)), "Next Review Date": daysFromNow(int(20, 60)),
    "Audit Date": daysFromNow(int(30, 150)),
  };
  seed.tenant.push(tRec);

  // assets
  const tenantAssets = [];
  for (const [type, names] of Object.entries(ASSET_NAMES)) {
    const n = type === "Security Tool" || type === "Cloud Service" ? int(2, 4) : int(1, 2);
    for (let i = 0; i < n && i < names.length; i++) {
      seq.asset++;
      const cls = pick(["CUI", "PHI", "PII", "Confidential", "Public"]);
      const dc = t.industry.includes("Healthcare") ? (chance(0.5) ? "PHI" : cls) : (t.industry.includes("Defense") || t.industry.includes("Manufacturing")) ? (chance(0.5) ? "CUI" : cls) : cls;
      const inScope = chance(0.82) ? "Yes" : "No";
      tenantAssets.push(names[i]);
      seed.asset.push({
        "Asset ID": `AST-${pad(seq.asset, 5)}`, "Tenant": tid, "Name": names[i], "Type": type,
        "Owner": pick(OWNERS), "Business Purpose": `${type} supporting ${t.name} operations.`,
        "Data Handled": dc, "Data Classification": dc,
        "Environment": pick(["Production", "Corporate", "Cloud", "On-Prem"]), "Location": pick(["HQ", "Cloud", "Branch", "Data Center"]),
        "Criticality": pickW([["Critical", 2], ["High", 4], ["Medium", 3], ["Low", 1]]),
        "In Scope": inScope, "Justification": inScope === "Yes" ? `Handles ${dc}; within assessment boundary.` : "No regulated data; out of boundary.",
        "Related Controls": "", "Related Vendors": "", "Last Validated": daysFromNow(-int(5, 90)), "Status": "Active",
      });
    }
  }

  // vendors
  for (const [vn, svc] of VENDORS) {
    if (chance(0.55)) continue;
    seq.vendor++;
    seed.vendor.push({ "Vendor ID": `VEN-${pad(seq.vendor, 4)}`, "Tenant": tid, "Name": vn, "Service Provided": svc, "Data Shared": pick(["CUI", "PHI", "PII", "Confidential"]), "Risk Tier": pickW([["Critical", 1], ["High", 3], ["Medium", 4], ["Low", 2]]), "SOC2 Status": pickW([["Current", 6], ["Expired", 1], ["None", 1]]), "Contract End": daysFromNow(int(60, 500)), "Owner": pick(OWNERS), "Status": "Active" });
  }

  // policies
  for (const pn of POLICIES) {
    if (chance(0.25)) continue;
    seq.policy++;
    seed.policy.push({ "Policy ID": `POL-${pad(seq.policy, 4)}`, "Tenant": tid, "Name": pn, "Type": pn.includes("Procedure") ? "Procedure" : "Policy", "Category": pick(["Governance", "Security", "Operations"]), "Owner": pick(OWNERS), "Version": `${int(1, 3)}.${int(0, 9)}`, "Status": pickW([["Approved", 6], ["In Review", 2], ["Draft", 1], ["Expired", 1]]), "Effective Date": daysFromNow(-int(60, 600)), "Review Date": daysFromNow(int(-30, 300)), "Linked Controls": "" });
  }

  // assessments per in-scope framework (sample ~22 controls/framework for volume control)
  const dist = STATUS_DIST[t.health];
  for (const fw of t.frameworks) {
    const lib = controlsByFw[fw] || [];
    const sample = lib.slice(0, Math.min(lib.length, fw === "NIST-800-171" || fw === "CMMC-L2" ? 30 : 22));
    for (const c of sample) {
      seq.assess++;
      const status = pickW(dist);
      const failing = ["Not Implemented", "Not Started"].includes(status);
      const partial = status === "Partially Implemented";
      const evStatus = status === "Implemented" ? "Complete" : partial || status === "In Progress" ? "Partial" : "Missing";
      const risk = failing ? pickW(SEV_BY_FAM(c["Control Family"])) : partial ? pickW([["High", 2], ["Medium", 4], ["Low", 3]]) : pickW([["Medium", 2], ["Low", 6]]);
      const aId = `ASM-${pad(seq.assess, 5)}`;
      seed.assessment.push({
        "Assessment ID": aId, "Tenant": tid, "Framework": fw, "Control ID": c["Control ID"], "Control Family": c["Control Family"], "Control Title": c["Title"],
        "Status": status, "Maturity": failing ? pick(["1", "2"]) : partial ? "3" : pick(["3", "4", "5"]),
        "Confidence": pick(["Low", "Medium", "High"]), "Owner": pick(OWNERS), "Reviewer": t.owner,
        "Evidence Status": evStatus, "Gap Summary": failing || partial ? `${c["Title"]} not fully satisfied.` : "",
        "Remediation Required": failing || partial ? "Yes" : "No", "Risk Rating": risk,
        "Notes": "", "Last Updated": daysFromNow(-int(1, 75)), "Next Review": daysFromNow(int(30, 200)),
      });

      // evidence for non-missing
      if (evStatus !== "Missing" || chance(0.2)) {
        seq.ev++;
        const est = status === "Implemented" ? pickW([["Accepted", 7], ["Needs Review", 2], ["Expired", 1]]) : partial ? pickW([["Submitted", 4], ["Needs Review", 3], ["Rejected", 2], ["Accepted", 1]]) : pickW([["Requested", 5], ["Submitted", 3], ["Rejected", 2]]);
        const exp = chance(0.3) ? daysFromNow(int(-20, 40)) : daysFromNow(int(120, 400));
        seed.evidence.push({
          "Evidence ID": `EVD-${pad(seq.ev, 5)}`, "Tenant": tid, "Title": `${c["Control ID"]} — ${c["Title"]}`,
          "Description": `Evidence demonstrating ${c["Title"].toLowerCase()}.`, "File or Link": `s3://grc-evidence/${tid}/${c["Control ID"].replace(/[^\w]/g, "_")}.pdf`,
          "Source System": pick(["Microsoft 365", "Splunk", "Okta", "Tenable", "Manual Upload", "Jira"]),
          "Related Controls": c["Control ID"], "Related Assets": pick(tenantAssets) || "", "Related Frameworks": fw,
          "Owner": pick(OWNERS), "Reviewer": t.owner, "Status": est, "Collection Date": daysFromNow(-int(5, 120)),
          "Expiration Date": exp, "Review Notes": est === "Rejected" ? "Insufficient — needs current configuration export." : "",
          "Audit Notes": "", "Reusable": chance(0.6) ? "Yes" : "No", "History": `Requested → Submitted → ${est}`,
        });
      }

      // gap + task for failing/partial
      if (failing || (partial && chance(0.6))) {
        seq.gap++;
        const sev = pickW(SEV_BY_FAM(c["Control Family"]));
        const gStatus = pickW([["Open", 5], ["In Progress", 3], ["Resolved", 1], ["Accepted", 1]]);
        const pct = gStatus === "Resolved" ? 100 : gStatus === "In Progress" ? int(20, 80) : gStatus === "Accepted" ? 0 : int(0, 30);
        const due = daysFromNow(int(-25, 90));
        const gId = `GAP-${pad(seq.gap, 5)}`;
        seed.gap.push({
          "Gap ID": gId, "Tenant": tid, "Title": `${c["Control ID"]} — ${c["Title"]} gap`, "Related Control": c["Control ID"],
          "Framework": fw, "Control Family": c["Control Family"], "Related Asset": pick(tenantAssets) || "",
          "Severity": sev, "Business Impact": `Could impair ${c["Control Family"].toLowerCase()} and contract eligibility.`,
          "Compliance Impact": `${fw} ${c["Control ID"]} not met — assessment finding.`, "Risk Rating": sev,
          "Recommended Remediation": c["Implementation Guidance"], "Owner": pick(OWNERS), "Due Date": due,
          "Status": gStatus, "Percent Complete": String(pct), "Blocking Issue": gStatus === "Open" && chance(0.3) ? pick(["Awaiting client input", "Budget approval pending", "Vendor dependency"]) : "", "Related Evidence": "",
        });
        // 1-2 tasks
        for (let ti = 0; ti < (sev === "Critical" || sev === "High" ? 2 : 1); ti++) {
          seq.task++;
          const tStatus = gStatus === "Resolved" ? "Complete" : pickW([["Not Started", 3], ["In Progress", 4], ["Waiting on Client", 2], ["Waiting on Provider", 1], ["Blocked", 1], ["Ready for Review", 1]]);
          const tpct = tStatus === "Complete" ? 100 : tStatus === "Not Started" ? 0 : int(10, 90);
          seed.task.push({
            "Task ID": `TSK-${pad(seq.task, 5)}`, "Tenant": tid, "Title": `${ti === 0 ? "Remediate" : "Validate"}: ${c["Title"]}`,
            "Description": `${ti === 0 ? "Implement and document" : "Test and collect evidence for"} ${c["Control ID"]}.`,
            "Related Gap": gId, "Related Control": c["Control ID"], "Framework": fw, "Owner": pick(OWNERS), "Approver": t.owner,
            "Priority": sev, "Due Date": daysFromNow(int(-20, 75)), "Status": tStatus, "Percent Complete": String(tpct),
            "Dependencies": "", "Completion Evidence": tStatus === "Complete" ? "Evidence accepted" : "",
          });
        }
      }
    }
  }

  // risks
  const riskCats = ["Operational", "Technical", "Compliance", "Third-Party", "Strategic", "Physical"];
  for (let i = 0; i < int(7, 11); i++) {
    seq.risk++;
    const L = int(2, 5), I = int(2, 5), score = L * I;
    const band = score >= 16 ? "Critical" : score >= 10 ? "High" : score >= 5 ? "Medium" : "Low";
    const resScore = Math.max(2, score - int(2, 6));
    const resBand = resScore >= 16 ? "Critical" : resScore >= 10 ? "High" : resScore >= 5 ? "Medium" : "Low";
    const cat = pick(riskCats);
    seed.risk.push({
      "Risk ID": `RSK-${pad(seq.risk, 4)}`, "Tenant": tid, "Title": pick(["Unpatched internet-facing system", "Excessive privileged access", "Missing MFA on legacy app", "Vendor without current SOC 2", "CUI stored outside boundary", "Incomplete incident response testing", "Shadow IT cloud usage", "Backup restoration unverified", "Phishing susceptibility", "Physical access not logged"]),
      "Description": `${cat} risk identified during assessment of ${t.name}.`, "Category": cat,
      "Related Asset": pick(tenantAssets) || "", "Related Control": pick(controlsByFw[t.frameworks[0]])["Control ID"], "Related Gap": "",
      "Likelihood": String(L), "Impact": String(I), "Inherent Risk": band,
      "Current Controls": pick(["Partial network segmentation", "EDR deployed", "Annual training", "Quarterly access reviews"]),
      "Residual Risk": resBand, "Treatment Plan": pick(["Deploy MFA", "Patch and re-scan", "Renew vendor attestation", "Migrate data to boundary"]),
      "Treatment Type": pickW([["Mitigate", 6], ["Accept", 2], ["Transfer", 1], ["Avoid", 1]]), "Owner": pick(OWNERS),
      "Due Date": daysFromNow(int(-10, 120)), "Status": pickW([["Open", 4], ["Mitigating", 4], ["Accepted", 1], ["Closed", 1]]),
      "Review Cadence": pick(["Quarterly", "Annual", "Monthly"]),
    });
  }

  // engagement
  seq.eng++;
  seed.engagement.push({ "Engagement ID": `ENG-${pad(seq.eng, 4)}`, "Tenant": tid, "Name": `${t.name} — Compliance Program`, "Owner": t.owner, "Frameworks": t.frameworks.join(", "), "Start Date": daysFromNow(-int(120, 300)), "Target Audit Date": tRec["Audit Date"], "Health": t.health, "Phase": pick(["Assessment", "Remediation", "Audit Prep"]), "Status": "Active" });

  // audit packets + findings for primary frameworks
  for (const fw of t.frameworks.slice(0, 2)) {
    seq.pkt++;
    const pId = `PKT-${pad(seq.pkt, 4)}`;
    seed["audit-packet"].push({ "Packet ID": pId, "Tenant": tid, "Framework": fw, "Name": `${fw} Audit Packet — ${t.name}`, "Status": pickW([["Draft", 4], ["In Review", 3], ["Final", 2]]), "Readiness Percent": "", "Scope Statement": `All systems, people, and data handling ${t.industry.includes("Defense") ? "CUI" : t.industry.includes("Healthcare") ? "ePHI" : "confidential client data"} within ${t.name}.`, "Executive Summary": `${t.name} is progressing toward ${fw} audit readiness. See readiness, gaps, and remediation plan.`, "Generated By": t.owner, "Generated Date": daysFromNow(-int(1, 40)), "Auditor": pick(["Apex Assessors LLC", "C3PAO Northstar", "Veritas Audit Group"]), "Audit Date": tRec["Audit Date"], "Open Exceptions": String(int(0, 6)) });
    for (let i = 0; i < int(2, 4); i++) {
      seq.find++;
      seed["audit-finding"].push({ "Finding ID": `FND-${pad(seq.find, 4)}`, "Tenant": tid, "Packet": pId, "Framework": fw, "Control ID": pick(controlsByFw[fw])["Control ID"], "Title": pick(["Logging gaps on key systems", "MFA not enforced everywhere", "Incomplete asset inventory", "Vendor attestation expired", "POA&M items overdue"]), "Severity": pickW(GAP_SEV()), "Status": pickW([["Open", 5], ["Remediated", 3], ["Accepted", 2]]), "Owner": pick(OWNERS), "Due Date": daysFromNow(int(-15, 90)) });
    }
  }

  // AI recommendations
  for (let i = 0; i < int(3, 6); i++) {
    seq.ai++;
    const type = pick(["Control Explanation", "Evidence Suggestion", "Gap Draft", "Remediation Plan", "Cross-Framework Mapping", "Executive Summary", "Missing Info"]);
    seed["ai-recommendation"].push({ "Rec ID": `AIR-${pad(seq.ai, 4)}`, "Tenant": tid, "Type": type, "Context": `Asked AI to assist with ${type.toLowerCase()} for ${t.name}.`, "Recommendation": `Suggested ${type.toLowerCase()} — requires human review before any compliance status change.`, "Related Record": pick(controlsByFw[t.frameworks[0]])["Control ID"], "Reviewer": t.owner, "Decision": pickW([["Pending", 4], ["Accepted", 4], ["Rejected", 2]]), "Decision Date": daysFromNow(-int(0, 20)), "Created Date": daysFromNow(-int(1, 30)) });
  }

  // activity trail
  for (let i = 0; i < int(6, 10); i++) {
    seq.act++;
    seed.activity.push({ "Activity ID": `ACT-${pad(seq.act, 5)}`, "Tenant": tid, "Record Type": pick(["assessment", "evidence", "gap", "task", "risk"]), "Record ID": `REC-${int(1000, 9999)}`, "Type": pick(["Comment", "Approval", "Status Change", "Notification"]), "Summary": pick(["Evidence accepted", "Status updated to In Progress", "Reviewer requested changes", "Task reassigned", "Risk accepted by sponsor"]), "Detail": "", "Actor": pick(OWNERS), "Created Date": daysFromNow(-int(0, 45)) });
  }

  // snapshots — climbing readiness trajectory over the last 8 months
  for (const fw of t.frameworks.slice(0, 2)) {
    const base = t.health === "Green" ? 70 : t.health === "Yellow" ? 48 : 30;
    for (let m = 7; m >= 0; m--) {
      seq.snap++;
      const ready = Math.min(98, base + (7 - m) * int(2, 5) + int(-2, 2));
      seed.snapshot.push({ "Snapshot ID": `SNP-${pad(seq.snap, 5)}`, "Tenant": tid, "Snapshot Date": dstr(new Date(TODAY.getTime() - m * 30 * dayMs)), "Framework": fw, "Readiness Percent": String(ready), "Risk Score": String(Math.max(10, 80 - (7 - m) * int(3, 7))), "Open Gaps": String(Math.max(0, 40 - (7 - m) * int(2, 5))), "Evidence Complete Percent": String(Math.min(99, ready + int(-5, 8))), "Tasks Complete Percent": String(Math.min(99, ready - int(0, 10))), "Controls Implemented": String(Math.round(ready * 1.1)) });
    }
  }

  // compute rollups on tenant
  const tAssess = seed.assessment.filter(a => a.Tenant === tid);
  const impl = tAssess.filter(a => a.Status === "Implemented").length;
  const na = tAssess.filter(a => a.Status === "Not Applicable").length;
  const denom = Math.max(1, tAssess.length - na);
  tRec["Readiness Score"] = String(Math.round((impl / denom) * 100));
  tRec["Open Gaps"] = String(seed.gap.filter(g => g.Tenant === tid && g.Status !== "Resolved" && g.Status !== "Accepted").length);
  tRec["Overdue Tasks"] = String(seed.task.filter(t2 => t2.Tenant === tid && t2.Status !== "Complete" && t2["Due Date"] < dstr(TODAY)).length);
  tRec["Evidence Missing"] = String(tAssess.filter(a => a["Evidence Status"] === "Missing").length);
  const critRisks = seed.risk.filter(r => r.Tenant === tid && (r["Residual Risk"] === "Critical" || r["Residual Risk"] === "High")).length;
  const riskBase = t.health === "Red" ? 60 : t.health === "Yellow" ? 42 : 22;
  tRec["Risk Score"] = String(Math.min(100, riskBase + critRisks * 3));
}

function GAP_SEV() { return [["Critical", 1], ["High", 3], ["Medium", 4], ["Low", 2]]; }

/* ── write ── */
const out = path.join(__dirname, "seed-data.json");
fs.writeFileSync(out, JSON.stringify(seed, null, 2) + "\n");
const counts = Object.entries(seed).map(([k, v]) => `${k}:${v.length}`).join("  ");
const total = Object.values(seed).reduce((a, v) => a + v.length, 0);
console.log(`Wrote ${out}`);
console.log(counts);
console.log(`TOTAL records: ${total}`);
