# ServiceProMax — Enterprise Services Delivery & Quality Management

## Overview

ServiceProMax is a comprehensive enterprise services delivery, quality governance, and management platform built on the Kinetic Platform. It serves as the operational command center for professional services organizations, providing visibility into project health, delivery quality, customer satisfaction, financial performance, and continuous improvement.

## Architecture

```
                    +-------------------+
                    |  Kinetic Platform |
                    |  (first.kinetics) |
                    |   Kapp: service-  |
                    |    pro-max        |
                    |   22 Forms        |
                    |   100+ Indexes    |
                    +--------+----------+
                             |
                    +--------+----------+
                    |  Base Server      |
                    |  (port 3011)      |
                    |  Auto-discovery   |
                    |  API proxy        |
                    +--------+----------+
                             |
              +--------------+--------------+
              |                             |
    +---------+----------+     +-----------+--------+
    |  index.html        |     |  server.mjs        |
    |  Single-page app   |     |  Custom API        |
    |  All tabs inline   |     |  8 dashboard       |
    |  CSS/JS embedded   |     |  endpoints         |
    +--------------------+     +--------------------+
```

## Data Model (ERD)

```
                           CUSTOMERS
                          +-------------------+
                          | Account ID (PK)   |
                          | Name              |
                          | Industry          |
                          | Region            |
                          | Tier              |
                          | Health            |
                          | Account Owner     |
                          +--------+----------+
                                   |
                          +--------+----------+
                          | Customer Contact  |
                          | Customer ID (FK)  |
                          | Contact Name      |
                          | Role              |
                          +-------------------+
                                   |
           +-----------+-----------+-----------+-----------+
           |           |           |           |           |
    +------+------+  +-+--------+ |    +------+------+    |
    |   PROJECT   |  |Customer  | |    |  Customer   |    |
    +-------------+  |Feedback  | |    |  (history)  |    |
    |Project ID   |  +----------+ |    +-------------+    |
    |Name         |               |                       |
    |Customer ID  |               |                       |
    |PM           |               |                       |
    |Stage        |               |                       |
    |Health       |               |                       |
    |Budget/Cost  |               |                       |
    |Quality Score|               |                       |
    +------+------+               |                       |
           |                      |                       |
    +------+------+------+-------+-------+------+--------+
    |      |      |      |       |       |      |        |
    |      |      |      |       |       |      |        |
  Team  Status  Mile-  Deliv-  Risks  Issues Change   Time/Cost
  Assign Update stones erables               Requests  Entries
    |      |      |      |       |       |      |        |
    +------+------+------+-------+-------+------+--------+
                          |
              +-----------+-----------+
              |           |           |
        Quality      Corrective   Recovery
        Reviews      Actions      Plans
              |           |
        Quality      Delivery
        Findings     Audits
              |
    +---------+---------+
    |         |         |
  Closeout  Post-Proj  Lessons    Integration
  Records   Reviews    Learned    Links
```

## Forms (22 total)

### Core Entities
| Form | Slug | Purpose |
|------|------|---------|
| Customer | `customer` | Customer accounts with tier, health, and strategic classification |
| Customer Contact | `customer-contact` | Key contacts at customer organizations |
| Project | `project` | Service delivery projects with full lifecycle tracking |
| Project Team Assignment | `project-team` | Team member allocation and rate tracking |

### Execution Tracking
| Form | Slug | Purpose |
|------|------|---------|
| Status Update | `status-update` | Weekly status reports with 7-dimension health scoring |
| Milestone | `milestone` | Planned vs actual milestone tracking |
| Deliverable | `deliverable` | Deliverable approval and customer acknowledgment |
| Risk | `risk` | Risk register with probability, impact, severity |
| Issue | `issue` | Issue tracking with root cause and resolution |
| Change Request | `change-request` | Scope/schedule/budget change control |

