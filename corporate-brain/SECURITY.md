# Security & Governance

Corporate Brain is **private by default**. Kinetic itself enforces access through KSL policies on the kapp and forms. The app server adds earlier, clearer checks, but always calls Kinetic with the **caller's own credentials**, so it cannot grant more than Kinetic allows.

## Teams and roles
| Team | Role | Can |
|---|---|---|
| `Corporate Brain::Members` | member | Read non-restricted records; propose knowledge; add notes; create jobs and ingest; edit their own still-proposed knowledge; request research (tracked as a research job) |
| `Corporate Brain::Reviewers` | reviewer | All of the above, plus approve, reject, dispute and supersede; read and modify restricted sources; edit reviewed knowledge |
| `Corporate Brain::Admins` | admin | Everything, including products and form changes |
| `Corporate Brain::Sales`, `::Legal`, `::Executive` | pricing | See and record **deal-level prices** (Sales Brain). No Corporate Brain access on their own: members are added to `Members` as well |
| `Corporate Brain::Marketing` | — | Sales Brain playbook audience (no prices). Grants nothing yet; playbook-only access is planned for Sales Brain phase 4 |
| (space admin) | admin | Bypasses all policies |

## Policy definitions (kapp level, `deploy.mjs`)
| Name | Type | Rule (summary) |
|---|---|---|
| CB Member | Kapp | member, reviewer or admin |
| CB Admin | Kapp | space admin or `Corporate Brain::Admins` |
| CB Member Form | Form | member |
| CB Admin Form | Form | admin |
| CB Member Submission | Submission | member |
| CB Knowledge Modification | Submission | reviewer, **or** (member **and** creator **and** Review Status ∈ proposed / needs-research) |
| CB Restricted Source | Submission | reviewer, **or** (member **and** `Access Scope` ≠ `restricted`) |
| CB Append Only | Submission | admin |
| CB Sales Modification | Submission | reviewer, **or** (member **and** creator **and** Verification Status ∈ proposed / needs-research) |
| CB Deal Pricing | Submission | member **and** (reviewer **or** Sales / Legal / Executive team) |

## Bindings
| Level | Endpoint → policy |
|---|---|
| Kapp | Display → CB Member · Modification → CB Admin · Form Creation → CB Admin · **Submission Support → CB Admin** · Default Form Display → CB Member Form · **Default Form Modification → CB Admin Form** · Default Submission Access → CB Member Submission · Default Submission Modification → CB Member Submission |
| knowledge-entries | Submission Modification → CB Knowledge Modification |
| sources | Submission Access, Submission Modification → CB Restricted Source |
| audit-log | Submission Modification → CB Append Only |
| sales-principles, pricing-models, deals, sales-objections, competitors, partner-models | Submission Modification → CB Sales Modification |
| deal-pricing | Submission Access, Submission Modification → CB Deal Pricing |

`Submission Support` and `Default Form Modification` grant access to *all* submissions and override form-level rules. Binding them to members was the cause of two privacy gaps found in testing. Both are now admin-only.

## Server-side controls (`server.mjs`, `lib/core.mjs`)
- All routes except `/health` and `/me` require membership (403 otherwise).
- **Review:**
  - approve, reject, dispute and supersede require a reviewer.
  - `reviewTransition` refuses `verified` unless `actorType === "user"`. Requests carrying `X-CB-Agent` are recorded as agent actions and **can never verify**.
  - Evidence-requiring knowledge types need at least one source before they can be verified.
  - Reasons are required for reject, dispute and research.
- **Protected fields:** generic edits cannot change knowledge review fields (Review Status, Verified By, Verified At, Review History, Superseded By, …), source identity fields, or job counters and checkpoints.
- **Verified events** cannot be rewritten (409).
- **Customer status** changes require a stated basis.
- **Audit log** writes come only from the server; there is no client create, and updates are refused.
- **Products** can only be written by admins.
- **Citations:** proposing knowledge checks that every cited source exists **and is visible to the caller**.

## Sales Brain controls
- A sales record and its review entry (Lens `sales`) are created together, and a bad citation creates neither.
- The record's `Verification Status` follows the review. Generic edits cannot set it or change the `Knowledge ID` link.
- A **principle** cannot be verified until it links at least 2 deals (`PRINCIPLE_MIN_DEALS`, decided by John on 2026-10-27).
- **Deal prices** live on their own form, `deal-pricing`:
  - They are not reachable through `/entities` or `/ref`. They are read and written only through `/sales/deal/{id}`.
  - That route also requires the pricing role.
  - Audit rows record which fields changed, never the amounts, because members can read the audit log.
  - Tested: a plain member gets 0 rows from a direct Core query, and a `Sales` member sees the prices.

## Workflow enforcement (Kinetic Task)
- **Verification Guard:** catches direct Core API writes that bypass the app. Any knowledge marked `verified` without a `Verified By`, or without evidence when evidence is required, is reverted to `needs-research`, with a review-history entry and an audit row. Tested live by setting `verified` through the Core API.
- **Contradiction Review:** contradicting proposals become `disputed`.

## Untrusted content
Emails, documents and web pages are **data, not instructions**:
- Ingestion stores metadata and short excerpts and never executes or follows their contents.
- The historian's optional model prompt wraps evidence in `<evidence>` and tells the model to ignore any instructions inside it.
- Model output is labelled "AI interpretation — not verified" and can only be saved as `proposed`.
- The UI escapes every value (`esc` / `jsArg`).

## Credentials and logging
- No credentials are kept in source code or app assets.
- Connector tokens come only from environment variables (`CB_GOOGLE_ACCESS_TOKEN`, `CB_GMAIL_ACCESS_TOKEN`, `CB_GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), and none is required.
- Scripts and tests take `KINETIC_URL`, `KINETIC_USER` and `KINETIC_PASS` from the environment.
- Server logs record errors (route plus message) and audit-write failures. Document contents are not logged.

## Retention, deletion and permission changes
- Deleting a source upstream marks it `source-deleted` and clears the excerpt. The reference is kept for provenance, and citing knowledge is flagged for re-review.
- When permission is revoked, the source becomes `restricted` and the excerpt is cleared.
- Records are retired with `Record Status` rather than deleted. The audit log is append-only for everyone except admins.

## Tested with real non-admin users (`tests/api.test.mjs`)
These were run with temporary users, a member and an outsider, who are deleted afterwards:
- Outsiders get 403 from the app and 0 rows from a direct Core API query.
- Members can use the app.
- A restricted source returns 404 to a member through the app, and 403 by ID through Core.
- Members cannot approve. A member's research request is accepted as a research job.
- A member PUT to reviewed knowledge through the Core API is refused.
- A member PUT to an audit-log row is refused.

## Known gaps
- The app runs on the local `:3011` launcher over **HTTP on the LAN**, not inside the Kinetic cluster and not behind TLS.
- Following the launcher's convention, the browser keeps Basic auth in `sessionStorage` (`kinetic_session` / `cb_session`).
- The agent (Claude Code) writes **as the human user's account** with an `X-CB-Agent` label. There is no separate service identity yet, so Kinetic's own `createdBy` shows the human user.
- Members' ingestion cannot flag knowledge they don't own (Kinetic refuses the update and the error is swallowed). Re-syncs that may change reviewed knowledge should be run by reviewers.
- The role cache lasts 60 s, so team changes take up to a minute to apply in the app. Kinetic policies apply immediately.
