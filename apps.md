# Session Persistence Across Tabs — Strategy

**Problem:** By default, browser tabs don't share `sessionStorage`. If auth lives only in `sessionStorage`, opening a record link in a new tab, shift-clicking, or middle-clicking forces another login. Nobody wants to log in every time they open a tab.

**Solution:** Mirror the session to `localStorage` on write, hydrate `sessionStorage` from `localStorage` on page load. New tabs pick up the most recent login automatically. Existing page code using `sessionStorage.getItem(...)` keeps working unchanged.

This pattern was established in `/apps/base` and should be used by every Kinetic Platform single-page app in this workspace.

## The contract

| Storage | Lifetime | Scope | Purpose |
|---|---|---|---|
| `sessionStorage` | until tab closes | one tab | primary read location — pages already use this |
| `localStorage` | until explicit clear | all tabs, same origin | mirror — used only to hydrate new tabs |

## The two paths

### Option A — `apps/base/index.html` (explicit, verbose)
Each auth touchpoint writes both stores:

```js
// on login
sessionStorage.setItem('base_session', JSON.stringify(API));
localStorage.setItem('base_session', JSON.stringify(API));

// on boot
let saved = sessionStorage.getItem('base_session');
if (!saved) {
  saved = localStorage.getItem('base_session');
  if (saved) sessionStorage.setItem('base_session', saved);  // rehydrate
}

// on logout
sessionStorage.removeItem('base_session');
localStorage.removeItem('base_session');
```

Good when you control all the auth code. Explicit.

### Option B — `phoenix/base/session.js` (transparent, zero-touch)
A single shared script proxies `sessionStorage.setItem` / `removeItem` for the session key:

```js
// phoenix/base/session.js (loaded on every page via server-side injection)
(function () {
  const KEY = 'phoenix_session';
  // Hydrate on load
  if (!sessionStorage.getItem(KEY)) {
    const ls = localStorage.getItem(KEY);
    if (ls) sessionStorage.setItem(KEY, ls);
  }
  // Mirror writes
  const origSet = sessionStorage.setItem.bind(sessionStorage);
  const origRemove = sessionStorage.removeItem.bind(sessionStorage);
  sessionStorage.setItem = function (k, v) {
    origSet(k, v);
    if (k === KEY) localStorage.setItem(KEY, v);
  };
  sessionStorage.removeItem = function (k) {
    origRemove(k);
    if (k === KEY) localStorage.removeItem(KEY);
  };
})();
```

Server-side inject it in the HTML:
```js
function injectSession(html) {
  return html.replace("</head>", `<script src="/base/session.js"></script></head>`);
}
```

Good when you have 10+ pages already written with inline `sessionStorage` calls and retrofitting each is expensive. Zero code changes to existing pages.

## When to use which

- **New app, small (≤3 pages):** Option A. Just be disciplined about writing to both.
- **Existing app with many pages:** Option B. One file, server injects it, pages don't change.
- **Multi-app launcher (like `/apps/` or `/phoenix/`):** Option B at the launcher level, so every sub-app inherits the behavior via `injectSession(html)`.

## Gotchas

1. **Write to `localStorage` AFTER `sessionStorage` in Option A.** If `localStorage.setItem` throws (private browsing, quota exceeded), at least sessionStorage still has the session.
2. **Logout must clear both.** A logout that only clears sessionStorage leaves localStorage as a time-bomb — next new tab re-authenticates from the stale session.
3. **Don't mirror PII by accident.** Only mirror the session blob (contains base64 auth + displayName). Don't mirror arbitrary key-value pairs.
4. **Storage events fire across tabs.** If you want tabs to react to logout in another tab (force-log-out), add a `window.addEventListener('storage', ...)` handler.
5. **CSRF tokens don't belong here.** Session persistence ≠ CSRF. If you need CSRF tokens, fetch them per-page-load from the server.

## Why not just use `localStorage` everywhere?
- `localStorage` persists across browser restarts. Some teams want auth to expire when the browser closes (sessionStorage behavior).
- The dual-store pattern gives you both: tab-close safety (sessionStorage is primary) AND new-tab inheritance (localStorage fallback).

## Reference implementations

- `apps/base/index.html` — Option A (explicit)
- `phoenix/base/session.js` + `phoenix/base/server.mjs` `injectSession()` — Option B (transparent)
