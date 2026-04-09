# App Branding & Design System

Standards for all Kinetic Platform console apps (HTML single-page applications). Every app in `apps/` must follow these conventions to maintain visual consistency across the platform.

See also: `reports/reports.md` for HTML report standards (same color palette, different component patterns).

---

## Color Palette

### Core Variables (Required — all apps)

```css
:root {
  --blue: #242F4D;         /* Primary brand, headers, topbar, dark text */
  --blue-light: #2E3B5E;   /* Hover state for blue elements */
  --orange: #F36C24;        /* Primary accent, CTAs, active tabs, highlights */
  --orange-light: #FF8A4C;  /* Hover state for orange elements */
  --green: #34A853;         /* Success, positive, active, low severity */
  --red: #EA4335;           /* Critical, negative, destructive, high severity */
  --yellow: #FBBC04;        /* Warning, caution, medium severity */
  --gray: #5F6368;          /* Secondary text, labels, metadata */
  --light: #F8F9FA;         /* Table headers, light backgrounds */
  --border: #E8EAED;        /* Card borders, dividers, input borders */
  --bg: #F1F3F4;            /* Page background */
  --white: #fff;            /* Card backgrounds, modals */
  --shadow: 0 1px 3px rgba(0,0,0,.12), 0 1px 2px rgba(0,0,0,.08);
  --shadow-lg: 0 4px 12px rgba(0,0,0,.15);
}
```

### Extended Palette (Include when app uses badges, entity colors, or data visualization)

```css
:root {
  --purple: #7B1FA2;       /* Memberships, integrations, secondary entities */
  --teal: #00695C;          /* Teams, system entities, tertiary accent */
  --indigo: #283593;        /* Space-level entities, knowledge, governance */
  --deep-orange: #BF360C;   /* Destructive actions, case/support contexts */
}
```

### Color Roles

| Role | Variable | Hex | Usage |
|------|----------|-----|-------|
| Primary | `--blue` | #242F4D | Topbar, page titles, KPI values, login button (governance-type apps) |
| Accent | `--orange` | #F36C24 | Active nav tabs, primary action buttons, accent bars, input focus rings |
| Success | `--green` | #34A853 | Active badges, positive KPIs, success toasts |
| Danger | `--red` | #EA4335 | Critical badges, error messages, destructive buttons |
| Warning | `--yellow` | #FBBC04 | Medium-severity badges, caution states |
| Muted | `--gray` | #5F6368 | Labels, metadata text, section headings, table headers |
| Surface | `--white` | #fff | Cards, modals, table backgrounds |
| Background | `--bg` | #F1F3F4 | Page body background |

### Badge Colors

Severity badges use background/text pairs for accessibility:

```css
.badge-critical { background: #FDECEA; color: #C62828; }  /* Red */
.badge-high     { background: #FFF3E0; color: #E65100; }  /* Orange */
.badge-medium   { background: #FFF8E1; color: #F9A825; }  /* Yellow */
.badge-low      { background: #E8F5E9; color: #2E7D32; }  /* Green */
.badge-new      { background: #E3F2FD; color: #1565C0; }  /* Blue */
.badge-active   { background: #E8F5E9; color: #2E7D32; }  /* Green */
.badge-closed   { background: #F1F3F4; color: #5F6368; }  /* Gray */
```

---

## Typography

### Font Stack

```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
```

No external fonts. System fonts only.

### Scale

| Element | Size | Weight | Color | Transform |
|---------|------|--------|-------|-----------|
| Login title (`h1`) | 24px | 700 | `--blue` | none |
| Page title | 22px | 700 | `--blue` | none |
| Topbar logo | 18px | 700 | white | none |
| Card heading (`h3`) | 13px | 600 | `--gray` | uppercase |
| Body text | 14px | 400 | #202124 | none |
| Table header (`th`) | 10px | 600 | `--gray` | uppercase, letter-spacing .3px |
| Table data (`td`) | 13px | 400 | inherit | none |
| Badge | 11px | 600 | varies | none |
| KPI value | 26px | 700 | varies | none |
| KPI label | 10px | 600 | `--gray` | uppercase, letter-spacing .5px |
| KPI sub-text | 11px | 400 | `--gray` | none |
| Button | 13px | 600 | varies | none |
| Input label | 12px | 600 | `--gray` | uppercase, letter-spacing .3px |
| Subtitle/metadata | 13px | 400 | `--gray` | none |

---

## Spacing & Radius

