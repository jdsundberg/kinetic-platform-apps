# Mining Operations Management

Production-grade Mining Operations Management app on Kinetic Platform. Single system of record for mining compliance, operations, and audit readiness. Australian mining theme (Apex Mining Corporation) with 8 mine sites across WA, QLD, NSW, and NT.

---

## App Identity

| Property | Value |
|----------|-------|
| Directory | `apps/mining_management/` |
| Kapp slug | `mining-ops` |
| Port | 3016 |
| Base server key | `"mining-ops"` |
| APP_REGISTRY | `{ dir: "mining_management", name: "Mining Ops", kapp: "mining-ops" }` |
| Credentials | `second_admin` / `password2` |
| Kinetic server | `https://second.jdsultra1.lan` |
| Launcher section | Industry (alongside SchoolForGood) |

---

## Files

| File | Lines | Purpose |
|------|-------|---------|
| `index.html` | 1,812 | Full SPA with 7 tabs, inline CSS/JS, no external deps |
| `server.mjs` | 964 | Port 3016, Kinetic proxy + 8 custom API endpoints |
| `seed.mjs` | 570 | Programmatic generation of 795 records across 9 forms |
| `setup.mjs` | 305 | Creates kapp + 9 forms with full field definitions |
| `build_indexes.mjs` | 148 | Index definitions for all 9 forms, builds and polls |
| `mining.md` | -- | This file (app-specific documentation) |
| `build_log.md` | -- | Implementation log |

**Total**: ~3,800 lines of code

---

## Data Model (9 Forms)

### 1. locations (37 seed records)
Hierarchy: Company > Region > Site > Zone

| Field | Required | Notes |
|-------|----------|-------|
| Name | Yes | Location name |
| Type | Yes | Company, Region, Site, Zone |
| Parent | | Parent location name |
| Parent ID | | Parent submission ID |
| Status | | Active, Inactive, Decommissioned |
| Latitude, Longitude | | GPS coordinates |
| Address | | Physical address (textarea) |
| Country, State, Timezone | | Geographic info |
| Site Manager | | Responsible person |
| Emergency Contact, Emergency Phone | | Emergency info |
| Notes | | Free text (textarea) |

**Hierarchy**: 1 Company (Apex Mining Corporation) > 4 Regions (WA, QLD, NSW, NT) > 8 Sites > 24 Zones (3 per site)

### 2. personnel (35 seed records)
Staff and contractor records

| Field | Required | Notes |
|-------|----------|-------|
| Employee ID | Yes | `EMP-001` format |
| Full Name | Yes | |
| Role | Yes | Site Manager, Geologist, Mining Engineer, Heavy Equipment Operator, Safety Officer, Environmental Analyst, Contractor |
| Department | | Operations, Safety, Environmental, Engineering, Management |
| Site, Site ID | | Assigned site |
| Employment Type | | Full-time, Part-time, Contractor |
| Status | | Active (32), On Leave (2), Terminated (1) |
| Start Date | | ISO date |
| Certifications | | Text description (textarea) |
| Certification Expiry | | ISO date |
| Email, Phone | | Contact info |
| Emergency Contact, Emergency Phone | | Emergency info |
| Notes | | Free text (textarea) |

### 3. permits (25 seed records)
Mining and environmental permits

| Field | Required | Notes |
|-------|----------|-------|
| Permit ID | Yes | `PRM-001` format |
| Permit Type | Yes | Mining License (8), Environmental Clearance (5), Water Use (4), Blasting (3), Land Use (2), Waste Disposal (2), Air Quality (1) |
| Site, Site ID | | Assigned site |
| Issuing Authority | | Regulatory body |
| Issue Date, Expiry Date | | Date range |
| Status | | Active (15), Pending (3), Expired (2), Renewal Pending (2), Suspended (2), Revoked (1) |
| Status History | | JSON/text history (textarea) |
| Conditions | | Permit conditions (textarea) |
| Renewal Lead Days | | Days before expiry to start renewal |
| Responsible Person | | Site manager |
| Reference Number | | External reference |
| Fees Paid | | Dollar amount |
| Notes | | Free text (textarea) |

**Transitions**: Pending > Active > Renewal Pending/Suspended; Suspended > Active/Revoked; Expired > Renewal Pending; Renewal Pending > Active

### 4. obligations (30 seed records)
Legal requirements tied to permits

