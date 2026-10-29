# RFP Intelligence

Every question Kinetic Data has been asked in an RFP, RFQ, RFI, security questionnaire or procurement response — the exact
answer Kinetic gave (or drafted), and where that answer sits in the original document. Built into Corporate Brain
(Corporate Brain → **RFP Intelligence**), on the same Kinetic kapp, services, permissions and review model.

The rule underneath everything: **an answer is only ever text found verbatim in an original document, at a stored
location.** Historical answers are evidence of what Kinetic said at the time. Only a reviewer-approved answer is current
knowledge.

## What was reused, what is new

| Need | Reused from Corporate Brain | New |
|---|---|---|
| Storage | Kinetic submissions on kapp `corporate-brain` (no other database) | 8 forms (below); the original file is a real Kinetic **attachment** on its document record |
| Provenance | `sources` + ingestion jobs (`processBatch`, hashed Source IDs, idempotency) | `rfp-upload` connector; Drive-originated files keep their Drive link |
| Review / truth model | knowledge entries + `services.review` (human-only verification), audit log | approved answers become **verified knowledge entries, Lens `rfp`** when a reviewer approves them |
| Permissions | caller's credentials on every call; `CB Restricted Source` policy; `store.setScope` | `Access Scope` on every RFP row; `CB RFP Answer Modification`, `CB Approved Answer Modification` |
| Retrieval | `RetrievalService` (`lib/retrieval.mjs`) used by search and the Historian | types `rfpquestion`, `approvedanswer`; every hit carries a `contentClass` |
| Document parsing | — (Corporate Brain stored references, not documents) | `lib/docparse.mjs`: .docx, .xlsx, .csv, .txt, text PDF — Node built-ins only |
| Extraction | rule-based extractor pattern (`lib/extract.mjs`) | `lib/rfp-extract.mjs`: questions, answers, compliance, priority, sections, duplicates, categories |
| UI | single `index.html`, tabs, detail views, modals, 25-per-page lists | **RFP Intelligence** tab with seven views |

Files: `lib/docparse.mjs`, `lib/rfp-extract.mjs`, `lib/rfp.mjs` (services), routes under `/api/corporate-brain/rfp/…`
in `server.mjs`, forms in `model.mjs`, policies in `deploy.mjs`, tests `tests/rfp.test.mjs` (offline) and
`tests/rfp-api.test.mjs` (live). The launcher gained one additive helper, `kineticTarget()`, so an app can move raw
file bytes to and from the Kinetic server the request targets.

## Data model

| Form (slug) | ID | What it holds |
|---|---|---|
| `rfp-sources` | `RS-…` | A procurement: customer/agency, RFP name, solicitation number, type (rfp/rfq/rfi/questionnaire/other), received, due, submitted, outcome + basis, document IDs, counts. `Library Status` historical or analysis. |
| `rfp-documents` | `RD-…` | One revision of one document: file name/type, **role** (response, solicitation, combined, reference), revision + the revision it supersedes, SHA-256, **the original file (attachment)**, Corporate Brain Source ID, extraction status and notes. |
| `rfp-questions` | `RQ-…` | A question exactly as asked: number, original text, normalized text, section/subsection, order (`Sequence`), category + tags (+ whether suggested or manual), location (JSON) + label, requirement level + basis, extraction status, answer status + preview, possible duplicate, canonical question. |
| `rfp-answers` | `RA-…` | A historical answer: exact text, its parts (each with its own cell/paragraph), compliance marks, answer date, document version, product version, status (candidate → confirmed; corrected/rejected), citation verified, who confirmed, `Revision Of`, correction note. |
| `canonical-questions` | `CQ-…` | A shared subject many questions map to. Each question keeps its wording and answers. |
| `approved-answers` | `AA-…` | A current reusable answer: canonical question, answer, category, product versions, environments, conditions, evidence references (confirmed historical answers), owner, status, approver, review due, supersedes/superseded by, linked knowledge entry, review history. |
| `rfp-analyses` | `AN-…` | A new RFP analysed against the library. |
| `rfp-analysis-items` | `AI-…` | One requirement of a new RFP: original text/number/order/location, requirement level, **AI-generated draft** + basis, matched questions with scores, citations, conflict flags, review status, final answer. |

Relationships: an RFP has many documents and questions; a question has many historical answers (one per document
revision, plus corrections); many questions map to one canonical question; a canonical question can have several
approved answers (for different versions/environments, or over time via supersede); an approved answer cites one or
more historical answers.

Every RFP row carries `Access Scope` (`internal` / `restricted`), judged per submission by the `CB Restricted Source`
policy: restricted RFPs (e.g. pricing volumes) are visible to reviewers only, and members' queries are always scoped.

## Workflow

