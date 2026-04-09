# Kinetic Platform Test Suite

Two automated test suites that verify every app in the Kinetic Platform ecosystem is loading data correctly — from the API layer through to the browser DOM.

**Requires:** Base server running on port 3011 (`node apps/base/server.mjs`)

---

## Quick Start

```bash
# Run both suites
node apps/test-harness.mjs && node apps/test-ui.mjs

# Run with details
node apps/test-harness.mjs --verbose
node apps/test-ui.mjs --verbose
```

---

## Suite 1: API Test Harness (`test-harness.mjs`)

Tests every backend endpoint — Kinetic Core API, Task API v2, and custom server APIs — to verify the platform and proxy are returning data correctly.

### What It Tests

| Category | What | How |
|----------|------|-----|
| Platform | Auth, space, kapps, teams, users | `GET /app/api/v1/{endpoint}` |
| Task API | Trees, runs, handlers | `GET /app/components/task/app/api/v2/{endpoint}` |
| Kapp forms | Every form in every kapp | Dynamic discovery: lists forms, then queries submissions for each |
| Custom APIs | Atlas, SecOps, Innovation, School, Mining, OGC | `GET /api/{app}/{endpoint}` |
| Tree export | Export validation with name matching | Detects known platform export bug |

### Coverage

- **203 tests** across 19 app groups
- **21 kapps**, **~130 forms** verified
- **31 custom API endpoints** tested
- ~50 seconds to run

### Usage

```bash
node apps/test-harness.mjs                     # Full suite
node apps/test-harness.mjs --verbose           # Show detail per test
node apps/test-harness.mjs --app atlas         # Single app
node apps/test-harness.mjs --group custom-api  # Group of apps
node apps/test-harness.mjs --group domain      # Domain apps only
node apps/test-harness.mjs --group meta        # Meta apps only
```

### App Groups

| Group | Apps |
|-------|------|
| `custom-api` | atlas, secops, innovation, school, mining, ogc |
| `domain` | itil, knowledge, crm, asset-mgmt, case, governance |
| `meta` | browser, kapp-admin, monitor, wf-builder, wf-debugger, space-mon |

### Single App Names

`platform`, `itil`, `knowledge`, `crm`, `atlas`, `secops`, `innovation`, `school`, `mining`, `ogc`, `asset-mgmt`, `case`, `governance`, `browser`, `kapp-admin`, `monitor`, `wf-builder`, `wf-debugger`, `space-mon`

### What It Catches

- Broken API endpoints (HTTP errors)
- Missing kapps or forms (404s)
- Proxy misconfiguration
- Authentication failures
- Custom server endpoint regressions
- Wrong tree exports (platform bug — flagged but not failed)
- Slow endpoints (>3s threshold)

### What It Does NOT Catch

