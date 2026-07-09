# Workflow & State-Transition Definitions

Workflows are implemented as Kinetic **Task Engine** trees triggered on submission create/update.
The UI and server hold **no process logic** — they read state. Each tree applies risk-based routing,
business-calendar due dates, reminder/escalation timers, parallel/sequential approvals, delegation
with provenance, separation-of-duties guards, and writes every transition to `audit-trail`.

Common capabilities across all trees:
- **Risk-based routing** — High/Critical records require an extra approval level and an *independent*
  effectiveness/verification reviewer.
- **Due dates** — computed from severity/risk against a business calendar; stored on the record.
- **Reminders & escalation** — timer nodes notify owner before due, escalate to the manager team after.
- **Delegation** — reassignment captures delegator, delegate, reason and time (provenance in audit trail).
- **Reject / rework / cancel / reopen / supersede** — explicit transitions, each reason-bearing.
- **Immutable history** — transitions are append-only; records are amended, never silently overwritten.
- **Queues** — task assignment to individual / team / site / role; surfaced in *My Work*.

## Quality Event
```
Open → Triage → Investigation → Pending Approval → Closed
                      │                   │
                      └─▶ (escalate to NC / CAPA / Complaint)   └─▶ Rejected
```
Triage sets severity/risk and disposition: close (no action), correct, or **escalate** (spawns NC,
CAPA or Complaint and links bi-directionally). Confidential/anonymous flags route to a restricted queue.

## Nonconformance / Material Review
```
Open → Containment → MRB Review → Disposition → Closed
                                       │
                                       └─▶ Reopened (new evidence)
```
Disposition ∈ {Use-As-Is, Rework, Scrap, Return to Supplier, Concession}; Use-As-Is and Concession
require **MRB approval** (Quality Manager). Containment/segregation and quantity affected are snapshotted.

## CAPA (the spine)
```
Initiated → Triage → Investigation → Action Planning → Implementation
   → Verification → Effectiveness → Closed
                          │              │
                          │              └─▶ (Effectiveness Result = Failed) → Reopened
                          └─▶ Reopened
```
Guards before **Closed**: all `capa-actions` Completed **and** verified, effectiveness criteria defined
and result = Passed, required signatures present (Effectiveness Approved by an *independent* reviewer +
CAPA Closure Approved). Investigation method ∈ {Five Whys, Ishikawa, Fault Tree, Is/Is-Not, Human
Factors, combinations}; multiple suspected/confirmed root causes supported.

## Complaint & Vigilance
```
Open → Investigation → Reportability Review → Pending Closure → Closed
```
Reportability Review yields Reportable ∈ {Yes, No, Undetermined}; if Yes, a regulatory clock
(MDR/MIR) and `Regulatory Due Date` are set and surfaced as overdue when breached. Duplicate detection
links to the primary complaint; returned-product analysis and CAPA/risk links captured.

## CAR / SCAR (supplier)
```
Issued → Supplier Response → Review → {Accepted | Rejected} → Closed
                                          │
                                          └─▶ Escalated (overdue or rejected twice)
```
Supplier contacts respond via the isolated portal. Acceptance verifies effectiveness and applies a
**supplier score impact**; rejection re-issues with a new due date; overdue auto-escalates.

## Audit
```
Scheduled → In Progress → Reporting → Closed
```
Findings (`Major | Minor | Observation | OFI`) get response → remediation → verification; Majors may
spawn a linked CAPA. Auditor independence enforced at assignment.

## Document & Change Control
```
Document:  Draft → In Review → Approved → Effective → Obsolete
Change:    Draft → Impact Assessment → Approval → Implementation → Verification → Closed (│ Rejected)
```
Approving an effective document/change with `Training Required = Yes` **auto-assigns training** to the
affected role/site population. Effective-date and obsolete-version control maintained.

## Training & Competency
```
Assigned → In Progress → Completed   (→ Overdue if past due; → re-assigned on Expiration)
```
Auto-assigned from document revisions, role changes, CAPAs and quality events. Overdue escalates;
expiration triggers retraining. Effectiveness via test score / practical qualification.

## Risk (ISO 14971)
```
Open → Controlled → Monitoring
```
Initial risk = Severity × Probability; controls + verification reduce to residual; benefit-risk
decision recorded. Post-production signals (complaints, CAPAs, NCs) re-open assessment.

## Management Review
```
Draft → In Progress → Approved
```
Aggregates audit results, complaints, CAPA performance, supplier performance, process metrics,
regulatory changes, risks, prior actions and improvement opportunities into a governed package,
approved by signature.

## Reusable handlers (integration touch-points, design)
ERP (lot/inventory hold) · MES (process exception → event) · PLM (design/doc change) · HRIS (role →
training) · LIMS (test result → NC) · Calibration (OOT → equipment + affected-product) · Supplier
portal · Email/notification · Document storage · Analytics/data platform. Each is a versioned task
handler invoked from the trees above; failures are retried and logged with correlation IDs.
