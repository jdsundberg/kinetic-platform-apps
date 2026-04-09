# ITSM/ITIL Demo Application

## Overview

A single-page ITSM (IT Service Management) application built with vanilla HTML/CSS/JavaScript, backed by a Kinetic Platform instance via a lightweight Node.js proxy. Designed for demos showcasing Kinetic's form, submission, and workflow capabilities.

**Stack:** Vanilla JS SPA + Node.js proxy (`server.mjs`) + Kinetic Platform APIs
**Location:** `/Users/jdsundberg/dev/claudeCode/MCPServer/itil/`

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | Complete SPA — all HTML, CSS, and JavaScript in one file |
| `server.mjs` | Node.js HTTP server (port 3000) — proxies `/app/*` to Kinetic, serves static files, adds CORS headers |
| `seed-knowledge.mjs` | Generates and submits 2,000 realistic IT knowledge articles to the Knowledge kapp |

---

## Running

```bash
# Start the proxy server
cd itil
NODE_TLS_REJECT_UNAUTHORIZED=0 node server.mjs

# Open in browser
open http://localhost:3000

# Login credentials
# Server: your Kinetic Platform URL
# User: your_username / your_password
```

The proxy server forwards all `/app/*` requests to the Kinetic Platform at `https://second.jdsultra1.lan`, handles CORS, and serves `index.html` at the root.

---

## Data Model

The app reads from these Kinetic kapps and forms:

| Kapp | Form | Key Fields |
|------|------|------------|
| `incident` | `incidents` | Incident Number, Title, Description, Reported By, Priority, Impact, Category, Source, Service, Assigned To, Status, Urgency, Resolved Date |
| `service-request` | `requests` | Request Number, Title, Description, Requested By, Requested For, Priority, Category, Service, Status |
| `change` | `change-requests` | Change Number, Title, Description, Type, Risk, Priority, Status, Scheduled Start/End, Assigned To/Team, Service, Implementation Plan, Backout Plan |
| `change` | `change-approvals` | Change ID, Approver, Status (Pending/Approved/Rejected), Decision Date, Comments |
| `knowledge` | `articles` | Article Number, Title, Content, Category, Status, Author, Tags, Views, Published Date, Related Service |
| `foundation` | `people` | Full Name, Department, Email |

**Workflow data** comes from the Task API v2 (trees, runs, tasks).

---

## Four Consoles

### 1. Agent Console

The day-to-day view for frontline support staff.

**Subtabs:**
- **My Queue** — Unified queue of incidents + requests assigned to the current user, sorted by priority. KPIs: Critical Incidents, Open Incidents, Open Requests, Resolved Today.
- **All Incidents** — Full incident list with search, status filter (New/In Progress/Resolved/Closed), priority filter. Click to view details. Create new incident button.
- **Service Requests** — Request list with search. Click to view details. Create new request button.
- **Knowledge Base** — Two-column split-pane: article search results on the left, article detail on the right. Category dropdown filter, keyword search across title/content/tags. API-powered search with pagination ("Load More Results"). Article detail renders markdown content, shows metadata, has "Copy to Clipboard" button.

**Features:**
- Typeahead people search for Reported By / Assigned To fields (uses KQL `=*` queries with `orderBy`)
- New incident/request forms with all standard ITIL fields
- Detail modals for viewing full ticket information

### 2. Operations Console

Change management and operational oversight.

**Subtabs:**
- **Change Board** — Kanban board with 5 columns: Draft, Submitted, Approved, Implementing, Completed. Cards show change number, title, type/risk/priority badges, assigned to/team.
- **Schedule Timeline** — Visual Gantt-style timeline of scheduled changes. Bars colored by type (Emergency=red, Normal=blue, Standard=green). Risk badges.
- **Pending Approvals** — Table of approvals awaiting decisions. Approve/Reject buttons with comment fields.
- **Impact Analysis** — Changes grouped by affected service, sorted by count. Shows impact breadth across services.

**KPIs:** Total Changes, Emergency, High Risk, Implementing, Pending Approvals.

### 3. Management Console

Analytics and team performance monitoring. Designed with a humorous "nit-picker" management tone.

**Subtabs:**
- **Dashboard** — Score cards (Team Efficiency Index, Customer Satisfaction, First Call Resolution). Incident volume by priority. Status distribution.
- **Agent Performance** — Agent ranking table with "shame-rank" medals. Resolution rate %, productivity score. "Send Gentle Reminder" button with sarcastic template options.
- **SLA Compliance** — SLA targets by priority (Critical=4h, High=8h, Medium=24h, Low=48h). Progress bars showing SLA usage %. Breach/At Risk/On Track status pills.
- **Ticket Aging** — All open tickets sorted oldest-first. Age color-coding (red >5d, orange >3d, yellow >1d, green <=1d). Nudge buttons.

**Nag banners** appear for critical incidents, stale tickets, and high average ticket age.

### 4. Workflows Console

Monitors Kinetic Task engine workflow executions. Designed to be demo-impressive.

