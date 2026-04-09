#!/bin/bash
# Asset Management Console — Setup & Run
# Requires: Node.js 18+, Python 3, a Kinetic Platform instance with the asset-management kapp

set -e
cd "$(dirname "$0")"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     Asset Management Console         ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Configuration
: "${KINETIC_URL:?Set KINETIC_URL to your Kinetic Platform URL (e.g. https://myspace.kinops.io)}"
: "${KINETIC_USER:=admin}"
: "${KINETIC_PASS:=admin}"
: "${PORT:=3004}"

export KINETIC_URL KINETIC_USER KINETIC_PASS PORT
export NODE_TLS_REJECT_UNAUTHORIZED=0

echo "  Kinetic:  $KINETIC_URL"
echo "  User:     $KINETIC_USER"
echo "  Port:     $PORT"
echo ""

AUTH=$(printf '%s:%s' "$KINETIC_USER" "$KINETIC_PASS" | base64)
API="$KINETIC_URL/app/api/v1"

if [ "$1" = "seed" ]; then
  echo "  Seeding 1000 assets..."
  python3 seed_assets.py
  echo ""
  echo "  Seeding complete!"
  echo ""
fi

# Ensure KQL index definitions exist on the assets form
echo "  Checking form index definitions..."
CURRENT_INDEXES=$(curl -sk -H "Authorization: Basic $AUTH" \
  "$API/kapps/asset-management/forms/assets?include=indexDefinitions" 2>/dev/null)

NEED_BUILD=false
for FIELD in 'values[Status]' 'values[Category]' 'values[Asset Name]' 'values[Status],values[Category]'; do
  if ! echo "$CURRENT_INDEXES" | grep -q "$FIELD"; then
    NEED_BUILD=true
    break
  fi
done

if [ "$NEED_BUILD" = true ]; then
  echo "  Adding single-field and compound index definitions..."
  curl -sk -X PUT -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
    "$API/kapps/asset-management/forms/assets" \
    -d '{"indexDefinitions":[{"name":"closedBy","parts":["closedBy"],"unique":false},{"name":"createdBy","parts":["createdBy"],"unique":false},{"name":"handle","parts":["handle"],"unique":false},{"name":"submittedBy","parts":["submittedBy"],"unique":false},{"name":"updatedBy","parts":["updatedBy"],"unique":false},{"name":"idx_status","parts":["values[Status]"],"unique":false},{"name":"idx_category","parts":["values[Category]"],"unique":false},{"name":"idx_asset_name","parts":["values[Asset Name]"],"unique":false},{"name":"idx_status_category","parts":["values[Status]","values[Category]"],"unique":false},{"name":"idx_status_asset_name","parts":["values[Status]","values[Asset Name]"],"unique":false},{"name":"idx_category_asset_name","parts":["values[Category]","values[Asset Name]"],"unique":false},{"name":"idx_status_category_asset_name","parts":["values[Status]","values[Category]","values[Asset Name]"],"unique":false}]}' >/dev/null 2>&1

  echo "  Building indexes..."
  curl -sk -X POST -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
    "$API/kapps/asset-management/forms/assets/backgroundJobs" \
    -d '{"type":"Build Index","content":{"indexes":["values[Status]","values[Category]","values[Asset Name]","values[Status],values[Category]","values[Status],values[Asset Name]","values[Category],values[Asset Name]","values[Status],values[Category],values[Asset Name]"]}}' >/dev/null 2>&1

  echo "  Waiting for index build..."
  for i in $(seq 1 30); do
    sleep 2
    STATUS=$(curl -sk -H "Authorization: Basic $AUTH" \
      "$API/kapps/asset-management/forms/assets?include=indexDefinitions" 2>/dev/null)
    if echo "$STATUS" | grep -q '"New"'; then
      printf "."
    else
      echo " done"
      break
    fi
    if [ "$i" = "30" ]; then
      echo ""
      echo "  Warning: indexes still building — KQL queries may not work immediately"
    fi
  done
else
  echo "  Index definitions OK"
fi
echo ""

echo "  Starting server on http://localhost:$PORT"
echo ""
node server.mjs
