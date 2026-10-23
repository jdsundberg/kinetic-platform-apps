# Product Blueprint — Telco NOC on Kinetic

**One sentence:** turn an alarm storm into one owned, explained incident; show exactly which services and customers are hurt and why; drive the fix; and refuse to call it done until customer service — not just the link — is measurably back.

The operator's five questions, and where the product answers each (top of the Incident Workspace):

| Question | Answer shown | Backed by |
|---|---|---|
| **What failed?** | Root resource + *observed* cause (human-confirmed) kept separate from *probable* cause (engine hypothesis, with confidence and basis) | `correlation-groups` (evidence, candidates), `incidents.Observed Root Cause` vs `Probable Cause` |
| **What services and customers are affected?** | Confirmed / Inferred / Potential services, accounts, public-safety flags, consumer subscribers, SLA exposure and breach ETA | `impacts` (one row per service × subscription with path + basis) |
| **Who owns the response?** | Owner, team, on-call, escalation level, ack time | `incidents`, `oncall`, ack-timer workflow |
| **What should we do next?** | Runbook-grounded next steps with approval flags; work order status/ETA | `ai-recommendations` (cited), `runbooks`, `work-orders` |
| **Has service actually recovered?** | Network recovery time vs customer-service verification per service, with the evidence used | verification engine → `impacts.Recovery State` + `Verification Evidence`; closure guard |

## Users

| Persona | What they need | Default screens | Can do (enforced server + KSL) |
|---|---|---|---|
| **NOC operator** (`Operator`) | Correlate, find cause & impact, own, dispatch, verify | Command Center, Incident Workspace, Impact Map, Network, Field, Changes | ack / assign / declare major / transitions / draft WO / approve dispatch / draft comms / verify / confirm cause / AI accept-reject |
| **Service owner** (`Service Owner`) | Availability, SLA exposure, customer impact, recurring problems | Incident Workspace, Customers, Executive, Changes | approve/reject customer comms (never their own draft), risk review, verify |
| **Field technician** (`Field Tech`) | Actionable work: where, access, safety, parts, done-criteria | Field Queue (only their assignments), Incident (read), Map | accept → en route → on site → complete (findings + evidence required) on *their* WO only |
| **Customer support agent** (`Support Agent`) | Approved customer-facing status for an account | Customers | read-only; sees approved/sent notification text only; PII masked; no internal cause/resource IDs |
| **Operations executive** (`Executive`) | Reliability, customer impact, ops performance by region/service | Executive, Command Center, Map | read-only |
| Integration identity (`Integration`) | Push events/metrics for *its own tenant* | — | ingest WebAPI + metrics adapter only |

## Primary screens (all implemented in `index.html`)

1. **NOC Command Center** — KPI strip (open/P1/major/unacked, customers, SLA exposure, active alarms, noise reduction), the *alarm-storm funnel* (raw → normalized → correlated → incidents), priority-sorted incident cards with impact chips, integration health with **observed** freshness, independent alarms, maintenance-suppressed alarms. Auto-refresh 20 s.
2. **Incident Workspace** — the five-question panel; action bar gated by role and state machine; tabs: Services (class, confidence, *why* incl. path + evidence, recovery evidence), Customers (SLA exposure, breach ETA), Alarms (25/page, filter by role/state), Timeline (user/engine/workflow/AI colour-coded), Field work, Comms (draft → approval → delivery), AI assist (facts vs inferences, citations, accept/reject), History (recurrence). Ask box (NL questions, cited).
3. **Service Impact Map** — sites plotted from GIS coordinates; failed span dashed red; sites down / at risk; backhaul lines incl. microwave protect; GIS freshness banner (GIS is *Degraded* in the seed — the map says so and impact classification does not depend on it).
4. **Network Resource View** — paged inventory with provenance (source, last seen, confidence); detail drawer: identifier map, depends-on / dependents with validity windows, retired edges (history), reconciliation conflicts, "what if this fails" impact.
5. **Customer Service View** — accounts with current impact status; detail: approved customer status per incident, services & SLAs, contacts (PII; masked for support). Internal detail only for ops roles.
6. **Change Calendar** — windows on a 12-day timeline, suppression scope, **topology risk review** that also detects conflicts with open incidents ("AGG-STP-02 is already the only path for 6 sites — postpone").
7. **Field Work Queue** — work cards with location (OTDR distance), access, safety, parts + reservation, completion criteria, map link; state buttons per role; completion dialog enforcing findings + evidence.
8. **Executive Dashboard** — open P1, MTTA, MTTR **to verified recovery**, customer-impact account-hours, open SLA exposure, verified-closure ratio; by market, by root-cause type, incident history bars, recurring failure points.

## Definitions the product enforces

| Pair | Distinction | Where it is enforced |
|---|---|---|
| **Event vs alarm vs incident** | *Event*: an immutable fact received from a source (every accepted message → one `raw-alarms` row, keyed by idempotency key). *Alarm*: a condition on a resource with a lifecycle (Active → Cleared), one record per fingerprint instance; repeats increment a count. *Incident*: the operational response to one correlated failure, with an owner, priority and verified closure. | Ingest WebAPI (Ruby) creates events + alarms; only the correlation engine opens incidents. |
| **Physical vs logical vs customer-facing** | *Physical*: fiber span, ROADM, port, router, CSR, power plant (`Resource Class = Physical`). *Logical*: wavelength, OTN link, interface, circuit, cell (`Logical`). *Customer-facing service*: `service-instances` with `Service Class = CFS`, bought via `subscriptions`. | Separate forms/classes; impact is only ever reported on CFS + subscriptions. |
| **Confirmed vs inferred vs potential impact** | *Confirmed*: topology says down **and** direct evidence (SA alarm on the service's own resources, or a failing probe/KPI). *Inferred*: topology says down, no direct evidence (unmonitored). *Potential*: redundancy degraded (at risk) — or topology says down but a fresh healthy measurement contradicts it (flagged as possible inventory error). | `engine/core.mjs assessImpact`; basis text on every row. |
| **Observed vs AI-suggested cause** | *Probable cause*: engine/AI hypothesis with confidence + basis, never displayed as fact. *Observed root cause*: recorded by a person (field finding / diagnostics) with who/when. | Separate fields; P1/P2 cannot close without observed cause. |
| **Network recovery vs confirmed customer recovery** | *Network recovered*: root-evidence alarms cleared. *Service verified*: per impacted service, no active SA alarms **and** a fresh healthy post-recovery measurement (or its own service-level alarm observed clearing, or a recorded customer/field confirmation for unmonitored services). | `verifyRecovery`; incident cannot close unless Verification State = Passed — enforced by the server **and** by a Kinetic workflow guard that reverts direct platform writes. |

## Priorities the design optimises for

- **Fast triage:** one incident, root first, impact classes and public safety visible in the first screen; noise-reduction funnel makes the correlation legible.
- **Trustworthy impact:** every impact row carries its path, basis, confidence and the topology *as of detection*; conflicts between inventories lower confidence visibly instead of silently picking a winner.
- **Clean workflows:** explicit state machines (whitelists), approvals where the prompt demands them (dispatch, customer comms, closure, config changes), append-only timeline + audit.
- **Multi-tenant security:** tenant on every row and every index, KSL policies re-check on the platform, integration identities bound to their own tenant.
- **Resilience to poor data:** unknown severities/conditions accepted with notes; unmatched resources fall back to parent/NE; late, duplicate, out-of-order and clock-skewed events handled; stale/degraded sources shown with observed freshness; missing integrations degrade to Kinetic-as-system-of-record (WFM, notifications) instead of blocking.
