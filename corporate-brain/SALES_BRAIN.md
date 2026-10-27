# Sales Brain

The Sales Brain is a second lens on Corporate Brain. It records **how Kinetic sells and why**:
- principles
- pricing over time
- deals
- objections
- competitors
- partner models

It shares Corporate Brain's evidence, companies and review flow, and has no separate store.

The plan document for John and James is https://claude.ai/artifact/XCQijPLs9pPu2wUKP589DM.

## Decisions (John, 2026-10-27)
| Decision | Answer |
|---|---|
| Record types | Approved all six: principle, pricing model, deal, objection, competitor, partner model |
| Verified principle | At least 2 linked deals, plus approval by John or James |
| Who verifies | John or James (`Corporate Brain::Reviewers`) |
| CRM source | Copper, read-only |
| Audience | The playbook is for the Sales, Marketing, Legal and Executive teams. Deal-level prices are for Sales, Legal and Executive only |
| Still open | James's mailbox (consent and labels to exclude); which 3–4 deals to use for the first interviews |

## Phases
1. **Design — done 2026-10-27.**
   - Seven forms, teams and policies.
   - The Sales tab with Playbook, Pricing timeline, Deals, Objections, Competitors, Partner models and a Sales review queue.
   - Deal pricing for permitted roles.
2. **Re-read the evidence already loaded — done 2026-10-27.**
   - 647 sales-relevant sources were selected from 14,744 loaded ones. 5 readers opened about 350 originals, read-only, through Gmail and Drive.
   - The findings were consolidated by hand in `ingest/sales/build-merged.py`.
   - 259 records were proposed: 33 principles (25 already have 2+ deals), 185 deals (121 with restricted prices), 15 objection patterns, 12 pricing models, 9 partner models and 5 competitors.
   - Research job: JB-9BA288E17C.
   - Run order: `ingest/sales/` — inventory.mjs → score.py → batches → PHASE2_RUNBOOK.md readers → check-findings.py → build-merged.py → load.mjs (resumable).
   - Questions the readers raised:
     - Per-user licensing contradicts "never license by user": 2014–2018 quotes and the 2014–15 per-user model.
     - One support quote's subtotal does not match its total (details on the restricted deal record).
3. **Load what's missing — Proposal Library and Copper done 2026-10-27. James's mailbox is waiting on his consent.**
   - **Proposal Library:** 7 documents were registered and read in full (job JB-BF9804930C). Of the 23 points in them:
     - 10 reinforce existing principles, with the playbook's words added under "Proposal Library (2026)".
     - 5 contradict an existing principle and are loaded as their own principles, cross-referenced both ways. A sixth contradiction, a per-user tier offered in one bid, is recorded as an exception on "Never license by user count".
     - 7 are new principles.
   - **Copper:** added as a read-only `copper` source type. 49 opportunities were loaded (job JB-BA6DAC4FBD):
     - 44 became new deals, and their values went to restricted Deal Pricing.
     - 5 updated phase 2 deals for the same bid.
     - 21 new companies were created with status `Unknown`.
     - One Copper company was left unlinked because it may duplicate an existing company (see the review queue).
     - Copper lists one opportunity twice (see the review queue).
   - **Scripts:** `ingest/sales/phase3/` (copper-to-records.py, load-copper.mjs, merge-playbook.mjs), job JB-80FB010B85.
   - **Totals after phase 3:** 45 principles, 232 deals, 16 objections, 12 pricing models, 9 partner models and 6 competitors. 320 are awaiting review.
4. **Interviews and the sales historian.** Recorded deal interviews, the Historian's sales mode, and playbook-only access for the audience teams.

## How it fits together
- **One form per record type** (`model.mjs`):
  - `sales-principles`, `pricing-models`, `deals`, `sales-objections`, `competitors`, `partner-models`.
  - Each record holds a `Knowledge ID` that points to a knowledge entry with `Lens = sales` and `Subject Type` = the record type.
  - That entry carries the review, and `services.review()` copies its status onto the record.
- **Deal prices** sit on `deal-pricing`, restricted by the `CB Deal Pricing` policy. See SECURITY.md.
- **API:**
  - `POST /sales/{kind}` with `{values, sourceIds}`: agents use this in phase 2 with an `X-CB-Agent` header. Agents can propose but never verify.
  - `GET /sales/{kind}/{id}`, `GET /sales/summary`, `GET /sales/pricing-timeline`.
  - `POST /sales/deal/{id}/pricing`.
  - `GET /review-queue?lens=sales`.
  - Lists: `GET /entities/{form}?status=…` plus one filter (`theme`, `outcome`, `category` or `type`).
- **Record types** (`kind`): `principle`, `pricingmodel`, `deal`, `objection`, `competitor`, `partnermodel`.
