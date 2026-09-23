#!/usr/bin/env bash
# Scripted AgentX demo for lessons and recordings. Model replies are canned;
# daemons, mesh, dashboard and ledger are real. State lives in the volume at
# /build/.agentx-demo, so it survives restarts; `docker compose down -v`
# resets it.
set -euo pipefail
log=/tmp/agentx-demo.log
: > "$log"
# PID files persist in the volume, but nothing runs at container start; in a
# new container those PIDs belong to other processes and block the daemons.
rm -f .agentx-demo/*/.agentx/daemon.pid

node dist/cli.js demo --no-open --reuse --bind 0.0.0.0 > >(tee -a "$log") 2>&1 &
demo=$!

# Seed once, after the scenario has finished, so its tasks do not interleave.
if [ ! -f .agentx-demo/.seeded ]; then
  until grep -q "Daemons stay up" "$log"; do
    kill -0 "$demo" 2>/dev/null || { echo "demo exited before it was ready" >&2; exit 1; }
    sleep 1
  done
  node docs/.scripts/seed-demo.mjs
  touch .agentx-demo/.seeded
fi

wait "$demo"
