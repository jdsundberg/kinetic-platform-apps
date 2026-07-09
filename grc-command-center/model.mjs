// Kinetic GRC Command Center — single source of truth for the data model.
// Consumed by build-app.mjs (emits app.json) and gen-seed.mjs (emits seed-data.json).
//
// Field notation:
//   { name, required?, rows?, idx? , opts? }
//     idx: "single"  -> own single-column index
//     opts: choice list (used by the seed generator and the SPA select inputs)
// Compound indexes are declared per-form in `compound`.
//
// One kapp: `grc`. Every tenant-scoped form carries a `Tenant` field so the
// multi-tenant provider model and record-level security can filter by client.

export const KAPP = "grc";

export const FRAMEWORKS = [
  { id: "CMMC-L1", name: "CMMC Level 1", version: "2.0", category: "Defense" },
  { id: "CMMC-L2", name: "CMMC Level 2", version: "2.0", category: "Defense" },
  { id: "NIST-800-171", name: "NIST 800-171", version: "Rev 2", category: "Federal" },
  { id: "NIST-CSF", name: "NIST CSF", version: "2.0", category: "Framework" },
  { id: "SOC2", name: "SOC 2", version: "2017 TSC", category: "Attestation" },
  { id: "ISO-27001", name: "ISO 27001", version: "2022", category: "Certification" },
  { id: "HIPAA", name: "HIPAA Security Rule", version: "2013", category: "Healthcare" },
  { id: "CIS", name: "CIS Controls", version: "v8", category: "Framework" },
];

// Control families used across frameworks (NIST 800-171 / CMMC domains).
export const FAMILIES = [
  "Access Control", "Awareness & Training", "Audit & Accountability",
  "Configuration Management", "Identification & Authentication",
  "Incident Response", "Maintenance", "Media Protection",
  "Personnel Security", "Physical Protection", "Risk Assessment",
  "Security Assessment", "System & Communications Protection",
  "System & Information Integrity",
];

export const ASSESS_STATUS = ["Not Started", "In Progress", "Implemented", "Partially Implemented", "Not Implemented", "Not Applicable"];
export const EVIDENCE_STATUS = ["Requested", "Submitted", "Needs Review", "Accepted", "Rejected", "Expired"];
export const GAP_SEVERITY = ["Critical", "High", "Medium", "Low"];
export const GAP_STATUS = ["Open", "In Progress", "Resolved", "Accepted", "Deferred"];
export const TASK_STATUS = ["Not Started", "In Progress", "Waiting on Client", "Waiting on Provider", "Blocked", "Ready for Review", "Complete", "Deferred"];
export const RISK_STATUS = ["Open", "Mitigating", "Accepted", "Closed"];
export const HEALTH = ["Green", "Yellow", "Red"];
export const ASSET_TYPES = ["Application", "Server", "Cloud Service", "Database", "End-User Device", "Network Device", "Facility", "Person", "Vendor", "Data Type", "Business Process", "Policy", "Procedure", "Security Tool"];
export const DATA_CLASS = ["CUI", "PHI", "PII", "Confidential", "Public"];