- Client-side rendering bugs (data loads but doesn't display)
- JavaScript errors in the browser
- Stale state when switching views
- Empty tables despite data being available

---

## Suite 2: UI Test Suite (`test-ui.mjs`)

Loads each app in a headless Chromium browser via Puppeteer, clicks every tab, and verifies that data actually renders in the DOM.

### What It Tests

| Step | What |
|------|------|
| Session restore | Sets `base_session` in localStorage, navigates to app, verifies `#app` becomes visible |
| Tab navigation | Clicks every tab button (function-based, data-attribute, or custom) |
| Content verification | Checks for table rows, KPI values, card content, or general text in the active panel |
| JS errors | Captures `pageerror` events per app |

### Coverage

- **90 tests** across 18 apps
- Every tab/view in every app verified
- ~2.5 minutes to run

### Apps Tested

| App | Tabs Tested |
|-----|-------------|
| Atlas | dashboard, catalog, domains, systems, glossary, issues, graph, admin |
| SecOps | dashboard, alerts, incidents, vulnerabilities, assets, playbooks, reports, admin |
| ITIL | agent/queue, agent/incidents, agent/requests, ops/board, ops/approvals, mgr/agents |
| Knowledge | portal/browse, manager/dashboard, manager/queue, manager/articles |
| CRM | sales/pipeline, sales/leads, sales/activities, sales/products |
| Innovation | my, review, dashboard |
| SchoolForGood | dashboard, sites, members, trainers, schedule, reminders |
| Mining Ops | dashboard, sites, compliance, issues, inspections |
| OG Compliance | dashboard, events, cases, capas, audits, reports |
| Asset Management | catalog, financial, assign, warranty |
| Case | cases, dash |
| Governance | feed, audit, scanner, risk |
| Browser | browse, alldata |
| Kapp Admin | forms, workflows, settings |
| Monitor | main |
| Workflow Builder | editor, runner |
| Workflow Debugger | main |
| Space Monitor | dashboard, inventory, logs |

### Usage

```bash
node apps/test-ui.mjs                         # Full suite (headless)
node apps/test-ui.mjs --verbose               # Show detail per check
node apps/test-ui.mjs --app atlas             # Single app
node apps/test-ui.mjs --headed                # Watch the browser
node apps/test-ui.mjs --headed --slow         # Watch with delays between tabs
```

### What It Catches

- Blank screens / empty views (data loaded but not rendered)
- JavaScript runtime errors
- Session restore failures
- Tab switching bugs (stale state, wrong data displayed)
- Missing DOM elements after navigation
- Login flow regressions

### Content Verification Logic

Each tab has one or more verification checks. The suite tries each in order and passes if any succeeds:

| Check Type | Selector Example | Pass Condition |
|------------|-----------------|----------------|
| `rows` | `table tbody tr` | At least 1 table row exists |
| `text` | `.kpi .val` | Element has non-empty text content |
| `exists` | `svg, canvas` | Element is present in DOM |
| `kpi` | `.kpi-row .kpi .val` | KPI value elements have text |

If no specific selector matches, the suite falls back to checking whether `#app` has >100 characters of text content. This catches apps with non-standard layouts while still detecting truly blank screens.

---

## Environment

| Setting | Default | Override |
|---------|---------|----------|
| Base server URL | `http://localhost:3011` | Edit `BASE` constant in script |
| Username | `second_admin` | `KINETIC_USER` env var |
| Password | `password2` | `KINETIC_PASS` env var |
| Puppeteer | Uses installed version at `node_modules/puppeteer` | — |

---

## Report Format

Both suites produce the same report structure:

```
═══════════════════════════════════════════════
                 TEST REPORT
═══════════════════════════════════════════════

Total: 203  Passed: 203  Failed: 0  Time: 49.7s

── FAILURES ──                    (only shown if failures exist)
  [app] test name
    error detail

── BY APP ──
  App           Pass  Fail  Time
  ───────────   ────  ────  ────
   ok  atlas        18     0  7.3s
   ok  secops       15     0  1.8s
  FAIL wf-builder    1     2  4.1s

── SLOW (>3s / >5s) ──            (only shown if slow tests exist)
  4.5s  [school] API: /api/school/stats
```

Exit code is `0` for all-pass, `1` if any failure.

---

## Extending the Suites

### Adding an API test for a new app

In `test-harness.mjs`, add a test function and register it in `GROUPS`:

```javascript
async function testNewApp() {
  console.log("\n── New App ──");

  // Custom API endpoints
  await test("newapp", "API: /api/newapp/stats", async () => {
    assertObject(await GET("/api/newapp/stats"), "stats");
    return "ok";
  });

  // Auto-discover forms and test submissions
  await discoverAndTestKapp("newapp", "new-kapp-slug");
}

// Register in GROUPS:
const GROUPS = {
  ...
  "newapp": [testNewApp],
};
```

### Adding a UI test for a new app

In `test-ui.mjs`, add an entry to the `APPS` array:

```javascript
{
  id: "newapp", name: "New App", path: "/new-app/",
  tabFn: "showTab",          // or tabType: "data" for data-tab buttons
  tabs: [
    { name: "dashboard", verify: [{ sel: ".kpi .val", check: "text" }] },
    { name: "list",      verify: [{ sel: "table tbody tr", check: "rows" }] },
  ],
},
```

**Tab navigation types:**

| Pattern | Config | Apps Using It |
|---------|--------|---------------|
| `showTab('name')` | `tabFn: "showTab"` | Atlas, SecOps |
| `switchTab('name')` | `tabFn: "switchTab"` | Innovation, Space Monitor |
| `switchConsole('name')` | `tabFn: "switchConsole"` | CRM, Browser, Kapp Admin, Asset Mgmt, Case, Governance |
| `[data-tab="name"]` click | `tabType: "data"` | School, Mining, OG Compliance |
| Nested sub-tabs | `customNav: true` + `tab.nav` string | ITIL, Knowledge, CRM |
| Direct button click | `customNav: true` + `tab.nav` string | Workflow Builder |

---

## Known Issues

### Wrong tree exports (platform bug)

The Kinetic Task API `/trees/{title}/export` endpoint returns wrong XML for trees created via Core API. The API test flags these as `WRONG TREE EXPORTS` in a separate report section but does not fail them, since this is a server-side platform bug, not an app bug. Both workflow-builder and workflow-debugger have client-side `isExportValid()` protection.

### Slow dashboard endpoints

Atlas and SecOps dashboards use `collectByQuery()` to aggregate data across multiple forms, resulting in 5-10 second load times. SchoolForGood stats endpoint pages through large datasets (~500 enrollments). These are expected and not failures.

### Space Monitor and networkidle

Space Monitor has a 60-second auto-refresh timer that prevents Puppeteer's `networkidle2` from settling. The UI suite uses `domcontentloaded` with an extended timeout for this app.
