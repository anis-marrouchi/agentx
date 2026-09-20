#!/bin/bash
# Launch the real Google Chrome for agents to drive over CDP.
#
# WHY NOT JUST USE THE BUNDLED CHROMIUM.
#
# agent-browser ships its own Chromium. Google's sign-in refuses it — an
# unbranded automation build is exactly what "this browser may not be
# secure" is aimed at — so anything behind a login (X, Google, GitLab SSO)
# is unreachable from it. Real Chrome, real user agent, real profile.
#
# WHY NOT YOUR EVERYDAY PROFILE.
#
# Chrome 136+ refuses --remote-debugging-port on the default user-data-dir.
# That is a deliberate hardening: an open debug port on the profile holding
# your live sessions lets any local process read every cookie you own.
# Trying to defeat it would hand agents your entire browsing identity.
#
# So: a SEPARATE profile at ~/.agentx/chrome-profile that you log into
# once, per site, deliberately. Sessions persist there across restarts, and
# the blast radius is whatever you chose to sign into — not everything.
set -euo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE="${AGENTX_CHROME_PROFILE:-$HOME/.agentx/chrome-profile}"
PORT="${AGENTX_CHROME_PORT:-9222}"

[ -x "$CHROME" ] || { echo "Google Chrome not found at $CHROME"; exit 1; }

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Agent Chrome already listening on $PORT"
  echo "  agent-browser --cdp $PORT snapshot"
  exit 0
fi

mkdir -p "$PROFILE"
echo "→ launching Chrome  profile=$PROFILE  cdp=$PORT"
"$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --restore-last-session \
  >/dev/null 2>&1 &

for _ in $(seq 1 40); do
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.25
done

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  cat <<TXT

Ready on port $PORT.

  Sign in ONCE, by hand, in this window for each site an agent needs
  (X, Google, GitLab). The session is stored in the profile above and
  survives restarts — agents never see your everyday Chrome.

  Agents then use:   agent-browser --cdp $PORT open https://x.com
                     agent-browser --cdp $PORT snapshot -i
TXT
else
  echo "Chrome did not open the debug port — is another Chrome using this profile?"
  exit 1
fi
