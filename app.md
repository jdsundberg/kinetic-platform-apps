# Kinetic Platform Applications — Architecture & Data Model

**Platform:** Kinetic Request CE (second.jdsultra1.lan)
**Base Launcher:** `base/server.mjs` on port 3011
**Pattern:** Node.js HTTP servers proxying to Kinetic Platform API
**Totals:** 10 Kapps | 50 Forms | 72 Users | 34 Teams | ~2,830 Knowledge Articles

---

## Architecture

Each application is a self-contained Node.js HTTP server that serves a single-page HTML frontend and proxies API calls to the Kinetic Platform backend. Applications can run standalone on their own port, or be served through the unified base launcher on port 3011.

```
Browser  -->  Node.js App Server  -->  Kinetic Platform (HTTPS)
             (port 3011-3019)         (second.jdsultra1.lan)
```

### Tier 1: Browser (Frontend)
- Single `index.html` file per app — all CSS, HTML, and JS in one file
- Login screen with Basic Auth against Kinetic `/app/api/v1/me`
- Session stored in `sessionStorage` (standalone) or `localStorage` (via launcher)
- Tabs, data tables, modals, KPI cards, state transition buttons
- Calls both Kinetic API (`/app/api/v1/...`) and custom API (`/api/{app}/...`)

### Tier 2: Node.js Server (Backend-for-Frontend)
- Pure Node.js — no frameworks, no npm dependencies
- ES modules (`.mjs` files) using `node:http`, `node:https`, `node:fs`, `node:path`
- Three responsibilities:
  1. **Static file serving** — serves `index.html` and any static assets
  2. **Kinetic API proxy** — forwards `/app/*` requests to the Kinetic backend
  3. **Custom API endpoints** — aggregation, state transitions, reports, business logic

### Tier 3: Kinetic Platform (Data & Workflows)
- Kapps, forms, submissions (the database)
- Workflow trees (event-triggered automation)
- Teams and users (identity and access)

---

## Directory Structure & Ports

```
apps/
  base/                    # Unified launcher (port 3011)
    server.mjs             # Central hub with APP_REGISTRY + all custom APIs
    index.html             # Landing page / app selector
  itil/                    # ITSM Console
  crm/                     # CRM Console
  knowledge/               # Knowledge Portal
  ...
```

| Port | App | Directory |
|------|-----|-----------|
| 3011 | **Base Launcher** | `base/` |
| 3012 | ITIL | `itil/` |
| 3013 | Knowledge | `knowledge/` |
| 3014 | CRM | `crm/` |
| 3015 | Atlas | `atlas/` |
| 3016 | SecOps | `sec_ops/` |
| 3017 | OG Compliance | `og_compliance/` |
| 3018 | Space Monitor | `space-monitor/` |
| 3019 | AgentHub | `agent_hub/` |
| **3020** | **Next available** | |

---

## App Registration (APP_REGISTRY)

Every app must be registered in `base/server.mjs`:

```javascript
const APP_REGISTRY = {
  "slug": { dir: "directory_name", name: "Display Name", kapp: "kapp-slug" },
};
```

- **slug**: URL path segment (e.g., `/og-compliance/`)
- **dir**: Filesystem directory under `apps/`
- **name**: Human-readable name shown in launcher
- **kapp**: Associated Kinetic kapp slug (`null` for utility apps)

The base server routes `/{slug}/` to `apps/{dir}/index.html` and injects auto-login scripts.

### APP_ABOUT (App Metadata)

Rich metadata for each app, used to generate "About" modals:

```javascript
const APP_ABOUT = {
  "slug": {
    title: "Display Title",
    overview: "Description paragraph",
    kapp: "kapp-slug(s)",
    tabs: [{ name: "Tab Name", desc: "What this tab does" }],
    entities: [{ name: "Entity", color: "#hex", fields: ["field1", "field2"] }],
    rels: [["Entity A", "FK Field", "Entity B"]],
  },
};
```

---

## Two App Patterns

### Simple Apps (Proxy Only)
~55-75 lines in `server.mjs`. Just serve HTML and proxy `/app/*` to Kinetic.

Examples: `itil/`, `crm/`, `knowledge/`, `governance/`, `case/`

```javascript
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const PORT = process.env.PORT || 3000;
const KINETIC = process.env.KINETIC_URL || "https://second.jdsultra1.lan";
// ... serve index.html, proxy /app/*, listen on PORT
```

### Industry Apps (Custom API Layer)
500-1000+ lines in `server.mjs`. Custom API endpoints for aggregation, state transitions, reporting.

