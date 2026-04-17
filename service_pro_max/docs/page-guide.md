# ServiceProMax — Page-by-Page Guide

## 1. Executive Dashboard (`Dashboard` tab)
**Screenshot:** `screenshots/01_dashboard.png`

The executive dashboard provides a portfolio-wide view of services delivery health at a glance.

**KPI Cards (top row):**
- **Active Projects** (orange) — Count of non-completed/closed projects with total count
- **Healthy (Green)** — Projects with Green health status
- **At Risk (Yellow)** — Projects with Yellow health status  
- **Critical (Red)** — Projects with Red health status
- **In Recovery** — Projects with active recovery plans
- **Escalations** — Status reports flagged for escalation

**Financial Summary card:**
- Planned Budget vs Actual Cost totals across portfolio
- Planned vs Actual Hours
- Billable percentage
- Over-budget project count

**Quality & Satisfaction card:**
- Average quality score across all scored projects
- Average customer satisfaction (1-5 scale)
- Open corrective actions count
- Overdue corrective actions (highlighted red if > 0)
- Pending feedback follow-ups
- Pending time approvals

**Projects by Stage table** — Distribution of projects across lifecycle stages with color-coded badges

**Customer Health card** — Green/Yellow/Red health distribution across customer accounts

---

## 2. Customer Management (`Customers` tab)
**Screenshot:** `screenshots/01_customers.png`

Manage customer accounts with filtering and drill-down capabilities.

**Filters:** Tier (Strategic/Enterprise/Growth/Standard), Health (Green/Yellow/Red), Search

**KPI Row:** Total Customers, Healthy, Attention, Critical counts

**Customer Table columns:**
- Account ID, Name, Industry, Tier (badge), Health (badge), Region, Account Owner, Active Projects, Avg Satisfaction

**Click any row** to open a customer detail modal showing all account fields including delivery preferences and renewal notes.

---

## 3. Project Portfolio (`Projects` tab)
**Screenshot:** `screenshots/01_projects.png`

Full project portfolio with comprehensive filtering and financial summary.

**Filters:** Stage, Health, Project Manager, Search

**Project Table columns:**
- Project ID + Name, Customer, PM, Stage (color badge), Health (badge), Priority (severity badge)
- Budget (planned), Cost (actual), Quality Score
- Open Risks count, Open Issues count, Milestones (complete/total)

**Click any row** to open a project detail modal showing:
- Full project metadata (type, service offering, PM, delivery lead, priority, stage, health)
- Budget progress bar (green/yellow/red based on burn rate)
- Hours progress bar
- Scope summary and notes

---

## 4. Status Management (`Status` tab)
**Screenshot:** `screenshots/01_status.png`

Weekly project status reports with multi-dimensional health visualization.

**Filters:** Overall Health, Escalation Only

**Status Table columns:**
- Project ID, Date, Reporter, Overall Health (badge)
- Schedule/Budget/Scope/Quality/Customer health (colored dots)
- Escalation flag (red ESC badge)

**Click any row** to see full status details including:
- All 7 health dimensions with badges
- Accomplishments, Planned Next Week, Risks, Milestone Progress

---

## 5. Time Tracking (`Time` tab)

### 5a. Summary subtab
**Screenshot:** `screenshots/02_time_summary.png`

**KPI Row:** Total Hours, Billable Hours, Billable %, Pending Approvals

**Hours by Consultant table:** Name, Total, Billable, Billable %

**Hours by Project table:** Project name, Actual vs Planned hours with progress bar

**Hours by Work Category table:** Development, Management, Testing, Implementation, etc.

### 5b. Time Entries subtab
**Screenshot:** `screenshots/02_time_time_entries.png`

Chronological list of all time entries with columns: Date, Project, Consultant, Hours, Category, Billable (Yes/No badge), Approval Status

### 5c. Utilization subtab
**Screenshot:** `screenshots/02_time_utilization.png`

Consultant utilization dashboard showing Total Hours, Billable, Non-Billable, Billable %, and a visual progress bar (green >= 75%, yellow >= 50%, red < 50%)

---

## 6. Cost & Margin Tracking (`Costs` tab)
**Screenshot:** `screenshots/01_costs.png`

Comprehensive financial analysis across the portfolio.

**KPI Row:** Total Planned, Total Forecast, Total Actual, Portfolio Variance %, Over Budget count

**Project Financial Summary table:**
- Project ID + Name, Customer, Stage
- Planned Budget, Forecast Cost, Actual Cost
- Variance % (color-coded: red > 5%, yellow > 0%, green <= 0%)
- Gross Margin %, Burn Rate (progress bar with percentage)

**Non-Labor Costs by Category table:** External Vendor, Software License, Equipment, Travel totals

---

## 7. Milestones & Deliverables (`Milestones` tab)

### 7a. Milestones subtab
**Screenshot:** `screenshots/02_milestones_milestones.png`

Milestone tracking with planned vs forecast date comparison.

**Columns:** Project, Milestone Name, Owner, Planned Date, Forecast Date (red if late), Actual Date, Status, Customer Visible

**Click any row** to see milestone details including dependency notes and delay reasons.

### 7b. Deliverables subtab
**Screenshot:** `screenshots/02_milestones_deliverables.png`

**Columns:** Project, Deliverable Name, Type, Due Date, Owner, Status, Approval Status, Customer Acknowledged

---

## 8. Risks & Issues (`Risks/Issues` tab)

### 8a. Risks subtab
**Screenshot:** `screenshots/02_risksIssues_risks.png`

