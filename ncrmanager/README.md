# Kinetic MedQMS (`ncrmanager`)

A production-grade **Medical-Device Manufacturing Quality Management System** built natively on the
Kinetic Platform. It unifies quality-event intake, nonconformance & material review, CAPA, complaints
& vigilance, audits, document & change control, training, supplier quality, ISO 14971 risk management,
equipment calibration and management review into one cross-linked, auditable system of record.

> **Compliance note.** MedQMS is designed to *help an organization establish, execute, measure and
> demonstrate* its quality processes against ISO 13485:2016, FDA 21 CFR Part 820 QMSR (effective
> 2026-02-02), ISO 14971, 21 CFR Part 11 and EU MDR quality-system expectations. **Software does not
> by itself establish compliance or certification.** All regulatory mappings, retention periods,
> approval rules, electronic-signature meanings and required fields are **configurable and subject to
> customer quality and legal review.**

---

## What's in the box

| File | Purpose |
|---|---|
| `app.json` | Kapp + 19 forms + fields + search indexes (drives install & launcher card) |
| `gen-seed.mjs` | Generates cross-linked Northstar Medical Systems sample data → `seed-data.json` |
| `seed-data.json` | ~890 cross-linked records incl. the full end-to-end showcase scenario |
| `install.mjs` | Provisions kapp → forms → indexes (build + poll) → seed (pure Node) |
| `server.mjs` | Read-side aggregation (dashboard, record-360 traceability) + versioned Web API; auto-discovered by the base launcher **and** runnable standalone on its own port (3021) |
| `index.html` | Single-page operational UI (My Work, analytics, 19 module views, record-360 drawer, e-signature) |
| `docs/` | Data model, role matrix, workflows, regulatory traceability, API, user/admin guides, validation package |

## Architecture (native Kinetic)

- **Kapp** `ncrmanager` — the bounded QMS domain.
- **Forms & submissions** — 19 governed record types (the data model; see `docs/DATA-MODEL.md`).
- **Search indexes** — every field used in a KQL query is indexed in `app.json` (KQL returns empty
  without indexes). System indexes (`handle`, `createdBy`, …) are added automatically.
- **Append-only `audit-trail`** — actor, timestamp, previous/new values, reason-for-change, workflow
  state, source and correlation ID for every regulated change.
- **`esignatures`** — 21 CFR Part 11 manifest: signer, printed name, meaning, reason, record version,
  re-authentication method and a tamper-evident hash, associated with the signed record.
- **Task Engine (design)** — risk-based routing, approvals, timers, escalations, effectiveness reviews
  and integrations are implemented as Kinetic **task trees** (state model in `docs/WORKFLOWS.md`). The
  server holds **no business-process logic** — it only reads and rolls up submissions.
- **KSL (design)** — record/field/role/site-level security and confidential-investigation access
  (`docs/ROLES-AND-SECURITY.md`).
- **Web APIs** — versioned `/api/ncrmanager/v1/*` external contract (`docs/API.md`).

## Deploy & run

### Install onto a space
```bash
node install.mjs https://ai-labs.kinopsdev.io <user> <pass> --seed
```
Creates the kapp, all forms, builds indexes (polls to completion) and loads `seed-data.json`.
Re-running is safe (existing kapp/forms are detected). Regenerate sample data with `node gen-seed.mjs`.

### Serve the app
- **Through the base launcher (recommended):** drop this folder under `apps/` and restart
  `apps/base/server.mjs` (port 3011), or `POST /api/base/rescan`. The launcher auto-discovers
  `app.json` (launcher card + routing at `/ncrmanager/`) and mounts `server.mjs` under `/api/ncrmanager`.
- **Standalone (own port):**
  ```bash
  PORT=3021 KINETIC_URL=https://ai-labs.kinopsdev.io node server.mjs
  ```
  Serves the UI at `http://localhost:3021/`, proxies `/app/*` to the Kinetic space and exposes
  `/api/ncrmanager/*`.

### Sign in
The launcher injects `sessionStorage.kinetic_session`; standalone shows a login box (server URL +
credentials). Use the **View as** persona selector in the top bar to see role-specific *My Work* queues.

## The showcase scenario
A complete, navigable end-to-end chain ships in the seed data — open **CAPA-0001** and use the
relationship graph:

> Complaint **CMP-0001** → Risk **RSK-0001** → Quality Event **QE-0001** → Nonconformance **NC-0001**
> (containment) → **CAPA-0001** (Five Whys + Fault Tree, root cause) → Change **CHG-0001** (firmware +
> SOP) → Training (5 records auto-assigned) → effectiveness check (Passed) → Management Review **MR-2026-Q1** metric.

Every hop is a real record with its own audit trail and (where closed) electronic signatures.

## Verification status
Installed and tested against `https://ai-labs.kinopsdev.io`:
- Dashboard / metrics return real counts (events 63, CAPAs 26, complaints 40, training 85, …).
- Record-360 traces the showcase chain (23 nodes / 22 edges) and supplier reverse-links (SCARs, audits, findings).
- Versioned Web API: filtering, pagination, idempotent intake, stable error envelope.
- Write paths: create → audit-trail entry; edit → field-level diff to audit trail with reason; e-signature with re-authentication.

See `docs/VALIDATION-PACKAGE.md` for the structured validation support package.
