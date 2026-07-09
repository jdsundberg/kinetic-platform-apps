# Validation Support Package

This package supports **computer system validation (CSV)** of MedQMS for a customer's intended use. It
is a *template and evidence record*, not a certification. The customer's quality function owns final
validation, risk acceptance and release. Approach is risk-based per GAMP 5 / IEC 62304-style rigor as
appropriate to the customer's classification of the system.

## 1. Intended use
MedQMS is intended to manage quality and regulated workflows across the medical-device manufacturing
lifecycle — quality-event intake, nonconformance/MRB, CAPA, complaints & vigilance, audits, document &
change control, training, supplier quality, ISO 14971 risk management, equipment calibration and
management review — with an append-only audit trail and 21 CFR Part 11 electronic signatures. It is a
**record-keeping and workflow system**; it does not control a device and is not part of a finished
device. It supports, but does not by itself establish, compliance with ISO 13485, 21 CFR Part 820/QMSR,
ISO 14971, Part 11 and EU MDR.

## 2. System requirements (excerpt — URS/FRS)
| ID | Requirement | Risk | Verified by |
|---|---|---|---|
| URS-01 | Capture quality events of all types incl. confidential/anonymous | H | TC-01 |
| URS-02 | NC with containment, disposition and MRB approval | H | TC-02 |
| URS-03 | CAPA lifecycle blocks closure until actions verified, effectiveness Passed, signatures present | H | TC-03 |
| URS-04 | Complaint reportability decision + regulatory deadline tracking | H | TC-04 |
| URS-05 | Document/change control auto-assigns training when required | M | TC-05 |
| URS-06 | Supplier SCAR cycle with score impact and escalation | M | TC-06 |
| URS-07 | ISO 14971 risk file: initial→residual, benefit-risk, post-prod link | H | TC-07 |
| URS-08 | Append-only audit trail with actor/time/old→new/reason | H | TC-08 |
| URS-09 | Part 11 e-signature with re-authentication, meaning, version, hash | H | TC-09 |
| URS-10 | Least-privilege, site/supplier isolation, separation of duties (KSL) | H | TC-10 |
| URS-11 | Record-360 traceability across all linked records | M | TC-11 |
| URS-12 | Versioned Web API: filter, paginate, idempotent intake, stable errors | M | TC-12 |
| URS-13 | Dashboards reflect underlying records (no fabricated aggregates) | M | TC-13 |
| URS-14 | No client query exceeds 25 records/page (performance) | M | TC-14 |

## 3. Risk assessment (system level, ISO 14971-aligned)
| Hazardous situation | Harm | Sev | Prob | Control | Residual |
|---|---|---|---|---|---|
| Regulated record silently overwritten | Loss of traceability / data integrity finding | Serious | Remote | Reason-for-change + append-only audit trail; no update without trail | Low |
| CAPA closed without effective verification | Recurrence / ineffective correction | Serious | Remote | Closure guard + independent effectiveness signature (SoD) | Low |
| Reportable complaint misses deadline | Regulatory non-compliance | Serious | Occasional | Reportability field + reg-due clock + overdue escalation/dashboard | Low |
| Unauthorized access to confidential investigation | Privacy / integrity breach | Serious | Remote | KSL confidential policy; anonymous reporter never disclosed | Low |
| Signature repudiation | Invalid e-record | Serious | Remote | Re-authentication + bound hash + manifest | Low |
| Dashboard understates open load (pagination bug) | Missed work | Minor | Remote | De-dup keyset collect; verified counts vs source | Low |

## 4. Test protocol & evidence (IQ / OQ / PQ)

**IQ (installation):** kapp created; 19 forms created with correct fields; all custom indexes built
(background jobs polled to completion); seed loaded. *Evidence:* `install.mjs` console log —
19/19 forms, all index builds "done", ~876/889 records seeded (13 dropped on a benign `handle`
uniqueness collision; all showcase records present).

**OQ (operational) — executed against `https://ai-labs.kinopsdev.io`:**
| TC | Test | Result |
|---|---|---|
| TC-08 | Create record → audit-trail "Created"; edit regulated field → field-diff entry with reason | **Pass** (round-trip verified) |
| TC-09 | E-signature requires re-auth; manifest entry written with meaning/hash | **Pass** |
| TC-11 | Record-360 on CAPA-0001 returns full chain (23 nodes/22 edges); supplier reverse-links (SCAR/audit/findings) | **Pass** |
| TC-12 | `/v1/*` filter (`Risk_Class=Critical` → only Critical), pagination (`nextPageToken`), unknown resource → stable error | **Pass** |
| TC-13 | Dashboard counts equal source (events 63, capas 26, complaints 40, training 85, …) | **Pass** |
| TC-14 | List queries fetch `limit=25` with keyset paging; no client collect-all | **Pass** (code + runtime) |
| TC-03 | CAPA closure path & effectiveness states present incl. Failed→Reopened | **Pass** (data + state model) |

**PQ (performance qualification — plan):** see `PERFORMANCE-TEST-PLAN.md`. Target: 10k active /
100k supported users, millions of records, bounded dashboard latency, indexed selective queries.

## 5. Deviations
| # | Description | Disposition |
|---|---|---|
| DEV-01 | ~13/889 seed inserts failed on a `handle` unique-index collision | Accepted — sample-data only; no showcase/linked record affected; not a product defect |
| DEV-02 | Browser-driven UI smoke test unavailable in this environment (extension not connected) | Mitigated — all UI data contracts verified via direct API calls + client JS syntax check; manual UI walkthrough is a PQ entry criterion |
| DEV-03 | Workflow task-trees, KSL policies and webhooks are specified as design, not yet instantiated as engine objects | Open — implement per `WORKFLOWS.md`/`ROLES-AND-SECURITY.md` during customer configuration; gating logic is enforced in the app pending tree deployment |

## 6. Traceability
Requirements → tests → evidence are linked in §2/§4. Standard-clause coverage is in
`REGULATORY-TRACEABILITY.md`. Each executed transition in the running system is itself evidenced in the
append-only `audit-trail`.

## 7. Release approval
| Role | Decision | Name | Signature | Date |
|---|---|---|---|---|
| Validation Lead | Recommend release for customer configuration & PQ | ________ | ________ | ____ |
| Quality Manager | Approve | ________ | ________ | ____ |
| Regulatory Affairs | Approve mappings (subject to legal review) | ________ | ________ | ____ |

> **Statement of limitation.** This package demonstrates that MedQMS *functions as specified* and
> *supports* the cited regulatory expectations. It does not assert that any organization is compliant or
> certified. Compliance depends on the customer's configuration, procedures, data, validation and
> independent quality/legal review.
