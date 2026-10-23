# Operational Workflows

Legend for "where": **K-WebAPI** = Kinetic WebAPI tree (Ruby) · **K-WF** = Kinetic form workflow · **SVC** = NOC service (`server.mjs` / `engine/*`) · **NEW** = component that does not exist yet (designed, not built).
Every workflow is **safe to retry**: creates use deterministic business IDs guarded by unique `[Tenant ID, <ID>]` indexes (a replay returns `uniqueness_violation` → treated as "already done"); updates are idempotent field sets; state transitions are whitelisted and re-checked on the server.

---

## 1. Event ingestion & normalization — **K-WebAPI `ingest-event`** ✅ implemented, tested live

```
            ┌──────── unscoped (no/malformed tenant) ─────────────▶ 400 (nothing stored)
            ├──────── forbidden (caller ≠ int.<tenant>/admin) ────▶ 403 (nothing stored)
 received ──┼──────── invalid (schema/time) ──▶ raw Rejected ─────▶ 422 (dead-letter, queryable)
            ├──────── duplicate (idempotency key seen) ───────────▶ 200 duplicate
            └──────── accepted ──▶ raw Accepted ──┬─ unique-index race ─▶ 200 duplicate
                                                  ├─ new     → alarm Active ─┐
                                                  ├─ repeat  → count+1       ├─▶ raw Normalized ─▶ 202
                                                  ├─ clear   → alarm Cleared ┘
                                                  └─ orphan-clear → raw Normalized (note) ─▶ 202  (repaired by correlator)
```
Decision points: caller/tenant binding; severity map (unknown → Indeterminate + note); condition map (unknown → `UNKNOWN`); late (> 120 s) flagged, not rejected; future skew (> 120 s) clamped to receipt time; resource resolution exact → alias → parent NE → unmatched (kept, flagged). Failure paths: Core write fails → run errors, raw stays `Accepted` → **designed** sweeper re-drives raws stuck in Accepted > 2 min (NEW). Throughput limit measured: ~1.3 events/s at 8 concurrent callers (see test results) → **NEW: batch envelope** (array of events per call, loop in Ruby) for production storm rates.

## 2. Alarm deduplication & correlation — dedup in **K-WebAPI**, correlation in **SVC** ✅

Dedup: fingerprint = `tenant | resolved Resource ID (or ref:<raw>) | canonical Alarm Type`; while an instance is Active, repeats (resyncs, second sources) update count / last-seen / source list. Correlation (`runCorrelation`):
1. **Settle**: skip while the newest uncorrelated alarm is < 15 s old (storm still arriving) — timer.
2. **Suppress**: alarm on a resource (or its parent) in scope of a change that is In Progress/Scheduled/Approved with `Suppress Alarms = Yes` and inside its window → `Suppressed` (kept, visible).
3. **Join**: uncorrelated alarms explained by an *open* group's root → join it (late / out-of-order arrivals).
4. **Root cover**: repeat {pick candidate explaining the most remaining alarms; tie → smallest downstream}; explanation uses the alarm's resource **or** its related resource (X2 neighbours); protection events join when their dependents are left at-risk. Groups < 2 alarms → alarms marked `Independent`.
5. **Repair**: active alarms with a later orphan clear on the same fingerprint → Cleared.
Failure path: any write failure is counted in the run summary; re-running is idempotent (deterministic group/incident IDs).

## 3. Root resource identification — **SVC** ✅
Confidence model (shown with its basis on the group and incident): direct SA alarm on the candidate 0.95 · passive element (span) with LOS on **both** terminating ports within 10 s 0.92 (≤ 0.8 if spread > 10 s) · one-sided LOS 0.6 · common-ancestor only 0.55 · −0.03 if low-confidence/disputed edges are involved. Top-5 alternative candidates kept as evidence. The **observed** root cause is a separate human action.

## 4. Service & customer impact calculation — **SVC** ✅
Graph *as of incident Detected At* → `propagate` (down / at-risk; redundancy groups OR, mandatory AND; fixpoint for cycles) → service instances → **Confirmed / Inferred / Potential** (definitions in blueprint) → active subscriptions at that time → accounts → SLA exposure (allowed downtime from target %, credits per started hour over allowance, capped; breach ETA = min(MTTR target, availability budget)). Open reconciliation conflicts touching the path lower confidence and are written into the basis. Priority: P1 if any public-safety account is confirmed/inferred, ≥ 10 000 consumer subscribers, or ≥ 5 accounts; P2 any services down; P3 potential only. Re-runnable (`POST /incidents/:id/impact`) — upserts impact rows; never downgrades an already-verified row's class.

