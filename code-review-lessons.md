# JavaScript Code Review — Lessons Learned

**Date:** 2026-03-04
**Scope:** 32 apps in `apps/`, including frontends (`index.html`), servers (`server.mjs`), and provisioning scripts (`setup.mjs`, `seed.mjs`, `build_indexes.mjs`).

---

## Three Generations of Apps

The codebase shows a clear evolutionary arc. Patterns improved over time but were not backported to earlier apps.

| Aspect | Gen 1 (ITIL, CRM) | Gen 2 (Knowledge, Mining) | Gen 3 (SecOps, Innovation, AgentHub) |
|--------|-------------------|--------------------------|--------------------------------------|
| Data loading | `limit:1000`, all in memory | Hybrid — small data full, large data lazy | `limit=25` with pageToken pagination |
| XSS protection | None | `esc()` added | `esc()` used consistently |
| Error UX | `alert()` | `showToast()` | `showToast()` with parsed error bodies |
| `/me` parsing | `data.user?.username` (wrong) | `me.displayName \|\| me.username` (correct) | Correct + space slug display |
| Pagination UI | None | Manual `prevTokens[]` | `makePager()` factory or structured pager objects |
| Tab switching | Inline onclick, hardcoded arrays | Event delegation + `wireSubtabs()` | `data-tab` attributes, `addEventListener` |
| Badge system | Manual lookup maps | Dynamic class from text | Dynamic or prefix-based (`sev-`, `stat-`) |
| Server pattern | Proxy-only (~70 lines) | Custom API + aggregation | Full BFF with state machines |

### Key Lesson
**When conventions improve, backport to existing apps.** The gap between Gen 1 and Gen 3 creates maintenance confusion — developers reading CRM learn one pattern, then find a different one in SecOps. Prioritize bringing Gen 1 apps up to Gen 3 standards for XSS escaping, pagination, and `/me` parsing.

---

## Frontend Lessons

### 1. XSS Escaping Is Non-Negotiable

**Finding:** ~Half the apps inject submission values directly into `innerHTML` without escaping. Any submission containing `<script>` tags would execute.

**Apps missing `esc()`:** ITIL, CRM, Knowledge, AtlasLake, SchoolForGood, Supply Chain (partial).

**Standard pattern (3 lines):**
```javascript
function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}
```

**Rule:** Every `${value}` inside a template literal that renders to `innerHTML` must be wrapped in `esc()`.

### 2. The `/me` Response Is Flat

**Finding:** ITIL and Knowledge parse the `/me` response as `data.user?.username`, which is wrong. The response is `{username, displayName, ...}` — not nested under a `user` key.

**Wrong:** `data.user?.displayName || user` (always falls back)
**Right:** `data.displayName || data.username || user`

This bug is masked by the fallback but means displayName is never shown in those apps.

### 3. `limit:1000` Must Be Eliminated

**Finding:** ITIL and CRM load all data with `limit:1000` on startup. OG Compliance uses `limit:100` in 14+ places. All violate the project's GOLDEN RULE of 25 submissions per client-side fetch.

**Impact:**
- Works fine for demo data (50-200 records)
- Breaks silently when data grows past the limit (records simply missing from UI)
- Kinetic hard cap is 1000 — data beyond that is invisible
- Single large fetch blocks the UI

**Fix:** Adopt the SecOps/Innovation pagination pattern — `limit=25`, `pageToken` tracking, Prev/Next controls showing "Page N".

### 4. Session Restore Should Validate Credentials

**Finding:** Clinical Equipment and Supply Chain skip credential validation on session restore — if `kinetic_session` exists, they enter the app without confirming the token works. This shows stale UI before the first API call fails.

**Standard pattern:**
```javascript
const sess = sessionStorage.getItem('kinetic_session');
if (sess) {
  const s = JSON.parse(sess);
  // Validate before entering
  const res = await fetch('/app/api/v1/me', { headers: { Authorization: 'Basic ' + s.auth } });
  if (res.ok) { /* enter app */ } else { /* show login */ }
}
```

### 5. State Objects Beat Scattered Variables

