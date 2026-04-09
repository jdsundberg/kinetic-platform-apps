#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="${1:?Usage: $0 SERVER_URL [USERNAME] [PASSWORD]}"
USER="${2:-second_admin}"
PASS="${3:-password2}"
echo ""
echo "  Installing Case Management"
echo "  Server: $SERVER"
echo ""
KINETIC_URL="$SERVER" node "$SCRIPT_DIR/setup.mjs" "$USER" "$PASS"
echo ""
echo "  ✓ Installation complete!"
echo ""
