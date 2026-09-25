#!/bin/bash
# Run the widget's Swift tests: the test file plus the sources it covers.
set -euo pipefail
cd "$(dirname "$0")"
out="$(mktemp -d)/speech-end-tests"
swiftc -O -o "$out" Sources/AgentXVoice/SpeechEnd.swift Tests/SpeechEnd/main.swift \
  -target arm64-apple-macosx14.0
"$out"
