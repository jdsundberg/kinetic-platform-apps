# Generic PDF Print Module

## Status: Planned (not yet built)

## Problem

Every app that needs PDF output re-implements the same pattern: build an HTML string, `window.open()`, `document.write()`, `print()`. The DoD Forms app has 3 variants (~1100 lines total). As more apps need printable output (HotelGuru invoices, ITIL incident reports, compliance audits, etc.), this duplication will grow.

## Existing Pattern (DoD Forms)

Three functions in `apps/dod_forms/index.html`:

| Function | Lines | What it does |
|---|---|---|
| `generateDD93PDF()` | 1880-2258 | Hardcoded DD Form 93 layout — fetches related records (contacts, beneficiaries, disposition, insurance), renders government form |
| `generateMemberPDF(dodId)` | 2260-2390 | Full member dossier — fetches all related data via `fetchMemberBundle()`, renders multi-section report with tables |
| `generateFormPDF()` | 2918-3013 | Semi-generic — iterates `gwDef.sections` and `gwValues`, auto-layouts fields 2-per-row, handles yes/no tables and wide fields |

Core technique (3 lines that every variant shares):
```javascript
const w = window.open('', '_blank');
w.document.write(htmlString);
w.document.close();
setTimeout(() => w.print(), 500);
```

Common CSS across all three:
- `@page { size: letter; margin: 0.5in; }`
- Times New Roman serif, 10pt body, 7pt labels, 14pt headers
- Black section headers with white text, uppercase
- `page-break-inside: avoid` on sections
- Signature blocks with border-top lines
- Footer with generation date

## Proposed Design

### File: `apps/base/pdf-print.js`

Served by the base server as a static JS file. Apps include it with:
```html
<script src="/base/pdf-print.js"></script>
```

### API Surface

```javascript
// Minimal usage — auto-layout all submission values
PrintPDF.submission(submission, { title: 'Incident Report' });

// Controlled layout — custom sections
PrintPDF.report({
  title: 'Guest Folio',
  subtitle: 'Reservation #R-20260228-001',
  theme: 'corporate',          // or 'government', 'minimal'
  pageSize: 'letter',          // or 'a4'
  sections: [
    {
      title: 'Guest Information',
      fields: [
        { name: 'First Name' },
        { name: 'Last Name' },
        { name: 'Email', wide: true },
        { name: 'Special Requests', wide: true }
      ]
    },
    {
      title: 'Charges',
      table: {                   // table mode for related records
        columns: ['Date', 'Description', 'Amount'],
        rows: chargesArray,      // [{Date:'...', Description:'...', Amount:'...'}]
        footer: ['', 'Total', '$1,234.00']
      }
    },
    {
      title: 'Medical Screening',
      yesno: true,              // yes/no checkbox table
      fields: [
        { name: 'Allergies Reported' },
        { name: 'Mobility Assistance Required' }
      ]
    }
  ],
  values: { 'First Name': 'Jane', ... },  // flat key-value map
  signatures: ['Guest', 'Front Desk'],     // optional signature lines
  footer: 'Confidential — Grand Meridian Hotels'
});
```

### Themes

| Theme | Font | Headers | Use case |
|---|---|---|---|
| `government` | Times New Roman | Black bg, white text, uppercase | DoD Forms, compliance |
| `corporate` | system-ui/Arial | Dark blue bg, white text | Hotels, ITIL, CRM |
| `minimal` | system-ui | Bold text, bottom border only | Simple reports, exports |

### Layout Rules

- **Fields**: 2 per row by default, `wide: true` takes full width
- **Tables**: full-width with alternating row shading, optional footer row
- **Yes/No**: checkbox-style table (X marks, red for Yes)
- **Page breaks**: `page-break-inside: avoid` on sections, `page-break-before: always` available per section
- **Auto-layout**: if no `sections` provided, group all values into one section, 2 fields per row, textareas (values > 100 chars) get `wide: true`

### Implementation Notes

- Pure browser-side, zero dependencies
- ~200 lines estimated
- Must handle HTML escaping (XSS prevention in printed output)
- `const CL = '<' + '/';` trick avoids `</script>` in inline context (not needed for external file, but keep for safety)
- `setTimeout(() => w.print(), 500)` delay lets browser render before print dialog
- Return the window reference so callers can do post-print cleanup if needed

## Apps That Would Use This

| App | Use case |
|---|---|
| DoD Forms | Replace 3 functions with theme=government calls |
| HotelGuru | Guest folios, invoices, housekeeping checklists |
| ITIL | Incident reports, change records |
| CRM | Contact sheets, deal summaries |
| Compliance | Audit reports, policy documents |
| Knowledge | Article print view |
| Capital Assets | Asset inventory sheets |
| Clinical Research | Study reports, consent forms |

## Migration Path

1. Build `pdf-print.js` with all 3 themes
2. Test standalone with a simple submission
3. Refactor DoD Forms to use it (validate output matches current)
4. Add to new apps as needed