| Field | Required | Notes |
|-------|----------|-------|
| Obligation ID | Yes | `OBL-001` format |
| Title | Yes | Descriptive name |
| Description | | Detail (textarea) |
| Permit ID, Permit Submission ID | | Linked permit |
| Category | | Reporting (9), Monitoring (5), Environmental (4), Remediation (4), Safety (5), Financial (3) |
| Frequency | | One-time, Daily, Weekly, Monthly, Quarterly, Annually |
| Due Date | | ISO date |
| Status | | Compliant (20), Pending (4), Overdue (3), Non-Compliant (2), Waived (1) |
| Responsible Person | | Site manager |
| Evidence Required | | Description of evidence (textarea) |
| Last Reviewed, Next Review | | Review dates |
| Notes | | Free text (textarea) |

### 5. issues (50 seed records)
Incidents, non-conformances, and CAPA tracking

| Field | Required | Notes |
|-------|----------|-------|
| Issue ID | Yes | `ISS-001` format |
| Title | Yes | Short description |
| Description | | Full detail (textarea) |
| Type | | Incident (15), Near Miss (12), Non-Conformance (10), Observation (8), Complaint (5) |
| Severity | | Critical (5), High (12), Medium (18), Low (15) |
| Category | | Safety (15), Environmental (12), Equipment (10), Compliance (8), Operational (5) |
| Site, Site ID, Zone | | Location |
| Status | | Open (8), Triage (5), Investigating (7), CAPA (10), Verify (5), Closed (15) |
| Status History | | JSON array of transitions (textarea) |
| Reported By, Reported Date | | Reporter info |
| Assigned To | | Investigator |
| Root Cause | | Root cause analysis (textarea) |
| CAPA Description | | Corrective action plan (textarea) |
| CAPA Due Date | | ISO date |
| CAPA Status | | Not Started, In Progress, Complete, Overdue |
| Verification Notes | | Verification details (textarea) |
| Closed Date, Closed By | | Closure info |
| Related Permit ID, Related Inspection ID | | Cross-references |
| Notes | | Free text (textarea) |

**Lifecycle**: Open > Triage > Investigating > CAPA > Verify > Closed (with allowed shortcuts: Triage > Closed, Investigating > Closed, Verify > CAPA)

### 6. inspections (30 seed records)
Scheduled and ad-hoc site inspections

| Field | Required | Notes |
|-------|----------|-------|
| Inspection ID | Yes | `INS-001` format |
| Type | Yes | Routine (12), Safety Audit (6), Environmental (5), Ad-Hoc (4), Regulatory (3) |
| Site, Site ID, Zone | | Location |
| Scheduled Date, Completed Date | | Dates |
| Inspector | | Person name |
| Status | | Complete (18), Scheduled (6), In Progress (3), Overdue (2), Cancelled (1) |
| Findings | | JSON array of finding objects (textarea) |
| Findings Count | | Integer count |
| Critical Findings | | Count of Critical/High findings |
| Score | | 0-100 numeric |
| Follow Up Required | | Yes, No |
| Follow Up Due Date | | ISO date |
| Related Permit ID | | Cross-reference |
| Notes | | Free text (textarea) |

### 7. assets (60 seed records)
Mining equipment and infrastructure

| Field | Required | Notes |
|-------|----------|-------|
| Asset ID | Yes | `AST-001` format |
| Name | Yes | Descriptive name (e.g. "Excavator EXC-001") |
| Category | | Heavy Equipment (24), Vehicles (16), Processing (8), Safety (4), Infrastructure (4), Monitoring (4) |
| Type | | Excavator, Haul Truck, Drill Rig, Dozer, Grader, Loader, Crusher, Conveyor Belt, etc. |
| Site, Site ID, Zone | | Location |
| Status | | Operational (42), Under Maintenance (10), Out of Service (5), Decommissioned (3) |
| Manufacturer, Model, Serial Number | | Equipment details |
| Purchase Date | | ISO date |
| Last Maintenance, Next Maintenance | | Maintenance dates |
| Maintenance Interval Days | | Days between maintenance |
| Operating Hours | | Cumulative hours |
| Assigned Operator | | Current operator (operational assets only) |
| Notes | | Free text (textarea) |

### 8. production-logs (168 seed records)
Daily production metrics by site

| Field | Required | Notes |
|-------|----------|-------|
| Site, Site ID | | Mine site |
| Date | Yes | ISO date |
| Shift | | Day, Night, Full Day |
| Material Type | | Iron, Gold, Copper, Coal, Ore, Overburden |
| Tonnes Extracted | | Numeric |
| Tonnes Processed | | Numeric |
| Grade | | Variable units (% Fe, g/t, % Cu, etc.) |
| Recovery Rate | | Percentage |
| Trucks Loaded | | Integer |
| Equipment Utilization | | Percentage |
| Downtime Hours | | Hours |
| Downtime Reason | | None, Scheduled maintenance, Equipment breakdown, Weather delay, etc. |
| Supervisor | | Site supervisor |
| Notes | | Free text (textarea) |

