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
swiftc -O -o "$out/pill-tests" Sources/AgentXVoice/PillPlacement.swift Sources/AgentXVoice/PillMenu.swift \
  Tests/Pill/main.swift \
  -target arm64-apple-macosx14.0
"$out/pill-tests"
swiftc -O -o "$out/pill-busy-tests" Sources/AgentXVoice/PillBusy.swift Tests/PillBusy/main.swift \
  -target arm64-apple-macosx14.0
"$out/pill-busy-tests"
swiftc -O -o "$out/history-tests" Sources/AgentXVoice/HistoryModel.swift Tests/History/main.swift \
  -target arm64-apple-macosx14.0
"$out/history-tests"
swiftc -O -o "$out/call-tests" Sources/AgentXVoice/CallModel.swift Tests/Calls/main.swift \
  -target arm64-apple-macosx14.0
"$out/call-tests"
swiftc -O -o "$out/turn-end-tests" Sources/AgentXVoice/TurnEnd.swift Tests/TurnEnd/main.swift \
  -target arm64-apple-macosx14.0
"$out/turn-end-tests"
swiftc -O -o "$out/local-model-tests" Sources/AgentXVoice/ModelStore.swift Sources/AgentXVoice/Parakeet.swift \
  Tests/LocalModels/main.swift -framework CoreML -target arm64-apple-macosx14.0
"$out/local-model-tests"
swiftc -O -o "$out/character-tests" Sources/AgentXVoice/CharacterMath.swift Sources/AgentXVoice/CharacterSim.swift \
  Sources/AgentXVoice/OrbMath.swift Tests/Character/main.swift -target arm64-apple-macosx14.0
"$out/character-tests"
swiftc -O -o "$out/play-tests" Sources/AgentXVoice/CharacterMath.swift Sources/AgentXVoice/PlayMath.swift \
  Tests/Play/main.swift -target arm64-apple-macosx14.0
"$out/play-tests"