| Element | Padding | Border-radius |
|---------|---------|---------------|
| Login box | 40px | 16px |
| Topbar | 0 24px, height 56px | none |
| Console/page content | 24px, max-width 1400px | none |
| Card | 20px | 12px |
| KPI card | 16px | 12px |
| Modal | 28px | 16px |
| Button (standard) | 8px 16px | 8px |
| Button (small) | 4px 10px | 6px |
| Input field | 10px 12px | 8px |
| Badge | 2px 8px | 10px |
| Toast | 12px 24px | 8px |

### Grid Gaps

| Grid | Gap |
|------|-----|
| KPI row | 12px |
| Card grids (2-col, 3-col) | 16px |
| Toolbar items | 8px |
| Subtab buttons | 4px |

---

## Layout

### Page Structure

Every app follows this DOM structure:

```
#login-screen          — visible on load, hidden after login
#app                   — hidden on load, shown after login
  .topbar              — sticky header with logo, nav tabs, user info
  .console             — tab panels (one per major view)
    .page-title
    .page-sub
    .subtabs           — optional inner tab row
    .subtab-panel      — optional inner tab content
    content            — KPI rows, cards, tables, grids
#modal                 — global modal overlay
#toast                 — global toast notification
```

### Z-Index Stack

| Layer | Z-index |
|-------|---------|
| Topbar | 100 |
| Modal overlay | 200 |
| Toast | 300 |

### Responsive Breakpoints

| Width | Behavior |
|-------|----------|
| > 900px | Multi-column grids (2-col, 3-col) |
| <= 900px | All grids collapse to single column |

---

## Components

### Login Screen

```css
#login-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
}
```

- Centered card, 400px wide, 16px border-radius
- Title: app name, 24px, `--blue`
- Subtitle: short description, 13px, `--gray`
- Accent bar: 40px wide, 3px tall, `--orange` (standard apps) or `--red` (governance/admin apps)
- Fields: Server URL (default to `http://localhost:PORT`), Username, Password
- Button: full-width, `--orange` background (standard apps) or `--blue` (governance/admin apps)
- Error message: `--red`, 12px, hidden by default
- Enter key on password field triggers login

### Topbar

```css
.topbar {
  background: var(--blue);
  color: white;
  display: flex;
  align-items: center;
  padding: 0 24px;
  height: 56px;
  position: sticky;
  top: 0;
  z-index: 100;
}
```

- Logo: app name, 18px bold, accent word in `--orange` (or `--red` for governance)
- Nav tabs: `--orange` background when active, transparent otherwise
- User info: right-aligned, display name + logout button
- Logout button: ghost style (border only, no fill)

### Cards

```css
.card {
  background: white;
  border-radius: 12px;
  padding: 20px;
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  margin-bottom: 16px;
}
```

### KPI Row

```css
.kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}
```

Color variants: `.kpi.orange`, `.kpi.green`, `.kpi.red`, `.kpi.yellow`, `.kpi.purple`, `.kpi.teal` change the `.val` color.

### Tables

- Headers: `--light` background, uppercase, 10px, sticky top
- Rows: hover background `#FAFAFA`
- Cell padding: 8px 10px
- Cursor: pointer on clickable rows

### Modals

- Overlay: `rgba(0,0,0,.5)` backdrop, click-outside-to-close
- Content: white, 16px radius, 28px padding, max-width 650px, max-height 85vh with overflow scroll
- Shadow: `--shadow-lg`

### Toast Notifications

- Fixed bottom-center, slides up on show
- Background: `--blue`, white text, 13px bold
- Auto-dismiss after 3 seconds

### Buttons

| Type | Background | Text | Border |
|------|-----------|------|--------|
| Primary | `--orange` | white | none |
| Secondary | `--light` | `--blue` | 1px `--border` |
| Danger | `--red` | white | none |
| Success | `--green` | white | none |

Hover: lighten background (e.g., `--orange-light` for primary).

### Input Focus

```css
input:focus {
  border-color: var(--orange);
  box-shadow: 0 0 0 3px rgba(243,108,36,.1);
}
```

Orange focus ring on all inputs across all apps.

---

## JavaScript Patterns

### API Layer

```js
let API = { url: '', auth: '', user: '', displayName: '' };

async function api(path, opts = {}) {
  const res = await fetch(`${API.url}/app/api/v1${path}`, {
    ...opts,
    headers: {
      'Authorization': `Basic ${API.auth}`,
      'Content-Type': 'application/json',
      ...opts.headers
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}
```

### Login Flow

1. Read Server URL, Username, Password from inputs
2. Set `API.auth = btoa(user + ':' + pass)`
3. Validate with `GET /app/api/v1/me`
4. On success: hide `#login-screen`, show `#app`, set display name
5. On failure: show error in `.error` div
6. Logout: clear API state, reverse visibility, clear password field

