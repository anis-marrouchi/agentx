#!/bin/bash
# AgentX Bridge - Send message to agents via AgentX

AGENTX_URL="${AGENTX_BRIDGE_URL:-http://127.0.0.1:18800}"
MAX_SPEAK_CHARS=300

# A delegated agent run routinely takes minutes; the daemon itself waits up
# to 30. curl's own default is unlimited, but the CALLER's shell timeout is
# not — Claude Code's Bash tool kills a command at 2 minutes by default, and
# that is what silently killed real delegations: the remote agent finished,
# and its answer went into a socket nobody was holding.
#
# So: an explicit ceiling that matches the daemon's, and ASYNC by default.
# In async mode the daemon answers immediately and delivers the result to
# the originating chat when the peer finishes, so no shell timeout can lose
# it. Set AGENTX_ASYNC=false to wait inline (only safe for fast agents, and
# only under a Bash timeout raised well past the expected run).
CURL_MAX_TIME="${AGENTX_CURL_MAX_TIME:-1800}"
ASYNC="${AGENTX_ASYNC:-true}"

# Default agent and peer
AGENT="${AGENTX_AGENT:-atlas}"
PEER="${AGENTX_PEER:-clawd-server}"
LOCAL="${AGENTX_LOCAL:-false}"

# #2007 piece 5 (receipt flow, AgentX >= 0.248.0). Inside an agent run
# (AGENTX_AGENT_ID is set by the daemon), the send names its caller, so the
# daemon answers with a 202 receipt at once and the answer comes back to the
# agent's chat as a new message. The agent never waits. Outside an agent (a
# person, Claude Code, a script) nothing changes: the send waits as before.
CALLER="${AGENTX_AGENT_ID:-}"
CALLER_FIELDS=""
CALLER_HEADER=()
if [ -n "$CALLER" ]; then
  CURL_MAX_TIME=10
  CALLER_FIELDS=", \"senderAgentId\": \"${CALLER}\""
  if [ -n "${AGENTX_CHANNEL}" ] && [ -n "${AGENTX_CHAT_ID}" ]; then
    CALLER_FIELDS="${CALLER_FIELDS}, \"callerChannel\": \"${AGENTX_CHANNEL}\", \"callerChatId\": \"${AGENTX_CHAT_ID}\""
  fi
  # A warm process has no task id; the agent plus its chat names the turn.
  if [ -n "${AGENTX_TASK_ID}" ]; then CALLER_HEADER=(-H "X-AgentX-Task: ${AGENTX_TASK_ID}"); fi
fi

MESSAGE="$*"

# Voice is off by default (Anis, 2026-11-19). AGENTX_SPEAK=true turns it on.
SPEAK="${AGENTX_SPEAK:-false}"
speak() {
  if [ "$SPEAK" = "true" ]; then say "$1"; fi
}

# A send that brought no answer is a failure, said plainly on stderr with a
# non-zero exit, never an empty line and exit 0 (Anis, 2026-11-19).
fail() {
  echo "agentx-bridge: FAILED: $1" >&2
  speak "Agent message failed."
  exit "${2:-1}"
}

if [ -z "$MESSAGE" ]; then
  fail "no message given" 1
fi

# Escape message for JSON
JSON_MESSAGE=$(echo "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')

if [ "$LOCAL" = "true" ]; then
  # Send to local agent
  RESPONSE=$(curl -sS --max-time "${CURL_MAX_TIME}" "${AGENTX_URL}/task" \
    -H "Content-Type: application/json" "${CALLER_HEADER[@]}" \
    -d "{\"agent\": \"${AGENT}\", \"message\": ${JSON_MESSAGE}${CALLER_FIELDS}}")
  CURL_RC=$?
else
  # Send to remote agent via mesh
  # Async needs a route home: context.channel/chatId say where the result
  # is delivered. AGENTX_CHANNEL/AGENTX_CHAT_ID carry the originating
  # conversation; without them the daemon refuses async rather than
  # accepting a task whose answer it could never deliver.
  CTX=""
  if [ -n "${AGENTX_CHANNEL}" ] && [ -n "${AGENTX_CHAT_ID}" ]; then
    CTX=", \"context\": {\"channel\": \"${AGENTX_CHANNEL}\", \"chatId\": \"${AGENTX_CHAT_ID}\"}"
  fi
  USE_ASYNC="${ASYNC}"
  if [ -z "$CTX" ]; then USE_ASYNC="false"; fi

  # An agent caller's own chat is the way home (receipt flow): no context.
  if [ -n "$CALLER" ]; then CTX=""; USE_ASYNC="true"; fi
  RESPONSE=$(curl -sS --max-time "${CURL_MAX_TIME}" "${AGENTX_URL}/mesh/task" \
    -H "Content-Type: application/json" "${CALLER_HEADER[@]}" \
    -d "{\"peer\": \"${PEER}\", \"agent\": \"${AGENT}\", \"message\": ${JSON_MESSAGE}, \"async\": ${USE_ASYNC}${CTX}${CALLER_FIELDS}}")
  CURL_RC=$?
fi

# No answer came back: say why. The agent may still be working, and its
# answer then exists only in its own session.
if [ "$CURL_RC" -ne 0 ]; then
  if [ "$CURL_RC" -eq 28 ] && [ -n "$CALLER" ]; then
    # R5: never "failed" for an agent. The send may have been taken.
    echo "Sent to ${AGENT}; it is running and no receipt came back within ${CURL_MAX_TIME}s, so there is no handle. Do not send it again. Its answer comes to this chat as a new message; if nothing comes, ask again later."
    exit 0
  fi
  if [ "$CURL_RC" -eq 28 ]; then
    fail "no reply from ${AGENT} within ${CURL_MAX_TIME}s (timed out). The agent may still be working; its answer was not delivered here." 2
  fi
  fail "could not reach AgentX at ${AGENTX_URL} for ${AGENT} (curl exit ${CURL_RC})." 2
fi
if [ -z "$(printf '%s' "$RESPONSE" | tr -d '[:space:]')" ]; then
  fail "empty reply from ${AGENT}." 3
fi

# A receipt (202): say where the answer goes, with its handle. Never wait.
if [ -n "$CALLER" ] && [ "$(printf '%s' "$RESPONSE" | jq -r '.accepted // empty' 2>/dev/null)" = "true" ]; then
  TASK=$(printf '%s' "$RESPONSE" | jq -r '.taskId // empty')
  NOTE=$(printf '%s' "$RESPONSE" | jq -r '.note // empty')
  echo "${NOTE:-Sent to ${AGENT} (task ${TASK}). Its answer comes back to this chat as a new message. Do not wait or poll for it.}"
  exit 0
fi

# Extract the result text
RESULT=$(printf '%s' "$RESPONSE" | jq -r '.content // .response // .result // .note // empty' 2>/dev/null)
if [ -z "$RESULT" ]; then
  ERR=$(printf '%s' "$RESPONSE" | jq -r '.error // empty' 2>/dev/null)
  if [ -n "$ERR" ]; then
    fail "${AGENT} answered with an error: ${ERR}" 4
  fi
  fail "reply from ${AGENT} had no content: $(printf '%s' "$RESPONSE" | head -c 200)" 3
fi

# Spoken only when AGENTX_SPEAK=true, and only if short enough
CHAR_COUNT=${#RESULT}
if [ "$CHAR_COUNT" -le "$MAX_SPEAK_CHARS" ]; then
  speak "$RESULT"
else
  speak "Response received. Check terminal for the full answer."
fi

echo "$RESULT"