### Financial
| Form | Slug | Purpose |
|------|------|---------|
| Time Entry | `time-entry` | Billable/non-billable time tracking with approval |
| Cost Entry | `cost-entry` | Non-labor costs (vendor, travel, materials) |

### Quality & Governance
| Form | Slug | Purpose |
|------|------|---------|
| Quality Review | `quality-review` | Quality gate reviews at lifecycle checkpoints |
| Quality Finding | `quality-finding` | Specific findings from quality reviews |
| Corrective Action | `corrective-action` | Corrective and preventive action tracking |
| Recovery Plan | `recovery-plan` | Formal recovery plans for at-risk projects |
| Delivery Audit | `delivery-audit` | PMO audits with 8-dimension scoring |

### Closeout & Learning
| Form | Slug | Purpose |
|------|------|---------|
| Customer Feedback | `customer-feedback` | Satisfaction surveys with follow-up tracking |
| Closeout Record | `closeout-record` | Pre-closeout validation checklist |
| Post-Project Review | `post-project-review` | Retrospective reviews |
| Lessons Learned | `lessons-learned` | Reusable lessons categorized by theme |

### Integration
| Form | Slug | Purpose |
|------|------|---------|
| Integration Link | `integration-link` | External system connections and sync status |

## Navigation & Tabs

### Main Tabs (12)
1. **Dashboard** — Executive portfolio overview with KPIs for health, finances, quality, and satisfaction
2. **Customers** — Customer list with filtering by tier, health, region; drill into customer details
3. **Projects** — Full project portfolio with filtering by stage, health, PM; project detail modals
4. **Status** — Weekly status reports with 7-dimension health visualization
5. **Time** — Time tracking with subtabs: Summary, Time Entries, Utilization
6. **Costs** — Cost & margin analysis with budget variance and burn rate tracking
7. **Milestones** — Subtabs: Milestones (planned vs actual), Deliverables (approval tracking)
8. **Risks/Issues** — Subtabs: Risks (register), Issues (tracking), Change Requests
9. **Quality** — Subtabs: Dashboard, Quality Reviews, Findings, Corrective Actions, Audits, Recovery Plans
10. **Feedback** — Customer satisfaction surveys with follow-up management
11. **Closeout** — Subtabs: Dashboard, Closeout Records, Post-Project Reviews, Lessons Learned
12. **Reports** — Subtabs: PM Performance, Integrations

## API Endpoints

All custom API endpoints are under `/api/spm/`:

| Endpoint | Description |
|----------|-------------|
| `GET /api/spm/dashboard` | Executive dashboard KPIs (portfolio, financial, quality, satisfaction) |
| `GET /api/spm/projects/summary` | Project portfolio with risk/issue/milestone counts |
| `GET /api/spm/quality/dashboard` | Quality gate pass rates, findings, corrective actions |
| `GET /api/spm/time/dashboard` | Time utilization by consultant and project |
| `GET /api/spm/cost/dashboard` | Cost & margin by project with variance tracking |
| `GET /api/spm/customers/dashboard` | Customer list with project counts and satisfaction |
| `GET /api/spm/feedback/dashboard` | Feedback scores and follow-up status |
| `GET /api/spm/closeout/dashboard` | Closeout status and lessons learned summaries |
| `GET /api/spm/reports/pm` | PM performance summary |

## Project Lifecycle Stages

```
Intake -> Scoping -> Approval -> Planned -> Kickoff -> In Progress
                                                          |
                                              +-----------+-----------+
                                              |           |           |
                                          On Hold     At Risk     Recovery
                                              |           |           |
                                              +-----------+-----------+
                                                          |
                                              Ready for Closeout -> Completed -> Closed -> Archived
```

## Quality Framework