Risk register with probability/impact/severity tracking.

**Columns:** Project, Risk Title, Category, Probability, Impact, Severity (badge), Owner, Status, Escalation

**Click any row** to see full risk details including mitigation plan.

### 8b. Issues subtab
**Screenshot:** `screenshots/02_risksIssues_issues.png`

**Columns:** Project, Issue Title, Severity, Owner, Due Date, Status, Escalation

### 8c. Change Requests subtab
**Screenshot:** `screenshots/02_risksIssues_change_requests.png`

**Columns:** Project, Change Title, Request Date, Requested By, Budget Impact, Schedule Impact, Approval Status

---

## 9. Quality Management (`Quality` tab)

### 9a. Quality Dashboard subtab
**Screenshot:** `screenshots/02_quality_dashboard.png`

**KPI Row:** Gate Pass Rate %, Open Findings, Overdue Actions, Avg Audit Score, Active Recoveries

**Gate Results by Type table:** Gate type, total reviews, passed count, pass rate %

**Findings by Category table:** Process, Communication, Technical, Financial counts

**Findings by Severity table:** Critical, High, Medium severity distribution

**Corrective Actions Summary:** Total, Open, Overdue, Corrective vs Preventive breakdown

### 9b. Quality Reviews subtab
**Screenshot:** `screenshots/02_quality_quality_reviews.png`

**Columns:** Project, Gate Type, Date, Reviewer, Score (color-coded), Decision (badge), Escalation

**Click any row** to see full review with checklist results (Pass/Fail/Partial color-coded items), findings, and decision notes.

### 9c. Findings subtab
**Screenshot:** `screenshots/02_quality_findings.png`

**Columns:** Project, Finding Title, Category, Severity, Owner, Due Date, Status

### 9d. Corrective Actions subtab
**Screenshot:** `screenshots/02_quality_corrective_actions.png`

Corrective and preventive action queue. Overdue items highlighted with red background.

**Columns:** Project, Action Title, Type (Corrective/Preventive badge), Severity, Owner, Due Date (with OVERDUE flag), Status

### 9e. Delivery Audits subtab
**Screenshot:** `screenshots/02_quality_delivery_audits.png`

PMO audit results with 8-dimension scoring.

**Columns:** Project, Date, Auditor, Status Discipline/5, Time/5, Docs/5, Risk/5, Quality/5, Comm/5, Governance/5, Overall Score (color-coded), Recommendation

**Click any row** to see full audit detail with all dimension scores, findings, and required actions.

### 9f. Recovery Plans subtab
**Screenshot:** `screenshots/02_quality_recovery_plans.png`

**Columns:** Project, Initiated Date, Assigned To, Manager, Status, Financial Impact, Review Cadence

**Click any row** to see full recovery plan details including trigger reason, root problem, key risk areas, immediate actions, leadership support, customer communication plan, new milestone targets, and outcome notes.

---

## 10. Customer Feedback (`Feedback` tab)
**Screenshot:** `screenshots/01_feedback.png`

**KPI Row:** Total Responses, Avg Overall/5, Avg Delivery/5, Avg Communication/5, Would Recommend %, Pending Follow-ups

**Feedback Table columns:**
- Customer, Project, Date, Type (badge)
- Overall Score (color-coded: green >= 4, yellow >= 3, red < 3)
- Delivery, Communication, Outcome scores (all /5)
- Would Recommend (Yes/No/Maybe badges)
- Follow-up Status

**Click any row** to see comments, improvement suggestions, and follow-up notes.

---

## 11. Closeout & Lessons Learned (`Closeout` tab)

### 11a. Closeout Dashboard
**Screenshot:** `screenshots/02_closeout_dashboard.png`

**KPI Row:** Ready for Closeout, In Progress, Complete, Reviews Done, Lessons Captured

**Lessons by Category table:** Delivery, Compliance, Customer, Scoping, Financial, Communication

**Lessons by Theme table:** Success Pattern, Improvement Needed, Failure Pattern

### 11b. Closeout Records subtab
**Screenshot:** `screenshots/02_closeout_closeout_records.png`

Closeout checklist with visual completion indicators (checkmark/X/pending icons).

**Columns:** Project, Initiated, Deliverables, Signoff, Time, Costs, Docs, Feedback, Lessons, Status

### 11c. Post-Project Reviews subtab
**Screenshot:** `screenshots/02_closeout_post_project_reviews.png`

**Columns:** Project, Date, Facilitator, Status

**Click any row** to see full retrospective: What Went Well, What Went Poorly, Delivery Blockers, Process Breakdowns, Quality Issues, Customer Sentiment, Team Recommendations, Best Practices, Expansion Ideas.

### 11d. Lessons Learned subtab
**Screenshot:** `screenshots/02_closeout_lessons_learned.png`

**Columns:** Title, Project, Category, Theme (Success/Failure/Improvement badges), Impact (severity badge), Service Offering, Submitted By

**Click any row** to see full lesson description and recommendation.

---

## 12. Reports Center (`Reports` tab)

### 12a. PM Performance subtab
**Screenshot:** `screenshots/02_reports_pm_performance.png`

Project Manager performance summary table.

**Columns:** PM Name, Total Projects, Active, At Risk (red if > 0), Open Risks, Open Issues, Avg Quality (color-coded)

### 12b. Integrations subtab
**Screenshot:** `screenshots/02_reports_integrations.png`

External system integration status.

**Columns:** Project, System (MS Project/SAP/Basecamp/Jira), External ID, Sync Direction, Last Sync, Status (Active/Warning/Error badges)
