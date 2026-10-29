# Kinetic Corporate Brain

Corporate Brain is Kinetic Data's institutional memory. It records companies, people, events, decisions and knowledge, and every historical claim is tied to the evidence behind it and approved by a person before it counts as history. All of its data is stored as Kinetic Platform submissions in the `corporate-brain` kapp. There is no other database.

| | |
|---|---|
| App (launcher on this Mac) | http://ai-labs.kineticdata.com:3011/corporate-brain/ (LAN: http://192.168.86.204:3011/corporate-brain/) |
| Kinetic space | https://ai-labs.kinopsdev.io, kapp `corporate-brain` (27 forms — 12 core + 7 Sales Brain + 8 RFP Intelligence) |
| API prefix | `/api/corporate-brain/*` (served by `server.mjs` through the `:3011` launcher) |
| Live build page | `build/index.html` (also served at http://192.168.86.204:3061/) |

## Definition of Done

| # | Requirement | Status |
|---|---|---|
| 1 | Open Corporate Brain on ai-labs | **Done.** The app is served by the `:3011` launcher and reads and writes the `corporate-brain` kapp on ai-labs.kinopsdev.io. The launcher runs on this Mac, not inside the Kinetic cluster. |
| 2 | Browse companies and people stored in Kinetic | **Done.** Company and People explorers show 25 per page with name-prefix and status/company filters. |
| 3 | View a company's chronological history | **Done.** The company timeline and the Timeline tab show exact, month, year, approximate and unknown dates, each labelled. |
| 4 | Inspect the evidence behind claims | **Done.** You can drill from knowledge to its sources and on to the original in Drive, GitHub or Kinetic. The source view lists every knowledge entry that cites it. |
| 5 | Search without vectors | **Done.** Search uses indexed KQL filters, a name-prefix search (`=*`) and a bounded keyword scan. See `lib/retrieval.mjs`. |
| 6 | Ask the historian, get a source-grounded answer | **Done (extractive).** Every finding cites its knowledge and source IDs. No LLM key is configured, so the answer has no narrative. |
| 7 | Ingest a permitted source record | **Done.** 24 real Google Drive documents were ingested through agent-mediated push. GitHub server pull is also tested. |
| 8 | Review and approve an extracted fact | **Done.** The Review Queue and knowledge detail support approve, reject, dispute, request research and supersede. This is tested in both the UI and the API. |
| 9 | Revisit knowledge in a later session | **Done.** The UI test opens a verified entry in a fresh browser session. |
| 10 | Knowledge persists in Kinetic submissions, not another DB | **Done.** All reads and writes go through Kinetic Core `/app/api/v1` using the caller's credentials. |

## What works end to end
- **Ingestion:** a bounded batch of source records (agent push, or server pull for GitHub and Kinetic) is deduplicated by hashed Source ID. The pipeline resolves company and people, extracts rule-based candidates, and creates proposed knowledge and events. Job counters, checkpoint and errors are tracked.
- **Review:** human approval sets `Verified By` / `Verified At`, appends to `Review History`, writes an audit-log row and updates the events backed by that knowledge. Agents can never verify.
- **Kinetic Task workflows** (live on ai-labs):
  - Verification Guard reverts any verification that has no named reviewer or no evidence.
  - Contradiction Review routes contradicting proposals to `disputed`.
  - Ingestion Retry re-queues failed jobs, up to 3 attempts.
- **Wally** (the landing tab): ask anything. One question searches past RFP answers, the historian and the companies, people, projects and products named in it, in parallel; each section shows as it arrives, and a link runs the slower full record search. Every question is logged with what it found. People see their own recent questions; `Corporate Brain::Historians` and admins see everyone's under "Questions people asked", filterable by person and by "nothing found".
- **Dashboard** (far-right tab): knowledge and review KPIs plus connectors and ingestion/research jobs (formerly the Ingestion tab). It loads only when opened.
- **Historian:** finds the subject company or person, separates verified, unverified and disputed findings, builds a timeline and contacts, checks 10 core history questions and turns gaps into a research job.
- **RFP Intelligence** (see RFP_INTELLIGENCE.md): import RFP/RFQ/RFI/questionnaire documents (.docx, .xlsx, .csv, .txt, text PDF; originals kept as Kinetic attachments) → questions and the exact historical answers extracted with cell/paragraph/page citations → human review and confirmation (citations re-checked against the original) → search → reviewer-approved reusable answers (verified knowledge, Lens `rfp`) → new-RFP analysis with labelled AI-generated drafts and CSV export.
- **Privacy:** the kapp is private by default and a restricted source is hidden from non-reviewers by Kinetic policy. Both were verified with real non-admin users.

## Tests (latest run: all passing)
```
node --test apps/corporate-brain/tests/core.test.mjs           # 15 unit tests: truth model, identity, extraction, validation, sales rules
KINETIC_URL=… KINETIC_USER=… KINETIC_PASS=… node apps/corporate-brain/tests/api.test.mjs        # 64 API/provenance/permission checks (incl. GitHub pull, contradiction workflow, Sales Brain + deal-price privacy)
node apps/corporate-brain/tests/rfp.test.mjs                   # 46 offline RFP Intelligence checks: parsing (Word/Excel/CSV/text/PDF), extraction, citations, similarity, categories
KINETIC_URL=… KINETIC_USER=… KINETIC_PASS=… node apps/corporate-brain/tests/rfp-api.test.mjs    # 64 live RFP Intelligence checks: import → extract → confirm → correct → search → approve → analyse, permissions
KINETIC_URL=… KINETIC_USER=… KINETIC_PASS=… node apps/corporate-brain/tests/workflows.test.mjs  # 6 live Task workflow checks
cd tests && KINETIC_URL=… KINETIC_USER=… KINETIC_PASS=… node test-corporate-brain.mjs [shotDir]  # 41 Playwright UI checks (incl. the Sales tab)
```
The API and UI tests create clearly labelled TEST records and temporary users, then remove them. Audit-log rows are append-only and are kept.

## Vattenfall pilot (real evidence)
- **Sources:** 24 Google Drive documents whose titles name Vattenfall, read by Claude Code through the user's Google Drive MCP grant and pushed as one batch (`pilot/vattenfall-pilot.mjs`).
- **Created:** 12 timeline events, 21 knowledge entries (9 rule-based, 12 proposed by the agent with citations), 10 people, 3 products, 1 project (ITSP) and Kinetic Data as an internal company.
- **0 verified:** everything is waiting for human review. Customer status stays `Unknown` until a reviewer sets it with a stated basis.
- **Revenue:** the ≈ USD 1.1M lifetime revenue figure is recorded as a `claim` in `needs-research`. No financial source has been ingested.
- **Covered by evidence:** the 2014 proposal and term offer (apparently sold through BMC), the 2018 renewal proposal and license agreement (a more direct relationship), the 2019–2020 RE→CE conversion estimates, the 2023 Berlin onsite and the March 2025 check-in (version 5.0, upgrade to 6.1 planned).
- **Still open:** how the relationship began (the first contact is not in the evidence), invoiced revenue, signed terms, go-live dates and lessons confirmed by people.
- **Idempotency:** a second run of the pilot skipped 24 of 24 sources and created 0 duplicate knowledge entries.

## Incomplete or blocked
- **Gmail:** the agent's Gmail MCP connector needs re-authentication (`/mcp`). Server-side Gmail pull is coded but has no `CB_GMAIL_ACCESS_TOKEN`.
- **Google Drive server pull:** coded but needs `CB_GOOGLE_ACCESS_TOKEN`. Agent-mediated push works today.
- **LLM:** no `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, so the historian is extractive only. The narrative provider code exists but has not been exercised.
- **Pull connectors:** GitHub and Kinetic pull work (GitHub is tested). The GitHub connector reads commits only.
- **Scheduling:** there is no scheduled job runner. Pull jobs run on demand from the UI or API, and the Ingestion Retry workflow only re-queues jobs.
- **Search:** keyword search is a bounded scan of the most recent 200 records per form (8 pages × 25). It reports when it was truncated.
- **Decisions:** the `decisions` form exists with full CRUD but the pilot created no decisions.
- **Entity merging:** duplicate detection exists for companies (by name key, plus refusing duplicate names). There is no merge UI yet, though `Merged Into` fields exist.

## Files
| Path | Purpose |
|---|---|
| `model.mjs` | Forms, fields and indexes (single source of truth); `node model.mjs` regenerates `app.json` |
| `deploy.mjs` | Non-destructive deploy of the kapp, teams, policies, forms, indexes and security bindings |
| `server.mjs` | API handler auto-mounted by `apps/base/server.mjs` |
| `lib/core.mjs` | IDs, hashed Source ID, truth model and review state machine, date parsing |
| `lib/store.mjs` | Kinetic Core access with caller credentials, pages of 25 or fewer |
| `lib/services.mjs` | Entity resolution, relationships, review, audit, dossiers, timeline |
| `lib/retrieval.mjs` | RetrievalService (structured, prefix and keyword; semantic is a placeholder) |
| `lib/historian.mjs` | Corporate Historian, agent tool surface, optional model providers |
| `lib/ingest.mjs`, `lib/extract.mjs`, `lib/connectors/index.mjs` | Ingestion pipeline, rule-based extraction, connectors |
| `workflows/*.xml`, `workflows/deploy-workflows.mjs` | Kinetic Task governance workflows |
| `pilot/vattenfall-pilot.mjs` | Pilot loader for real Drive evidence |
| `index.html` | Single-page UI (9 tabs plus detail views) |
| `tests/` | Unit, API, workflow and harness tests; the UI test is `../../tests/test-corporate-brain.mjs` |

Further reading: [ARCHITECTURE](ARCHITECTURE.md) · [DATA_MODEL](DATA_MODEL.md) · [DEPLOYMENT](DEPLOYMENT.md) · [INGESTION](INGESTION.md) · [SECURITY](SECURITY.md) · [FUTURE_NATIVE_VECTOR_SEARCH](FUTURE_NATIVE_VECTOR_SEARCH.md)

## Known limitations found in code review (2026-10-22)

Fixed after review:
- If a member proposes knowledge that contradicts a reviewed entry, the new entry still records the contradiction and the Contradiction Review workflow routes it to `disputed`. The back-link on the reviewed entry needs a reviewer, so an audit row `contradiction-backlink-pending` is written for them.
- If a member re-syncs a source whose citing knowledge they may not change, that record fails with a clear error in the job's Errors list. An audit row `flag-blocked` is also written, so a reviewer can re-check the knowledge. It is never silently left unflagged.
- Only reviewers can add restricted notes, because members could not see the source they had just created.
- The job page decides whether to show Run from each connector's live capability. A Drive or Gmail job therefore shows Run once a server token is configured.

Still open:
- Dashboard counts stop at 1,000 per form (shown as `1000+`).
- `decisions` have no link back to knowledge, so their `Verification Status` is set by reviewers directly rather than synced from a review.
- In the Google Drive server pull, `scope.folderId` is not escaped inside the Drive query. Admins define the scope, and server pull is not configured.