**Finding:** SchoolForGood's single `DATA = { stats, sites, members, ... }` object is cleaner than AtlasLake's scattered `dashboardData`, `securityData`, `stewardData`, etc.

**Benefit:** Single object is easier to reset on logout, inspect in devtools, and audit for completeness.

### 6. Toast Implementations Vary Unnecessarily

Three different toast patterns exist:
- Create+append new DOM element each time (ITIL, SecOps)
- Reuse single `#toast` element with `.show` class (Knowledge)
- Create+append with stacking support (AgentHub)

**Standardize on:** Reusable element with severity support (`toast(msg, 'error')` vs `toast(msg)`).

---

## Server-Side Lessons

### 7. The 9,300-Line Monolith Needs Splitting

`base/server.mjs` contains 26 domain handlers in a single file. The routing dispatch block (6 lines) is copy-pasted 26 times. The `vf()` helper is defined 15+ times.

**Fix:** Split into per-domain handler modules. ES module `import()` is a Node.js built-in — no npm dependency needed.

**Potential structure:**
```
base/
  server.mjs          # Core: HTTP server, proxy, routing, injectScripts
  handlers/
    atlas.mjs
    secops.mjs
    mining.mjs
    ...
```

### 8. Route Dispatch Should Be Data-Driven

**Current (repeated 26x):**
```javascript
if (pathname.startsWith("/api/atlas/")) {
  const auth = req.headers["authorization"];
  const handled = await handleAtlasAPI(req, res, pathname, auth);
  if (handled) return;
  jsonResp(res, 404, { error: "Not found" });
  return;
}
```

**Better (once):**
```javascript
const routes = [
  ["/api/atlas/",  handleAtlasAPI],
  ["/api/secops/", handleSecOpsAPI],
  // ...
];
for (const [prefix, handler] of routes) {
  if (pathname.startsWith(prefix)) {
    if (await handler(req, res, pathname, req.headers["authorization"])) return;
    jsonResp(res, 404, { error: "Not found" });
    return;
  }
}
```

### 9. Transition Validation Should Be a Shared Utility

Every domain handler repeats the same transition validation pattern. Extract once:

```javascript
function validateTransition(transitions, currentStatus, newStatus) {
  const allowed = transitions[currentStatus];
  if (!allowed || !allowed.includes(newStatus)) {
    return { valid: false, error: `Cannot transition from "${currentStatus}" to "${newStatus}"` };
  }
  return { valid: true };
}
```

### 10. Log ID Generation Has Race Conditions

`clmLogActivity` and `scrLogActivity` generate IDs by counting existing records. Two concurrent requests produce the same ID. Use `Date.now()` (as `credLogActivity` already does) or UUIDs.

### 11. `collectByQuery` maxPages Is a Performance Trap

`maxPages=8` with `limit=25` means up to 8 sequential API calls (~500ms each = 4s). For dashboard endpoints with known date ranges, a single KQL range query with `limit=200` is faster.

**Reserve `collectByQuery`** for truly unbounded aggregation. Use targeted KQL for bounded queries.

---

## CSS/Design System Lessons

### 12. Topbar Class Names Must Match `injectScripts` Expectations

The base launcher's `injectScripts()` queries `.topbar .logo` to insert the Home icon and `.user-info` for the user menu.

**Apps using `.topbar-logo` instead of `.logo`:** Clinical Equipment, OG Compliance, Supply Chain. These miss the Home icon injection.

**Apps using `handleLogout()` instead of `doLogout()`:** Clinical Equipment. The base launcher cannot override this.

### 13. Component Naming Needs Standardization

Same component, different names across apps:

| Component | Variants Found |
|-----------|---------------|
| Login container | `.login-box`, `.login-card` |
| KPI container | `.kpi-row`, `.kpi-grid` |
| KPI card | `.kpi`, `.kpi-card` |
| KPI value | `.val`, `.kpi-value` |
| KPI label | `.label`, `.lbl`, `.kpi-label` |
| Tab panel | `.console`, `.tab-panel`, `.page` |
| Main content class | `.console.active`, `.tab-panel.active` |

