# Administrator Guide

## Installation & environment
```bash
# provision kapp + 19 forms + indexes (+ optional seed)
node install.mjs <serverUrl> <user> <pass> [--seed] [--no-build-wait]
```
- Idempotent: existing kapp/forms are detected and skipped.
- Indexes build asynchronously; the installer polls background jobs to completion (omit with
  `--no-build-wait`). **KQL returns empty until indexes finish building.**
- Regenerate deterministic sample data any time: `node gen-seed.mjs` (writes `seed-data.json`).

### Hosting
- **Via base launcher (port 3011):** drop the folder under `apps/`, restart or `POST /api/base/rescan`.
  Auto-discovery reads `app.json` (launcher card + `/ncrmanager/` route) and mounts `server.mjs` under
  `/api/ncrmanager`. No central registry to edit.
- **Standalone (port 3021):** `PORT=3021 KINETIC_URL=<space> node server.mjs`.

## What administrators configure (no code)
Configuration is metadata-driven through Kapp/Form/Team **attributes** and **KSL** policies. The
**Admin → Configuration** tab lists the shipped defaults; all are customer-configurable:

| Area | Mechanism | Default |
|---|---|---|
| Event types & taxonomies | form field option list | 8 types |
| Risk matrix | attribute (Severity × Probability → Level) | ISO 14971 5×5 |
| Numbering schemes | per-record prefix | QE/NC/CAPA/CMP/… |
| Workflow routing | task-tree config | high-risk → 2-level + independent effectiveness |
| Approval thresholds / signature meanings | attribute + policy | per record class |
| Due-date rules | business-calendar attribute | severity-driven |
| Escalation policy | timer node config | overdue → manager team |
| Investigation methods | option list | 6 methods |
| Disposition choices | option list | Use-As-Is/Rework/Scrap/Return/Concession |
| Root-cause categories | option list | Ishikawa 6M + custom |
| Retention rules | attribute | **set with legal review** |
| Regulatory mappings | attribute | see traceability matrix |
| Required fields | form constraint | per form |
| Site-specific terminology | translation context | per locale/site |
| Dashboard targets | attribute | per metric |
| Notification templates | task handler | email/task |

> Changing field **slugs/names** after go-live breaks indexes and stored links. Add/retire *option
> values* and *attributes* instead; never rename a field that appears in an index or KQL query.

## Security administration
- Assign personas to **Teams** (`Quality::Managers::{Site}`, `Supplier::External::{SupplierId}`, …).
- Apply **KSL** policies for site boundaries, confidential investigations, supplier isolation,
  field-level restrictions and separation of duties (see `ROLES-AND-SECURITY.md`).
- The System Administrator role configures the system but holds **no record-approval authority**.

## Compliance operations
- **Admin → Audit Trail** — append-only regulated change log (actor, time, old→new, reason, correlation).
- **Admin → E-Signatures** — the Part 11 signature manifest (signer, meaning, reason, version, method, hash).
- **Admin → API & Integrations** — the versioned Web API reference, reference integration map, and a
  live "GET /v1/metrics" tester.
- Neither audit-trail nor esignatures records should ever be edited or deleted; restrict write access to
  the platform service identity only.

## Indexing checklist when adding a field
1. Add the field to the form in `app.json`.
2. If it will be used in a KQL filter, add it to that form's `indexes.single` (and a compound index if
   it pairs with Status/Site/Owner).
3. Re-run `install.mjs` (it issues the index build and polls completion).
4. Verify with a filtered query before relying on it in the UI.

## Operational notes
- The dashboard endpoint caches for 5 minutes and de-duplicates concurrent requests; expect up to a
  5-minute lag on aggregate tiles. Record lists and drawers are always live.
- For scale (millions of records) keep dashboard collects bounded, rely on indexed filters, and push
  heavy historical analysis to the data-platform integration rather than the live dashboard.
