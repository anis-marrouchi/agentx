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

# No default agent or peer (Anis 11-25: AgentX bare minimum by default).
AGENT="${AGENTX_AGENT:-}"
PEER="${AGENTX_PEER:-}"
LOCAL="${AGENTX_LOCAL:-false}"

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

command -v jq >/dev/null 2>&1 || fail "jq is needed (install jq)." 1
[ -n "$AGENT" ] || fail "set AGENTX_AGENT to the agent to send to." 1
if [ "$LOCAL" != "true" ] && [ -z "$PEER" ]; then
  fail "set AGENTX_PEER to a mesh peer, or AGENTX_LOCAL=true for an agent on this machine." 1
fi
if [ -z "$MESSAGE" ]; then
  fail "no message given" 1
fi

# #2007 piece 5 (receipt flow, AgentX >= 0.248.0). Inside an agent run
# (AGENTX_AGENT_ID is set by the daemon), the send names its caller, so the
# daemon answers with a 202 receipt at once. The agent never waits. Outside
# an agent (a person, Claude Code, a script) nothing changes: the send waits.
CALLER="${AGENTX_AGENT_ID:-}"
CALLER_HEADER=()
if [ -n "$CALLER" ]; then
  CURL_MAX_TIME=10
  # A warm process has no task id; the agent plus its chat names the turn.
  if [ -n "${AGENTX_TASK_ID}" ]; then CALLER_HEADER=(-H "X-AgentX-Task: ${AGENTX_TASK_ID}"); fi
fi

# The JSON body, built by jq so every value is escaped.
BODY=$(jq -n \
  --arg agent "$AGENT" --arg message "$MESSAGE" \
  --arg caller "$CALLER" --arg channel "${AGENTX_CHANNEL:-}" --arg chat "${AGENTX_CHAT_ID:-}" \
  '{agent: $agent, message: $message}
   + (if $caller != "" then {senderAgentId: $caller} else {} end)
   + (if $caller != "" and $channel != "" and $chat != "" then {callerChannel: $channel, callerChatId: $chat} else {} end)') \
  || fail "could not build the request body." 1

if [ "$LOCAL" = "true" ]; then
  # Send to local agent
  RESPONSE=$(curl -sS --max-time "${CURL_MAX_TIME}" "${AGENTX_URL}/task" \
    -H "Content-Type: application/json" "${CALLER_HEADER[@]}" -d "$BODY")
  CURL_RC=$?
else
  # Send to remote agent via mesh
  # Async needs a route home: context.channel/chatId say where the result
  # is delivered. AGENTX_CHANNEL/AGENTX_CHAT_ID carry the originating
  # conversation; without them the daemon refuses async rather than
  # accepting a task whose answer it could never deliver.
  USE_CTX="false"
  if [ -n "${AGENTX_CHANNEL}" ] && [ -n "${AGENTX_CHAT_ID}" ]; then USE_CTX="true"; fi
  USE_ASYNC="${ASYNC}"
  if [ "$USE_CTX" = "false" ]; then USE_ASYNC="false"; fi
  # An agent caller's own chat is the way home (receipt flow): no context.
  if [ -n "$CALLER" ]; then USE_CTX="false"; USE_ASYNC="true"; fi
  BODY=$(printf '%s' "$BODY" | jq \
    --arg peer "$PEER" --argjson async "$USE_ASYNC" --argjson ctx "$USE_CTX" \
    --arg channel "${AGENTX_CHANNEL:-}" --arg chat "${AGENTX_CHAT_ID:-}" \
    '{peer: $peer} + . + {async: $async}
     + (if $ctx then {context: {channel: $channel, chatId: $chat}} else {} end)') \
    || fail "could not build the request body." 1
  RESPONSE=$(curl -sS --max-time "${CURL_MAX_TIME}" "${AGENTX_URL}/mesh/task" \
    -H "Content-Type: application/json" "${CALLER_HEADER[@]}" -d "$BODY")
  CURL_RC=$?
fi

# No answer came back: say why. The agent may still be working, and its
# answer then exists only in its own session.
if [ "$CURL_RC" -ne 0 ]; then
  if [ "$CURL_RC" -eq 28 ] && [ -n "$CALLER" ]; then
    # R5: never "failed" for an agent. The send may have been taken.
    echo "Sent to ${AGENT}; no receipt came back within ${CURL_MAX_TIME}s, so there is no handle. Do not send it again: the send may still have been taken. If no answer comes to this chat, find the hand-off with GET ${AGENTX_URL}/a2a/delegations and read it by its dlg- id."
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
  MODE=$(printf '%s' "$RESPONSE" | jq -r '.mode // empty')
  NOTE=$(printf '%s' "$RESPONSE" | jq -r '.note // empty')
  # Only a callback (or deliver) receipt brings the answer to a chat. With
  # mode "none" no turn could be named: the answer is read by its id.
  if [ "$MODE" = "none" ]; then
    DEFAULT="Sent to ${AGENT} (task ${TASK}). The answer does not come back to this chat: read it by its id with agentx_lookup (handoff: \"${TASK}\") or GET ${AGENTX_URL}/a2a/delegations/${TASK}?as=${CALLER}. Do not wait or poll for it."
  else
    DEFAULT="Sent to ${AGENT} (task ${TASK}). Its answer comes back to this chat as a new message. Do not wait or poll for it."
  fi
  echo "${NOTE:-$DEFAULT}"
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
