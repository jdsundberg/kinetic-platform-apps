# 9 · Test Results & Demonstrated Limitations

All results below were produced on 2026-09-27 against `https://first.kinetics.com` (Core 7.0.0) with the code in this folder. Raw logs: `tests/e2e-results.json` (last live run).

## Summary

| Suite | What it proves | Result |
|---|---|---|
| `tests/test_norm.rb` (JRuby 9.4) | The **exact Ruby snippet deployed** in the ingest WebAPI: severity/condition mapping, identifier resolution (alias, parent, unmatched), fingerprint, idempotency key, late/skew, invalid/unscoped, duplicate/repeat/clear/orphan-clear, caller↔tenant binding, safety when upstream results are missing | **33/33 pass** |
| `tests/engine.test.mjs` (offline) | Correlation, suppression, late joins, protection events, parent-matched alarms, impact classes vs ground truth, time-aware topology, conflicts, priority, SLA math, verification fail → pass | **16/16 pass** |
| Workflow gate (`validate-workflow.mjs`) | All 5 trees: node-ID/lastID rules, start node, handler paths, installed handlers | **5/5 valid** |
| `deploy/verify-indexes.mjs` + `tests/index-combos.mjs` | Every declared index is Built; every filter combination the screens/engine use returns 200 on the live store | **193 built · 44/44 combos 200** |
| `tests/security.mjs` | Real non-admin users on **direct Kinetic REST** and on the API: tenant isolation (read + modify), PII reader rule, append-only audit, role checks, no tenant switching via header, customer-safe support view, ingest WebAPI policy + per-tenant caller binding | **17/17 pass** |
| `tests/api-smoke.mjs` | Every endpoint behind the 8 screens returns real data; bad credentials → 401 | **18/18 pass** |
| `tests/e2e.mjs` (live vertical slice) | See below | **76/76 pass** (final run: incident `INC-20260927-CC0F`, batch `demo-202609272101`) |
| `tests/ui.mjs` (Playwright, headless Chromium) | 6 role users sign in through the launcher, see exactly their navigation, every tab renders with no JS/console errors, workspace sub-tabs, alarms pager, resource drawer, change risk review; cold deep link shows sign-in | **54/54 pass** (run against open incident `INC-20260927-AB8C`) |

## The fiber-cut scenario, live (final e2e run)

| Stage | Measured |
|---|---|
| Events sent to the WebAPI (5 source systems, as `int.borealis`) | **316** (incl. 10 exact retransmits, 60 resyncs, 13 cross-source MoM duplicates, 1 late, 1 clock-skewed, 2 malformed, 1 unknown severity, 1 unknown AID, 13 unrelated/maintenance) |
| WebAPI outcomes | 163 new · 141 repeat · **10 duplicate (idempotent)** · **2 rejected (422, dead-lettered)** |
| Normalized alarms | **163** (from 306 accepted events) |
| Correlation | **1 group, 156 alarms, root `FIB-MSP-STP-01`, confidence 0.92** (LOS on both terminating ports); 3 suppressed by CHG-4410; 4 independent (Duluth temp, Rochester rectifier, flapping optic) — noise correctly excluded |
| Incidents | **exactly 1**, P1, auto-assigned TEAM-TRANSPORT / on-call `noc.borealis` |
| Impact vs ground truth | Confirmed **15/15**, Inferred **1/1**, Potential **12/12** exact set match; 10 accounts, 1 public-safety account impacted + 1 at risk (911 PSAP on diverse path), 19,583 consumer subscribers; re-homed circuit evaluated on the edge valid at detection with conflict RCN-000001 in its basis |
| Operator path | ack → major → In Progress; illegal transitions refused (400); AI assist 4 kinds, **all citations verified**; accept + reject-with-reason recorded |
| Field | WO drafted; tech cannot approve dispatch (403); operator approval reserves parts (0→2 splice kits); tech flow; completion without evidence refused; **Kinetic workflow** sets verification Pending |
| Comms | AI draft is customer-safe; operator cannot approve (403); service owner approves; **Kinetic workflow** marks Sent, sets incident Comms State, timeline, audit; support agent sees only the approved text |
| Restore (209 events) | Network recovered; **C07 still down → verification Failed**; unmonitored circuit → "needs confirmation"; server refuses close; **direct platform write of State=Closed reverted by the Closure Guard workflow** |
| Reboot + confirmation | Verification **Passed**; Resolution notice refused before verification, drafted/approved/sent after; **incident Closed**; group closed; audit ≥ 8 entries; NL question answered with citations; executive MTTR > 0 |
| Ack timer | Probe incident left unacknowledged → **escalated to level 1 by the Kinetic `system_wait_v1` workflow after 3 min** + timeline entry |

## Bugs found by the tests and fixed during the build

| Found by | Defect | Fix |
|---|---|---|
| installer | TLS failure reported as success (`status 0 < 300`) | explicit 2xx check; private-CA agent |
| API smoke | missing compound index (Incident ID + Correlation Role) → 400 | all filter combinations declared + tested live |
| index verify | **unique indexes never build on populated forms** (platform) | build before seeding; form rebuild path; documented in skills |
| live replay | protection-switch alarms formed a stray group | protection events explained via at-risk dependents |
| e2e | validation errors surfaced as 500 | status passthrough (400/404/409) |
| e2e | replay stamped offset times → 284/306 events "late" | stamp at send time; only the intended event is late |
| e2e | a *Resolution* notice could be drafted (and sent) before verification, with "ongoing" wording | sequence-aware drafting + server refuses Resolution before Passed |
| e2e | index lag right after bulk clears made verification read stale state | verification retried until clears visible (test), documented |
| demo re-run | closing an incident left its correlation group Open → the next outage's alarms joined the closed incident | group closed on incident close; correlator ignores/cleans groups of closed incidents; e2e asserts it |
| UI | chassis-matched OSC LOS left "Independent" | parent-matched alarms explained via part_of children |
| demo reset | timeline/audit rows without batch tag survived reset; reservations never released | reset by incident ID; reservations recomputed |

## Demonstrated limitations (measured, not assumed)

1. **Ingest throughput ≈ 1.3–1.5 events/s** through the WebAPI with 8 parallel callers (316 events in 211–250 s; one run degraded to 41 s/event under engine contention, where some 25 s calls timed out and their retries were correctly deduplicated). A real storm needs the batch envelope + buffering (roadmap 0.1).
2. **Index/replication lag**: queries immediately after bulk writes can return stale field values for a few seconds.
3. **AI is rules/v1**, not an LLM (no model endpoint available); the NL "ask" is an intent matcher over 6 intents.
4. **Notification delivery is simulated** (notify-gw not configured); WFM, ticketing, paging outbound are designed only.
5. **Inventory/BSS/CRM/GIS adapters** are represented by the seed loader's sync contract; no live source systems were connected.
6. **Tenant stamping on create** is not enforced by the platform for Drafts (verified); mitigation designed.
7. **Correlation scope**: single-root cover per group; dual simultaneous failures and SRLG/conduit reasoning are roadmap items. Orphan clears from multi-source reporting (60 in the restore phase) are expected and harmless but noisy in raw logs.
8. **Map** is a schematic projection of site coordinates (no basemap tiles).
9. The shared **:3011 launcher still runs an older `server.mjs`** (with an opt-out correlator) until someone restarts it; all testing used the dedicated :3031 instance.