Examples: `sec_ops/`, `mining_management/`, `innovation/`, `school-for-good/`, `og_compliance/`, `agent_hub/`

Custom API namespace pattern: `/api/{app-prefix}/...`
- `/api/secops/...` — Security Ops
- `/api/mining/...` — Mining Ops
- `/api/ogc/...` — OG Compliance
- `/api/innovation/...` — Innovation
- `/api/school/...` — SchoolForGood

Industry app custom APIs are **duplicated** in `base/server.mjs` so they work through the launcher.

---

## Auto-Login Injection

When the base launcher serves an app's `index.html`, it injects two scripts:

1. **Head script**: Reads `base_session` from `localStorage`, populates `sessionStorage` with `kinetic_session`, hides login screen via CSS
2. **Body script**: Adds home button, user menu, About modal, overrides `doLogout()` to redirect to launcher

Apps work both standalone (own login) and through the launcher (auto-authenticated).

---

## Creating a New App

1. **Create directory**: `apps/{app_name}/`
2. **Write `server.mjs`**: Choose simple or industry pattern, assign next port
3. **Write `index.html`**: Single-page app with login screen, topbar, tabs
4. **Register in `base/server.mjs`**:
   - Add to `APP_REGISTRY`
   - Add to `APP_ABOUT`
   - If industry app: add custom API handler + route + console logs
5. **Restart base server**: Kill port 3011 process, re-run `node base/server.mjs`

### Kinetic Platform Setup (for industry apps)

Before building the Node.js app:
1. Create the Kapp on Kinetic Platform
2. Create all forms with field definitions — **slugs must match exactly what the app code references**
3. Create teams for RBAC
4. Create workflows (event-triggered trees with XML definitions)
5. Seed reference data (sites, categories, configurations)

### Form Slug Discipline

Form slugs are referenced by name throughout the app's `index.html`. Never rename forms or create them with different slugs than the code expects. Existing submission data is tied to the original form slug.

### Workflow Data Model

- **workflow.id = workflow.sourceGroup** — same UUID, identifies the workflow, NOT the kapp
- **workflow.platformItemId** — the kapp's UUID
- **WebAPI trees** use sourceGroup pattern: `"WebApis > {kapp-slug}"`
- **Event-triggered workflows**: create via Core API (`create_workflow`)
- **WebAPI/non-event trees**: create via Task API v2 (`create_tree` + `update_tree_json`)
- **ERB tags in treeXml** must be XML-escaped: `&lt;%=` and `%&gt;`

---

## Troubleshooting

### Apps returning 404 through the base launcher

The base server must be restarted after modifying `APP_REGISTRY`, changing `index.html`, or creating new app directories:
```bash
kill $(lsof -ti:3011) && node base/server.mjs &
```

### Governance Hub scanner returning HTTP 404

The scanner calls Kinetic Core API endpoints with `include` parameters. If the Platform version doesn't support a particular include value, the API returns 404. Verify include parameters match the Platform version.

---

## Key Conventions

- **No npm dependencies** — everything uses Node.js built-ins
- **Single HTML file** — all CSS and JS inline, no build step
- **ES modules** — `.mjs` extension, `import`/`export` syntax
- **Self-signed TLS** — `NODE_TLS_REJECT_UNAUTHORIZED = "0"` for dev
- **CORS permissive** — `Access-Control-Allow-Origin: *` on all responses
- **Basic Auth forwarding** — `Authorization` header passed through to Kinetic
- **No database** — Kinetic Platform is the sole data store
- **Stateless servers** — no server-side session state, all auth via headers

---

## Platform Data Model

The Kinetic Platform follows a strict hierarchy: **Space > Kapps > Forms > Submissions**. Teams and Users exist at the Space level and are referenced across all Kapps.

### What the Platform Does NOT Have Natively

- No field types (everything is text — numbers, dates, booleans stored as strings)
- No native foreign key constraints between forms
- No relational joins — cross-form references are stored as text values
- No sub-team or team hierarchy — teams are flat
- No built-in approval workflows without the Task Engine
- No file/attachment storage in form fields

---

## Kapps & Forms

### Foundation (`foundation`) — 5 Forms

Core reference data shared across all ITSM processes.

| Form | Slug | Fields | Role |
|------|------|--------|------|
| People | `people` | 10 | Employee/contact directory |
| Organizations | `organizations` | 12 | Companies, departments, business units |
| Locations | `locations` | 10 | Physical sites and addresses |
| Services | `services` | 8 | IT service catalog definitions |
| SLA Definitions | `sla-definitions` | 7 | Service level agreement templates |