### Value Helper

```js
function v(sub, field) { return sub.values?.[field] || ''; }
```

Standard shorthand for extracting field values from submissions.

---

## Server Pattern

Every app uses an identical `server.mjs` — a Node.js HTTP server that:

1. Proxies `/app/*` requests to the Kinetic Platform (HTTPS, with TLS verification disabled for local dev)
2. Handles CORS preflight (`OPTIONS`)
3. Serves static files from the app directory

```js
const PORT = process.env.PORT || XXXX;
const KINETIC = process.env.KINETIC_URL || "https://second.jdsultra1.lan";
```

Each app gets a unique port. See the port registry below.

### Port Registry

| Port | App | Kapps Served |
|------|-----|-------------|
| 3000 | itil | incident, problem, change, service-request |
| 3001 | knowledge | knowledge |
| 3002 | crm | crm |
| 3003 | governance | governance (space-level admin) |
| 3004 | asset-management | asset-management |
| 3005 | casemgmt | case |
| 3006 | catalog | catalog (placeholder) |
| 3007 | sec_ops | sec-ops (Security Operations) |
| 3008 | monitor | workflow monitoring (all kapps) |
| 3009 | kapp_admin | kapp administration (any kapp) |
| 3010 | home | launcher (all kapps) |
| 3011 | base | platform launcher & app proxy |
| 3012 | browser | data browser (any kapp) |
| 3013 | innovation | innovation (proposal intake) |
| 3014 | workflow-builder | workflow builder (visual WebAPI editor) |
| 3015 | school-for-good | SchoolForGood (school management) |
| 3016 | mining_management | mining-ops (Mining Operations) |

Ports 3017+ are available for future apps. Foundation and CMDB do not have dedicated apps yet.

---

## File Conventions

| Convention | Detail |
|------------|--------|
| Location | Each app lives in `apps/{app-name}/` |
| `index.html` | Self-contained SPA. All CSS inline in `<style>`. All JS inline in `<script>`. No external dependencies. |
| `server.mjs` | Node.js proxy server. ES modules. No npm dependencies. |
| `setup.sh` | Optional. Environment config and app startup script. |
| `setup.mjs` | Optional. Creates Kapp/form structure in Kinetic via API. |
| `seed_*.mjs` | Optional. Populates sample/test data. |
| No build step | Apps are static files served by the Node proxy. No bundler, no transpiler. |
| No external CSS/JS | Everything is inline. No CDN links (except Chart.js in reports). |

---

## How Consistency Is Maintained

There is no shared CSS file. Each app embeds its own copy of the `:root` variables and component styles inline in `index.html`. This is intentional — each app is a self-contained single file with zero external dependencies.

To maintain consistency:
1. Copy the `:root` block exactly from this document when creating a new app
2. Use the same component class names and CSS patterns documented here
3. Follow the same DOM structure (login screen > topbar > console panels)
4. Use the same JS patterns (API object, login/logout flow, value helper)

When updating the design system, update this document first, then propagate changes to each app.

---

## Known Compliance Drift (from 2026-03-04 code review)

The following apps deviate from the standards above. Fix when touching these files.

### Topbar Class Names (breaks `injectScripts` Home icon injection)
| App | Issue | Fix |
|-----|-------|-----|
| Clinical Equipment | Uses `.topbar-logo` | Change to `.logo` |
| OG Compliance | Uses `.topbar-logo` | Change to `.logo` |
| Supply Chain | Uses `.topbar-logo` | Change to `.logo` |
| Clinical Equipment | Uses `handleLogout()` | Change to `doLogout()` |

### Component Naming Drift
| App | Issue |
|-----|-------|
| Mining | `.kpi-card` / `.kpi-value` / `.kpi-label` instead of `.kpi` / `.val` / `.label` |
| Mining | `.two-col` instead of `.grid-2` |
| Mining | `.tab-panel` instead of `.console` |
| AtlasLake | `.login-card` instead of `.login-box` |
| AtlasLake | Topbar 52px instead of 56px, card radius 10px instead of 12px |
| SecOps | Active tab uses bottom-border instead of orange background |

### Missing XSS Escaping
Apps that render submission values into `innerHTML` without `esc()`:
ITIL, CRM, Knowledge, AtlasLake, SchoolForGood, Supply Chain (partial).

### Pagination Violations (GOLDEN RULE: limit=25)
| App | Issue |
|-----|-------|
| ITIL | `limit:1000` on all fetches |
| CRM | `limit:1000` on all fetches |
| OG Compliance | `limit:100` in 14+ client-side fetches |
| AgentHub | `limit=100` on runs fetch |