export const FORMS = [
  /* ───────────────────────── 1. Tenants / Clients ───────────────────────── */
  { slug: "tenant", name: "Tenant", label: "${values('Name')}",
    desc: "Client / tenant — the unit of MSP multi-tenancy.",
    fields: [
      { name: "Tenant ID", idx: "single" },
      { name: "Name", required: true, idx: "single" },
      { name: "Industry" },
      { name: "Regulatory Drivers" },
      { name: "Contract Requirements", rows: 2 },
      { name: "Frameworks" },
      { name: "Engagement Owner", idx: "single" },
      { name: "Primary Contact" },
      { name: "Contact Email" },
      { name: "Readiness Score" },
      { name: "Risk Score" },
      { name: "Open Gaps" },
      { name: "Overdue Tasks" },
      { name: "Evidence Missing" },
      { name: "Project Health", idx: "single", opts: HEALTH },
      { name: "Audit Date" },
      { name: "Last Review Date" },
      { name: "Next Review Date" },
      { name: "Status", idx: "single", opts: ["Active", "Onboarding", "Paused"] },
      { name: "Color" },
    ],
    compound: [] },

  /* ───────────────────────── 2. Framework catalog ───────────────────────── */
  { slug: "framework", name: "Framework", label: "${values('Name')}",
    desc: "Reusable framework catalog (global, not tenant-scoped).",
    fields: [
      { name: "Framework ID", idx: "single" },
      { name: "Name", required: true },
      { name: "Version" },
      { name: "Category", idx: "single" },
      { name: "Description", rows: 2 },
      { name: "Control Count" },
      { name: "Status", opts: ["Active", "Draft"] },
    ], compound: [] },

  /* ───────────────────────── 3. Control library ───────────────────────── */
  { slug: "control", name: "Control", label: "${values('Framework')} ${values('Control ID')}",
    desc: "Reusable control library entry, keyed by framework + control id.",
    fields: [
      { name: "Control Key", idx: "single" },
      { name: "Framework", idx: "single" },
      { name: "Control ID", idx: "single" },
      { name: "Control Family", idx: "single", opts: FAMILIES },
      { name: "Title", required: true },
      { name: "Requirement Text", rows: 3 },
      { name: "Plain English", rows: 2 },
      { name: "Implementation Guidance", rows: 3 },
      { name: "Evidence Examples", rows: 2 },
      { name: "Testing Procedure", rows: 2 },
      { name: "Mapped Controls" },
      { name: "Default Owner" },
      { name: "Review Cadence", opts: ["Annual", "Semi-Annual", "Quarterly"] },
    ],
    compound: [["values[Framework]", "values[Control Family]"]] },

  /* ───────────────────────── 4. Cross-framework mapping ───────────────────────── */
  { slug: "control-mapping", name: "Control Mapping", label: "${values('Source Control')} → ${values('Target Control')}",
    desc: "Cross-framework control mapping — evidence reuse across frameworks.",
    fields: [
      { name: "Source Framework", idx: "single" },
      { name: "Source Control", idx: "single" },
      { name: "Target Framework", idx: "single" },
      { name: "Target Control" },
      { name: "Relationship", opts: ["Equivalent", "Partial", "Supports"] },
      { name: "Notes", rows: 2 },
    ], compound: [] },

  /* ───────────────────────── 5. Assets ───────────────────────── */
  { slug: "asset", name: "Asset", label: "${values('Name')}",
    desc: "Asset-centric scope — systems, data, people, vendors, processes.",
    fields: [
      { name: "Asset ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Name", required: true },
      { name: "Type", idx: "single", opts: ASSET_TYPES },
      { name: "Owner", idx: "single" },
      { name: "Business Purpose", rows: 2 },
      { name: "Data Handled" },
      { name: "Data Classification", idx: "single", opts: DATA_CLASS },
      { name: "Environment", opts: ["Production", "Staging", "Corporate", "Cloud", "On-Prem"] },
      { name: "Location" },
      { name: "Criticality", idx: "single", opts: ["Critical", "High", "Medium", "Low"] },
      { name: "In Scope", idx: "single", opts: ["Yes", "No"] },
      { name: "Justification", rows: 2 },
      { name: "Related Controls" },
      { name: "Related Vendors" },
      { name: "Last Validated" },
      { name: "Status", opts: ["Active", "Retired"] },
    ],
    compound: [["values[Tenant]", "values[Type]"]] },

  /* ───────────────────────── 6. Vendors ───────────────────────── */
  { slug: "vendor", name: "Vendor", label: "${values('Name')}",
    desc: "Third-party vendors in scope for the compliance program.",
    fields: [
      { name: "Vendor ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Name", required: true },
      { name: "Service Provided" },
      { name: "Data Shared", opts: DATA_CLASS },
      { name: "Risk Tier", idx: "single", opts: ["Critical", "High", "Medium", "Low"] },
      { name: "SOC2 Status", opts: ["Current", "Expired", "None"] },
      { name: "Contract End" },
      { name: "Owner" },
      { name: "Status", opts: ["Active", "Offboarding"] },
    ], compound: [] },

  /* ───────────────────────── 7. Policies & procedures ───────────────────────── */
  { slug: "policy", name: "Policy", label: "${values('Name')}",
    desc: "Policies & procedures referenced by controls and evidence.",
    fields: [
      { name: "Policy ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Name", required: true },
      { name: "Type", idx: "single", opts: ["Policy", "Procedure"] },
      { name: "Category" },
      { name: "Owner" },
      { name: "Version" },
      { name: "Status", idx: "single", opts: ["Approved", "Draft", "In Review", "Expired"] },
      { name: "Effective Date" },
      { name: "Review Date" },
      { name: "Linked Controls" },
    ], compound: [] },

  /* ───────────────────────── 8. Control assessments (high volume) ───────────────────────── */
  { slug: "assessment", name: "Assessment", label: "${values('Tenant')} ${values('Framework')} ${values('Control ID')}",
    desc: "Per-tenant control assessment — the engine of readiness scoring.",
    fields: [
      { name: "Assessment ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Framework", idx: "single" },
      { name: "Control ID", idx: "single" },
      { name: "Control Family", idx: "single", opts: FAMILIES },
      { name: "Control Title" },
      { name: "Status", idx: "single", opts: ASSESS_STATUS },
      { name: "Maturity", opts: ["1", "2", "3", "4", "5"] },
      { name: "Confidence", opts: ["Low", "Medium", "High"] },
      { name: "Owner", idx: "single" },
      { name: "Reviewer" },
      { name: "Evidence Status", opts: ["Complete", "Partial", "Missing"] },
      { name: "Gap Summary", rows: 2 },
      { name: "Remediation Required", opts: ["Yes", "No"] },
      { name: "Risk Rating", idx: "single", opts: ["Critical", "High", "Medium", "Low"] },
      { name: "Notes", rows: 2 },
      { name: "Last Updated" },
      { name: "Next Review" },
    ],
    compound: [["values[Tenant]", "values[Framework]"], ["values[Tenant]", "values[Status]"]] },

  /* ───────────────────────── 9. Evidence ───────────────────────── */
  { slug: "evidence", name: "Evidence", label: "${values('Title')}",
    desc: "Evidence — request, upload, review, reuse, validate.",
    fields: [
      { name: "Evidence ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Title", required: true },
      { name: "Description", rows: 2 },
      { name: "File or Link" },
      { name: "Source System" },
      { name: "Related Controls" },
      { name: "Related Assets" },
      { name: "Related Frameworks", idx: "single" },
      { name: "Owner", idx: "single" },
      { name: "Reviewer" },
      { name: "Status", idx: "single", opts: EVIDENCE_STATUS },
      { name: "Collection Date" },
      { name: "Expiration Date", idx: "single" },
      { name: "Review Notes", rows: 2 },
      { name: "Audit Notes", rows: 2 },
      { name: "Reusable", opts: ["Yes", "No"] },
      { name: "History", rows: 2 },
    ],
    compound: [["values[Tenant]", "values[Status]"]] },

  /* ───────────────────────── 10. Gaps ───────────────────────── */
  { slug: "gap", name: "Gap", label: "${values('Title')}",
    desc: "Gaps auto-identified from assessment results.",
    fields: [
      { name: "Gap ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Title", required: true },
      { name: "Related Control" },
      { name: "Framework", idx: "single" },
      { name: "Control Family", idx: "single", opts: FAMILIES },
      { name: "Related Asset" },
      { name: "Severity", idx: "single", opts: GAP_SEVERITY },
      { name: "Business Impact", rows: 2 },
      { name: "Compliance Impact", rows: 2 },
      { name: "Risk Rating", opts: ["Critical", "High", "Medium", "Low"] },
      { name: "Recommended Remediation", rows: 2 },
      { name: "Owner", idx: "single" },
      { name: "Due Date", idx: "single" },
      { name: "Status", idx: "single", opts: GAP_STATUS },
      { name: "Percent Complete" },
      { name: "Blocking Issue" },
      { name: "Related Evidence" },
    ],
    compound: [["values[Tenant]", "values[Severity]"], ["values[Tenant]", "values[Status]"]] },

  /* ───────────────────────── 11. Remediation tasks ───────────────────────── */
  { slug: "task", name: "Remediation Task", label: "${values('Title')}",
    desc: "Remediation action items — turns gaps into trackable work.",
    fields: [
      { name: "Task ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Title", required: true },
      { name: "Description", rows: 2 },
      { name: "Related Gap" },
      { name: "Related Control" },
      { name: "Framework", idx: "single" },
      { name: "Owner", idx: "single" },
      { name: "Approver" },
      { name: "Priority", idx: "single", opts: ["Critical", "High", "Medium", "Low"] },
      { name: "Due Date", idx: "single" },
      { name: "Status", idx: "single", opts: TASK_STATUS },
      { name: "Percent Complete" },
      { name: "Dependencies" },
      { name: "Completion Evidence" },
    ],
    compound: [["values[Tenant]", "values[Status]"]] },

  /* ───────────────────────── 12. Risk register ───────────────────────── */
  { slug: "risk", name: "Risk", label: "${values('Title')}",
    desc: "Practical risk register connected to compliance.",
    fields: [
      { name: "Risk ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Title", required: true },
      { name: "Description", rows: 2 },
      { name: "Category", idx: "single", opts: ["Operational", "Technical", "Compliance", "Third-Party", "Strategic", "Physical"] },
      { name: "Related Asset" },
      { name: "Related Control" },
      { name: "Related Gap" },
      { name: "Likelihood", opts: ["1", "2", "3", "4", "5"] },
      { name: "Impact", opts: ["1", "2", "3", "4", "5"] },
      { name: "Inherent Risk", opts: ["Critical", "High", "Medium", "Low"] },
      { name: "Current Controls", rows: 2 },
      { name: "Residual Risk", idx: "single", opts: ["Critical", "High", "Medium", "Low"] },
      { name: "Treatment Plan", rows: 2 },
      { name: "Treatment Type", opts: ["Mitigate", "Accept", "Transfer", "Avoid"] },
      { name: "Owner", idx: "single" },
      { name: "Due Date" },
      { name: "Status", idx: "single", opts: RISK_STATUS },
      { name: "Review Cadence", opts: ["Annual", "Quarterly", "Monthly"] },
    ],
    compound: [["values[Tenant]", "values[Status]"]] },

  /* ───────────────────────── 13. Audit packets ───────────────────────── */
  { slug: "audit-packet", name: "Audit Packet", label: "${values('Name')}",
    desc: "Generated audit packets — scope, evidence index, summaries.",
    fields: [
      { name: "Packet ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Framework", idx: "single" },
      { name: "Name", required: true },
      { name: "Status", idx: "single", opts: ["Draft", "In Review", "Final"] },
      { name: "Readiness Percent" },
      { name: "Scope Statement", rows: 3 },
      { name: "Executive Summary", rows: 4 },
      { name: "Generated By" },
      { name: "Generated Date" },
      { name: "Auditor" },
      { name: "Audit Date" },
      { name: "Open Exceptions" },
    ], compound: [] },

  /* ───────────────────────── 14. Audit findings ───────────────────────── */
  { slug: "audit-finding", name: "Audit Finding", label: "${values('Title')}",
    desc: "Findings raised during audit / assessment.",
    fields: [
      { name: "Finding ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Packet", idx: "single" },
      { name: "Framework" },
      { name: "Control ID" },
      { name: "Title", required: true },
      { name: "Severity", idx: "single", opts: GAP_SEVERITY },
      { name: "Status", idx: "single", opts: ["Open", "Remediated", "Accepted"] },
      { name: "Owner" },
      { name: "Due Date" },
    ], compound: [] },

  /* ───────────────────────── 15. AI recommendations ───────────────────────── */
  { slug: "ai-recommendation", name: "AI Recommendation", label: "${values('Type')} — ${values('Related Record')}",
    desc: "Auditable AI guidance — every recommendation requires human approval.",
    fields: [
      { name: "Rec ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Type", idx: "single", opts: ["Control Explanation", "Evidence Suggestion", "Gap Draft", "Remediation Plan", "Cross-Framework Mapping", "Executive Summary", "Audit Packet Summary", "Missing Info"] },
      { name: "Context", rows: 2 },
      { name: "Recommendation", rows: 4 },
      { name: "Related Record" },
      { name: "Reviewer" },
      { name: "Decision", idx: "single", opts: ["Pending", "Accepted", "Rejected"] },
      { name: "Decision Date" },
      { name: "Created Date" },
    ], compound: [] },

  /* ───────────────────────── 16. Activity (comments/approvals/history) ───────────────────────── */
  { slug: "activity", name: "Activity", label: "${values('Type')} — ${values('Summary')}",
    desc: "Unified audit trail: comments, approvals, status changes, notifications.",
    fields: [
      { name: "Activity ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Record Type", idx: "single" },
      { name: "Record ID", idx: "single" },
      { name: "Type", idx: "single", opts: ["Comment", "Approval", "Status Change", "Notification", "AI"] },
      { name: "Summary" },
      { name: "Detail", rows: 2 },
      { name: "Actor" },
      { name: "Created Date" },
    ],
    compound: [["values[Record Type]", "values[Record ID]"]] },

  /* ───────────────────────── 17. Engagements / projects ───────────────────────── */
  { slug: "engagement", name: "Engagement", label: "${values('Name')}",
    desc: "Provider engagement / project per tenant.",
    fields: [
      { name: "Engagement ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Name", required: true },
      { name: "Owner", idx: "single" },
      { name: "Frameworks" },
      { name: "Start Date" },
      { name: "Target Audit Date" },
      { name: "Health", idx: "single", opts: HEALTH },
      { name: "Phase", opts: ["Onboarding", "Scoping", "Assessment", "Remediation", "Audit Prep", "Audit", "Maintenance"] },
      { name: "Status", opts: ["Active", "Complete", "On Hold"] },
    ], compound: [] },

  /* ───────────────────────── 18. Dashboard snapshots (trend) ───────────────────────── */
  { slug: "snapshot", name: "Snapshot", label: "${values('Tenant')} ${values('Snapshot Date')}",
    desc: "Periodic readiness snapshots for trend / audit-readiness trajectory.",
    fields: [
      { name: "Snapshot ID", idx: "single" },
      { name: "Tenant", idx: "single" },
      { name: "Snapshot Date", idx: "single" },
      { name: "Framework", idx: "single" },
      { name: "Readiness Percent" },
      { name: "Risk Score" },
      { name: "Open Gaps" },
      { name: "Evidence Complete Percent" },
      { name: "Tasks Complete Percent" },
      { name: "Controls Implemented" },
    ],
    compound: [["values[Tenant]", "values[Snapshot Date]"]] },
];

