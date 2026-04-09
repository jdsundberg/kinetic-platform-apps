#!/usr/bin/env bash
set -euo pipefail

KINETIC="${KINETIC_URL:-https://second.jdsultra1.lan}"
USER="${KINETIC_USER:-second_admin}"
PASS="${KINETIC_PASS:-password2}"
KAPP="atlas"
AUTH=$(printf '%s:%s' "$USER" "$PASS" | base64)

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   Atlas Setup                         ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  Target: $KINETIC"
echo "  Kapp:   $KAPP"
echo ""

# ── Create Kapp ──
echo "  Creating kapp '$KAPP'..."
curl -sk -X POST "$KINETIC/app/api/v1/kapps" \
  -H "Authorization: Basic $AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Atlas\",\"slug\":\"$KAPP\"}" \
  -o /dev/null -w "  HTTP %{http_code}\n" || true

# ── Helper to create a form ──
create_form() {
  local slug="$1"
  local name="$2"
  local fields="$3"
  echo "  Creating form: $slug ($name)..."
  curl -sk -X POST "$KINETIC/app/api/v1/kapps/$KAPP/forms" \
    -H "Authorization: Basic $AUTH" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$name\",\"slug\":\"$slug\",\"fields\":$fields}" \
    -o /dev/null -w "  HTTP %{http_code}\n" || true
}

# ── Create forms ──
create_form "domain" "Domain" \
  '[{"name":"Name"},{"name":"Description","rows":3},{"name":"Status"},{"name":"Owner"},{"name":"Tags"},{"name":"Icon Color"}]'

create_form "system" "System" \
  '[{"name":"Name"},{"name":"Description","rows":3},{"name":"System Type"},{"name":"Technology"},{"name":"Environment"},{"name":"Domain"},{"name":"Owner"},{"name":"Status"},{"name":"Tags"},{"name":"Connection Info"}]'

create_form "dataset" "Dataset" \
  '[{"name":"Name"},{"name":"Description","rows":3},{"name":"System"},{"name":"Domain"},{"name":"Dataset Type"},{"name":"Schema Name"},{"name":"Record Count"},{"name":"Refresh Frequency"},{"name":"Source of Truth"},{"name":"Owner"},{"name":"Classification"},{"name":"Status"},{"name":"Tags"},{"name":"Version"}]'

create_form "field" "Field" \
  '[{"name":"Name"},{"name":"Description","rows":3},{"name":"Dataset"},{"name":"System"},{"name":"Data Type"},{"name":"Max Length"},{"name":"Nullable"},{"name":"Primary Key"},{"name":"Foreign Key Target"},{"name":"Default Value"},{"name":"Allowed Values"},{"name":"Example Values"},{"name":"Business Definition","rows":3},{"name":"Glossary Term"},{"name":"Classification"},{"name":"Status"},{"name":"Tags"},{"name":"Sort Order"}]'

create_form "glossary-term" "Glossary Term" \
  '[{"name":"Name"},{"name":"Definition","rows":5},{"name":"Domain"},{"name":"Synonyms"},{"name":"Related Terms"},{"name":"Owner"},{"name":"Status"},{"name":"Version"},{"name":"Tags"}]'

create_form "relationship" "Relationship" \
  '[{"name":"Name"},{"name":"Relationship Type"},{"name":"Source Entity Type"},{"name":"Source Entity"},{"name":"Target Entity Type"},{"name":"Target Entity"},{"name":"Confidence"},{"name":"Description","rows":3},{"name":"Status"}]'

create_form "classification" "Classification" \
  '[{"name":"Name"},{"name":"Category"},{"name":"Sensitivity Level"},{"name":"Regulation"},{"name":"Retention Period"},{"name":"Description","rows":3},{"name":"Status"}]'

create_form "owner" "Owner" \
  '[{"name":"Name"},{"name":"Email"},{"name":"Team"},{"name":"Role"},{"name":"Domains"},{"name":"Systems"},{"name":"Status"}]'

create_form "quality-rule" "Quality Rule" \
  '[{"name":"Name"},{"name":"Dataset"},{"name":"Field"},{"name":"Rule Type"},{"name":"Expression"},{"name":"Description","rows":3},{"name":"Severity"},{"name":"Status"}]'

create_form "issue" "Issue" \
  '[{"name":"Title"},{"name":"Description","rows":5},{"name":"Issue Type"},{"name":"Severity"},{"name":"Status"},{"name":"Related Domain"},{"name":"Related System"},{"name":"Related Dataset"},{"name":"Related Field"},{"name":"Related Term"},{"name":"Evidence","rows":3},{"name":"Recommendation","rows":3},{"name":"Assigned To"},{"name":"Resolution","rows":3}]'

create_form "change-log" "Change Log" \
  '[{"name":"Entity Type"},{"name":"Entity ID"},{"name":"Entity Name"},{"name":"Action"},{"name":"Changed By"},{"name":"Timestamp"},{"name":"Details","rows":3},{"name":"Notes"}]'

create_form "scan-result" "Scan Result" \
  '[{"name":"Scan ID"},{"name":"Source Type"},{"name":"Source Name"},{"name":"Scan Status"},{"name":"Started At"},{"name":"Completed At"},{"name":"Systems Found"},{"name":"Datasets Found"},{"name":"Fields Found"},{"name":"Relationships Found"},{"name":"Issues Found"},{"name":"Scanned By"},{"name":"Notes","rows":3}]'

echo ""
echo "  ✓ Kapp and forms created"
echo ""

# ── Build indexes ──
echo "  Building indexes..."
node "$(dirname "$0")/build_indexes.mjs" "$USER" "$PASS"

# ── Seed data (optional) ──
if [[ "${1:-}" == "seed" ]]; then
  echo ""
  echo "  Seeding demo data..."
  node "$(dirname "$0")/seed.mjs" "$USER" "$PASS"
fi

# ── Start server ──
echo ""
echo "  Starting Atlas server..."
exec node "$(dirname "$0")/server.mjs"