**Layout:**
- **Hero section** — Dark gradient banner with 6 KPI stats (Total Executions, Today, Active, Completed, Errors, Trees Count). 24-hour activity chart with hourly bars (errors shown in red).
- **Tree cards grid** — Each workflow tree shown as a card with name, event/trigger, status indicator (green glow = active).
- **Runs table** — Server-side paginated (25 per page). Prev/Next navigation. Filter by tree (server-side), status and text search (client-side within page). Shows: Run ID, Tree name, Status pill, Started time + time ago, Duration, Triggered By.
- **Run detail** — Prev/next run navigation. Header with run metadata. Tasks table showing all nodes in the execution.
- **Task detail** — Prev/next task navigation. Properties grid. Results table (green box). Deferred results (yellow box). Back to run button.

**Data loading:** Only fetches 25 runs at a time from the API. Uses `count` field for total. Does NOT load all records upfront. Tree filter uses server-side `&tree=` parameter. `include=details` is always included on `/runs` requests.

---

## API Integration

### Authentication
HTTP Basic Auth — user enters credentials on the login screen, stored as `btoa(user:pass)` in the `API` object. Every fetch includes `Authorization: Basic <base64>`.

### Core API (v1)
```
GET  /app/api/v1/me                                          — verify login
GET  /app/api/v1/kapps/{kapp}/forms/{form}/submissions       — list submissions
POST /app/api/v1/kapps/{kapp}/forms/{form}/submissions       — create submission
PUT  /app/api/v1/submissions/{id}                            — update submission
```

Query params: `include=values`, `include=details,values`, `limit=1000`, `q=values[Field] = "value"`, `orderBy=values[Field]`

### Task API (v2)
```
GET /app/components/task/app/api/v2/trees?limit=100&include=details
GET /app/components/task/app/api/v2/runs?limit=25&offset=0&include=details
GET /app/components/task/app/api/v2/runs?limit=1&start={ISO}         — count-only query
GET /app/components/task/app/api/v2/runs/{id}/tasks
```

Filter params: `tree=`, `source=`, `start=`, `end=`

### Data Loading Pattern
- On login: fetches all submissions from each kapp (incidents, requests, changes, approvals, people) in parallel
- Knowledge base: loaded on-demand via API search (not pre-loaded)
- Workflows: loaded on-demand when Workflows tab is clicked. Server-side pagination, 25 at a time.
- Core data cached in `DATA` object, re-rendered client-side on filter changes

---

## Design System

### Colors (CSS Variables)
- `--blue: #242F4D` — primary text, headers
- `--orange: #F36C24` — accent, primary buttons, active states
- `--green: #34A853` — success, resolved, on-track
- `--red: #EA4335` — errors, critical, breached
- `--yellow: #FBBC04` — warnings, at-risk
- `--gray: #5F6368` — secondary text
- `--border: #E8EAED` — borders, dividers

### Components
- **KPI cards** — White card, colored number, label, sub-label
- **Badges** — Rounded pills for status, priority, severity, type, risk
- **Tables** — Sticky headers, hover highlight, row click handlers
- **Modals** — Centered overlay, 600px wide, scrollable, form actions
- **Buttons** — Primary (orange), Secondary (light), Danger (red), Small variants
- **Status pills** — Colored dot + text for workflow statuses
- **Duration badges** — Monospace, color-coded (fast=green, medium=yellow, slow=red)
- **Pager** — Prev/Next buttons with position indicator

### Animations
- Pulse on critical indicators and active status dots
- Spinner for loading states
- Fade-in on view transitions (workflow drill-down)

---

## Seed Script (seed-knowledge.mjs)

Generates 2,000 realistic IT knowledge articles across 10 categories:

| Category | Templates | Articles |
|----------|-----------|----------|
| Hardware | 10 | 200 |
| Software | 11 | 200 |
| Network & Connectivity | 6 | 200 |
| Account & Access | 6 | 200 |
| Email & Calendar | 6 | 200 |
| Security | 4 | 200 |
| Mobile Devices | 3 | 200 |
| Cloud Services | 5 | 200 |
| Printing | 4 | 200 |
| Audio & Video Conferencing | 3 | 200 |

**Features:**
- Template system with placeholder substitution (`{laptop}`, `{error}`, etc.)
- Real device models, software names, error messages
- Markdown-formatted content with Problem Description, Resolution, and Additional Notes sections
- Article numbers: KBA000001–KBA002000
- Status distribution: 80% Published, 10% Draft, 10% Review
- Random view counts (0–5000)
- Concurrent submission (15 at a time, ~28 records/sec)

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 node seed-knowledge.mjs
```

---

## Architecture Decisions

1. **Single HTML file** — Keeps the entire app portable. No build step, no framework dependencies. Easy to deploy or demo from any web server.

2. **Node.js proxy** — Solves CORS for browser-to-Kinetic requests. Stateless pass-through, no server-side logic.

3. **Server-side pagination for workflows** — Only loads 25 runs at a time. Uses API `count` field for totals. Prev/Next navigation (no page numbers). Tree filter is server-side (`&tree=`); status/search are client-side within the current page.

4. **Client-side data for ITSM records** — Incidents, requests, changes are loaded fully on login (typically <1000 records each). Filtering, sorting, and rendering happen client-side for instant responsiveness.

5. **Knowledge base search** — API-powered with KQL queries. Not pre-loaded due to volume (2000+ articles). Category filter and keyword search with pagination.

6. **Typeahead people search** — Uses KQL `=*` (starts-with) operator with `orderBy` parameter. Falls back to email search if name search fails. Requires form index on searched fields.