**Key lessons:** Foundation must be built first — every process references People, Services, and Locations. People records vs Platform Users are separate concerns. Organizations use self-referencing for hierarchy.

### Incident Management (`incident`) — 3 Forms

Restore normal service after unplanned interruptions.

| Form | Slug | Fields | Role |
|------|------|--------|------|
| Incidents | `incidents` | 18 | Core incident records |
| Incident Tasks | `incident-tasks` | 10 | Work breakdown tasks |
| Incident Notes | `incident-notes` | 5 | Activity log and work notes |

**Key lessons:** Priority = Impact x Urgency (derive via workflow). The Notes pattern (ID, Author, Content, Type, Visibility) is universal. Closed Date vs Resolved Date measures different things. Configuration Item links incidents to the CMDB.

### Problem Management (`problem`) — 4 Forms

Identify root causes of recurring incidents.

| Form | Slug | Fields | Role |
|------|------|--------|------|
| Problems | `problems` | 15 | Root cause investigations |
| Known Errors | `known-errors` | 8 | KEDB — documented errors with workarounds |
| Problem Tasks | `problem-tasks` | 8 | Investigation tasks |
| Problem Notes | `problem-notes` | 5 | Investigation notes |

**Key lessons:** Problems are NOT Incidents (disease vs symptom). The KEDB is the highest-value artifact. Root Cause, Workaround, and Resolution are three distinct fields.

### Change Management (`change`) — 4 Forms

Control the lifecycle of all changes to minimize risk.

| Form | Slug | Fields | Role |
|------|------|--------|------|
| Change Requests | `change-requests` | 20 | RFC records (most fields of any form) |
| Change Tasks | `change-tasks` | 10 | Implementation work items |
| Change Approvals | `change-approvals` | 5 | CAB approval records |
| Change Notes | `change-notes` | 5 | Activity log |

**Key lessons:** Approvals are junction forms (Approver + Change ID + Status). Change Types (Standard/Normal/Emergency) drive the approval path. Scheduled vs Actual dates reveal implementation discipline.

### Service Request Management (`service-request`) — 5 Forms

Handle standard, pre-defined service requests.

| Form | Slug | Fields | Role |
|------|------|--------|------|
| Requests | `requests` | 13 | Service request records |
| Request Items | `request-items` | 6 | Line items (shopping cart) |
| Request Tasks | `request-tasks` | 8 | Fulfillment work items |
| Request Approvals | `request-approvals` | 5 | Approval records |
| Request Notes | `request-notes` | 5 | Activity log |

**Key lessons:** "Requested By" vs "Requested For" is essential. Request Items enable shopping-cart behavior. Service Requests are the highest-volume ITSM process.

### Knowledge Management (`knowledge`) — 5 Forms

Capture, organize, and share knowledge.

| Form | Slug | Fields | Role |
|------|------|--------|------|
| Articles | `articles` | 11 | Knowledge base articles |
| Article Categories | `article-categories` | 5 | Taxonomy |
| Article Feedback | `article-feedback` | 5 | User ratings |
| Article Comments | `article-comments` | 12 | Improvement suggestions |
| Article Versions | `article-versions` | 11 | Version history |

**Data:** 1,000 IT articles + 1,830 HR articles across 20 categories, loaded at ~27/sec with 15 concurrent connections.

**Key lessons:** Articles need a lifecycle (Draft > Review > Published > Retired). Versioning is critical. Comments are mini-tickets for article improvements.

### CMDB (`cmdb`) — 3 Forms

Track IT assets (Configuration Items) and relationships.

| Form | Slug | Fields | Role |
|------|------|--------|------|
| Configuration Items | `configuration-items` | 14 | IT assets and components |
| CI Relationships | `ci-relationships` | 5 | Parent-child CI mappings |
| CI History | `ci-history` | 7 | Change audit trail for CIs |

**Key lessons:** The CMDB is the single source of truth for infrastructure. CI Relationships model the dependency graph. Start small with business-critical CIs.

### Case Management / CSM (`case`) — 12 Forms

External customer support with full customer context. The most complex kapp.

| Form | Slug | Fields | Role |
|------|------|--------|------|
| Cases | `cases` | 15 | Core case records |
| Customers | `customers` | 12 | Customer organizations |
| Contacts | `contacts` | 8 | People at customer orgs |
| Products | `products` | 7 | Product/service catalog |
| Agents | `agents` | 7 | Support staff |
| Customer Products | `customer-products` | 9 | Customer entitlements |
| Case Products | `case-products` | 6 | Case-to-product link |
| Case Contacts | `case-contacts` | 5 | Additional case contacts |
| Case Notes | `case-notes` | 6 | Activity log |
| Case Attachments | `case-attachments` | 7 | File references |
| Categories | `categories` | 4 | Case taxonomy |
| SLA Policies | `sla-policies` | 6 | Customer SLA definitions |

