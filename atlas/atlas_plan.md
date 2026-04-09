# Atlas — Data Dictionary & Consistency Intelligence

## Overview
Enterprise data catalog app for the Kinetic Platform. Provides a searchable dictionary of data assets (tables, forms, APIs, files), their definitions, owners, relationships, and consistency health. Port 3008.

## File Structure
```
apps/atlas/
  index.html          - Single-page app UI (8 tabs)
  server.mjs          - Proxy + custom API routes
  setup.sh            - Create kapp/forms, build indexes, optional seed, start server
  seed.mjs            - Demo data generator
  scan_kinetic.mjs    - Standalone Kinetic Platform scanner
  build_indexes.mjs   - Index creation and build script
  atlas_plan.md       - This file
```

## Data Model (12 Forms in kapp "atlas")

| # | Form | Key Fields |
|---|------|------------|
| 1 | domain | Name, Description, Status, Owner, Tags, Icon Color |
| 2 | system | Name, Description, System Type, Technology, Environment, Domain, Owner, Status, Tags, Connection Info |
| 3 | dataset | Name, Description, System, Domain, Dataset Type, Schema Name, Record Count, Refresh Frequency, Source of Truth, Owner, Classification, Status, Tags, Version |
| 4 | field | Name, Description, Dataset, System, Data Type, Max Length, Nullable, Primary Key, Foreign Key Target, Default Value, Allowed Values, Example Values, Business Definition, Glossary Term, Classification, Status, Tags, Sort Order |
| 5 | glossary-term | Name, Definition, Domain, Synonyms, Related Terms, Owner, Status, Version, Tags |
| 6 | relationship | Name, Relationship Type, Source Entity Type, Source Entity, Target Entity Type, Target Entity, Confidence, Description, Status |
| 7 | classification | Name, Category, Sensitivity Level, Regulation, Retention Period, Description, Status |
| 8 | owner | Name, Email, Team, Role, Domains, Systems, Status |
| 9 | quality-rule | Name, Dataset, Field, Rule Type, Expression, Description, Severity, Status |
| 10 | issue | Title, Description, Issue Type, Severity, Status, Related Domain/System/Dataset/Field/Term, Evidence, Recommendation, Assigned To, Resolution |
| 11 | change-log | Entity Type, Entity ID, Entity Name, Action, Changed By, Timestamp, Details, Notes |
| 12 | scan-result | Scan ID, Source Type, Source Name, Scan Status, Started At, Completed At, counts, Scanned By, Notes |

## Index Strategy

### Single-field indexes
- dataset: Status, Domain, System, Classification, Dataset Type
- field: Dataset, System, Data Type, Glossary Term
- glossary-term: Domain, Status
- issue: Status, Issue Type, Severity
- relationship: Relationship Type, Source Entity, Target Entity
- system: Domain, Status, System Type
- change-log: Entity Type, Action
- scan-result: Source Type, Scan Status
- domain: Status
- owner: Status, Role
- classification: Category, Status
- quality-rule: Dataset, Status

### Compound indexes
- dataset: Status+Domain, Status+System
- field: Dataset+System
- issue: Status+Severity, Status+Issue Type

## UI Tabs (8)

1. **Dashboard** — KPIs, coverage bars, domain health, top issues
2. **Catalog** — Subtabs: Datasets | Fields. Paginated + filtered
3. **Domains** — Domain cards with drill-down
4. **Systems** — System cards with drill-down
5. **Glossary** — Term list with field reference counts
6. **Issues** — Paginated table with status/type/severity filters
7. **Graph** — SVG relationship explorer (radial 1-hop)
8. **Admin** — Scanner trigger, scan history

## Server Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/atlas/stats | Dashboard KPIs |
| GET | /api/atlas/stats/health | Coverage percentages + domain health |
| GET | /api/atlas/search?q=&type= | Cross-entity text search |
| POST | /api/atlas/scan/kinetic | Trigger Kinetic Platform scan |

## Scanner (scan_kinetic.mjs)

CLI: `node scan_kinetic.mjs --url <source> --user <u> --pass <p> --atlas-url <atlas> --atlas-user <u> --atlas-pass <p>`

1. GET /kapps from source → System records
2. GET /kapps/{slug}/forms → Dataset records
3. GET forms with fields → Field records
4. Detect FK relationships (field names ending in ID/_id)
5. Create scan-result + change-log entries

## Seed Data Summary

- 3 domains, 5 owners, 5 systems, 6 classifications
- 15 datasets, 80+ fields, 20 glossary terms
- 30 relationships, 8 quality rules, 10 issues
- 15 change-log entries, 2 scan-results

## Key Decisions

- Cross-form references use text names (not submission IDs)
- Server-side aggregation for dashboard only; other tabs use KQL via proxy
- SVG graph with radial 1-hop layout (no external deps)
- Scanner writes sequentially to avoid rate limits
- Compound indexes for common AND queries, client-side filter for extras