### Quality Gates (8 types)
1. **Intake Quality Gate** — Validates project setup before approval
2. **Kickoff Readiness** — Confirms team, timeline, milestones before start
3. **Delivery Health Review** — Weekly delivery quality checks
4. **Milestone Readiness** — Validates deliverables before milestone sign-off
5. **Customer Feedback Review** — Processes customer satisfaction data
6. **Pre-Closeout Quality Gate** — Validates all closeout checklist items
7. **Post-Project Retrospective** — Captures lessons and best practices
8. **Delivery Audit** — PMO-driven project compliance review

### Quality Scoring
- Quality Reviews: 0-100 score with Pass/Fail/Partial checklist items
- Delivery Audits: 8 dimensions scored 1-5, weighted to overall score
- Customer Feedback: 1-5 scale across delivery, communication, outcome

## Maintenance Guide

### Adding New Seed Data
```bash
# Edit seed-data.json then run:
node setup-all.mjs --seed
```

### Rebuilding Indexes
```bash
node setup-all.mjs  # Redefines and builds indexes
```

### Adding a New Form
1. Add the form definition to `app.json` with fields and indexes
2. Run `node setup-all.mjs` to create fields and indexes on the platform
3. Add UI elements in `index.html` for the new form
4. Add API endpoints in `server.mjs` if needed for dashboards

### Adding New Fields to Existing Forms
1. Update the field list in `app.json`
2. Run the setup script — it will PUT the updated field definitions
3. Update the UI and API as needed

### Server Restart
```bash
# Kill and restart the base server
kill $(lsof -ti:3011) && cd apps/base && node server.mjs &
```

## Design Principles

### Single-File Architecture
- One `index.html` contains all CSS, HTML, and JavaScript
- No external dependencies, no build step
- System fonts only (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto`)

### Branding
- Primary: `#242F4D` (dark blue) — topbar, titles
- Accent: `#F36C24` (orange) — active tabs, CTAs
- Health colors: Green `#34A853`, Yellow `#FBBC04`, Red `#EA4335`
- Cards: white with `1px solid #E8EAED` border, `12px` radius

### Data Patterns
- All field values are strings (Kinetic standard)
- Dates in ISO format: `2026-04-15`
- Dollar amounts as strings: `"450000"`
- Health/status as enum strings: `"Green"`, `"In Progress"`

### Security Model
- All API calls authenticated via Basic Auth
- Session stored in `sessionStorage` (cleared on tab close)
- Base launcher provides auto-login via `localStorage`

## Future Enhancement Roadmap

### Phase 1: Workflow Automation
- [ ] Automated weekly status reminders via workflow
- [ ] Auto-escalation when health turns Red for 2+ weeks
- [ ] Status overdue notifications
- [ ] Recovery plan auto-trigger on persistent Red status
- [ ] Time entry weekly reminders

### Phase 2: Advanced Reporting
- [ ] Portfolio trend charts (health over time)
- [ ] Financial forecast modeling
- [ ] Resource capacity planning dashboard
- [ ] Customer lifetime value tracking
- [ ] SLA compliance reporting

### Phase 3: Enhanced Quality
- [ ] Quality review template library
- [ ] Automated quality checklist generation
- [ ] Root cause analysis trends
- [ ] Predictive risk scoring using ML
- [ ] Delivery standard compliance scoring

### Phase 4: Integration Framework
- [ ] Microsoft Project schedule sync
- [ ] Basecamp task/milestone sync
- [ ] CRM opportunity linkage
- [ ] Finance/ERP cost feed
- [ ] Document repository linkage
- [ ] Email/calendar integration

### Phase 5: Mobile & Advanced UX
- [ ] Mobile-friendly time entry
- [ ] Mobile status update workflow
- [ ] Kanban board view for projects
- [ ] Gantt chart visualization
- [ ] Drag-and-drop resource allocation
- [ ] PDF report generation (executive summaries)

### Phase 6: Advanced Analytics
- [ ] Service profitability analysis
- [ ] PM performance benchmarking
- [ ] Customer health prediction
- [ ] Delivery pattern analysis
- [ ] Lessons learned knowledge graph
- [ ] AI-powered risk assessment