## 5. Incident lifecycle — **SVC** state machine + **K-WF** timer ✅

```
New ──ack──▶ Acknowledged ──▶ In Progress ──▶ Mitigated ──▶ Resolved ──▶ Closed
 │                │               │   ▲            │            │  ▲
 └───────────── Cancelled ◀───────┘   └────────────┘            └──┘ (reopen → In Progress)
```
Creation: correlator only (deterministic ID; attaches to an existing open incident on the same root instead of opening another). Assignment: team by root resource type → on-call primary. **Escalation timer (K-WF "Ack Timer Escalation")**: on create, `system_wait_v1` N minutes (3 in the demo, 10–15 in production) → re-read → still `New` → Escalation Level 1 + timeline + audit. **Major incident**: explicit, reason required → P1, escalation ≥ 2, 30-minute update cadence. Guards: Resolve requires network recovery evidence; Close requires Verification Passed + observed cause (P1/P2) + resolution comms sent (if customers impacted) — enforced by the server **and** by the **K-WF Closure Guard**, which reverts any direct platform write of `State=Closed` without passed verification (tested live).

## 6. Field dispatch & work-order completion — **SVC** + **K-WF** ✅

```
Draft ──(Operator approves: dispatch)──▶ Dispatched ──tech──▶ Accepted ──▶ En Route ──▶ On Site ──▶ Work Complete ──NOC──▶ Verified
  └──────────────────────── Cancelled ◀──────────────────────────────────────────────────┘      (Work Complete ──▶ On Site: rework)
```
Draft is created by an operator (or suggested by AI — never dispatched by it). Dispatch approval reserves parts and **fails closed** on insufficient stock. Tech steps only by the *assigned* tech. Completion requires findings, notes and ≥ 1 evidence item. **K-WF "Field Completion"** → incident Verification State `Pending` (+ Mitigated At) and timeline — idempotent (`UPD-<WO>-COMPLETE`). WFM integration is not configured in the pilot (Kinetic is system of record; integration health shows *Not Configured*).

## 7. Customer communication approval & delivery — **SVC** + **K-WF** ✅

```
Draft ──submit──▶ Pending Approval ──Service Owner approve (≠ drafter)──▶ Approved ──K-WF──▶ Sent
                        └──reject (reason)──▶ Rejected ──edit/submit──┘                    └─▶ Failed (designed)
```
Audience = accounts with Confirmed/Inferred impact → contacts by `Notify On`; consumer segments → status page; Potential accounts deliberately **not** notified (recorded in Audience). Draft text is generated customer-safe (no internal IDs, no cause speculation). **K-WF "Deliver Approved Notification"**: Status Sent + delivery results + incident Comms State + next-update due + timeline + audit. Delivery channel is **simulated** (notify-gw not configured) — the result says so explicitly. Production: `system_integration_v1` operation per channel (email/SMS/status page).

## 8. Change risk review & maintenance suppression — **SVC** ✅ (approval workflow designed)
Risk review = propagate the change scope as failed at window start → services down/at-risk, accounts, public-safety, **conflicts with open incidents** (targets already at-risk because an incident removed redundancy → "postpone"). Score 0–100 → Low/Medium/High written back with factors. Suppression is applied during correlation (step 2). Designed (NEW): CAB approval as a Kinetic approval workflow (deferral per approver) and auto-unsuppress + "unexpected impact during change" alert when a suppressed alarm's resource is outside scope.

## 9. Recovery verification & closure — **SVC** + **K-WF guard** ✅
Network recovered = all Root-Evidence alarms cleared (time = last clear). Per impacted service: active SA alarms on its own resources → *Verification Failed*; else latest post-recovery sample per metric (fresh ≤ 20 min) failing → *Failed*, healthy → *Service Verified*; else own service-level alarm observed clearing after recovery → *Verified*; else recorded customer/field confirmation → *Verified*; else Potential rows → verified (no outage); else → *Network Restored* (needs evidence). Overall: Pending / Partial / Failed / Passed. Writes impact recovery states + evidence, incident timestamps, timeline, audit.

## 10. Problem creation & post-incident review — ⚠ partially implemented
Implemented: recurrence detection (AI "Recurrence" suggestion + Executive "recurring failure points"), seeded problem PRB-0012 linked to prior incidents, `Problem ID` on incidents. Designed (NEW): on Close of a P1/P2 or ≥ 2 incidents on one root in 90 days → create/link problem (deterministic `PRB-<root hash>`), PIR task due in 5 business days with template (timeline, MTTA/MTTR, impact, cause, actions), Known Error when workaround documented. Would be a K-WF on `incidents / Submission Updated` (State → Closed).
