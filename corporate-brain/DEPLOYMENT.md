# Deployment

Credentials always come from the environment: `KINETIC_URL`, `KINETIC_USER` and `KINETIC_PASS`, where the user is a space admin. Nothing is stored in source code or delivered to the browser.

## 1. Kapp, teams, policies, forms and indexes
```
KINETIC_URL=https://ai-labs.kinopsdev.io KINETIC_USER=… KINETIC_PASS=… node apps/corporate-brain/deploy.mjs [--dry-run]
```
The deploy is non-destructive and safe to re-run. It never deletes forms, fields, indexes or submissions. In order, it:
1. Writes `app.json` from `model.mjs`.
2. Creates the kapp `corporate-brain` if it is missing.
3. Creates the teams `Corporate Brain`, `Corporate Brain::Members`, `::Reviewers` and `::Admins`. Teams that already exist are reported, not changed.
4. Creates or updates 8 kapp security policy definitions (see SECURITY.md).
5. Creates missing forms and appends missing fields to existing forms.
6. Merges index definitions (system, unique, single and compound) and runs a `Build Index` background job for anything that isn't `Built`, waiting up to 60 s per form.
7. Applies the kapp security bindings and the form-level overrides for `knowledge-entries`, `sources` and `audit-log`.

## 2. Kinetic Task workflows
```
KINETIC_URL=… KINETIC_USER=… KINETIC_PASS=… node apps/corporate-brain/workflows/deploy-workflows.mjs
```
For each workflow the script:
1. Creates the form workflow if it is missing.
2. Pushes the tree through the sanctioned `skills/skills/concepts/workflow-xml/scripts/put-workflow.mjs`, which validates node IDs, `lastID`, the start node, handler paths and installed handlers before the PUT.
3. Reads `treeJson` back from the Task API to confirm the nodes were stored.
4. **Re-applies `event` and `filter`**, because a PUT that carries only the tree clears the filter, then reads them back and compares.

| Form | Workflow | Event | Filter (KSL) |
|---|---|---|---|
| knowledge-entries | Verification Guard | Submission Updated | `values('Review Status') == 'verified' && (!values('Verified By') \|\| ((!values('Supporting Source IDs') \|\| values('Supporting Source IDs') == '[]') && ['fact','narrative','lesson','summary','interpretation'].indexOf(values('Knowledge Type')) >= 0))` |
| knowledge-entries | Contradiction Review | Submission Submitted | `values('Review Status') == 'proposed' && !!values('Contradicts') && values('Contradicts') != '[]'` |
| research-jobs | Ingestion Retry | Submission Updated | `values('Status') == 'failed' && values('Job Type') == 'ingestion' && parseInt(values('Attempts') \|\| '0', 10) < 3` |

All three use `kinetic_core_api_connection_v1`, whose connection is already configured on ai-labs. Debug runs with `node skills/skills/concepts/workflow-xml/scripts/workflow-debug.mjs`, which reads `/runs/{id}/tasks`.

## 3. App server
The app is a folder under `apps/`. The `:3011` launcher (`apps/base/server.mjs`) auto-discovers `app.json`, `server.mjs` and `index.html`. `index.html` is read from disk on every request, but **`server.mjs` and `lib/*` load once**, so restart the launcher after server changes:
```
launchctl kickstart -k gui/$(id -u)/com.kinetic.base-3011
curl -s http://192.168.86.204:3011/api/corporate-brain/health
```
Users sign in at the launcher with server URL `https://ai-labs.kinopsdev.io`. The app's own login form also works and sends `X-Kinetic-Server`.

## 4. Access
To grant access, add each user to a team, for example with `POST /app/api/v1/memberships {"team":{"name":"Corporate Brain::Members"},"user":{"username":"…"}}`:

| Team | Grants |
|---|---|
| `Corporate Brain::Members` | Read and propose |
| `Corporate Brain::Reviewers` | Verify, reject, dispute and supersede; see restricted sources |
| `Corporate Brain::Admins` | Everything, including products and forms |

Space admins bypass all policies.

## 5. Pilot and tests
```
CB_URL=http://192.168.86.204:3011 KINETIC_URL=… KINETIC_USER=… KINETIC_PASS=… node apps/corporate-brain/pilot/vattenfall-pilot.mjs   # idempotent
node --test apps/corporate-brain/tests/core.test.mjs
KINETIC_URL=… KINETIC_USER=… KINETIC_PASS=… node apps/corporate-brain/tests/api.test.mjs
KINETIC_URL=… KINETIC_USER=… KINETIC_PASS=… node apps/corporate-brain/tests/workflows.test.mjs
cd tests && KINETIC_URL=… KINETIC_PASS=… node test-corporate-brain.mjs <shotDir>
```

## Platform behaviors found during deployment (Core 7.0.0-rc4)
These are recorded in `skills/skills/concepts/security-policies` and `api-basics`.
- **Policy endpoint names:**
  - Kapp: `Display`, `Modification`, `Form Creation`, `Submission Support`, `Default Form Display`, `Default Form Modification`, `Default Submission Access`, `Default Submission Modification`.
  - Form: `Display`, `Modification`, `Submission Access`, `Submission Modification`.
  - Descriptive names such as "Kapp Display" or "Submission Display" are rejected with a 400.
- **`Submission Support` and `Default Form Modification` grant access to every submission and silently override form-level `Submission Access`.** Bind both to admins only. This was proven with a form rule of literally `false`: members could still read the row until `Submission Support` was rebound.
- **Only space admins can set `coreState`.** Non-admin creates return 403. The store therefore creates with `POST …/submissions?completed=true` and `{values}`, which still fires `Submission Submitted` for the Contradiction Review workflow.
- **Unique indexes are case-insensitive.** Case-sensitive external IDs are hashed into `Source ID`.
- The Task engine on ai-labs has no `utilities_echo_v1`. Use only installed handlers; the validator checks this.

## Rollback
- **App:** remove or rename `apps/corporate-brain` and restart the launcher. The Kinetic data is untouched.
- **Workflows:** set `status: "Inactive"` on the three form workflows (`PUT /kapps/corporate-brain/forms/{form}/workflows/{id}`) or delete them.
- **Policies:** re-run `deploy.mjs` after editing `POLICIES`, or remove `securityPolicies` from the kapp and forms. Doing so makes the data visible under the space defaults.
- **Data:** deleting the kapp deletes all Corporate Brain submissions, which is irreversible. Prefer setting `Record Status` instead. The original evidence lives in Drive and other source systems and is unaffected.