**1. Import (Import Documents).** Pick an RFP (or create one), choose files and each file's role:
*Kinetic's response*, *questions + our answers*, *buyer's RFP (questions only)* or *reference only*. The server:
stores the original as an attachment, registers a Corporate Brain source (an ingestion job), parses the structure,
extracts candidates in the background, attaches answers to the RFP's existing questions (a response document answering
the buyer's solicitation, or a later draft of the same response), flags duplicates, and counts. Re-importing the same
bytes creates nothing; a changed file with the same name (ignoring "DRAFT v2", "(1)") becomes revision N+1, and its
answers are recorded as revisions of the earlier ones. Extraction is idempotent (unique `Row Key` / `Answer Key`) and
resumable ("Re-run extraction" keeps existing rows, adds missing ones).

**2. Extraction rules.**
- *Tables / spreadsheets*: the header row is found by vocabulary (and multi-row headers, sub-header rows and merged
  banners are read), then each column is scored on both its header and its data: question/requirement, answer
  (narrative), compliance (dropdown values, X marks — read as "Requirement Managed by: Vendor"), priority (Must Have,
  Mandatory → requirement level), ID. A lone label row sets the section; a sparse long-text column to the left carries a
  use-case heading down. A response document's table with no answer column is skipped and noted.
- *Narrative (Word, PDF, text)*: numbered questions, "?" questions and imperative asks ("Describe your …"); in a
  response document the following paragraphs up to the next question are the answer — **explicitly labelled answers**
  ("Response:", "Kinetic Response:") are *extracted*, **unlabelled ones are only candidates (`needs_review`)**.
- *Never invented*: no answer → `unanswered`; uncertain pairing → `needs_review`; a solicitation never yields answers;
  a reference document is stored, not extracted; scanned pages and encrypted PDFs are reported, not guessed.
- *Requirement level*: from a priority column, an explicit "(Mandatory)/(Desirable)" label, or shall/must wording
  (recorded with its basis); otherwise `unspecified`.

**3. Review (document page).** Text is shown exactly as in the document, with its location. A person confirms rows
("Confirm all clear rows" confirms only rows the extractor was sure of; `needs_review` rows are confirmed one by one),
re-points an answer by pasting the exact text (accepted only if found in the document — the citation is taken from
where it is found), marks a row unanswered, or rejects a non-question. **Confirming re-checks every citation against
the original file.** Once confirmed, a historical answer is immutable: a reviewer may record a correction, which must
also be text in the document and becomes a new confirmed revision; the original stays, marked `corrected`.

**4. Search.** Natural-language or keyword search over every question the caller may see, with category, customer,
date and answered filters. Each result shows the original question, the historical answer and its citation (opens the
original — PDFs at the cited page), customer, RFP, date, category, related questions, and the current approved answer
when its canonical question has one.

**5. Approve (Answer Library / Knowledge Review).** Promote a *confirmed* historical answer → a **draft** approved
answer (canonical question created or reused, the historical answer attached as evidence) → edit text, product
versions, environments, conditions, owner, review date, more evidence → **submit** → a **reviewer approves** (agents
never can). Answers in security, compliance, authentication, pricing/licensing, contractual/legal, data/privacy, high
availability and backup/DR categories are **sensitive**: approval needs an explicit confirmation and a comment.
Approving creates (and verifies) the answer's knowledge entry. Statuses: draft, needs-review, approved, outdated,
superseded, historical-only. Approving an answer that names one it supersedes retires the old one (and supersedes its
knowledge entry). Every change is in the audit log and the answer's review history.

**6. New RFP Analysis.** Upload a new RFP and attachments; its requirements are extracted (with numbering, order,
requirement level) and matched against the library. Draft rules — **nothing is written that the evidence does not say**:
1. a *strong* match to an **approved** answer → the approved text, verbatim (overdue review dates and competing approved
   answers are flagged);
2. else a *strong* match whose historical answer is **confirmed** → that text, verbatim, flagged "not approved for reuse";
3. else no draft: "unconfirmed history", "partial evidence" or "no evidence".
Every draft is labelled **AI-generated draft** and lists its citations; historical answers to similar questions that
disagree (yes vs no) are flagged. People accept, edit, or mark items as needing evidence; the reviewed matrix exports as
CSV (original numbering and order kept). Retrieved documents are treated as data, never as instructions — no model
reads them in this release (drafting is extractive; an LLM drafting step, if added, must keep these rules and cite).

**Match strength** (search and analysis) — token overlap of the two questions after normalization and synonym grouping
(SSO/SAML/identity provider, backup/RPO/RTO, …), plus a small boost when the answer shares the terms. Not a probability:
- **strong ≥ 0.60** — same subject, most of the same terms; the historical answer is likely relevant (still check scope and date)
- **partial ≥ 0.35** — related subject; useful context, do not reuse as-is
- **weak ≥ 0.18** — shares a few terms only

## Brain integration — what other agents get

`GET /api/corporate-brain/rfp/retrieve?q=…[&drafts=1]` and the shared `/search` (types `rfpquestion`, `approvedanswer`)
return results with a `contentClass`:

