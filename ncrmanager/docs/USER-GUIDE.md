# User Guide

## Signing in
Open the app (via the launcher at `/ncrmanager/` or standalone on port 3021). If you arrived from the
launcher you're already authenticated; otherwise enter the server URL and your credentials. Your
session persists across tabs.

## The top bar
- **Module navigation** — My Work, Analytics, and one entry per domain (Events, Nonconformance, CAPA,
  Complaints, Audits, Documents, Training, Suppliers, Risk, Equipment, Mgmt Review, Master Data, Admin).
- **View as** — switch the *My Work* perspective to any sample persona (Quality Manager, Investigator,
  Regulatory, SQE, …) to see that role's queue. Defaults to you.

## My Work (home)
Your operational landing page — **not** a marketing screen. Shows:
- KPIs: open assigned items, overdue count, and counts by record type (click to jump to that module).
- **Overdue & Escalated** — act on these first.
- **My Open Items** — everything assigned to you, soonest-due first.
- **Quick Intake** — one-click start of a Quality Event, Complaint, Nonconformance, CAPA or Finding.

## Working a list (any module)
Each module shows a filtered, searchable, paginated table (25 rows/page):
- **Search** box (debounced) matches IDs, titles, owners, etc.
- **Filter** dropdowns (Status, Type, Severity, …) run as indexed server-side KQL.
- **+ Add New** opens the create form.
- **Click any row** to open the record-360 drawer. Overdue dates are flagged red with ⚠.
- **Prev / Next** page through results — the app never loads more than one page at a time.

## The record-360 drawer
Clicking a record slides in a full 360° view:
- **Header** — business ID, title and status/risk/severity badges, with **Edit** and **Sign** actions.
- **Record Details** — all populated fields.
- **Action Plan** (CAPAs) — actions with owner, due date and status.
- **Relationship Graph** — the record at the center with every linked record around it; **click a node**
  to navigate straight to that record (e.g. CAPA → its Complaint → its Risk).
- **Linked Records** — the same neighbors as a clickable list.
- **Electronic Signatures** — the Part 11 manifest for this record.
- **Audit Trail / Timeline** — every change, newest first, with actor, time, old→new and reason.

### Try the showcase
Open **CAPA → CAPA-0001** and walk the graph: Complaint CMP-0001 → Risk RSK-0001 → Event QE-0001 →
Nonconformance NC-0001 → Change CHG-0001 → five training records, plus its two closure signatures and
full timeline.

## Creating & editing records
- **Add New** / **Edit** opens a form built from the record's fields (dropdowns for controlled values,
  date pickers, text areas for narratives).
- **Regulated records** (events, NCs, CAPAs, complaints, findings, changes, SCARs, risks) require a
  **Reason for Change** when edited. On save, each changed field is written to the audit trail with the
  old → new value, your name, the time and your reason. Creating a record writes a "Created" entry.

## Applying an electronic signature
On a CAPA, complaint, change, document, SCAR or management review, click **✍ Sign**:
1. Choose the **signature meaning** (e.g. *Effectiveness Approved*, *CAPA Closure Approved*).
2. Enter a **reason/comment**.
3. **Re-enter your password** — you are re-authenticated before the signature is recorded.

The signature (printed name, meaning, reason, version, method, hash, timestamp) is appended to the
record's signature manifest and a corresponding audit-trail entry is written. *Signature meanings and
policy are configured by your administrator and subject to your organization's quality/legal review.*

## Analytics
Live, KQL-backed metrics across the whole QMS. Every KPI tile and table row **drills down** to the
underlying records — there are no disconnected aggregates. Use it for open/overdue load, CAPA aging and
cycle time, effectiveness failures, complaint and finding trends, supplier scorecards, training and
calibration compliance, and the overdue priority queue.

## Tips
- Use **View as** before reviewing someone's workload.
- Filters + search combine; clear them to see the full list.
- Deep links: a record drawer is reachable by `openRecord(form, submissionId)` — the relationship graph
  uses the same navigation so you can traverse the entire quality network without leaving the page.