**Standard (per branding.md):** `.kpi-row` > `.kpi` > `.val` / `.label` / `.sub`; tab panels use `.console`.

### 14. Badge Strategy: Dynamic Is Best

Three strategies exist:
- **Manual lookup** (CRM): Explicit map from value to class. Must update both JS map and CSS for new values.
- **Dynamic generation** (Mining, OGC): `badge(text)` → `.badge-{lowercased-dashed}`. Only needs CSS for new values.
- **Prefix-based** (SecOps): `sevBadge()` → `.sev-critical`. Semantic grouping but more functions.

**Recommendation:** Dynamic generation. One function, scales automatically, CSS-only for new values.

---

## Provisioning Script Lessons

### 15. Three-Phase Lifecycle Works Well

`setup.mjs` → `build_indexes.mjs` → `seed.mjs` is consistent and correct. Each phase is idempotent (re-runnable).

### 16. Uniqueness Guard Must Check 400, Not Just 409

Kinetic returns `400` with `{"errorKey":"uniqueness_violation"}`, not `409`. Setup scripts that only catch `e.message.includes("409")` miss the actual error.

**Fix:** `if (e.message.includes("409") || e.message.includes("uniqueness_violation"))`

### 17. Concurrent Seeding Is 10x Faster

Sequential: 1 record at a time. Concurrent: `Promise.all` with batch size 10.

Use concurrent when records don't reference each other (production logs, articles, environmental readings). Use sequential only when later records need IDs from earlier ones (enrollments referencing class IDs).

### 18. Config Variable Naming Is Inconsistent

| Variable | Used By |
|----------|---------|
| `BASE_URL` | CRM |
| `KINETIC` | Mining, Knowledge, most others |
| `USERNAME` | CRM |
| `USER` | Mining, Knowledge |

**Standardize on:** `KINETIC`, `USER`, `PASS` (matches majority).

### 19. Seed Data Should Use `Date.now()` for IDs

Count-based IDs (`LOG-${records.length + 1}`) have race conditions and break if records are deleted. `Date.now()` or `crypto.randomUUID()` are safer.

---

## Security Notes

### 20. Global TLS Bypass Is Too Broad

`NODE_TLS_REJECT_UNAUTHORIZED = "0"` disables certificate verification for ALL outbound connections, including user-supplied scan URLs in Atlas. Consider per-request TLS configuration via `https.Agent({ rejectUnauthorized: false })` applied only to known Kinetic backend calls.

### 21. CORS Is Fully Open

`Access-Control-Allow-Origin: *` on every response. Combined with Basic auth passthrough, any page can make authenticated Kinetic API requests if the user has a session. Acceptable for development; would need origin restriction in production.

### 22. AgentHub Stores Plaintext Passwords

`localStorage.setItem('ah_pass', pass)` — the only app that stores the raw password instead of the base64 auth token. Should be changed to match the standard `btoa(user + ':' + pass)` pattern.

---

## Dead Code Found

| Location | Dead Code | Notes |
|----------|----------|-------|
| ITIL `index.html` | `WF` state object, `switchSubtab()` function | Workflow tab was removed |
| ITIL `index.html` | `Math.random()` management metrics | Fake data, changes on every render |
| `base/server.mjs` | `collectSchool()` function | Wraps `collectByQuery` in unused loop, never called |
| AtlasLake `server.mjs` | `computeRisk()` function | Defined but never called |

---

## Priority Actions

1. **Backport `esc()` to ITIL, CRM, Knowledge, AtlasLake, SchoolForGood, Supply Chain** — XSS fix
2. **Fix ITIL and CRM `limit:1000`** → proper pagination — golden rule compliance
3. **Fix `/me` parsing in ITIL and Knowledge** — display name bug
4. **Fix topbar class names** (`.topbar-logo` → `.logo`) in Clinical Equipment, OGC, Supply Chain
5. **Fix `handleLogout()` → `doLogout()`** in Clinical Equipment
6. **Split `base/server.mjs`** into per-domain handler modules
7. **Remove dead code** across 4 locations identified above
