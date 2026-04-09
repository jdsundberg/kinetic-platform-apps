You are building a world-class Oil & Gas Compliance + Sustainability Compliance application on the Kinetic Platform.

1) Product goal

Create a single operational system that:
	•	Ingests incoming events from automated discovery/monitoring tools (security, OT/ICS monitoring, environmental sensors, CMMS/EAM signals, vendor risk, cloud posture, data loss, field inspection apps, etc.)
	•	Normalizes and correlates events into Compliance Cases with clear ownership and SLAs
	•	Enables management to track compliance posture via management screens
	•	Enables teams to share and reuse institutional knowledge via a knowledge + controls library
	•	Produces audit-ready evidence and reporting packs without heroics

2) Primary user personas

Define roles and permissions for:
	•	Compliance Manager (program owner)
	•	Sustainability/ESG Manager
	•	HSE Lead (health/safety/environment)
	•	Operations Manager / Field Supervisor
	•	Auditor (internal/external) – mostly read-only with evidence access
	•	Analyst/Coordinator (triage and routing)
	•	SME/Assignee (does investigation + remediation tasks)
	•	Executive Viewer (high-level dashboards only)
	•	System Integrations (service account, least privilege)

3) Core modules to build (must)

Build these modules as first-class nav sections with management-grade UI:

A. Command Center (Management)
	•	Executive summary dashboard with configurable KPIs
	•	Risk + compliance posture heatmap (by asset/site/business unit/regulatory domain)
	•	“Today’s Exceptions” panel (SLA breaches, overdue corrective actions, high severity events)
	•	Trending charts: event volume, case closure time, repeat findings, emissions anomalies
	•	Drill-down: click KPI → filtered queue → case details

B. Event Intake & Normalization
	•	Event Inbox (raw incoming events)
	•	Normalization pipeline:
	•	Parse payload
	•	Map to standardized fields
	•	Deduplicate
	•	Correlate to assets/sites/vendors
	•	Severity scoring
	•	Suggest category + control mapping
	•	Event-to-Case rules engine:
	•	When to open a new case vs attach to existing
	•	Correlation window + similarity matching (asset + category + time)
	•	Escalation triggers

C. Compliance Case Management
	•	Case types: Incident, Finding, Audit Issue, Nonconformance, Permit Deviation, Data Quality Issue, Supplier Risk, Sustainability Disclosure Issue
	•	Standard case lifecycle:
	•	New → Triage → Investigate → Remediate → Validate → Closed
	•	Reopen path + exception approvals
	•	Each case must support:
	•	Ownership + team assignment
	•	SLA timers, due dates, escalations
	•	Tasks/subtasks/checklists
	•	Evidence attachments + evidence metadata
	•	Approvals and sign-off steps
	•	Related records (events, assets, controls, policies, audits)
	•	Full audit log and comment timeline

D. Corrective & Preventive Actions (CAPA)
	•	Action plan builder with dependencies
	•	Recurrence prevention tracking
	•	Verification step with evidence requirement
	•	Management roll-up: open CAPAs by site/owner/severity/age

E. Knowledge & Controls Library (Knowledge Sharing)
	•	Policy/Standard/Procedure Library:
	•	Versioning, owners, review cadence, approvals
	•	Tagging and search (reg domain, asset type, risk)
	•	Controls Catalog:
	•	Control statements, control owners, frequency, test procedures
	•	Mapping: controls ↔ requirements ↔ risks ↔ evidence templates ↔ cases
	•	Playbooks / Runbooks:
	•	Step-by-step response guides for common event types
	•	“Lessons learned” capture from closed cases
	•	Evidence Templates:
	•	What evidence is required, acceptable formats, retention rules
	•	Auto-checklists generated from templates

F. Assets / Sites / Facilities / Vendors Registry
	•	Asset hierarchy: enterprise → region → site → facility → unit → equipment
	•	Key fields: identifiers, location, owner, criticality, permit associations
	•	Vendor registry: supplier risk profile, certifications, audit history

G. Audits & Inspections
	•	Plan audits/inspections with scopes and checklists
	•	Capture findings directly into cases and CAPAs
	•	Audit pack export: selected controls, evidence, approvals, timelines, outcomes
	•	Auditor portal view: filtered, read-only access + evidence downloads

H. Sustainability / ESG Data Quality + Attestation
	•	Track sustainability reporting cycles (monthly/quarterly/annual)
	•	Data quality workflow:
	•	Incoming data anomalies become cases
	•	Attestation tasks for responsible owners
	•	Sign-off chain (preparer → reviewer → approver)
	•	Support “reporting pack” assembly with evidence links

4) Data model (define records and relationships)

Create record types with key relationships:

Event
	•	Source system, source event id, timestamp, raw payload (stored securely), normalized fields
	•	Links to Asset/Site/Vendor
	•	Links to Case (optional/many-to-one)

