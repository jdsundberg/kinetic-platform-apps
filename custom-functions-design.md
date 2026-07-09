# Design: Eliminating Per-App `server.mjs`

**Goal:** an app is just `app.json` + `index.html` + `seed-data.json`. Custom server code only when genuinely necessary — and with a clear decision rule for where it lives.

**Status:** PROPOSED (2026-06-04). No code changes yet.

---

## 1. Where We Are

- 66 app directories; **44 ship a custom `server.mjs`** (~237 custom endpoints total).
- The launcher auto-mounts `server.mjs` (`apiPrefix` + `handleAPI` exports). It works, but:
  - Every app carries 100–600 lines of near-duplicate node code.
  - Drift: the same patterns are re-implemented with small variations (and small bugs).
  - Fragility: a renamed file silently kills features. *Real incident 2026-06-04 — bike_store's
    `server.mjs` had been renamed `BAKCUP_server.mjs`; History and Edit/save were broken for
    weeks with only a cryptic Safari error to show for it.*
  - Portability: an app with a `server.mjs` can't run against a bare Kinetic space without our
    launcher.

## 2. Endpoint Census (all 44 server.mjs files, June 2026)

| Pattern | Endpoints | What it is | Variance between apps |
|---|---|---|---|
| `transition` | **46** | Status state-machine on a record: validate current status → set new → stamp fields → optionally create follow-on records | Very low — statuses and side-effects differ, logic doesn't |
| `dashboard` / `stats` / `summary` / `compliance` / `financials` | **~70** | Aggregate over `collectByQuery`: counts, sums, group-bys, top-N, recent-N | Low for KPIs; **high** for showcase logic (joins, projections) |
| `search` | 15 | Multi-form / multi-field search orchestration | Low |
| `report` | 11 | Data assembly for reports/PDFs | Medium |
| `save` + `history` (audit) | 5 | Save-with-diff + AI-narrated audit-log write; history read | Near zero — only the record-label field map differs |
| Bespoke verbs | ~25 | Atomic multi-record transactions: asset `transfer`, art-swap `advance-swap`, lunch-tracker `send-feedback`, agent-hub `generate-prompt`, atlas `scan` | **Total** — this is real custom code |

**Conclusion: ~85% of custom endpoint code collapses into four declarative engines. ~15% is genuinely bespoke.**

## 3. Proposed Architecture — Three Tiers

### Tier 1 — Declarative engines in `base/server.mjs`, configured in `app.json`

Base server gains four generic engines. An app opts in by adding a section to `app.json`;
the launcher serves the corresponding `/api/{slug}/…` endpoints with zero app code.

#### 3.1 `audit` engine → `/api/{slug}/save/:form/:id`, `/api/{slug}/history/:form/:id`

```json
"audit": {
  "form": "audit-log",
  "labelFields": { "warehouses": "Code", "products": "SKU",
                   "inventory": ["Warehouse Code", "Product SKU"] }
}
```

Provides exactly what bike_store's server.mjs does today: fetch-before-write, field diff,
templated narration ("john increased Capacity from 3500 to 5200 (+1700) on warehouse DEN"),
audit-log submission, history read with parsed diffs. The narration templates are already
app-agnostic.

#### 3.2 `transitions` engine → `POST /api/{slug}/transition/:form/:id`

```json
"transitions": {
  "work-orders": {
    "statusField": "Status",
    "states": {
      "Open":        { "to": ["In Progress", "Cancelled"] },
      "In Progress": { "to": ["Completed", "Cancelled"] },
      "Completed":   { "onEnter": { "set": { "Completed Date": "$today" } } }
    },
    "log": true
  }
}
```

Collapses 46 endpoints. `onEnter.set` supports `$today`, `$now`, `$user`. An optional
`"create"` side-effect covers the common "write a log/notification record on transition" case.

#### 3.3 `dashboard` engine → `GET /api/{slug}/dashboard`

```json
"dashboard": {
  "kpis": [
    { "name": "openOrders", "form": "orders", "op": "count", "filter": { "Status": ["Open","In Progress"] } },
    { "name": "totalValue", "form": "artworks", "op": "sum", "field": "Appraised Value" },
    { "name": "avgRating",  "form": "feedback", "op": "avg", "field": "Rating" }
  ],
  "groups": [
    { "name": "byStatus", "form": "orders", "by": "Status" },
    { "name": "topOptions", "form": "lunch-orders", "by": "Lunch Option", "top": 10 }
  ],
  "recent": [ { "name": "recentOrders", "form": "orders", "sortBy": "values[Order Date]", "limit": 10 } ]
}
```

