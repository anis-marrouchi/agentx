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
swiftc -O -o "$out/hotkey-tests" Sources/AgentXVoice/Hotkey.swift Sources/AgentXVoice/HotkeySpec.swift \
  Tests/Hotkey/main.swift -target arm64-apple-macosx14.0
"$out/hotkey-tests"
swiftc -O -o "$out/pill-tests" Sources/AgentXVoice/PillPlacement.swift Sources/AgentXVoice/PillMenu.swift Sources/AgentXVoice/BubbleMotion.swift \
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
swiftc -O -o "$out/character-tests" Sources/AgentXVoice/CharacterMath.swift Sources/AgentXVoice/CharacterSim.swift Sources/AgentXVoice/CharacterSimFrame.swift \
  Sources/AgentXVoice/PointerPlay.swift Sources/AgentXVoice/IdlePlay.swift Sources/AgentXVoice/OrbMath.swift Sources/AgentXVoice/Meets.swift Tests/Character/main.swift \
  -target arm64-apple-macosx14.0
"$out/character-tests"
swiftc -O -o "$out/pointer-play-tests" Sources/AgentXVoice/CharacterMath.swift Sources/AgentXVoice/CharacterSim.swift Sources/AgentXVoice/CharacterSimFrame.swift \
  Sources/AgentXVoice/PointerPlay.swift Sources/AgentXVoice/IdlePlay.swift Sources/AgentXVoice/OrbMath.swift Tests/PointerPlay/main.swift \
  -target arm64-apple-macosx14.0
"$out/pointer-play-tests"
swiftc -O -o "$out/idle-play-tests" Sources/AgentXVoice/CharacterMath.swift Sources/AgentXVoice/CharacterSim.swift Sources/AgentXVoice/CharacterSimFrame.swift \
  Sources/AgentXVoice/PointerPlay.swift Sources/AgentXVoice/IdlePlay.swift Sources/AgentXVoice/OrbMath.swift Tests/IdlePlay/main.swift \
  -target arm64-apple-macosx14.0
"$out/idle-play-tests"
swiftc -O -o "$out/play-tests" Sources/AgentXVoice/CharacterMath.swift Sources/AgentXVoice/PlayMath.swift \
  Sources/AgentXVoice/PlayActs.swift Sources/AgentXVoice/PlayMotion.swift Tests/Play/main.swift \
  -target arm64-apple-macosx14.0
"$out/play-tests"
swiftc -O -o "$out/play-motion-tests" Sources/AgentXVoice/CharacterMath.swift Sources/AgentXVoice/PlayMotion.swift \
  Tests/PlayMotion/main.swift -target arm64-apple-macosx14.0
"$out/play-motion-tests"
swiftc -O -o "$out/guide-tests" Sources/AgentXVoice/GuideMath.swift Tests/Guide/main.swift \
  -target arm64-apple-macosx14.0
"$out/guide-tests"
