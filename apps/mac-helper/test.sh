#!/bin/bash
# Run the helper's Swift tests: the test file plus the sources it covers.
set -euo pipefail
cd "$(dirname "$0")"
out="$(mktemp -d)/capture-tests"
swiftc -O -o "$out" Sources/AgentXHelper/Watch.swift Sources/AgentXHelper/Ring.swift Tests/Capture/main.swift \
  -target arm64-apple-macosx14.0
"$out"
