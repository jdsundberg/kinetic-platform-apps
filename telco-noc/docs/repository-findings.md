# 1 · Repository Findings & Platform Constraints

What I inspected before designing, what the platform actually provides, and what I verified by running it. "Verified" means exercised against `https://first.kinetics.com` (Core 7.0.0, build f6faf51, Task engine with Ruby/JRuby) during this build.

## Sources inspected

| Source | Path | Used for |
|---|---|---|
| Kinetic Platform CE installer | `~/dev/kinetic_install/kinetic-platform-community-edition` (`README.md`, `kinetic` CLI, `kinetic-platform-installer.tar.gz` → Helm chart `kinetic-platform-7.0.0.tgz`) | Deployment model, components, limits |
| Kinetic AI skills (canonical platform knowledge) | `skills/skills/concepts/*/SKILL.md` — webapis-and-webhooks, workflow-xml, workflow-creation, workflow-engine, security-policies, kql-and-indexing, api-basics; `platform/known-bugs` | APIs, gotchas, the workflow gate scripts |
| Workflow gate scripts | `skills/skills/concepts/workflow-xml/scripts/validate-workflow.mjs`, `put-workflow.mjs` | Mandatory validation of every tree (all 5 trees pass) |
| Working examples | `apps/cpq/workflows/gen-trees.mjs` + `put-trees.mjs` (proven treeJson path), `apps/mfgdream` (installer, server.mjs export pattern), `apps/base/server.mjs` (launcher, auto-discovery, `collectByQuery`) | Patterns reused |
| Repo rules | `CLAUDE.md`, `apps/CLAUDE.md`, `docs/app-build-prompt.md` | Conventions: no npm deps, single-file UI, ≤25 records/page, state machines as whitelists, invariant tests, index combinations |

## CE deployment facts (file references inside the Helm chart unless noted)

- Single-node **k0s + Helm + NFS** (`README.md:58-74`); every service 1 replica, no HPA (`env.values.yaml.tpl:164-223`). Chart `kinetic-platform` 7.0.0, appVersion **7.0.0-rc-1**.
- Per-space **Task engine** `kinetic-task` limited to **1 CPU / 2 GiB** (`values.yaml:2285-2295`); per-space **Integrator 6.1.7** 1 CPU / 512 MiB (`values.yaml:2320-2328`).
- Stores: **Cassandra 4.1.11** (Core), **PostgreSQL 16** (Task, Integrator; nightly backup 7-day retention, `env.values.yaml.tpl:229-242`), Elasticsearch 8.19 optional (logs). RabbitMQ internal only.
- Auth configured: username/password (Basic); **no SAML/OIDC config** shipped (`core.configMap.yaml:21-26` empty `security.properties`) — SSO is per-space post-install work.
- **Unlicensed limit: 1,000 submissions** then the submission engine stops (`README.md:117-119`, `kinetic:811-813`). This slice stores ~2,000 records per demo run → **a license is a hard prerequisite** for any pilot (first.kinetics.com is licensed; its history shows periodic licensing stops — see memory note).
- No streaming ingest, no graph, geospatial or time-series store. → alarm floods must be absorbed by an adapter; topology traversal runs in the NOC service; map is schematic from stored lat/lon.

## Platform capabilities used — and verified

| Capability | Mechanism | Verified behaviour |
|---|---|---|
| Data definitions | Kapp + 31 forms via Core API; fields `required` | Required fields enforced on API submit (400 `fieldConstraintViolations`) |
| Queries | KQL with compound, tenant-led indexes; `IN`; `count=true`; keyset paging | 44 filter combinations return 200; missing combination → 400 naming the index |
| Idempotency | **Unique** compound index | `uniqueness_violation` (case-insensitive) on duplicates — **but only if defined before data** (new finding, below) |
| Inbound API | **WebAPI** (`/app/kapps/telco-noc/webApis/ingest-event`) → Task tree | Works with `?timeout=25`; `@request['Body']`, `@requested_by`; multiple exclusive Return nodes; ~0.5–1 s/event single-caller |
| Custom code | **Ruby** in ERB parameters/connector conditions (JRuby 9.4) | 33 unit tests of the exact deployed snippet pass under JRuby locally; live behaviour matches |
| Platform calls from workflows | `kinetic_core_api_connection_v1` (installed; service-account connection) | `body` + `extra_headers` must be present; paths `/app/api/v1/...` |
| Timers | `system_wait_v1` deferral in a form workflow | Ack timer escalates after 3 min (e2e) |
| Event triggers | Form workflows on Submission Created/Updated | Closure guard reverts direct writes; field completion; delivery |
| Security | Kapp security policy definitions (KSL/JS) bound per form + WebAPI Execution; admin-set user attributes | Tenant isolation + role rules verified with real non-admin users on direct REST and via the API |
| Handlers installed on this engine | `kinetic_core_api_connection_v1`, `smtp_email_send_v1`, `servicenow_connection_v1`, `microsoft_graph_connection_v1`, others | No `utilities_echo_v1` → Ruby normalization is re-evaluated per node (generated from one snippet, so no drift) |

## New platform findings (written to the shared skills, per project rule)

1. **Unique indexes never build on a form that has (ever had) submissions** — job accepted then silently vanishes; stays `New`; deleting all data or re-adding the definition does not help; only form delete + recreate works. → `skills/skills/concepts/kql-and-indexing/SKILL.md` ("Unique indexes: define them BEFORE the form has data"). Cost me a reinstall; the installer now builds every index before seeding.
2. **WebAPIs without a security policy are admin-only** (401 anonymous / 403 non-admin), not "run as admin" as the skill said → corrected in `security-policies/SKILL.md`.
3. **Submission policies are not evaluated on create; non-admins cannot set `coreState`** (403) but can create Drafts with any field values → added to `security-policies/SKILL.md`; documented as a known tenant-stamping gap with mitigation.
4. (Existing, observed) **Bug 5 is live on this space**: non-admin `GET /kapps` returns 500 because the *Kinetic Insights* kapp's "Space Admin" Display policy fails to evaluate. Not caused by this app; the NOC app does not call `GET /kapps`. **Needs an owner decision** (fix that kapp's policy).

## Constraints that shaped the design

- **Ingest throughput**: one WebAPI run per event with 5 Core calls ≈ **1.3 events/s** sustained on this space (316 events in 216–250 s at 8 parallel callers). A real fiber cut can emit thousands of events/minute → production needs the batch envelope (designed) and/or an external buffer (Kafka) with back-pressure.
- **No graph primitives** in Core/Task → correlation and impact run in the NOC service (Node, pure functions, 16 offline tests).
- **Every value is a string**; types enforced by writers + JSON Schemas.
- **1,000-row cap per KQL result and 25/page UI rule** → keyset paging in the service; aggregate endpoints cached 8–15 s.
- **Shared launcher**: this repo's :3011 launcher is used by other sessions; I ran a dedicated instance on :3031 for development (`scripts/dev-launcher.sh`). The :3011 process still holds an earlier build of `server.mjs` until it is restarted.
