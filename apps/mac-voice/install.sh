#!/bin/bash
# Install AgentX Voice so it behaves like an app, not a command.
#
# Two things make it feel native: it lives in /Applications so Spotlight
# and Launchpad find it, and a LaunchAgent starts it at login so it is
# simply always there. Neither requires remembering a path.
set -euo pipefail
cd "$(dirname "$0")"

./build.sh

APP_NAME="AgentX Voice.app"
DEST="/Applications/$APP_NAME"
PLIST="$HOME/Library/LaunchAgents/tn.noqta.agentx.voice.plist"

echo "→ installing to $DEST"
rm -rf "$DEST"
cp -R "build/$APP_NAME" "$DEST"

echo "→ login item: $PLIST"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>tn.noqta.agentx.voice</string>
  <key>ProgramArguments</key>
  <array><string>$DEST/Contents/MacOS/AgentXVoice</string></array>
  <key>RunAtLoad</key><true/>
  <!-- KeepAlive so a crash brings it straight back. The widget is
       stateless between turns, so restarting loses nothing. -->
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/agentx-voice.err.log</string>
</dict>
</plist>
PL

# bootout is asynchronous: bootstrapping immediately after can race the
# teardown and fail with "Input/output error". Wait for the label to
# actually disappear, then bootstrap only if it is really gone.
LABEL="tn.noqta.agentx.voice"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in $(seq 1 20); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.25
done
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  # Still registered (a stuck job): reuse it rather than fail the install.
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
else
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
fi

echo
echo "Installed. It is running now and will start at login."
echo "  Spotlight : ⌘Space, type \"AgentX Voice\""
echo "  Talk      : hold ⌥Space"
echo "  Stop      : launchctl bootout gui/\$(id -u)/tn.noqta.agentx.voice"
echo "  Logs      : ~/Library/Logs/agentx-voice.log"
