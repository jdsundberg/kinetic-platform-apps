# Architecture & Data Flow

## Component view

```mermaid
flowchart LR
  subgraph Sources["Source systems (adapters)"]
    EMS[Optical EMS]:::src; NMS[IP/MPLS NMS]:::src; RAN[RAN OSS]:::src; MOM[Manager-of-managers]:::src; BMS[Power BMS]:::src
    PRB[TWAMP probes / RAN KPIs]:::src; INV[Network + service inventory]:::src; BSS[BSS / CRM]:::src; GIS[GIS]:::src; TKT[Change / ticketing]:::src
  end
  subgraph Kinetic["Kinetic Platform (space first.kinetics.com, kapp telco-noc)"]
    WAPI["WebAPI ingest-event\n(Task engine tree, Ruby ERB)\nvalidate · map severity/condition\nresolve identifiers · idempotency · dedup · clear"]:::k
    FORMS[("31 forms = system of record\nraw-alarms · alarms · correlation-groups · incidents · impacts\nresources · relationships · identifiers · service-instances\nsubscriptions · customers · work-orders · notifications · audit …")]:::k
    WF["Form workflows (Task engine)\nAck-timer escalation (system_wait_v1)\nClosure guard · Field completion\nDeliver approved notification"]:::k
    KSL["KSL security policies\n(tenant + role, per form + WebAPI)"]:::k
  end
  subgraph Svc["NOC service (Node, apps/telco-noc/server.mjs, mounted by the launcher)"]
    COR["Correlator\n(min root cover over time-aware graph)"]:::n
    IMP["Impact engine\n(redundancy-aware propagation, SLA exposure)"]:::n
    VER["Recovery verification"]:::n
    AST["Assistant (rules/v1)\ncitations · fact/inference split"]:::n
    API["/api/noc/* — role + state-machine checks"]:::n
    MET["Metric adapter\n(unit normalization)"]:::n
  end
  UI["index.html — 8 screens\n(Command Center … Executive)"]:::ui
  EMS & NMS & RAN & MOM & BMS -- "POST envelope v1 (int.<tenant>)" --> WAPI
  PRB -- "observations" --> MET --> FORMS
  INV & BSS & GIS & TKT -- "batch sync (deploy/seed.mjs in pilot)" --> FORMS
  WAPI --> FORMS
  FORMS -- "Submission Created/Updated" --> WF --> FORMS
  COR <--> FORMS
  IMP <--> FORMS
  VER <--> FORMS
  AST <--> FORMS
  UI <--> API
  API --> COR & IMP & VER & AST
  classDef src fill:#1e293b,stroke:#64748b,color:#e2e8f0; classDef k fill:#0b3a5b,stroke:#27c4d8,color:#e6f6ff; classDef n fill:#3b2a0b,stroke:#f2a93b,color:#fff3dc; classDef ui fill:#2a1f4a,stroke:#a78bfa,color:#efe9ff
```

## The vertical slice, as data flow

```
source event ──POST /app/kapps/telco-noc/webApis/ingest-event (Basic int.<tenant>; policy "NOC Integration")
   │   Ruby: schema check → tenant/caller binding → severity map → condition map (X.733) → timestamp checks (late / skew clamp)
   │         → identifier resolution (exact → alias → parent/NE) → fingerprint → idempotency lookup → active-instance lookup
   ├─ invalid  → raw-alarms (Rejected, reason)                                  → 422
   ├─ duplicate (same tenant|source|sourceEventId)                                → 200 duplicate
   └─ accepted → raw-alarms (Accepted; UNIQUE [Tenant, Idempotency Key] = race-proof)
                 → alarms: new instance | repeat (count+1, sources ∪) | clear | orphan-clear (out-of-order; repaired by correlator)
                 → raw-alarms (Normalized)                                     → 202
correlator (every 20 s after the storm settles 15 s, or on demand)
   → maintenance suppression (change window + scope) → join open groups (late arrivals)
   → minimal root cover: candidate = alarmed resources ∪ ancestors; pick max explained, tie → smallest blast radius
   → protection events (APS / microwave switchover) explained when their dependents are left at-risk by the root
   → correlation-groups (evidence, candidates, confidence) → incidents (deterministic ID, auto-assign to on-call)
impact engine (topology AS OF incident detection)
   → propagate down / at-risk with redundancy groups → service instances → active subscriptions → accounts → SLA exposure
   → impacts rows (class, basis, path, confidence) → incident title, priority, counts
operator / owner / tech actions (API; role + state machine) ⇄ Kinetic workflows (timer, guard, field completion, delivery)
verification → per service: SA alarms cleared + fresh healthy measurement | own alarm observed clearing | recorded confirmation
closure → server blockers + Kinetic closure-guard workflow
```

## What runs where — and why

| Concern | Runs in | Why here |
|---|---|---|
| System of record for every entity | **Kinetic forms** (Cassandra-backed Core) | Native CRUD, KQL indexes, KSL security, audit fields, workflow events. |
| Event ingestion + normalization + idempotency + dedup | **Kinetic WebAPI** (Task engine tree, **Ruby** ERB) | The platform's native inbound API; Ruby is the engine's language. Uniqueness is guaranteed by a Core unique index, not by code. |
| Timers, guards, delivery, field completion | **Kinetic form workflows** | Event-driven, auditable in run history, survive service restarts (the ack timer is a durable deferral). |
| Correlation, graph traversal, impact, verification, AI | **NOC service (Node)** | Needs whole-graph, cross-record computation over hundreds of records per run; a Task tree does one handler call per node and has no graph primitives. Node because this repo's app host (`apps/base` launcher) is pure Node (project rule: no npm deps). The engine is pure functions (`engine/core.mjs`) and could be ported to a JRuby handler; it is not, because a handler cannot hold a cached topology between runs and every run would re-read ~1,300 records. |
| UI | Static single file served by the launcher | Project convention; no build step. |

## Key decisions

1. **One resource table + one relationship table** (TMF639/638-style specialization) rather than a form per resource type — traversal code stays generic; type-specific attributes go in `Characteristics`.
2. **Time-aware edges** (`Valid From/To`, never deleted) — impact is computed *as of detection*; historical analysis survives inventory changes (tested: the re-homed circuit).
3. **Redundancy groups on edges** — OR semantics inside a group, AND across groups; gives Potential (at-risk) impact without special cases.
4. **Deterministic IDs + unique indexes everywhere** — every retry (WebAPI, workflow, engine) is idempotent by construction.
5. **Engine writes as a service identity, attributed** — reads for screens use the *user's* credentials so KSL applies; writes are audited with the acting user.
6. **Single correlator per deployment** (`NOC_AUTOCORRELATE=1` on exactly one process).