**Material by site**: Pilbara = Iron, Kalgoorlie/Tanami/Pine Creek = Gold, Mount Isa = Copper, Bowen Basin/Hunter Valley = Coal, Broken Hill = Ore

### 9. environmental-readings (360 seed records)
Environmental monitoring data

| Field | Required | Notes |
|-------|----------|-------|
| Site, Site ID | | Mine site |
| Monitoring Point | | Station ID (e.g. `MP-01-Pilbara`) |
| Date | Yes | ISO date |
| Parameter | | pH, TSS, Turbidity, Dust PM10, Dust PM2.5, Noise dB, Water Flow, Heavy Metals |
| Value | | Numeric reading |
| Unit | | pH, mg/L, NTU, ug/m3, dB(A), L/s |
| Threshold | | Regulatory limit |
| Status | | Normal (~75%), Warning (~15%), Exceedance (~8%), Critical (~2%) |
| Measured By | | Analyst name |
| Instrument | | Equipment used |
| Calibration Date | | ISO date |
| Notes | | Free text (textarea) |

---

## Indexes

Each form has single-field indexes and compound indexes for KQL queries:

| Form | Single Indexes | Compound Indexes |
|------|---------------|-----------------|
| locations | Type, Status, Parent ID | Type+Status |
| personnel | Status, Role, Site, Site ID, Department | Status+Site |
| permits | Status, Permit Type, Site, Site ID, Permit ID | Status+Site |
| obligations | Status, Category, Permit ID, Permit Submission ID | Status+Category |
| issues | Status, Severity, Category, Site, Site ID, Issue ID, Type | Status+Severity, Status+Site |
| inspections | Status, Type, Site, Site ID, Inspection ID | Status+Site |
| assets | Status, Category, Site, Site ID, Asset ID | Status+Site |
| production-logs | Site, Site ID, Date, Material Type | Site+Date |
| environmental-readings | Site, Site ID, Parameter, Status, Date | Site+Parameter, Status+Parameter |

All forms also include the 5 required system indexes: closedBy, createdBy, handle, submittedBy, updatedBy.

---

## Server Endpoints (8)

Base URL: `http://localhost:3016/api/mining/`

### 1. GET /api/mining/dashboard
Aggregates KPIs from all 8 data forms in parallel. Returns:
- `openIssues`, `criticalIssues` - open issue counts
- `activePermits`, `expiringPermits` - permit counts (expiring = within 30 days)
- `overdueInspections` - count of overdue inspections
- `assetsOperational`, `assetsTotal` - asset counts
- `personnelActive` - active staff count
- `obligationsCompliant`, `obligationsTotal` - compliance counts
- `avgInspectionScore` - average score of completed inspections
- `issuesBySeverity`, `issuesByCategory` - breakdown objects
- `complianceRate` - percentage
- `recentIssues` - latest 10 issues
- `expiringPermitsList` - permits expiring within 60 days
- `productionSummary` - last 7 days totals
- `envExceedances` - last 7 days exceedance count

### 2. GET /api/mining/stats/compliance
- `permitsByStatus`, `permitsByType` - breakdowns
- `obligationsByStatus`, `obligationsByCategory` - breakdowns
- `complianceRate` - percentage
- `overdueObligations` - list of overdue/non-compliant

### 3. GET /api/mining/stats/operations
- `assetsByStatus`, `assetsByCategory` - breakdowns
- `productionByMaterial` - extracted/processed totals by material
- `envByParameter`, `envByStatus` - environmental breakdowns
- `maintenanceDue` - assets due within 14 days

### 4. POST /api/mining/issues/:id/transition
Body: `{ newStatus, notes, user, displayName, rootCause, capaDescription, capaDueDate, verificationNotes }`
- Validates against `ISSUE_TRANSITIONS` map
- Appends to Status History
- Sets CAPA fields when transitioning to CAPA
- Sets Closed Date/By when closing

### 5. POST /api/mining/permits/:id/transition
Body: `{ newStatus, notes, user }`
- Validates against `PERMIT_TRANSITIONS` map
- Appends to Status History

### 6. POST /api/mining/inspections/:id/complete
Body: `{ score, findings, notes, inspector, criticalFindings }`
- Sets Status to "Complete", sets Completed Date
- Parses findings JSON, counts findings
- Auto-creates issue submissions for Critical/High severity findings

### 7. GET /api/mining/report/:type
8 report types:
- `issues-summary` - all issues with breakdowns by status/severity/category/site
- `compliance-status` - permits with linked obligations, compliance rate by site
- `inspection-results` - completed inspections grouped by site with avg scores
- `production-summary` - production totals by site and material
- `environmental-summary` - readings by parameter/status, exceedance list
- `asset-inventory` - assets grouped by category with maintenance info
- `personnel-roster` - staff grouped by site and role
- `overdue-items` - all overdue inspections, expired/expiring permits, overdue obligations, overdue CAPAs

