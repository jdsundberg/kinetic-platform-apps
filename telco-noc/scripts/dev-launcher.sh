#!/bin/bash
# Dev launcher for the Telco NOC on :3031 (separate from the shared :3011 launcher). Restart to load code changes.
# NOC_AUTOCORRELATE=1 → this process runs the continuous correlator (exactly one process should).
PORT=${PORT:-3031}
pkill -f "PORT_TAG=noc-dev" 2>/dev/null; lsof -ti tcp:$PORT -sTCP:LISTEN | xargs kill 2>/dev/null; sleep 1
cd "$(dirname "$0")/../../base" && PORT_TAG=noc-dev PORT=$PORT NOC_AUTOCORRELATE=1 nohup node server.mjs > "${NOC_LOG:-/tmp/noc-launcher-$PORT.log}" 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null localhost:$PORT/ && break; sleep 0.5; done
echo "launcher on :$PORT (log ${NOC_LOG:-/tmp/noc-launcher-$PORT.log})"