**Key lessons:** Junction forms model many-to-many (Case Products, Case Contacts, Customer Products). SLA Policies tie to SLA Tiers on Customers. Attachments are metadata only — files live elsewhere.

### Catalog / Helpdesk (`catalog`) — 5 Forms

Lightweight helpdesk — tickets, assets, agents, knowledge.

| Form | Slug | Fields | Role |
|------|------|--------|------|
| Tickets | `tickets` | 10 | Support tickets |
| Customers | `customers` | 6 | Customer records |
| Agents | `agents` | 5 | Support staff |
| Assets | `assets` | 9 | IT asset inventory |
| Knowledge Articles | `knowledge-articles` | 5 | Self-service KB |

**Key lessons:** Simpler alternative to full ITSM. Assets overlap with CMDB CIs (simpler view). Catalog KB articles are separate from the full Knowledge Kapp.

### CRM (`crm`) — 4 Forms

Sales pipeline management.

| Form | Slug | Fields | Role |
|------|------|--------|------|
| Leads | `leads` | 16 | Sales leads and prospects |
| Opportunities | `opportunities` | 18 | Pipeline deals |
| Products | `products` | 10 | Product catalog with pricing |
| Activities | `activities` | 12 | Sales activity log |

**Key lessons:** Leads convert to Opportunities. Lead Score enables prioritization. Opportunity Stages define the pipeline (Amount x Probability = weighted forecast). Activities are polymorphic (linked to Leads, Opportunities, or Accounts via `Related To` + `Related ID`).

---

## Cross-Cutting Patterns

### Recurring Form Patterns

| Pattern | Used In | Fields |
|---------|---------|--------|
| **Notes/Activity Log** | Incident, Problem, Change, Service Request, Case | ID, Author, Content, Note Type, Visibility |
| **Tasks** | Incident, Problem, Change, Service Request | Task Number, Parent ID, Title, Status, Assigned To, Due Date |
| **Approvals** | Change, Service Request | Parent ID, Approver, Status, Decision Date, Comments |
| **Junction/Bridge** | Case Products, Case Contacts, Customer Products, CI Relationships | Parent ID, Child ID + metadata |
| **Categories** | Case, Knowledge | Category Name, Parent Category, Description, Active |

### Data Model Design Principles

1. **Denormalize display names alongside IDs** — no joins, so store both `Customer ID` and `Customer Name`
2. **Use submission labels for search** — `submissionLabelExpression` makes submissions identifiable without full loads
3. **Status fields: controlled vocabulary** — define valid statuses per form, enforce via UI/workflow
4. **Number fields auto-generated** — store as text, generate sequentially via workflow
5. **Date fields are text** — store in ISO 8601 (`2026-02-14T17:30:00Z`) for consistent sorting
6. **Every core form: auto-number + human-readable title** — number for machines, title for humans

### Team Organization

- **34 teams** in Fortune 2000-style IT hierarchy
- **5 departments:** IT Leadership, IT Operations, IT Security, IT Applications, IT Governance
- **Naming convention:** `Parent::Child` (e.g., `Cloud Engineering::DevOps`)
- **72 users** with role-based assignments; cross-functional membership supported

### API & Data Loading

- **Endpoint pattern:** `https://{server}/app/api/v1/kapps/{kappSlug}/forms/{formSlug}/submissions`
- **Auth:** Basic auth (`-u username:password`)
- **Bulk loading:** ~27 submissions/sec with 15 concurrent connections
- **Payload:** `{"values": {"Field Name": "value", ...}, "completed": true}`
- **KQL:** `values[Status] = "Active"` syntax for searching

### What Would Be Different in Production

- Workflows on every form for auto-numbering, status transitions, SLA timers, notifications
- Bridges connecting to external systems (email, Slack, AD, monitoring)
- Role-based access restricting visibility and editing by team
- Custom bundles (UI themes) for portal, agent console, admin interfaces
- Scheduled tasks for SLA breach warnings, stale ticket notifications, reports

---

## Related Files

- [branding.md](branding.md) — Design system and style guide
- [code-review-lessons.md](code-review-lessons.md) — 22 lessons across 3 app generations
- [kinetic-test-suite.md](kinetic-test-suite.md) — Test suites
- [mcp-gaps.md](mcp-gaps.md) — MCP tool gaps and workarounds