Returns: `{ type, generatedAt, data }`

### 8. GET /api/mining/site-summary?site=SiteName
Deep site summary using KQL `values[Site]="SiteName"` across 6 forms. Returns:
- `permits` - total, byStatus, list
- `issues` - total, open, bySeverity, recent (top 10)
- `inspections` - total, completed, avgScore, overdue, recent (top 10)
- `assets` - total, byStatus, list
- `production` - totalLogs, totalExtracted, totalProcessed
- `personnel` - total, active, byRole, list

---

## UI Tabs (7)

### 1. Dashboard
- 6 KPI cards: Open Issues, Active Permits, Compliance Rate, Inspection Score, Assets Operational, Env Exceedances
- Horizontal bar chart: issues by severity (colored bars)
- Two-column layout: Recent Issues table + Expiring Permits table
- Data source: `GET /api/mining/dashboard`

### 2. Sites
- 3 subtabs: Regions, Sites, Zones
- Regions rendered as card grid
- Sites table with clickable rows
- Site detail modal: fetches `GET /api/mining/site-summary?site=` and displays KPIs, personnel, assets, issues, inspections

### 3. Compliance
- 2 subtabs: Permits, Obligations
- Permits: status/type filter dropdowns, clickable rows, detail modal with permit info + transition buttons + status history timeline
- Obligations: status/category filter dropdowns, data table

### 4. Issues
- Status pipeline: colored chips showing count per status (Open/Triage/Investigating/CAPA/Verify/Closed)
- Filter bar: status, severity, category, site dropdowns
- Data table with clickable rows
- Detail modal: full issue info, transition buttons, conditional CAPA form fields (root cause, description, due date), verification notes

### 5. Inspections
- Filter bar: status, type dropdowns
- Data table with clickable rows
- Detail modal: inspection info, parsed findings from JSON
- Complete Inspection form: score, findings JSON, notes, critical count

### 6. Operations
- 3 subtabs: Assets, Production, Environmental
- Assets: status/category filters, yellow highlight for maintenance due within 14 days
- Production: summary cards by material type, full logs table
- Environmental: status summary chips (Normal/Warning/Exceedance/Critical), parameter/status filters, readings table

### 7. Reports
- 8 report cards in 2-column grid
- Each card: description + Generate button
- Modal display with summary stats, data tables, CSV export button

---

## Workflows (3 Kinetic Trees)

All form-level, triggered on "Submission Updated":

| Workflow | Form | Tree Action |
|----------|------|-------------|
| Permit Lifecycle Notification | permits | Echo: logs permit number, name, status, type, site, expiry |
| Issue CAPA Tracking | issues | Echo: logs issue ID, title, status, severity, category, CAPA status |
| Inspection Completion Logging | inspections | Echo: logs inspection ID, type, site, inspector, status, rating |

Each tree: Start node > Echo node with ERB template referencing submission values.

---

## Sites Reference

| Site | Region | Material | Manager |
|------|--------|----------|---------|
| Pilbara Iron Ridge | Western Australia | Iron (55-65% Fe) | James McPherson |
| Kalgoorlie Gold Basin | Western Australia | Gold (1.5-5.0 g/t) | Sarah Whitfield |
| Mount Isa Copper Complex | Queensland | Copper (1.5-4.0% Cu) | David Chen |
| Bowen Basin Coal | Queensland | Coal (50-70% C) | Karen O'Brien |
| Hunter Valley Operations | New South Wales | Coal (48-65% C) | Michael Torres |
| Broken Hill Silver | New South Wales | Ore (80-200 g/t Ag) | Rebecca Singh |
| Tanami Gold Operations | Northern Territory | Gold (2.0-6.0 g/t) | Andrew Blake |
| Pine Creek Mine | Northern Territory | Gold (1.0-3.5 g/t) | Lisa Nakamura |

---

## Setup & Run

```bash
# 1. Create kapp and forms
node apps/mining_management/setup.mjs

# 2. Build indexes (waits for completion)
node apps/mining_management/build_indexes.mjs

# 3. Seed demo data (~795 records)
node apps/mining_management/seed.mjs

# 4. Start standalone server
node apps/mining_management/server.mjs

# 5. Open browser
open http://localhost:3016
# Login: second_admin / password2
```

Also accessible via the base launcher at `http://localhost:3011/mining-ops/` (requires base server running).

---

## Base Server Integration

- APP_REGISTRY entry in `apps/base/server.mjs`
- `/api/mining/*` route handler with full `handleMiningAPI()` function (mirrors standalone server)
- APP_ABOUT entry for the About modal in the launcher
- Launcher `index.html`: listed in Industry section with hard-hat icon
