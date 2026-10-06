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

# The AX symbol (written by scripts/gen-icons.ts), as Finder and the
# permission prompts show it.
SET="build/AppIcon.iconset" && mkdir -p "$SET"
for n in 16 32 128 256 512; do
  sips -s format png -z $n $n Resources/AppIcon.png --out "$SET/icon_${n}x${n}.png" >/dev/null
  sips -s format png -z $((n * 2)) $((n * 2)) Resources/AppIcon.png --out "$SET/icon_${n}x${n}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$SET"

# Signing. Unsigned bundles get a fresh TCC identity on every launch. An
# ad-hoc signature (the default) holds only for this one build: macOS keys
# a permission to the build's hash, so every new build is asked again for
# the microphone and Screen Recording. AGENTX_SIGN_IDENTITY names a
# code-signing certificate in the keychain (a self-signed one is enough)
# whose permissions carry over to the next build.
IDENTITY="${AGENTX_SIGN_IDENTITY:--}"
if [ "$IDENTITY" = "-" ]; then
  codesign --force --sign - --identifier tn.acme.agentx.voice "$APP" 2>/dev/null \
    || echo "warning: codesign failed; expect repeated microphone prompts"
  echo "note: ad-hoc signature; macOS asks again for the microphone and Screen Recording after this install (set AGENTX_SIGN_IDENTITY to keep them)"
else
  codesign --force --sign "$IDENTITY" --identifier tn.acme.agentx.voice "$APP"
fi

echo "built: $APP"
echo "run:   open \"$APP\"     (or ./build/AgentX\\ Voice.app/Contents/MacOS/AgentXVoice for logs)"
