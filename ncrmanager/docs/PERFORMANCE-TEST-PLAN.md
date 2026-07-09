# Performance Test Plan

## Targets
- **Users:** 10,000 active, 100,000 supported (named).
- **Data:** millions of submissions; large evidence collections; 12 sites, global.
- **UX latency:** list page < 1s P95; record-360 drawer < 1.5s P95; dashboard tiles < 3s P95 (cached).

## Design principles already in place
- **Indexed, selective KQL** — every filter field is indexed; compound indexes for common pairs.
- **25-record client pages** — no client ever loads more than one page; keyset/cursor paging only.
- **Bounded server aggregation** — dashboard collects are page-bounded and de-duplicated, then cached
  5 minutes with in-flight de-duplication.
- **No N+1 in lists** — list rows render from one query; record-360 fans out a fixed, bounded set of
  indexed queries (not per-row calls).
- **Append-only history not loaded in lists** — audit trail is queried only inside a record drawer,
  filtered by `Record Type + Record ID` (compound index).

## Test scenarios
| # | Scenario | Load | Pass criteria |
|---|---|---|---|
| P-1 | Module list filtered query | 500 rps, 5M-row form | P95 < 800ms; 0 errors; constant memory |
| P-2 | Record-360 fan-out | 100 rps | P95 < 1.5s; query count fixed regardless of links |
| P-3 | Dashboard cold vs warm | 50 concurrent | cold < 8s, warm (cached) < 500ms; single upstream burst (in-flight dedup) |
| P-4 | Web API list pagination | 200 rps, deep pages | stable latency across pages; no growth from token depth |
| P-5 | Idempotent intake | 100 rps with replays | replays return cached result; no duplicate submissions |
| P-6 | Concurrent edits + audit trail | 50 rps writes | each write yields exactly one trail entry per changed field; no lost updates |
| P-7 | Escalation/timer sweep (workflow) | 1M open records | scheduled job completes within window; no UI impact |
| P-8 | Soak | 24h at 30% peak | no memory growth, no connection leak, stable latency |

## Instrumentation
- Correlation IDs end-to-end; capture per-endpoint P50/P95/P99 and upstream Kinetic query counts.
- Track cache hit ratio on `/dashboard` and `/v1/metrics`.
- Assert query plans use indexes (no full submission scans) via platform query metrics.

## Scaling levers
- Raise/lower dashboard collect `maxPages` per form size; push >N-page analytics to the data-platform
  integration rather than the live dashboard.
- Add compound indexes for any new high-cardinality filter pair before enabling it in the UI.
- Horizontally scale the app server (stateless except the in-memory cache; safe to run N replicas —
  cache is per-replica and short-TTL).

## Exit criteria
All scenarios meet pass criteria at target load for two consecutive runs; soak shows no degradation;
no unindexed scans observed. Results recorded as PQ evidence in `VALIDATION-PACKAGE.md` §4.
