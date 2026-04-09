You are building a world-class enterprise application inside the Kinetic Platform.

Application Name: AtlasLake
Subtitle: Enterprise Data Lake Service Catalog & Governance Platform

This application must meet Fortune 500 standards for highly regulated industries (healthcare, finance, energy, defense). It must be security-first, governance-first, audit-ready, and architected for AI-era enterprise environments.

This is not a simple metadata registry. It must function as the control plane for enterprise data ecosystems.

⸻

OBJECTIVE

Design and generate a production-grade Kinetic application that enables:
	1.	Executives to understand enterprise data risk, exposure, and duplication.
	2.	Security teams to monitor and approve access with zero trust posture.
	3.	Data teams to register, manage, classify, and govern data assets.
	4.	Compliance teams to map regulatory obligations and produce audit evidence.
	5.	Architecture teams to visualize lineage and dependency.
	6.	AI teams to assess dataset quality, reuse potential, and redundancy.

⸻

SCOPE

The system must manage:

• Data Lakes
• Data Warehouses
• Data Marts
• Streaming Systems
• Data Pipelines
• Feature Stores
• Semantic Layers
• Data APIs
• Data Products

⸻

ARCHITECTURAL PRINCIPLES

Implement:

• Zero trust access model
• Full audit logging
• Attribute-based access control (ABAC)
• Configurable risk scoring engine
• Data classification automation workflow
• Lineage modeling
• Change management
• Security approval workflows
• Encryption state tracking
• Cross-platform dependency mapping
• AI-ready duplication detection hooks

⸻

CORE DATA OBJECTS

Create structured objects with relationships:
	1.	DataPlatform
	•	Name
	•	Type (Lake, Warehouse, Stream, Feature Store, API)
	•	Cloud Provider
	•	Region
	•	Encryption Status
	•	Owner
	•	Criticality Level
	•	Compliance Scope
	2.	DataDomain
	•	Business Domain
	•	Executive Owner
	•	Data Steward
	•	Risk Rating
	3.	Dataset
	•	Platform (reference)
	•	Domain (reference)
	•	Sensitivity Classification (Public, Internal, Confidential, Restricted)
	•	Regulatory Tags (HIPAA, PCI, GDPR, SOX, etc.)
	•	Row Count
	•	Data Volume
	•	Encryption at Rest
	•	Encryption in Transit
	•	Masking Status
	•	Tokenization Status
	•	Retention Policy
	•	Business Owner
	•	Technical Owner
	•	Steward
	•	Quality Score
	•	Duplication Risk Score
	•	Last Accessed Date
	•	Access Count
	4.	DataProduct
	•	Consumes Datasets (many-to-many)
	•	Exposes APIs
	•	SLA
	•	Consumer Groups
	•	Revenue Impact
	•	Business Criticality
	5.	AccessRequest
	•	User
	•	Dataset
	•	Justification
	•	Risk Score
	•	Expiration Date
	•	Approval State
	•	Workflow Instance
	6.	SecurityFinding
	•	Dataset
	•	Finding Type
	•	Severity
	•	Discovered By
	•	Remediation Owner
	•	Due Date
	•	Status
	7.	LineageNode
	•	Upstream Dataset
	•	Downstream Dataset
	•	Transformation Type
	•	Pipeline Owner
	•	Last Validation Date

⸻

MANAGEMENT MODULES

Design the following consoles:

Executive Dashboard

• Enterprise risk heatmap
• Regulatory exposure summary
• Duplication risk index
• Shadow data score
• Top 10 critical datasets
• Access approval backlog

Security Operations Panel

• Open findings
• High-risk access grants
• Datasets lacking encryption
• Over-permissioned users
• Stale access detection

Data Steward Console

• Missing metadata
• Unclassified datasets
• Quality degradation alerts
• Orphaned domain assets

Architecture View

• Lineage visualization
• Dependency tree
• Blast radius simulation
• Redundancy detection

Compliance Console

• Regulatory mapping matrix
• Audit trail viewer
• Evidence export
• Control testing log

⸻

WORKFLOWS

Implement production-grade workflows with SLA tracking, escalation paths, and immutable audit logging:

• New Dataset Registration
• Classification Review
• Risk-Based Access Approval
• Security Finding Remediation
• Platform Decommission
• Data Retention Review
• Risk Reassessment
• Executive Exception Approval

Risk scoring formula (configurable):

Risk Score = Sensitivity Weight × Exposure Level × Access Count × Compliance Weight

⸻

SECURITY MODEL

Implement:

• Role-based access (Executive, Security, Steward, Engineer, Auditor)
• Attribute-based access (domain, classification, risk tier)
• Dataset-level authorization
• Future-ready field-level classification flags
• Immutable audit ledger
• Version tracking
• Change history timeline

⸻

ANALYTICS & AI READINESS

Design event model to support:

• Duplicate dataset detection via schema similarity
• Unused dataset detection
• Access anomaly detection
• Data product reuse recommendations
• Consolidation suggestions

Expose APIs for future ML pipeline integration.

⸻

ENTERPRISE REQUIREMENTS

• Multi-region awareness
• Cloud neutral (AWS, Azure, GCP, on-prem)
• API-first design
• Metadata export capability
• Designed for 1M+ datasets
• Sub-300ms API response target
• Horizontally scalable
• Multi-tenant ready (future)

⸻

UX REQUIREMENTS

• Clean enterprise UI
• Risk-based color coding
• Drill-down dashboards
• Search-first navigation
• Bulk management capabilities
• Dark mode ready

⸻

DELIVERABLES

Generate:
	1.	Full Kinetic application structure
	2.	Data model definitions
	3.	Workflow definitions
	4.	Security model configuration
	5.	Dashboard definitions
	6.	API design
	7.	Event model
	8.	Role definitions
	9.	AI integration hook points

This must be production-grade.

Do not build a demo, this is a real app.


See it with sample data. 

Use exising lessons learned markdown files.