**Scope discipline (important):** count / sum / avg / group-by / top-N / recent-N — *and stop*.
Cross-form joins (lunch-tracker allergy conflicts), projections (art-swap 12-month timeline),
and derived entity graphs are explicitly out of scope. The moment this DSL grows conditionals
it has become a worse programming language; bespoke logic goes to Tier 2/3.

#### 3.4 `search` engine → `GET /api/{slug}/search?q=…`

```json
"search": { "targets": [
  { "form": "assets",  "fields": ["Asset Tag", "Serial Number"], "label": "Asset Tag" },
  { "form": "people",  "fields": ["Full Name", "Email"],         "label": "Full Name" }
] }
```

One indexed starts-with/equality query per target (each field must be indexed — install
already enforces index creation), merged and capped at 25 per the Golden Rule.

**Estimated impact of Tier 1:** ~30 of 44 apps lose their `server.mjs` entirely.

### Tier 2 — Platform-native custom functions (Kinetic WebAPIs + trees)

For logic that must be server-side but is *portable business logic* — not launcher plumbing —
the right home is the **Kinetic Platform itself**: a WebAPI backed by a workflow tree,
declared in `app.json` and provisioned at install time exactly like forms and indexes:

```json
"webApis": [
  { "slug": "advance-swap", "method": "POST",
    "tree": "trees/advance-swap.xml" }
]
```

- Install flow gains a step: create WebAPI + PUT tree (through the mandatory validate/put
  gates).
- The app then calls `/app/kapps/{slug}/webApis/advance-swap?timeout=30` directly — **works on
  any Kinetic server with no launcher node code at all.** This is the only tier that makes an
  app fully portable.
- Known costs: tree logic is Ruby/ERB (joins are painful), 30-second synchronous timeout,
  ASCII-only parameter values (see workflow-xml PITFALLS), every install runs the tree gates.
- Good fit: transitions with platform side-effects, integrations (the OneStream/connector
  routines already live here), notification fan-out (lunch-tracker `send-feedback` is 90% a
  tree already — the email-log workflow proved it).

### Tier 3 — `server.mjs` stays as the documented escape hatch

Compute-heavy or join-heavy logic that would be miserable in a tree and dishonest in a DSL:

- lunch-tracker: allergy conflict matrix (3-form join, set intersection per order)
- art-swap: gallery grid + 12-month location projection
- atlas: platform scanning
- agent-hub: prompt generation

Rule of thumb: **if the endpoint reads ≥3 forms and computes a derived structure, it's
Tier 3.** Expectation after Tiers 1–2 land: roughly 8–12 apps keep a (much smaller)
`server.mjs`.

## 4. Decision Rule (for new apps)

```
Does the UI need server-side help at all?            → No  → app.json + index.html + seed only
Is it audit, transition, KPI/group-by, or search?    → Yes → Tier 1 config in app.json
Is it portable business logic / integration / event? → Yes → Tier 2 WebAPI + tree in app.json
Else (joins, projections, heavy compute)             →       Tier 3 server.mjs (justify in header comment)
```

## 5. Migration Plan (when approved)

1. **Phase 1 — audit + transitions engines** (51 endpoints, near-zero variance). Build in
   `base/server.mjs`, port bike_store + one transition-heavy app (capital_assets) as proof,
   verify with Playwright, then sweep.
2. **Phase 2 — dashboard + search engines.** Port the simple half of the dashboards; leave
   showcase dashboards in place.
3. **Phase 3 — WebAPI provisioning in app.json** (install-flow change + gates integration).
   Port one bespoke verb (asset-tracker `transfer`) end-to-end as the reference.
4. Each phase: convert, test every tab (per testing rules), delete the app's server.mjs only
   after its replacement is verified with real data.

## 6. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Dashboard DSL scope creep | Hard rule in §3.3 — five operations, no conditionals, no joins. Reviewers reject additions. |
| Tier 1 engines become a single point of failure | They replace 190 copies of the same code with 1 tested copy; add a base-server test suite before the sweep. |
| Tier 2 trees are harder to debug than node code | Gates + `/runs/{id}/tasks` debugging are established; keep Tier 2 for genuinely platform-shaped logic only. |
| Hidden behavioral drift during ports | Port = endpoint-for-endpoint diff of JSON responses against the old server before deletion. |

## 7. Open Questions

- Should Tier 1 engine responses be cache-wrapped by default (the 5-min aggregation cache
  pattern), or opt-in per app.json?
- Does `transitions.create` (follow-on record) cover enough of the 46, or do some need a
  Tier 2 tree? (Audit during Phase 1.)
- Install-time WebAPI provisioning needs a story for *updating* trees on reinstall
  (versionId handling).
