# Web API Documentation

Two surfaces are exposed under the app's `apiPrefix` (`/api/ncrmanager`):

1. **Internal aggregation/UX endpoints** — power the dashboards and record-360 drawer.
2. **Versioned external Web API (`/v1/*`)** — the stable integration contract.

All endpoints require HTTP Basic auth (the platform session). Every response carries a
`correlationId`; clients may supply `X-Correlation-Id` to propagate their own. Errors use a stable
envelope:

```json
{ "error": { "code": "validation_error", "message": "Title is required", "correlationId": "COR-…" } }
```

Aggregation endpoints read submissions server-side with bounded, de-duplicated pagination and a 5-minute
cache; **no client ever loads more than 25 records per page** (Golden Rule). Index-backed KQL filters
run server-side before paging.

---

## Versioned Web API — `/api/ncrmanager/v1`

### `GET /v1/quality-events` · `/v1/capas` · `/v1/complaints` · `/v1/suppliers`
Paginated, filterable list of governed records.

**Query params**
| Param | Notes |
|---|---|
| `limit` | 1–100 (default 25) |
| `pageToken` | opaque cursor from a previous response |
| filter fields | per resource — spaces as `_` (e.g. `Risk_Class=Critical`, `Status=Closed`) |

Filterable fields: events `Status,Type,Severity,Site,Owner` · capas `Status,Type,Risk_Level,Site,Owner`
· complaints `Status,Reportable,Product,Owner` · suppliers `Approval_Status,Risk_Class,Category,Country`.

**Example**
```bash
curl -u user:pass \
  "$HOST/api/ncrmanager/v1/quality-events?Status=Closed&limit=3"
```
```json
{
  "apiVersion": "1.0",
  "correlationId": "COR-mqws…",
  "data": [
    { "id": "ac8b…", "businessId": "QE-0064", "createdAt": "2026-06-27T19:52:…",
      "updatedAt": "…", "values": { "Event ID": "QE-0064", "Title": "…", "Status": "Closed", … } }
  ],
  "pagination": { "limit": 3, "nextPageToken": "eyJ…" }
}
```

### `POST /v1/quality-events` — idempotent intake
Create a quality event from an external system (MES, portal, etc.).

**Headers:** `Idempotency-Key: <uuid>` (replays return the original result).
**Body:** any event fields; `Title` required. `Event ID`, `Status`, `Source`, `Reported Date`
defaulted if omitted.

```bash
curl -u user:pass -X POST "$HOST/api/ncrmanager/v1/quality-events" \
  -H "Idempotency-Key: 9f1c-…" -H "Content-Type: application/json" \
  -d '{"Title":"MES process excursion line 4","Type":"Deviation","Severity":"High","Site":"Plymouth MN"}'
```
```json
{ "apiVersion":"1.0", "correlationId":"COR-…", "id":"b21d…", "businessId":"QE-EXT-…", "status":"created" }
```
Returns `201 Created`. Invalid payloads return `400 validation_error`.

### `GET /v1/metrics`
QMS metrics contract for external dashboards / data platform.
```json
{ "apiVersion":"1.0", "correlationId":"COR-…", "generatedAt":"2026-06-27T00:00:00.000Z",
  "metrics": { "openCapas":18, "overdueCapas":13, "effectivenessFailed":6, "openComplaints":23,
               "reportableOpen":6, "openScars":13, "trainingCompliancePct":54 } }
```

---

## Internal aggregation / UX endpoints

### `GET /dashboard`
Executive QMS rollup: KPIs (open/overdue per module, CAPA aging & cycle time, effectiveness failures,
reportable-overdue, training & calibration compliance, high risks), grouped breakdowns
(events by type/site, CAPA by status/source, complaints by product, findings by class, risks by level),
worst-performing suppliers and an overdue priority queue. Every metric carries the keys needed to
**drill into the underlying governed records**.

### `GET /mywork?user=<displayName>`
Personal queue across CAPAs, events, NCs, complaints, findings, changes, SCARs owned by `user`, split
into overdue vs open, with per-type counts. Powers the *My Work* home and the "View as" persona switch.

### `GET /record360/:form/:submissionId`
Traceability for one record:
- `record`, `businessId`, `label`
- `graph`: `{ nodes:[{id,type,label,status,form,subId}], edges:[{from,to,rel}] }` (forward + reverse links)
- `related`: resolved neighbor records (deep-linkable)
- `actions`: CAPA action plan (for CAPAs)
- `timeline`: append-only `audit-trail` entries, newest first
- `signatures`: `esignatures` manifest for the record

```bash
curl -u user:pass "$HOST/api/ncrmanager/record360/capas/<subId>"
```

---

## Webhooks (design)
Major lifecycle events publish to configured subscribers via Kinetic webhooks: `event.created`,
`nc.disposition`, `capa.statusChanged`, `capa.closed`, `complaint.reportable`, `scar.escalated`,
`change.effective`, `audit.finding.raised`, `training.overdue`. Payloads include the business ID,
new state, actor and correlation ID.

## Conventions
- **Versioning:** breaking changes ship under a new path segment (`/v2`); `apiVersion` echoed in body.
- **Idempotency:** mutation endpoints honor `Idempotency-Key`.
- **Pagination:** cursor (`pageToken`) or business keyset (`createdAt`); never unbounded scans.
- **Correlation:** `X-Correlation-Id` in, `correlationId` out, logged to `audit-trail`.
- **Errors:** stable `{error:{code,message,correlationId}}`; HTTP status reflects the class.
- **Rate / payload protection (design):** per-key rate limits and max payload size at the gateway.