// Tenant scenarios — one defense contractor + an MSP portfolio of five clients.
export const TENANTS = [
  { id: "northstar", name: "Northstar Defense Systems", industry: "Defense / Aerospace",
    drivers: "DoD contracts, DFARS 7012, CUI handling", health: "Yellow", color: "#C62828",
    frameworks: ["CMMC-L2", "NIST-800-171", "SOC2", "ISO-27001"], owner: "Dana Whitfield",
    contact: "Marcus Pruitt", email: "mpruitt@northstardef.com",
    contract: "Prime contractor — F-series avionics; CUI flow-down from 4 primes." },
  { id: "prairie", name: "Prairie Health Services", industry: "Healthcare",
    drivers: "HIPAA Security Rule, HITECH, payer contracts", health: "Red", color: "#AD1457",
    frameworks: ["HIPAA", "SOC2", "NIST-CSF"], owner: "Dana Whitfield",
    contact: "Dr. Elena Ruiz", email: "eruiz@prairiehealth.org",
    contract: "Regional clinical network — ePHI across 9 facilities." },
  { id: "summit", name: "Summit Manufacturing Group", industry: "Manufacturing",
    drivers: "CMMC for DoD subcontracts, IP protection", health: "Yellow", color: "#EF6C00",
    frameworks: ["CMMC-L2", "NIST-800-171", "CIS"], owner: "Priya Nair",
    contact: "Wendell Cho", email: "wcho@summitmfg.com",
    contract: "Tier-2 supplier — machined components, ITAR-adjacent." },
  { id: "lakeside", name: "Lakeside Financial Partners", industry: "Financial Services",
    drivers: "SOC 2, GLBA, client due-diligence", health: "Green", color: "#2E7D32",
    frameworks: ["SOC2", "ISO-27001", "NIST-CSF"], owner: "Priya Nair",
    contact: "Helena Barros", email: "hbarros@lakesidefp.com",
    contract: "RIA / wealth management — SOC 2 Type II for institutional clients." },
  { id: "ironrange", name: "IronRange Cloud Services", industry: "Technology / MSP",
    drivers: "SOC 2, ISO 27001, customer security reviews", health: "Green", color: "#00838F",
    frameworks: ["SOC2", "ISO-27001", "CIS", "NIST-CSF"], owner: "Dana Whitfield",
    contact: "Theo Lindqvist", email: "theo@ironrange.io",
    contract: "Managed cloud + IaaS — multi-tenant SaaS, FedRAMP aspirations." },
];

export const OWNERS = ["Dana Whitfield", "Priya Nair", "Marcus Pruitt", "Wendell Cho", "Helena Barros", "Theo Lindqvist", "Dr. Elena Ruiz", "Sam Okafor", "Riya Patel", "Jordan Mills"];
