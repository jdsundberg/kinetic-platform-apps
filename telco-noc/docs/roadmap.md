# 10 · Roadmap — Pilot to Enterprise

Ordered by what blocks a real NOC pilot first. Effort: S ≤ 1 wk · M 2–4 wk · L 1–3 mo (one engineer-equivalent, rough).

## Phase 0 — Pilot readiness (before any live traffic)

| # | Item | Why | Effort |
|---|---|---|---|
| 0.1 | **Batch ingest** (`events[]` ≤ 200 per call, Ruby loop, per-event results) + collector with back-pressure | Measured 1.3 events/s is far below a storm (thousands/min). Single largest risk. | M |
| 0.2 | **Real adapters** for the operator's 2–3 highest-volume monitors (EMS, NMS, RAN OSS) → envelope v1; identifier-map bootstrap from their inventories | Seed data proves the model, not the mappings | M–L |
| 0.3 | **Inventory sync jobs** (network, discovery, service, BSS/CRM) using the diff-by-key contract; conflicts queue UI for data stewards | Impact is only as good as topology | L |
| 0.4 | **License + capacity**: licensed space; task engine > 1 CPU; Core/Cassandra sizing for ~2k records per incident + retention | CE unlicensed cap is 1,000 submissions | S (ops) |
| 0.5 | **SSO** (SAML/OIDC) and group→`NOC Role` mapping; retire Basic for humans; OAuth client-credentials for integrations | CE ships Basic only | M |
| 0.6 | Fix the space-wide **Bug-5** policy (Kinetic Insights kapp) — non-admin `GET /kapps` is 500 | Other apps' non-admin users are affected today | S |
| 0.7 | Tenant-stamping guard workflow on `Submission Created` (delete/quarantine Drafts with foreign Tenant ID) | Verified create-time gap | S |
| 0.8 | Raw-event re-drive sweeper (raws stuck `Accepted` > 2 min) + dead-letter review screen | Failure path of ingestion | S |

## Phase 1 — Pilot (one region, read-mostly, shadow mode)

- Run correlation/impact in **shadow** next to the existing NOC tooling for 4–6 weeks; score against the eval set (root accuracy ≥ 85%, impact precision ≥ 0.95 / recall ≥ 0.98, zero unsafe AI).
- Build the **historical eval set** from 30–50 closed incidents (alarms + inventory snapshot + ticket + confirmed cause); add the replay harness to CI.
- Outbound integrations: ticketing link (existing `servicenow_connection_v1` handler), paging, notification gateway (`system_integration_v1` ops) — replace the simulated delivery.
- Problem/PIR automation (workflow 10), CAB approval workflow for changes, auto-unsuppress when change scope is exceeded.
- LLM generator behind the existing citation contract (needs model endpoint, key, and a tenant decision on data egress).

## Phase 2 — Production (multi-region, system of engagement)

- Correlation at scale: incremental correlation (per-resource subgraph cache), multi-root incidents (dual failures), SRLG/conduit awareness (shared-risk groups as ancestors), time-windowed grouping for flapping.
- Service KPIs streaming into metrics via a time-series store; Kinetic keeps only verification-relevant samples (retention job).
- Real GIS basemap (tiles) + route geometry for spans; crew location from WFM.
- Customer portal status page fed by approved notifications; per-account subscription to incidents.
- TMF API façade (TMF642 alarms, TMF639/638 inventory, TMF621 trouble tickets) with a verified conformance run (CTK).
- HA: CE is single-node/single-replica → move to the commercial HA deployment (multi-node Cassandra, ≥2 task engines, ingress per KNOWN_ISSUES).

## Phase 3 — Enterprise

- Multi-org tenants (host operator + MVNO/wholesale partners seeing their own slice of shared incidents), data residency per tenant, per-tenant retention/purge jobs, legal hold.
- Predictive: recurring-failure risk scores per span/site feeding change risk and capital planning; SLA-breach forecasting.
- Closed-loop remediation for pre-approved, reversible actions only (e.g. protection switch) — still behind explicit approval + rollback, with the AI eval gate extended to "unsafe action" red-teaming.
