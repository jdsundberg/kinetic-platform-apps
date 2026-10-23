# Trustworthy AI Assistance

## What is implemented (and what is not)

| Feature | Implemented as | Status |
|---|---|---|
| Incident summary | `generate("Summary")` — facts from incident, group, root-evidence alarms, impacts, WOs; inferences = hypothesis + recurrence | ✅ rules/v1 |
| Probable-cause hypotheses | `generate("Hypothesis")` — engine hypothesis + top alternatives from correlation evidence + change/history checks | ✅ rules/v1 |
| Next diagnostic steps / runbook | `generate("Next Step" | "Runbook")` — runbook matched by resource type / alarm type; approval-requiring steps flagged | ✅ rules/v1 |
| Customer update drafts | `generate("Customer Draft")` — customer-safe wording; Initial / Update / Resolution | ✅ rules/v1 |
| Recurring failure detection | `generate("Recurrence")` + Executive "recurring failure points" | ✅ rules/v1 |
| Natural-language questions | `answer()` — **intent matcher** over authorized records (affected customers, root cause, SLA, recovery, owner, public safety) with citations | ✅ (not an LLM) |
| LLM generation | 📐 designed adapter below | **Not implemented** — no model API key/endpoint available in this environment; I did not want to ship untested LLM code |

The generator is deliberately labelled `rules/v1` in every stored record so nobody mistakes template output for model output.

## The contract every generator (rules or LLM) must meet

Stored in `ai-recommendations`:
- `Facts[]` — each `{text, citations:[{form, id, at}]}`; a fact **without** a citation is invalid.
- `Inferences[]` — each `{text, confidence 0..1, citations[]}`; shown dashed/amber with the percentage.
- `Citation Check` — `checkCitations()` resolves every citation against the set of records fetched **with the requesting user's credentials**; any miss → the recommendation is stored as `Rejected` with `Feedback: auto-rejected: citation check failed` and never shown as a proposal. (Prevents both hallucinated IDs and leakage of records the user may not see.)
- `Requires Approval Action` — `dispatch | send-comms | close | config-change | none`. Accepting a recommendation **never executes** anything; the gated action still needs its own explicit human approval (dispatch approval, Service-Owner comms approval, closure blockers). There is no code path from AI output to a network configuration change.
- Operator decision: `Accepted` / `Rejected` (reason **required**) + `Decided By/At` → the evaluation signal. Older proposals of the same kind are `Superseded`.

## 📐 LLM adapter (design)
`engine/assist.mjs` gains `generateLLM(kind, pack)`: build the same evidence pack (records the user can see; PII stripped; contacts never included), send it with a system prompt that requires JSON `{facts[], inferences[], content, requiresApproval}` where every fact cites `form:id`; validate with the same `checkCitations()`; on failure fall back to rules/v1. Model and endpoint configurable per tenant (data-residency), temperature 0, prompts/versioned in the catalog, full prompt+response stored for audit. Needs: model endpoint + key, and a tenant decision on which data may leave the platform.

## Evaluation set & criteria (📐 harness partially implemented)

**Set**: historical incidents with ground truth — the seeded history (5 incidents with confirmed causes) + the fiber-cut scenario (`seed/scenario-fiber-cut.json` → `truth`) + 📐 to add before pilot: 30–50 real closed incidents from the operator (alarms export + inventory snapshot + ticket timeline + confirmed cause), and synthetic variants (single-site power loss, card failure with one-sided LOS, flapping optic, maintenance-caused, dual failure).

| Criterion | Metric | Pass bar (pilot) | Measured now |
|---|---|---|---|
| Root-cause accuracy | top-1 root resource == confirmed root | ≥ 85% | fiber cut: correct (1/1) — `tests/engine.test.mjs`, live e2e |
| Impact accuracy | precision/recall of Confirmed+Inferred services vs truth | ≥ 0.95 / ≥ 0.98 | 1.0 / 1.0 on the scenario (exact set match, offline + live) |
| Factual accuracy | % of facts whose cited record contains the stated value (spot-checked by reviewer) | ≥ 98% | citation *resolution* 100% (automated); value-check is manual 📐 |
| Hallucination / leakage | citations not resolvable by the user | 0 | 0 (automated check blocks them) |
| Unsafe recommendations | suggestion that would execute or recommend an ungated risky action (config change, closure, dispatch, comms) without approval flag | 0 | 0 — gated kinds carry the flag (asserted in e2e) |
| Operator acceptance | accepted / (accepted + rejected) per kind | ≥ 70% summary/next-step | recorded per decision; no population yet |
| Time saved | MTTA and time-to-first-customer-update, with vs without assist (A/B by shift) | −30% | not measurable without a live pilot |
