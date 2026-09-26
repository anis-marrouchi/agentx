#!/bin/bash
# Build the native computer-use helper.
#
# Bundled as a .app even though it is a CLI: macOS only offers an
# Accessibility permission prompt to a bundled, signed binary, and a bare
# executable silently reads an empty tree instead — which looks exactly
# like an app with no controls.
#
#   build.sh [--icon IMAGE]
#
# The bundle's icon is what macOS shows on the helper's notification
# banners. It defaults to the AgentX logo in Resources/; --icon takes any
# PNG, JPEG or .icns instead (agentx desktop install passes
# notifications.local.icon from agentx.json).
set -euo pipefail
ICON=""
if [ "${1:-}" = "--icon" ]; then ICON="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; fi
cd "$(dirname "$0")"
ICON="${ICON:-Resources/AppIcon.png}"

APP="build/AgentX Helper.app"
BIN="$APP/Contents/MacOS"
rm -rf build && mkdir -p "$BIN" "$APP/Contents/Resources"

swiftc -O -o "$BIN/agentx-mac-helper" \
  Sources/AgentXHelper/*.swift \
  -framework AppKit -framework ApplicationServices -framework Vision -framework UserNotifications \
  -target arm64-apple-macosx14.0

case "$ICON" in
  *.icns) cp "$ICON" "$APP/Contents/Resources/AppIcon.icns" ;;
  *)
    SET="build/AppIcon.iconset" && mkdir -p "$SET"
    for n in 16 32 128 256 512; do
      sips -s format png -z $n $n "$ICON" --out "$SET/icon_${n}x${n}.png" >/dev/null
      sips -s format png -z $((n * 2)) $((n * 2)) "$ICON" --out "$SET/icon_${n}x${n}@2x.png" >/dev/null
    done
    iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"
    rm -rf "$SET" ;;
esac

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>AgentX Helper</string>
  <key>CFBundleIdentifier</key><string>tn.acme.agentx.helper</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
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
