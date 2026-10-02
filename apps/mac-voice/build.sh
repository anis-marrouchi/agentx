#!/bin/bash
# Build AgentX Voice into a .app bundle.
#
# swiftc directly, not SwiftPM: a CommandLineTools-only install ships a
# broken PackageDescription ManifestAPI, and this target has no
# dependencies, so the package manager buys nothing here.
#
# The .app wrapper is not cosmetic — macOS grants microphone access to
# bundles with an Info.plist, so a bare executable can never get a TCC
# prompt and will fail with an inscrutable silence instead.
set -euo pipefail
cd "$(dirname "$0")"

APP="build/AgentX Voice.app"
BIN="$APP/Contents/MacOS"
rm -rf build && mkdir -p "$BIN" "$APP/Contents/Resources"

swiftc -O \
  -o "$BIN/AgentXVoice" \
  Sources/AgentXVoice/*.swift \
  -framework AppKit -framework AVFoundation -framework Carbon -framework CoreML -framework SwiftUI -framework Vision \
  -target arm64-apple-macosx14.0

# The on-device models from a terminal: fetch them, transcribe a file, see
# where a turn would end. Same sources as the app; the models themselves
# are downloaded on first use into ~/.agentx/models, never bundled.
swiftc -O \
  -o "$BIN/agentx-voice-local" \
  Sources/AgentXVoice/ModelStore.swift Sources/AgentXVoice/SileroVAD.swift \
  Sources/AgentXVoice/Parakeet.swift Sources/AgentXVoice/TurnEnd.swift Tools/LocalSTT/main.swift \
  -framework CoreML -target arm64-apple-macosx14.0

cp Resources/Info.plist "$APP/Contents/Info.plist"

# Ad-hoc signature. Unsigned bundles get a fresh TCC identity on every
# rebuild, so macOS re-asks for the microphone every single launch.
codesign --force --sign - --identifier tn.acme.agentx.voice "$APP" 2>/dev/null \
  || echo "warning: codesign failed; expect repeated microphone prompts"

echo "built: $APP"
echo "run:   open \"$APP\"     (or ./build/AgentX\\ Voice.app/Contents/MacOS/AgentXVoice for logs)"
