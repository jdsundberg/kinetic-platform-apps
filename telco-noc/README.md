# Telco NOC — Network Operations on Kinetic Platform

Alarm storm → one understandable incident → root resource → impacted sites, services and customers → owner, field work, customer comms → **verified** recovery. Built and tested live on `https://first.kinetics.com`, kapp `telco-noc`.

**Docs:** [findings](docs/repository-findings.md) · [blueprint & screens](docs/blueprint.md) · [architecture](docs/architecture.md) · [data dictionary](docs/data-dictionary.md) · [identifiers & data quality](docs/data-quality.md) · [schemas](docs/schemas/) & [live samples](docs/samples/) · [workflows](docs/workflows.md) · [integrations](docs/integrations.md) · [AI](docs/ai.md) · [test results](docs/test-results.md) · [roadmap](docs/roadmap.md)

## What is in this folder

| Path | What it is |
|---|---|
| `model.mjs` | **Single declaration** of 31 entities (fields, types, enums, lifecycle, filters) → generates forms, indexes, docs |
| `build.mjs` → `app.json` | Kinetic forms + tenant-led indexes (193 definitions, incl. unique business IDs) |
| `deploy/` | `deploy-all.sh` (full idempotent deploy), `install.mjs` (kapp/forms/indexes/attributes/KSL), `security.mjs` (policies), `users.mjs` (pilot users), `seed.mjs` (diff-by-key loader), `verify-indexes.mjs`, `drop-forms.mjs`, `lib.mjs` |
| `workflows/` | `gen-trees.mjs` (one node model → validator XML + treeJson), `deploy-trees.mjs`, generated `*.xml` / `trees.json`: **WebAPI `ingest-event`** (Ruby normalization) + 4 form workflows |
| `engine/` | `catalog.json` (severity/condition/metric maps), `core.mjs` (graph, correlation, impact, verification — pure), `ops.mjs` (runs + state machines), `store.mjs` (Kinetic I/O), `assist.mjs` (grounded assistant) |
| `server.mjs` | NOC API `/api/noc/*`, auto-mounted by `apps/base/server.mjs`; in-process correlator (opt-in) |
| `index.html` | The 8 screens |
| `seed/` | `gen-seed.mjs` → `reference.json` (1,268 records: topology, services, customers, history, 2 tenants) + `scenario-fiber-cut.json` (536 events in 3 phases + metrics + ground truth) |
| `scripts/replay.mjs` | Plays the scenario through the real WebAPI as `int.<tenant>` |
| `scripts/dev-launcher.sh` | Private launcher on :3031 with the correlator enabled |
| `tests/` | `test_norm.rb` (JRuby, deployed Ruby snippet), `engine.test.mjs` (offline truth), `index-combos.mjs`, `security.mjs`, `api-smoke.mjs`, `e2e.mjs` (live vertical slice) |

## Run it

```bash
cd apps/telco-noc
./deploy/deploy-all.sh            # add --fresh on a demo space to drop & recreate the kapp's forms (deletes data)
./scripts/dev-launcher.sh         # launcher on :3031 with NOC_AUTOCORRELATE=1 (exactly one correlator per deployment)
open http://localhost:3031/telco-noc/
```
Env: `KINETIC_URL`, `KINETIC_USER`, `KINETIC_PASS` (installer/service account), `NOC_SERVICE_USER/PASS` (engine identity), `NOC_TEST_PASSWORD` (pilot users; dev default `noc-pilot-2026`), `NOC_AUTOCORRELATE=1` on one process only. The shared :3011 launcher also serves the app after a restart (`apps/base`), but should run **without** `NOC_AUTOCORRELATE` if :3031 is running.

Pilot users (tenant `borealis` unless noted): `noc.borealis` Operator · `owner.borealis` Service Owner · `tech.borealis` Field Tech · `support.borealis` Support Agent · `exec.borealis` Executive · `noc.prairie` Operator (tenant `prairie`) · `int.borealis` / `int.prairie` Integration. Admins (e.g. `john`) get a "view as role" selector (navigation preview only — the server still enforces real permissions).

## Tests

```bash
ruby tests/test_norm.rb <(node -e 'import("./workflows/gen-trees.mjs").then(m=>process.stdout.write(m.NORM))')   # 33 Ruby checks
node --test tests/engine.test.mjs      # 16 offline checks vs ground truth
node tests/index-combos.mjs            # every filter combination → 200 on the live store
node tests/security.mjs                # tenant isolation + roles, direct REST and API, ingest binding
node tests/api-smoke.mjs               # every screen's endpoint returns real data
node tests/e2e.mjs                     # the live vertical slice (~15 min: 3 replays + ack timer)
```

## Demo script (≈ 20 minutes)

1. **Before** — sign in as `noc.borealis`. Command Center: no open incidents; integration panel shows GIS *Degraded* and WFM/notify-gw *Not Configured* (the product keeps working).
2. **The cut** — `node scripts/replay.mjs --phase=cut --launcher=http://localhost:3031` (316 events from 5 systems, incl. duplicates, resyncs, late, skewed, malformed and unrelated noise; ~4 min). Watch the funnel: ~306 raw → 163 alarms → 1 group → **1 P1 incident**.
3. **Incident Workspace** — the five questions: root `FIB-MSP-STP-01` (probable, 92%: both ends lost light), 15 confirmed / 1 inferred / 12 potential services, 10 accounts incl. East Metro Public Safety Radio, ~19.6k subscribers, owner auto-assigned. Services tab: *why* each service is in its class (path, evidence; the re-homed credit union circuit shows the inventory conflict). Alarms tab: root evidence vs symptoms, cross-source merges, notes.
4. **Impact Map** — the dashed red span, 9 sites down, 9 at risk (3 on microwave).
5. **Act** — Acknowledge, Declare major (reason), AI assist → accept the summary, reject the alternative hypothesis with a reason. Create work order → sign in as `tech.borealis` and try to dispatch (refused) → back as operator **Approve dispatch** (parts reserved).
6. **Comms** — Draft customer update → Submit → try to approve as operator (refused) → sign in as `owner.borealis`, Approve → within seconds the Kinetic workflow marks it *Sent* (simulated channel, stated). Sign in as `support.borealis` → Customers → Riverbend Medical: only the approved text.
7. **Field** — as `tech.borealis`: Accept → En Route → On Site → Complete (findings + OTDR evidence). The incident's verification flips to *Pending* (Kinetic workflow). Operator records the observed cause.
8. **Restore** — `node scripts/replay.mjs --phase=restore …` → **Verify recovery**: network recovered, but **SVC-RAN-STP-C07 fails** (cell site router hung) and Highland Grocers (unmonitored) needs confirmation. Resolve is allowed; **Close is refused**. Optional: show the platform guard — write `State=Closed` directly via the Kinetic API and watch the Closure Guard workflow revert it.
9. **Finish** — `--phase=reboot`, record Highland's confirmation, Verify → **Passed**; draft/approve the Resolution notice; Close. Executive dashboard: MTTR measured to verified recovery; recurring failure point FIB-MSP-STP-01 (3 incidents).
10. **Reset** — `POST /api/noc/demo/reset {"batch":"<batch>"}` as admin (deletes only that replay batch's runtime records).
