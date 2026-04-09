# Kinetic Platform Applications

## Overview

Single-page web applications on the Kinetic Platform. Each app is a standalone Node.js server that also runs through the base launcher at port 3011.

- **Architecture & data model:** [app.md](app.md)
- **Branding & design:** [branding.md](branding.md)
- **Test suites:** [kinetic-test-suite.md](kinetic-test-suite.md)
- **MCP gaps:** [mcp-gaps.md](mcp-gaps.md)

## Base Launcher

- `base/server.mjs` on port **3011** — all apps served through here
- `base/index.html` — **Platform Launcher** (the APPS array grid)
- `home/index.html` — **Platform Home** (auto-discovers kapps)

Everything runs through :3011. Standalone server ports are for development only.

## Port Assignments

| Port | App |
|---|---|
| 3011 | Base launcher (all apps) |
| 3012 | ITIL |
| 3013 | Knowledge |
| 3014 | CRM |
| 3015 | Atlas |
| 3016 | SecOps |
| 3017 | OG Compliance |
| 3018 | Space Monitor |
| 3019 | AgentHub |
| **3020** | **Next available** |

## Two App Patterns

- **Simple** (proxy-only, ~60 lines): Just forward requests to Kinetic API
- **Industry** (custom API, 500+ lines): Server-side aggregation, computed endpoints
- Industry apps: sec_ops, mining_management, innovation, school-for-good, og_compliance, agent_hub

## Adding a New App — Three Registration Points

### 1. `base/server.mjs` — Backend routing & API
- **APP_REGISTRY** (~line 16): `"slug": { dir: "dir_name", name: "Display Name", kapp: "kapp-slug" }`
- **Custom API handler**: Add `handleFooAPI(req, res, pathname, auth)` function
- **Route dispatch** (~line 2800+): `if (pathname.startsWith("/api/foo/"))` block
- **APP_ABOUT**: Metadata object with title, overview, kapp, tabs[], entities[], rels[]
- **console.log**: API endpoint listing at the bottom

### 2. `base/index.html` — Platform Launcher card
- **APPS array** (~line 192): `{ slug, name, desc, icon, color, bg }`
  - No flags = **Applications** section
  - `industry: true` = **Industry** section
  - `admin: true` = **Admin Tools** section
- **svgIcon function**: Add SVG if using a new icon name

### 3. `home/index.html` — Platform Home card (optional)
- **APP_META** (~line 199): `{ icon, color, bg, desc }`
- **svgIcon function**: Add SVG if using a new icon name
- Auto-discovers kapps, but without APP_META gets fallback gray puzzle icon

## Auth Pattern

The launcher's `injectScripts()` populates `sessionStorage.kinetic_session`:
```json
{ "url": "", "auth": "base64(user:pass)", "user": "username", "displayName": "Name", "spaceSlug": "slug" }
```

Apps MUST check sessionStorage first, fall back to standalone login:
```javascript
const sess = sessionStorage.getItem('kinetic_session');
if (sess) {
  const s = JSON.parse(sess);
  API = s.url || '';
  AUTH = 'Basic ' + s.auth;
  USERNAME = s.displayName || s.user || '';
  enterApp();
}
```

## File Pattern Per App

```
app_name/
├── setup.mjs      ← Create kapp + forms on Kinetic
├── seed.mjs       ← Populate sample data
├── server.mjs     ← Standalone server + custom API
└── index.html     ← Single-page app (all CSS/JS inline)
```

## GOLDEN RULE: 25 Submissions Per Page Maximum

**NEVER load more than 25 submissions at a time from the client.** Every client-side fetch must use `limit=25` with `pageToken` pagination. Show Prev/Next controls, one page at a time.

- Server-side `collectByQuery()` in `base/server.mjs` is fine for aggregation endpoints
- Client-side must NEVER loop through pages to build in-memory arrays (`collectAll` pattern is banned)
- Use KQL queries with form indexes to filter server-side before the 25-record page fetch

## App Packaging (app.json + server.mjs)

Each app is a self-contained directory that the base server auto-discovers:

```
apps/my-app/
├── app.json          ← Kapp definition: name, slug, forms, fields, indexes
├── seed-data.json    ← Sample data keyed by form slug (optional)
├── index.html        ← Single-page app (all CSS/JS inline)
└── server.mjs        ← Exports: appId, apiPrefix, kapp, handleAPI() (optional)
```

