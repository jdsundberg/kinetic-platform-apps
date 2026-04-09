# Kinetic Air

Airtable-like spreadsheet data manager built on the Kinetic Platform. Users create tables, add columns, and do inline data entry in a spreadsheet-style grid. All data stored in Kinetic forms and submissions.

## Architecture

| Concept | Kinetic Mapping |
|---------|----------------|
| Table | Form (in `kinetic-air` kapp) |
| Column | Field element (on form page) |
| Row | Submission |
| Cell value | Submission field value |

## Setup

```bash
node apps/kinetic_air/setup.mjs   # Creates kinetic-air kapp
```

No seed data — users create tables from scratch via the UI.

## Access

- **Through launcher:** http://localhost:3011 → click "Kinetic Air" card
- **Standalone:** http://localhost:3021 (port 3021)
- **Kapp:** `kinetic-air`
- **Custom API endpoints:** None — all CRUD goes through the Core API proxy

## Features

- **Table CRUD** — Create, rename, delete tables (forms)
- **Column types** — Text, Long Text, Number, Date, Dropdown (with choices), Checkbox
- **Inline editing** — Click any cell to edit, auto-saves on blur
- **Row CRUD** — Add rows, select with checkboxes, bulk delete
- **Pagination** — 25 rows per page with Prev/Next
- **Search indexes** — Auto-created for each new column

## Column Type → Kinetic Field Mapping

| Air Type | dataType | renderType | Notes |
|----------|----------|------------|-------|
| Text | string | text | rows=1 |
| Long Text | string | text | rows=3 |
| Number | string | text | rows=1, client-side validation |
| Date | date | date | Native date picker |
| Dropdown | string | dropdown | Requires choices array |
| Checkbox | string | checkbox | Values: "true"/"false" |

## Kinetic Field Element Requirements

When creating fields via `PUT /forms/{slug}`, each field element requires these properties:

```
type, name, key, label, dataType, renderType, renderAttributes,
required, enabled, visible, defaultValue, defaultResourceName,
requiredMessage, omitWhenHidden, pattern, constraints, events
```

**Type-specific:**
- Text fields: `rows` (number, top-level — NOT in renderAttributes)
- Dropdown/Checkbox: `choices` (array, top-level), `choicesResourceName`, `choicesRunIf`
- Date: no `rows` property (will error if present)

## Limitations (v1)

- No column reorder, resize, or rename
- No sorting or filtering (future: KQL-powered)
- No formula columns
- No multi-select or file attachment column types
- Column deletion removes the field definition; existing submission values remain in the database
- No undo

## Files

| File | Purpose |
|------|---------|
| `setup.mjs` | Creates the `kinetic-air` kapp |
| `index.html` | Single-page app (all CSS/JS inline) |
| `server.mjs` | Standalone proxy server, port 3021 |
