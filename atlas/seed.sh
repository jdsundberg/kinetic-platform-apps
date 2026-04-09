#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="${1:?Usage: $0 SERVER_URL [USERNAME] [PASSWORD]}"
USER="${2:-second_admin}"
PASS="${3:-password2}"
echo ""
echo "  Seeding Data Atlas"
echo "  Server: $SERVER"
echo ""
KINETIC_URL="$SERVER" node "$SCRIPT_DIR/seed.mjs" "$USER" "$PASS"
echo ""
echo "  ✓ Seeding complete!"
echo ""
