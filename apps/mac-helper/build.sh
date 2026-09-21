#!/bin/bash
# Build the native computer-use helper.
#
# Bundled as a .app even though it is a CLI: macOS only offers an
# Accessibility permission prompt to a bundled, signed binary, and a bare
# executable silently reads an empty tree instead — which looks exactly
# like an app with no controls.
set -euo pipefail
cd "$(dirname "$0")"

APP="build/AgentX Helper.app"
BIN="$APP/Contents/MacOS"
rm -rf build && mkdir -p "$BIN"

swiftc -O -o "$BIN/agentx-mac-helper" \
  Sources/AgentXHelper/*.swift \
  -framework AppKit -framework ApplicationServices -framework Vision \
  -target arm64-apple-macosx14.0

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>AgentX Helper</string>
  <key>CFBundleIdentifier</key><string>tn.acme.agentx.helper</string>
  <key>CFBundleExecutable</key><string>agentx-mac-helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
</dict>
PLIST
echo "</plist>" >> "$APP/Contents/Info.plist"

codesign --force --sign - --identifier tn.acme.agentx.helper "$APP" 2>/dev/null \
  || echo "warning: codesign failed; Accessibility grants will not stick across rebuilds"

echo "built: $APP"
echo "binary: $BIN/agentx-mac-helper"