| contentClass | Meaning |
|---|---|
| `current-approved` | an approved answer — current knowledge (also a verified knowledge entry, Lens `rfp`) |
| `historical-evidence` | what Kinetic answered in a past procurement — evidence, **not** a current verified fact |
| `superseded` | an approved answer that was superseded or marked outdated — do not reuse |
| `unapproved-draft` | an approved-answer draft that no reviewer has approved |
| `ai-generated-draft` | an analysis draft for one proposal — never approved knowledge (only with `drafts=1`) |

Other knowledge hits carry `verified-knowledge`, `unreviewed-proposal`, `superseded`, `evidence` or `record`. The
Historian labels RFP results the same way. All of it runs with the caller's permissions.

## Search architecture and the semantic path

Today: a per-login in-memory index (built from the caller's own visible rows, rebuilt on change or after 10 minutes)
and a token/synonym similarity scorer. `rfp.search()` is the single retrieval interface (used by the UI, the analysis,
the shared RetrievalService and `/rfp/retrieve`). A semantic provider — the generic Kinetic Search API backed by
Cassandra 5.x vector indexes, optionally hybrid with Elasticsearch (see `FUTURE_NATIVE_VECTOR_SEARCH.md`) — replaces
the scorer inside `search()`; callers, result shapes and permissions do not change. No vector database is required now.

## Initial dataset (2026-10-28)

One real 2026 state-agency ESM RFP, imported from John's local copy of the RFP folder through the same API a user
would use (a loader under `ingest/rfp/`, which is not published): the RFP (Word), the buyer's security-standards and
requirements workbooks, Kinetic's draft responses to both (kept as revisions v1–v2 and v1–v3) and the buyer's Q&A PDF
(reference only) — 570 questions, 481 with a historical answer. Nothing is confirmed or approved; that is for John and
James. The outcome and submission date are unknown and recorded as unknown. A real 2026 state ITSM RFQ was also run
through New RFP Analysis.

**Historical discovery (2026-10-28).** Corporate Brain already held Kinetic's RFx history as ordinary sources (the
Drive waves), so a discovery pass registered every past opportunity it could find as an RFP record: 89 more
procurements from 2007 to 2026 (RFPs, RFQs, RFIs, sources-sought notices, questionnaires, CSO calls), each linked to the
Drive files already loaded for it (368 sources) or to the Proposal Library's Bid History. They are searchable in the RFP
Library now; the detail page lists the linked files (**Files in Corporate Brain**) with links to the originals. Dates are
only what a title, folder name or the Bid History states; outcomes stay unknown. No questions or answers exist for them
until their files are imported. The curated list and loader live under `ingest/rfp/history/` (not published);
`POST /rfp/sources/{id}/link-sources` links existing sources (refuses sources that do not exist or are not visible).
Not yet covered: RFx email threads (~200 in John's mailbox) and the RFx working folder named in the Bid History, which is
not on this machine.

**Importing historical files from Google Drive (on demand, no sync).** `ingest/rfp/drive/import-rfp.mjs <client.json> <RS-id>`
downloads an RFP's linked Drive files into memory with a read-only OAuth "Desktop app" client (PKCE on a loopback port;
the token lives in the OS temp directory; the client JSON stays outside the repo), imports them through `POST /rfp/import`
and keeps no local copies. Roles come from the file name: the buyer's RFP / requirements / attachments are `solicitation`,
Kinetic's answer is `response`; SOWs, charters, contracts, diagrams and spreadsheets the parser cannot read stay linked
files. **Order matters:** the solicitation is imported and extracted first, then responses — a response's answers attach
to the solicitation's questions (a solicitation never matches existing rows). One document at a time; the loader waits
for the RFP recount (the document turns "extracted" before the recount is written). `--skip=SR-…` leaves out a linked
file that belongs to another RFP; `--dry-run` prints the plan. First imports (2026-10-28): two
legacy-Word RFPs of one public-sector customer — one with its draft and final response (121 questions, 83 answered),
one solicitation-only (57 questions).

## Limitations (first release)

- Scanned PDFs: reported, not OCR'd. Encrypted PDFs: refused with instructions. Legacy Word 97–2003 `.doc` is read
  natively (OLE piece table + paragraph properties: text, headings, tables; automatic list numbers are not reproduced);
  encrypted `.doc` is refused. Legacy `.xls`: save as .xlsx.
- Word page numbers are not computed (Word citations are table/row/column or paragraph + section; PDFs cite page and line).
- PDF tables are read as text lines (narrative extraction applies); Word and Excel tables keep their structure.
- Narrative extraction from long solicitations is noisy (instructions with "shall/must" are flagged `needs_review`).
- Categories are rule-based suggestions (marked `rule-suggested`); people correct them. An LLM classifier can plug in
  via the Historian's model providers.
- Drafting is extractive (approved or confirmed text only); no LLM rewriting yet.
- The search index is per login and in-memory; very large libraries (tens of thousands of questions) will want the
  Kinetic Search API provider.
