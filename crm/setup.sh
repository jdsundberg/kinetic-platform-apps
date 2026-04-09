#!/bin/bash
# CRM Console — Setup & Run
# Requires: Node.js 18+, a Kinetic Platform instance

set -e
cd "$(dirname "$0")"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║          CRM Console                 ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Configuration
: "${KINETIC_URL:?Set KINETIC_URL to your Kinetic Platform URL (e.g. https://myspace.kinops.io)}"
: "${KINETIC_USER:=admin}"
: "${KINETIC_PASS:=admin}"
: "${PORT:=3002}"

export KINETIC_URL KINETIC_USER KINETIC_PASS PORT
export NODE_TLS_REJECT_UNAUTHORIZED=0

echo "  Kinetic:  $KINETIC_URL"
echo "  User:     $KINETIC_USER"
echo "  Port:     $PORT"
echo ""

if [ "$1" = "setup" ] || [ "$1" = "init" ]; then
  echo "  Step 1: Creating CRM kapp and forms..."
  node setup.mjs
  echo ""
  echo "  Step 2: Seeding sample data..."
  node seed_crm.mjs
  echo ""
  echo "  Setup complete!"
  echo ""
elif [ "$1" = "seed" ]; then
  echo "  Seeding CRM data (products, leads, opportunities, activities)..."
  node seed_crm.mjs
  echo ""
  echo "  Seeding complete!"
  echo ""
fi

echo "  Starting server on http://localhost:$PORT"
echo ""
node server.mjs
