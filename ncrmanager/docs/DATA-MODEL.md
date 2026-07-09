# Data Model & Relationship Catalog

19 governed forms in kapp `ncrmanager`. Each record carries a human-readable **business ID** (the
prefix scheme below) in addition to its Kinetic submission UUID. Cross-links are stored as business
IDs (e.g. a CAPA's `Linked Complaint = "CMP-0001"`), so records reference authoritative IDs rather
than copying data. Where historical integrity requires it (e.g. quantity affected, MRB decision) a
snapshot value is stored on the record itself.

## Numbering scheme (configurable)

| Prefix | Record | Form slug | ID field |
|---|---|---|---|
| `QE` | Quality Event | `quality-events` | Event ID |
| `NC` | Nonconformance | `nonconformances` | NC ID |
| `CAPA` | CAPA | `capas` | CAPA ID |
| `CAPA-…-A#` | CAPA Action | `capa-actions` | Action ID |
| `CMP` | Complaint | `complaints` | Complaint ID |
| `AUD` | Audit | `audits` | Audit ID |
| `FND` | Audit Finding | `audit-findings` | Finding ID |
| `DOC` | Document | `documents` | Document ID |
| `CHG` | Change Request | `change-requests` | Change ID |
| `TRN` | Training Record | `training-records` | Training ID |
| `SUP` | Supplier | `suppliers` | Supplier ID |
| `SCAR` | SCAR | `scars` | SCAR ID |
| `RSK` | Risk | `risks` | Risk ID |
| `PRD` | Product (DMR) | `products` | Product ID |
| `EQP` | Equipment | `equipment` | Equipment ID |
| `SITE` | Site | `sites` | Site ID |
| `MR` | Management Review | `mgmt-reviews` | Review ID |
| `SIG` | E-Signature | `esignatures` | Signature ID |
| `AT` | Audit Trail entry | `audit-trail` | Entry ID |

## Module groups

- **Master data:** `sites`, `products`, `suppliers`, `equipment`
- **Intake & investigation:** `quality-events`, `nonconformances`, `capas`, `capa-actions`, `complaints`
- **Audit:** `audits`, `audit-findings`
- **Document control:** `documents`, `change-requests`
- **People:** `training-records`
- **Supplier quality:** `scars` (+ `suppliers`)
- **Risk:** `risks`
- **Governance:** `mgmt-reviews`
- **Compliance substrate (append-only):** `audit-trail`, `esignatures`

## Relationship graph (link fields)

Arrows point from the record that *holds* the reference to the record it references. The server's
record-360 endpoint resolves these **forward** and scans the same fields **in reverse** to build the
full neighborhood for any record.

```
complaints ──Linked Risk──▶ risks
complaints ──Linked Event──▶ quality-events
complaints ──Linked CAPA──▶ capas
complaints ──Duplicate Of──▶ complaints
quality-events ──Linked NC──▶ nonconformances
quality-events ──Linked CAPA──▶ capas
quality-events ──Linked Complaint──▶ complaints
quality-events ──Product / Supplier──▶ products / suppliers
nonconformances ──Source Event──▶ quality-events
nonconformances ──Linked CAPA / Linked Complaint──▶ capas / complaints
capas ──Source Event──▶ quality-events
capas ──Linked NC / Complaint / Risk / Change / SCAR──▶ …
capa-actions ──CAPA ID──▶ capas
audit-findings ──Audit ID──▶ audits
audit-findings ──Linked CAPA──▶ capas
audit-findings ──Supplier──▶ suppliers
change-requests ──Linked CAPA / Linked Product / Document──▶ …
training-records ──Linked CAPA / Linked Change / Document──▶ …
scars ──Supplier / Source Event / Linked CAPA──▶ …
risks ──Product / Linked CAPA / Linked Complaint──▶ …
audits ──Supplier / Site──▶ …
audit-trail ──Record ID──▶ (any record)
esignatures ──Record ID──▶ (any record)
```

## Indexing rules applied

- Every field appearing in a KQL filter (Status, Type, Owner, Site, due dates, link/ID fields) has a
  **single** index; common pair-filters (e.g. `Status + Owner`, `Status + Site`, `Status + Risk Level`)
  have **compound** indexes. See `indexes` in `app.json`.
- Append-only forms are indexed on `Record Type` + `Record ID` (compound) so a record's full history
  and signature manifest are a single selective query.

## Data-integrity model

- **No silent overwrite of regulated records.** Edits to records in the *regulated set*
  (`quality-events`, `nonconformances`, `capas`, `complaints`, `audit-findings`, `change-requests`,
  `scars`, `risks`) require a **reason for change**; each changed field is written to `audit-trail`
  with old → new values, actor, timestamp, workflow state and correlation ID.
- **Append-only history.** `audit-trail` and `esignatures` are only ever inserted into, never updated.
- **Snapshots vs references.** Lots, quantities and decisions that must remain historically faithful
  are snapshotted onto the record; everything else is an authoritative ID reference.
