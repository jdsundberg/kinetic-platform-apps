#!/bin/bash
# Full, idempotent deployment of the Telco NOC to a Kinetic space.
#   KINETIC_URL / KINETIC_USER / KINETIC_PASS  (defaults: dev space in this repo)
#   --fresh   drop and recreate all telco-noc forms first (demo/pilot spaces only — deletes data)
set -euo pipefail
cd "$(dirname "$0")/.."
[ "${1:-}" = "--fresh" ] && node deploy/drop-forms.mjs --yes
node build.mjs                                   # model.mjs → app.json (forms, fields, indexes incl. unique)
node deploy/install.mjs                          # kapp, forms, ALL indexes built BEFORE data, user attrs, KSL policies
node deploy/verify-indexes.mjs                   # every declared index must be Built
node deploy/users.mjs                            # pilot users + integration identities (admin-set attributes)
node workflows/gen-trees.mjs                     # trees from one node model → xml (gate) + treeJson
for f in workflows/*.xml; do KINETIC_URL="${KINETIC_URL:-https://first.kinetics.com}" node ../../skills/skills/concepts/workflow-xml/scripts/validate-workflow.mjs --tree "$f" >/dev/null || { echo "✗ validator refused $f"; exit 1; }; done
node workflows/deploy-trees.mjs                  # WebAPI + 4 form workflows, read back and counted
node deploy/seed.mjs                             # reference data (idempotent by business key)
echo "✓ deployed. Start/restart the launcher (apps/base) to load server.mjs, then open /telco-noc/"
