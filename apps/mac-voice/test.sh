#!/bin/bash
# Run the widget's Swift tests: each test file plus the sources it covers.
set -euo pipefail
cd "$(dirname "$0")"
out="$(mktemp -d)"
swiftc -O -o "$out/speech-end-tests" Sources/AgentXVoice/SpeechEnd.swift Tests/SpeechEnd/main.swift \
  -target arm64-apple-macosx14.0
"$out/speech-end-tests"
swiftc -O -o "$out/orb-tests" Sources/AgentXVoice/OrbMath.swift Tests/Orb/main.swift \
  -target arm64-apple-macosx14.0
"$out/orb-tests"
