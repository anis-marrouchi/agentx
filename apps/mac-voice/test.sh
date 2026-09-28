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
swiftc -O -o "$out/settings-tests" Sources/AgentXVoice/HotkeySpec.swift Sources/AgentXVoice/VoiceSettings.swift \
  Tests/Settings/main.swift -target arm64-apple-macosx14.0
"$out/settings-tests"
swiftc -O -o "$out/pill-tests" Sources/AgentXVoice/PillPlacement.swift Tests/Pill/main.swift \
  -target arm64-apple-macosx14.0
"$out/pill-tests"