Case
	•	Case type, severity, status, owner, SLA, due dates
	•	Links to Events (one-to-many), CAPAs (one-to-many), Evidence (one-to-many)
	•	Links to Controls/Policies/Requirements (many-to-many)
	•	Links to Asset/Site/Vendor

CAPA
	•	Action items, owner, due date, status, verification evidence required
	•	Linked to Case

Control
	•	Name, description, owner, frequency, test procedure
	•	Linked to Requirements, Evidence Templates, Cases, Audits

Policy/Procedure
	•	Versioned docs, approvals, review schedule
	•	Linked to Controls and Cases

Evidence
	•	Attachment + metadata (type, collection date, collected by, system-of-record, retention, sensitivity)
	•	Linked to Cases/Controls/Audits/CAPAs
	•	Must support immutable audit trail + integrity (hash stored if available)

Audit/Inspection
	•	Scope, checklist, findings, final report, sign-offs
	•	Linked to Controls/Evidence/Cases

Asset/Site
	•	Hierarchy and ownership
	•	Linked broadly

Requirement
	•	Store “requirements” in a generic way:
	•	Requirement ID, domain, summary, applicability, effective date, mapping guidance
	•	(Do not provide legal advice; treat as internal requirement statements)
	•	Linked to Controls and Cases

5) UI requirements (management-heavy)

Every module needs:
	•	A queue/list screen with rich filtering (site, asset, severity, status, owner, source, date range)
	•	A detail screen with tabs: Overview, Timeline, Tasks, Evidence, Related, Approvals, Audit Log
	•	Bulk actions for coordinators (assign, prioritize, attach to case, set due date, escalate)
	•	Saved views for execs and managers
	•	“My Work” personalized dashboard

6) Workflows & automation (must be explicit)

Implement these workflows:

Incoming Event workflow
	1.	Receive event (API / webhook / file drop)
	2.	Validate + normalize
	3.	Enrich (lookup asset/vendor/site; apply severity scoring)
	4.	Deduplicate + correlate
	5.	Decide: create case or attach to existing
	6.	Route to owner/team based on rules
	7.	Notify + create tasks/checklists
	8.	Track SLA timers and escalate if breached

Case workflow
	•	Triage form → Investigation form → Remediation plan → Validation checklist → Closure summary
	•	Required fields enforced by status transitions
	•	Approvals for exceptions (e.g., closing without evidence, extending due dates)

Knowledge capture workflow
	•	On case close, prompt user for:
	•	Root cause
	•	Preventive measure
	•	“Lessons learned”
	•	Recommend updates to playbooks/controls/policies (create drafts)

Audit pack workflow
	•	Select audit → choose scope → auto-collect linked evidence → generate review tasks → finalize pack

7) Integrations (generic, pluggable)

Create an integration layer with connectors that can be configured per customer:
	•	Inbound: webhook/event receiver with authentication, replay protection, idempotency keys
	•	Outbound: notifications to email/Slack/Teams, ticket creation in ITSM, update CMMS/EAM work orders
	•	Reference connectors: data discovery tools, monitoring systems, GRC, emissions data systems
	•	Create a “Source System” admin screen to manage API keys, mappings, field transforms, enable/disable sources

8) Security, privacy, auditability
	•	Role-based access control down to record type + field sensitivity
	•	Evidence access restrictions (e.g., HR/security sensitive)
	•	Immutable audit log on all state changes, approvals, and evidence modifications
	•	Data retention policies configurable by record type
	•	Support eDiscovery-style export (permissions permitting)

9) Reporting & analytics

Provide reporting screens (not just exports):
	•	Compliance performance KPIs
	•	Case aging and SLA compliance
	•	Repeat issue analysis (recurrence)
	•	CAPA effectiveness
	•	Sustainability attestation completion status
	•	Drill-down from chart → filtered list

10) Seed configuration (starter content)

Create starter templates so the app is usable day 1:
	•	Case templates per case type (required fields, checklists, default SLAs)
	•	Evidence templates (photos, sensor reports, inspection forms, system logs, calibration records)
	•	Example controls and requirement domains (generic placeholders):
	•	Environmental compliance
	•	Operational safety
	•	Data governance / reporting integrity
	•	Vendor compliance
	•	Asset integrity
(Use placeholders; do not claim specific regulatory text.)

11) Output format requirements for the build

When generating the Kinetic application:
	•	Provide the full set of:
	•	Record types, fields, relationships
	•	Kinetic forms (create/edit/view) per module
	•	List views/queues with default filters
	•	Workflows/automations with clear transition rules
	•	Role/permission model
	•	Integration endpoints and configuration screens
	•	Seed templates and sample data
	•	Keep naming consistent and professional, suitable for board-level demos.
	•	Include “Admin” section: Source Systems, Mappings, SLAs, Categories, Severity Scoring, Notification Rules, Retention Policies.

12) Non-goals / constraints
	•	Do not provide legal or regulatory advice.
	•	Treat “requirements” as internal compliance statements with customer-configurable text.
	•	Prioritize management UX, auditability, and knowledge reuse.


Now build the application accordingly.