### app.json format
```json
{
  "name": "Display Name",
  "slug": "kapp-slug",
  "description": "What the app does",
  "category": "Healthcare",
  "forms": [
    {
      "slug": "form-slug",
      "name": "Form Name",
      "fields": [{ "name": "Field Name", "required": true, "rows": 3 }],
      "indexes": {
        "single": ["values[Status]", "values[Category]"],
        "compound": [["values[Status]", "values[Category]"]]
      }
    }
  ]
}
```

### server.mjs export format (for apps with custom API endpoints)
```js
export const appId = "kapp-slug";
export const apiPrefix = "/api/prefix";
export const kapp = "kapp-slug";

export async function handleAPI(req, res, pathname, auth, helpers) {
  const { collectByQuery, kineticRequest, jsonResp, readBody, vf } = helpers;
  // Use collect() shorthand — NEVER call collectByQuery directly (it needs kapp as first arg)
  async function collect(formSlug, kql, maxPages = 8) {
    return collectByQuery(kapp, formSlug, kql, auth, maxPages);
  }
  // ... routes ...
}
```

### Critical: collectByQuery signature
- **Base server helpers:** `collectByQuery(kapp, formSlug, kql, auth, maxPages)` — kapp is FIRST arg
- **Inside handleAPI:** always use `collect(formSlug, kql)` shorthand which prepends the kapp
- **NEVER call `collectByQuery("formSlug", ...)` directly** — it will silently query the wrong kapp and return empty results
- This was a systematic bug that broke 19 app dashboards — all returned zeros because kapp was missing

### Install flow
- `node admin_apps/app_manager/install.mjs <server> <user> <pass> <app-dir> [--seed]`
- Or click any uninstalled app in the launcher — admins see an Install button
- Install creates: kapp → forms → indexes (waits for build) → seed data

### Index rules for app.json
- Scan the index.html and server.mjs for all `values[FieldName]` in KQL queries
- Every field used in a KQL query needs an index in app.json
- Field names in indexes must **exactly match** the field names on the form (case-sensitive)
- `values[Type]` ≠ `values[Issue Type]` — this causes 500 errors on index PUT

## Common Mistakes

- **"Platform Launcher" = `base/index.html`** (APPS array), NOT `home/index.html`
- **`collectByQuery` signature differs**: base server takes `(kapp, formSlug, kql, auth)`, standalone takes `(formSlug, kql, auth)`
- Don't assume standalone ports matter — users access everything through :3011
- Custom APIs must be duplicated in `base/server.mjs` for launcher compatibility

## Required Patterns (from code review)

### XSS Escaping — Every App Must Have This
```javascript
function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}
```
Wrap every `${value}` in `esc()` when rendering to `innerHTML`. No exceptions.

### `/me` Response Is Flat
```javascript
// WRONG: data.user?.displayName (nested — doesn't exist)
// RIGHT: data.displayName || data.username
```

### Topbar Must Use Standard Class Names
- Logo class: `.logo` (NOT `.topbar-logo`) — `injectScripts` queries `.topbar .logo`
- Logout function: `doLogout()` (NOT `handleLogout()`) — `injectScripts` overrides `window.doLogout`
- Must include `<div class="spacer">` between nav and user-info

### Value Helper Name
- Client-side: `v(sub, field)`
- Server-side: `vf(s, f)`

## Testing & Verification Rules

### After any server.mjs refactor
1. Test ONE app end-to-end before converting others (load dashboard, verify non-zero data)
2. If you change a function signature, grep for every call site and verify they all pass the right args
3. API returning 200 does NOT mean it works — check the response body has real data

### After installing an app
1. Load the dashboard tab — it must show non-zero KPIs
2. Click every tab — each must load without JS errors
3. Check browser console for `undefined is not an object` or `Cannot read properties` errors

### Playwright test requirements
- Don't check for the word "error" in page text — JS error handlers contain that word
- DO check for: `Error loading`, `undefined is not an object`, `Cannot read properties`, `Failed to load`
- DO verify dashboard KPIs are non-zero (fetch the API endpoint, check response values)
- Take screenshots of failures for debugging

### Never report "done" without
- Loading at least 5 apps manually through the UI
- Verifying dashboards show actual data (not all zeros)
- Clicking every tab in at least 3 industry apps (ones with custom API endpoints)

## Code Review Reference

See [code-review-lessons.md](code-review-lessons.md) for the full review covering:
- Three generations of app patterns and their evolution
- 22 specific lessons learned (XSS, pagination, CSS drift, server patterns, provisioning)
- Priority action items for bringing older apps up to current standards
