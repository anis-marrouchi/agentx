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
BIN="$DEST/Contents/MacOS/AgentXVoice"
AGENTS="$HOME/Library/LaunchAgents"

# One login item per machine. An earlier install may have used another
# label (the identifier was renamed); adopt that one instead of adding a
# second KeepAlive agent, and retire any other that runs the same binary.
# AGENTX_VOICE_LABEL forces a label.
LABEL="${AGENTX_VOICE_LABEL:-}"
PLIST=""
for p in "$AGENTS"/*agentx.voice*.plist; do
  [ -e "$p" ] && grep -qF "$BIN" "$p" || continue
  l=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$p" 2>/dev/null) || continue
  if [ -z "$LABEL" ] || [ "$l" = "$LABEL" ]; then
    LABEL="$l"; PLIST="$p"; continue
  fi
  echo "→ removing duplicate login item: $l"
  launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
  rm -f "$p"
done
LABEL="${LABEL:-tn.acme.agentx.voice}"
PLIST="${PLIST:-$AGENTS/$LABEL.plist}"

echo "→ installing to $DEST"
rm -rf "$DEST"
cp -R "build/$APP_NAME" "$DEST"

# A login item gets launchd's bare PATH (/usr/bin:/bin:/usr/sbin:/sbin),
# where mlx_whisper cannot find ffmpeg. Put the folder of the ffmpeg found
# now in front of it. AGENTX_VOICE_PATH replaces the whole value.
LAUNCHD_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
if [ -n "${AGENTX_VOICE_PATH:-}" ]; then
  VOICE_PATH="$AGENTX_VOICE_PATH"
elif FFMPEG=$(command -v ffmpeg); then
  VOICE_PATH="$(dirname "$FFMPEG"):$LAUNCHD_PATH"
else
  echo "! ffmpeg not found: local Whisper transcription needs it (brew install ffmpeg), then rerun"
  VOICE_PATH="$LAUNCHD_PATH"
fi

echo "→ login item: $PLIST (PATH=$VOICE_PATH)"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BIN</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$VOICE_PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <!-- KeepAlive so a crash brings it straight back. The widget is
       stateless between turns, so restarting loses nothing. -->
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/agentx-voice.err.log</string>
</dict>
</plist>
PL
plutil -lint -s "$PLIST"

# bootout is asynchronous: bootstrapping immediately after can race the
# teardown and fail with "Input/output error". Wait for the label to
# actually disappear, then bootstrap only if it is really gone.
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
echo "  Stop      : launchctl bootout gui/\$(id -u)/$LABEL"
echo "  Logs      : ~/Library/Logs/agentx-voice.log"
