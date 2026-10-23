# Integration Contracts

**Status legend:** ✅ implemented & tested · 🟡 implemented against seed/simulation (real source not connected) · 📐 designed only.

**TM Forum note.** Resource/relationship modelling follows the *shape* of TMF639 (Resource Inventory), TMF638 (Service Inventory), TMF642 (Alarm Management) and TMF688 (Event) — one resource entity specialised by type, characteristic maps, relationship lists, X.733 probable causes. **No conformance is claimed**: I did not verify against the published TMF specifications/CTK in this environment. Mapping tables below show where an adapter would translate; a conformance pass is on the roadmap.

## Inbound

### A. Monitoring events → `POST /app/kapps/{kapp}/webApis/ingest-event?timeout=25` ✅
- **Auth**: HTTP Basic (or Kinetic OAuth token) of an integration identity `int.<tenant>` with user attributes `NOC Tenant=<tenant>`, `NOC Role=Integration`. Platform policy **NOC Integration** (WebAPI Execution) + tree check caller ↔ `tenantId`.
- **Request**: `docs/schemas/event-ingestion.schema.json` (v1.0/1.1; additive minors; unknown fields ignored; major → new slug `ingest-event-v2`).
```json
{ "schemaVersion":"1.0","tenantId":"borealis","source":"optical-ems","sourceEventId":"EMS-771001",
  "eventTime":"2026-09-27T19:04:50Z","resourceRef":"ROADM-MSP-01:OTS-2","condition":"LOS","vendorSeverity":"CR",
  "state":"raise","text":"OTS LOS — no input power (east degree)" }
```
- **Responses**: `202 {status:"accepted",kind:new|repeat|clear|orphan-clear,rawId,alarmId,fingerprint,resourceId,resourceMatch,severity,late,clockSkew,notes[]}` · `200 {status:"duplicate"}` · `422 {status:"rejected",errors[]}` (stored as dead-letter) · `400` unscoped · `401/403` auth · `500 run_results_error` (engine) · timeout if > `timeout` s (max 30 — platform bug #4).
- **Retries**: callers retry on 5xx/timeout with exponential backoff (idempotent by `sourceEventId`); never on 4xx. **Ordering**: partition by `resourceRef|condition` (serial within partition); cross-partition order is not required.
- **Rate**: measured ~1.3 events/s sustained with 8 parallel callers on this space (1 CPU task engine). Production needs the 📐 batch variant (`events[]`, ≤ 200/call) or a Kafka→WebAPI bridge with back-pressure.
- **Webhook vs polling**: sources that can push use this WebAPI (webhook style). Pull-only sources (e.g. BMS SNMP) → 📐 poller in the NOC service that emits the same envelope.

### B. Metrics / probes → `POST /api/noc/ingest/metrics` ✅
`{ tenantId, replayBatch?, observations:[{subject, metric, value, unit, observedAt, source}] }` (≤ 500/call) → unit conversion via `catalog.json` (`ratio→%`, `us→ms`, `Gbps→Mbps`), future timestamps > 2 min marked `Suspect`, deterministic Observation ID (hash of subject/metric/time/source) → duplicates counted not stored. Response `{accepted, duplicates, rejected:[{i,error}]}`. Auth: `Integration` or `Tenant Admin`.

### C. Inventory & topology (network inventory, discovery, service inventory) 🟡
Pilot: `deploy/seed.mjs` performs the batch sync contract — **diff by business key; create missing, update drifted, never delete** (retire = set `Valid To`). 📐 Production adapter (NOC service, nightly + on-change webhook):
- `GET {netinv}/resource?type=…&modifiedSince=…&limit=200&offset=…` (TMF639-like) → `resources` + `identifiers` (every vendor ID / hostname / AID becomes an identifier row).
- `GET {discovery}/links?since=…` → `relationships` with `Source System=discovery-lldp`, `Confidence` from protocol (LLDP 0.9, ISIS 0.95).
- Conflicts: same edge/attribute asserted differently by two sources → `conflicts` row; resolution policy per field: *authority first* (integrations.Authority), then *freshness*; open conflicts lower impact confidence.
- Freshness: `integrations.Last Success At` per run; UI shows age vs `Freshness SLA Minutes`.

### D. OSS/BSS (subscriptions, SLAs), CRM (accounts, contacts) 🟡
Same diff-sync contract. Contacts are PII: synced fields limited to name/role/email/phone/channel/consent; `Notify On` honoured; deletion requests remove the contact row and keep only hashed IDs in audit (📐).

### E. GIS 🟡 (degraded on purpose in the seed)
Sites' Latitude/Longitude/Geo Source; the map shows GIS freshness and a banner when degraded. Impact never depends on GIS.

### F. Change / ticketing 🟡 → `changes`
📐 Webhook from ticketing on change state → upsert by `Change ID`; outbound: incident ↔ ticket link (below).

## Outbound

| Target | Trigger | Contract | Status |
|---|---|---|---|
| Customer notifications (email/SMS/status page) | notification Approved (K-WF) | `system_integration_v1` operation per channel; body = approved text; results → `Delivery Results` | 🟡 simulated (notify-gw *Not Configured*); workflow + audit real |
| Workforce management | WO Dispatched | `POST {wfm}/workorders` (location, access, safety, parts, criteria) → external ID in `External IDs`; status webhook back to `POST /api/noc/work-orders/:id/transition` | 📐 (Kinetic is WFM in pilot) |
| Ticketing (e.g. ServiceNow) | incident created / state change | `POST /api/now/table/incident` via existing `servicenow_connection_v1` handler on this engine; correlation ID = Incident ID | 📐 |
| Paging | Major declared / ack timer | K-WF node → paging API | 📐 |

## NOC service API (for UI and partners)
All under `/api/noc` (see header of `server.mjs`). Auth: the caller's Kinetic Basic credentials (or session via launcher). **Pagination**: every list is ≤ 25/page with Kinetic `pageToken` passthrough (`nextPageToken` in response). **Errors**: `{error, blockers?}` with 400 (validation/state machine), 401 (not signed in), 403 (role/tenant), 404 (not in your tenant — indistinguishable from nonexistent), 500. **Rate limits**: 📐 per-identity token bucket (not implemented). **Timeouts**: Kinetic calls 45 s with 3 retries on 5xx/409/429.
