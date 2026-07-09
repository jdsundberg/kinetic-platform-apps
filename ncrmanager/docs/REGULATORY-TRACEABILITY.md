# Regulatory Traceability Matrix

This maps system capabilities to clauses of the standards MedQMS is designed to support. **Mappings,
interpretations, retention periods and approval rules are configurable and must be reviewed and
approved by the customer's quality and legal functions.** Software does not by itself confer compliance
or certification.

Legend: **13485** = ISO 13485:2016 · **QMSR** = 21 CFR Part 820 / QMSR (eff. 2026-02-02, incorporating
ISO 13485) · **14971** = ISO 14971:2019 · **Part 11** = 21 CFR Part 11 · **MDR** = EU 2017/745.

| Capability (MedQMS) | 13485 | QMSR / Part 820 | 14971 | Part 11 | EU MDR |
|---|---|---|---|---|---|
| Document & record control (`documents`, revisions, effective/obsolete) | 4.2.3–4.2.5 | 820.40 | — | 11.10(b,c) | Annex IX 2 |
| Management review package (`mgmt-reviews`) | 5.6 | 820.20(c) | — | — | Art. 10(9) |
| Quality-event intake / data analysis (`quality-events`) | 8.4 | 820.100, 820.250 | 10 | — | Annex III |
| Nonconforming product & MRB (`nonconformances`) | 8.3 | 820.90 | — | — | — |
| CAPA lifecycle incl. effectiveness (`capas`, `capa-actions`) | 8.5.2–8.5.3 | 820.100 | — | — | Annex IX |
| Complaint handling & vigilance (`complaints`) | 8.2.2 | 820.198 | — | — | Art. 87–92 |
| Reportability decision & deadlines (MDR/MIR fields) | 8.2.3 | 803 (MDR) | — | — | Art. 87 |
| Internal/supplier/external audits (`audits`, `audit-findings`) | 8.2.4 | 820.22 | — | — | Annex IX 2.2 |
| Auditor independence | 8.2.4 | 820.22 | — | — | — |
| Supplier qualification, scorecards, SCAR (`suppliers`, `scars`) | 7.4 | 820.50 | — | — | Annex IX 2.2 |
| Training & competency (`training-records`, matrices) | 6.2 | 820.25 | — | 11.10(i) | — |
| Risk management file (`risks`, residual, benefit-risk) | 7.1, 0.2 | 820.30(g) | 4–10 | — | Annex I 3 |
| Post-production information → risk | 8.4 | 820.100 | 10 | — | Art. 83 (PMS) |
| Design & product records (DMR via `products`) | 7.3 | 820.30, 820.181 | — | — | Annex II |
| Equipment, calibration, OOT (`equipment`) | 7.6 | 820.72 | — | — | — |
| Change control + impact + validation (`change-requests`) | 7.3.9, 4.1.4 | 820.30(i), 820.70(b) | — | — | Art. 10(9) |
| **Append-only audit trail** (actor, time, old/new, reason) | 4.2.5 | 820.180, 820.186 | — | **11.10(e)** | Annex IX |
| **Electronic signatures** (meaning, re-auth, binding) | — | — | — | **11.50, 11.70, 11.200** | — |
| Record retention (configurable) | 4.2.5 | 820.180(b) | — | 11.10(c) | Annex IX 8 |
| Access control / least privilege (KSL) | 4.2.5, 6.2 | 820.180 | — | **11.10(d,g)** | — |

## How each control is evidenced in the system

- **Audit trail (11.10(e), 820.186):** `audit-trail` form — append-only; every regulated edit records
  actor, timestamp, field, previous → new value, reason for change, workflow state, source and
  correlation ID. Surfaced per-record in the record-360 timeline and globally in **Admin → Audit Trail**.
- **Electronic signature (11.50/11.70/11.200):** `esignatures` form — re-authenticated signing event
  with printed name, meaning (configurable list), reason, record version, method and tamper-evident
  hash, bound to the signed record. CAPA/complaint/change/document/MR closures are signature-gated.
- **CAPA effectiveness (8.5.2):** closure blocked until actions verified, effectiveness criteria defined
  and result = Passed, with an *independent* effectiveness signature (separation of duties).
- **Reportability (820.198 / MDR Art. 87):** complaint reportability decision and regulatory due date
  tracked; breaches escalate and appear on the executive dashboard ("Reg. Reporting Overdue").
- **Risk file (14971):** initial → residual risk with controls, verification and benefit-risk decision;
  post-production signals link complaints/CAPAs/NCs back to the impacted risk.

> **Disclaimer.** This matrix is a configurable *aid to demonstrating* process coverage. It is not a
> certification, legal determination, or guarantee of regulatory acceptance. Customers must validate
> the system for their intended use and obtain quality/legal sign-off on all mappings.
