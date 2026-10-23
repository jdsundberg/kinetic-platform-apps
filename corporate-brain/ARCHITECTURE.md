# Architecture

```
 Browser (index.html)                     Agent (Claude Code + MCP: Google Drive, Gmail…)
   │  Basic auth + X-Kinetic-Server          │  same API + X-CB-Agent: <name>
   ▼                                         ▼
 apps/base/server.mjs  (:3011 launcher, auto-mounts apps/corporate-brain/server.mjs)
   └─ /api/corporate-brain/*  ── server.mjs
         ├─ lib/store.mjs       Kinetic Core /app/api/v1 with the CALLER's credentials (≤25/page)
         ├─ lib/services.mjs    entity resolution · relationships · review · audit · dossiers
         ├─ lib/retrieval.mjs   RetrievalService (structured | prefix | keyword | semantic*)
         ├─ lib/historian.mjs   question → subject → evidence package → cited answer (+ optional model)
         ├─ lib/ingest.mjs      pipeline, jobs, checkpoints; lib/extract.mjs rule-based candidates
         └─ lib/connectors/     manual · kinetic · github (pull) · google-drive · gmail
                    │
                    ▼
 Kinetic Platform (ai-labs.kinopsdev.io)
   kapp corporate-brain — 12 forms, KSL security policies, indexes
   Kinetic Task — Verification Guard · Contradiction Review · Ingestion Retry
   (*semantic = future native platform capability, not implemented)
```

## Request flow
1. The browser calls `/api/corporate-brain/...` with `Authorization: Basic …`. The launcher's injected fetch wrapper, or the app's own login, adds `X-Kinetic-Server: https://ai-labs.kinopsdev.io`. The launcher routes Core calls per request to that server (AsyncLocalStorage), so other apps on `:3011` keep their own targets.
2. `server.mjs` resolves `/me?include=memberships` (cached for 60 s per login and server) into roles: `admin` (space admin or `Corporate Brain::Admins`), `reviewer`, and `member` (any `Corporate Brain::*` team). Everything except `/health` and `/me` requires `member`.
3. Each store, service, retrieval, ingestion and historian call is built per request with the caller's credentials. Kinetic security policies are therefore the final authority. Server checks add earlier, clearer refusals; they are not the only guard.
4. **Agents** send `X-CB-Agent: <name>`. Their actions are recorded as `Actor Type: agent` with the label `<name> (for <username>)`. `reviewTransition` refuses `verified` for any actor that isn't a human user.

Lists sent to the browser are always one page of 25 or fewer, using `pageToken` pagination. Aggregations such as dashboard counts, dossiers and keyword scans run on the server with bounded page walks. Dashboard stats are cached for 60 s with in-flight deduplication, and writes clear the cache.

## RetrievalService (`lib/retrieval.mjs`)
| Provider | How | Notes |
|---|---|---|
| structured | KQL equality on indexed fields (Company ID, Review Status, Knowledge Type, Event Type, …) | `structuredQuery(type, filters)` |
| prefix | `values[Name Key] =* "<normalized>"` with `orderBy=values[Name Key]` | companies, people, projects, products |
| keyword | Scans the most recent 8 pages × 25 per form and scores tokens with AND semantics (title > body) | Reports truncation in `notes` |
| semantic | `available: false` | Placeholder; see FUTURE_NATIVE_VECTOR_SEARCH.md |

`search({q, types, companyId, status, kind, from, to})` merges the hits into a normalized shape: `{type, form, id, submissionId, title, snippet, status, kind, date, companyId, score, matchedBy}`. The UI, the historian and the agent tools all use this one function.

## Corporate Historian (`lib/historian.mjs`)
- **Subject resolution:** builds 1–3 word phrases from the question (stop-words removed) and runs `Name Key =*` prefix lookups on companies, then people. Ambiguous matches are returned in `ambiguous`.
- **Company answer:** `services.companyDossier` produces these sections:
  - Established (verified)
  - Unverified (proposed or needs-research)
  - Disputed (competing claims kept)
  - Timeline
  - People

  Every item carries citations as knowledge, event or person IDs plus source IDs. `COMPANY_CHECKLIST` (10 questions, from origin to lifetime revenue) turns gaps into `unanswered` questions and suggested research. `/historian/research` turns those into a research job.
- **No subject:** falls back to `retrieval.search` and labels the results as search results, not an answer.
- **Model providers (optional):** `anthropic` (`ANTHROPIC_API_KEY`, `CB_ANTHROPIC_MODEL`) and `openai` (`OPENAI_API_KEY`, `CB_OPENAI_MODEL`), selected by `CB_MODEL_PROVIDER`. The model receives only the same evidence package, wrapped in `<evidence>`. The system prompt treats that evidence as untrusted data, requires ID citations and forbids new facts. The output is labelled "AI interpretation — not verified". The UI's "Save as proposed narrative" creates a `narrative` entry in `proposed`. **No key is configured, so `mode: "extractive"`.**
- **Agent tools** (`GET /historian/tools`, `POST /historian/tools/{name}`):
  - Read tools: `search_records`, `get_company_dossier`, `get_person_profile`, `get_source`, `get_knowledge`, `ask`.
  - Write tool: `propose_knowledge`, the only write, which always creates a proposal.

## Ingestion
See INGESTION.md. The steps are: discover → normalize → hashed Source ID dedup → resolve company and people → save the source reference → extract candidates → proposed knowledge, events and communications → audit → job progress. Server pull runs in the background of the launcher process (`POST /jobs/{id}/run` returns 202), never inside the browser request.

## Kinetic Task workflows (form-level, `workflows/`)
| Workflow | Form / event | Effect |
|---|---|---|
| Verification Guard | knowledge-entries / Submission Updated | Reverts `verified` to `needs-research` when there is no `Verified By`, or when a fact, narrative, lesson, summary or interpretation has no sources. Appends history and writes an audit row. |
| Contradiction Review | knowledge-entries / Submission Submitted | A new proposal with `Contradicts` set becomes `disputed`. Appends history and writes an audit row. |
| Ingestion Retry | research-jobs / Submission Updated | A failed ingestion job with Attempts < 3 goes back to `queued`, and an audit row is written. |

All three use `kinetic_core_api_connection_v1` to call the Core API on the same space. Long-running work is **not** done in Task, because the engine cannot reach the LAN launcher. Task enforces governance on the records themselves, which also catches writes made directly through the Core API that bypass the app.

## Why there is no separate database
Every entity, relationship, job, checkpoint and audit row is a submission. Uniqueness and deduplication use Kinetic unique indexes. Privacy uses KSL policies. History is kept in `Review History` and the `audit-log` form. External systems stay authoritative for content; Corporate Brain stores metadata, a short excerpt (at most 4000 characters, usually a few hundred) and a link.
