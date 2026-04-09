#!/bin/bash
# Security Operations (SecOps) Application Setup
# ================================================
# Usage: ./setup.sh
#
# Prerequisites:
#   - Node.js 18+
#   - Kinetic Platform instance with sec-ops kapp and forms already created
#
# This script:
#   1. Seeds data into Kinetic
#   2. Starts the SecOps server on port 3007

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   Security Operations (SecOps)       ║"
echo "  ║   Application Setup                  ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Seed data
echo "  → Seeding data into Kinetic Platform..."
node seed.mjs "$@"

echo ""
echo "  → Starting SecOps server on port 3007..."
echo ""

# Start server
exec node server.mjs
