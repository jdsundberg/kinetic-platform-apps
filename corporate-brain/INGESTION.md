# Ingestion

The code is in `lib/ingest.mjs` (pipeline and jobs), `lib/extract.mjs` (rule-based candidates) and `lib/connectors/index.mjs` (connectors).

## NormalizedSourceRecord
Every connector, and every agent, produces records in this shape:
```js
{ system: "gmail"|"google-drive"|"github"|"kinetic"|"manual",   // required
  originalId: "…",            // required; ID in the source system (case-sensitive)
  sourceType: "email"|"document"|"presentation"|"spreadsheet"|"code"|"record"|"interview"|…,
  title: "…",                 // required unless deleted/permissionRevoked
  date: "YYYY-MM-DD",         // date in the source system (treated as approximate for documents)
  owner, url,                 // owner and a link to the original
  excerpt: "…",               // short; >4000 chars is refused — store a reference, not the document
  contentHash: "…",           // change detection
  accessScope: "internal"|"restricted",
  participants: [{ name, email, role }],
  companyHints: ["Vattenfall"],
  deleted?: true, permissionRevoked?: true }
```

## Modes
- **pull:** the server reads the system itself with server-side credentials. Start it with `POST /api/corporate-brain/jobs/{id}/run`, which returns 202. Up to **8 batches of 25 or fewer records** are processed in the background, after which the job is `paused` and the next run resumes from `Checkpoint`. An in-process guard stops the same job running twice at once.
- **push (agent-mediated):** an authorized agent reads the system under the user's own grant and posts batches to `POST /jobs/{id}/batch` as `{ records: [...≤25], checkpoint, done }`, adding the header `X-CB-Agent: <name>`. Every record's `system` must match the job's connector. The pipeline is the same as for pull.

| Connector | Mode | Status |
|---|---|---|
| `manual` (interviews, notes) | push via `POST /notes` | **Works.** The note is the archival copy, stored in `Excerpt` (up to 4000 characters) and proposed as a `recollection`. |
| `kinetic` | pull | **Works.** Scope is `{kapp, form, q?, titleField?, dateField?, companyHint?}`, read with the caller's permissions. It refuses to ingest `corporate-brain` itself. |
| `github` | pull | **Works and is tested.** Scope is `{repo:"owner/name", path?, since?, until?, maxPages?, companyHint?}` and reads commits. Public repositories need no token; `CB_GITHUB_TOKEN` enables private repos and higher limits. |
| `google-drive` | push today; pull if `CB_GOOGLE_ACCESS_TOKEN` is set | **Push works (pilot).** Server pull (Drive v3 `files.list`, metadata only) is written but untested because no token is configured. |
| `gmail` | push; pull if `CB_GMAIL_ACCESS_TOKEN` is set | **Blocked.** The agent's Gmail MCP grant needs re-authentication (`/mcp`). Server pull is metadata only (Subject, From, To, Cc, Date, snippet), written but untested. |

`GET /api/corporate-brain/connectors` reports each connector's live status.

## Pipeline (per record)
1. **Validate:** a known `system` and an `originalId` are required, a `title` is required unless the record is deleted or revoked, and an excerpt must be 4000 characters or fewer.
2. **Identity:** `Source ID = "SR-" + sha256(system \0 originalId)[:20]`. This hash is case-safe, which matters because Kinetic unique indexes are case-insensitive.
3. **Already processed?** If the source exists:
   - Same `contentHash`: **skipped**, and only `Last Synced At` is updated.
   - Changed hash: the title, excerpt, hash and URL are updated and `Processing Status: changed` is set. **Every knowledge entry citing the source is flagged:** verified entries become disputed, and proposed or disputed entries become needs-research, each with a comment.
   - `deleted: true`: `Processing Status: source-deleted`, the excerpt is cleared, the record is **kept** for provenance, and citing knowledge is flagged.
   - `permissionRevoked: true`: `Access Scope: restricted`, `Processing Status: permission-restricted`, and the excerpt is cleared.
4. **Resolve entities:**
   - Companies come from the job subject, then `companyHints` (created as `Customer Status: Unknown` if missing), then participant email domains.
   - People are matched by email or by Name Key within a company. They are only created when the job scope sets `createPeople`.
   - `kineticdata.com` and `kinops.io` addresses resolve to Kinetic Data.
5. **Save the source reference:** metadata, excerpt and link, with `Processing Status: retrieved`.
6. **Extract** with `extractCandidates()`:
   - **Contract, order, SOW, license or EULA, proposal or RFP, invoice, or implementation documents** with a resolved company produce a `fact` that the document exists ("terms have not been reviewed") and a linked event.
   - **Notes, meetings, check-ins and onsites** produce a meeting event.
   - **Email and meeting records** produce a communication.
   - **Dates** come from the title only when written there; otherwise the file's creation date is used as `approximate`.
7. **Save candidates:** knowledge is created as `proposed` (through `services.proposeKnowledge`, with an audit row), plus events and communications, and a source `evidence-for` company relationship. The source becomes `extracted`.
8. **Review:** proposals appear in the Review Queue. Nothing is verified automatically.

Each record gets up to 3 attempts with exponential backoff. Errors with a status between 400 and 499 (other than 429) are not retried. Failed records are added to `Errors` (the last 25 are kept) and to `Items Failed`, and the batch continues.

## Jobs
- **Counters:** `Items Discovered`, `Items Processed` (created plus updated), `Items Skipped` and `Items Failed`.
- **Checkpoint and status:** `Checkpoint` is JSON. `Status` moves through queued → running → paused, completed or failed. `blocked` means the connector is not configured.
- **Retry and cancel:** `POST /jobs/{id}/retry` re-queues a job, which resumes from its checkpoint. `POST /jobs/{id}/cancel` cancels it.
- **Ingestion Retry workflow:** Kinetic Task automatically re-queues a failed ingestion job while `Attempts` is below 3.
- **Scheduling:** there is no scheduler. Queued jobs run when someone clicks Run or calls `/run`.

## Bounded scope
- Gmail jobs **must** include a restricted `scope.query`. Whole-mailbox ingestion is refused (400).
- Batches are limited to 25 records, and each run to 8 batches.
- Excerpts stay short. Bodies and documents remain in the source system, and the UI links to the original, where that system enforces the viewer's own permissions.

## How the Vattenfall pilot ran (`pilot/vattenfall-pilot.mjs`)
1. Claude Code searched Google Drive through the user's MCP grant for files about Vattenfall. Scope was limited to files whose titles name Vattenfall, plus the 2018 license agreement. Seven documents were read in full to write accurate excerpts and proposals.
2. The script ensures `Kinetic Data` (Internal) exists, creates a `google-drive` job, and posts all **24** records as one batch with `X-CB-Agent: claude-code (Google Drive MCP)`. Ingestion created Vattenfall (`Unknown`) from `companyHints`, the sources, 12 events and 9 rule-based facts.
3. It adds 10 people named in the documents (each citing sources), 12 agent-proposed knowledge entries with citations and `Extraction Method: ai-agent (…)`, 3 products, the ITSP project and relationships.
4. The USD 1.1M revenue hypothesis is proposed as a `claim` with no sources and immediately moved to `needs-research`.
5. A re-run produced `{"skipped":24}`, created no duplicate knowledge (deduplicated by title per company) and reused the existing people and products.
