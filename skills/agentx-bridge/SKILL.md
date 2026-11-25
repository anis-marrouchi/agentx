---
name: agentx-bridge
description: Send messages to agents via AgentX (local or remote via mesh). Use when the user says "ask <agent>", "tell <agent>", "send to <agent>", or uses /agentx-bridge.
---

# AgentX Bridge

Send a message to an agent running on AgentX, on this machine or on a mesh peer.

## How to use

```bash
# Send to the default agent on the default peer
skills/agentx-bridge/agentx-bridge.sh "your message here"

# Send to a specific remote agent
AGENTX_AGENT=devops-agent AGENTX_PEER=my-server skills/agentx-bridge/agentx-bridge.sh "check server status"

# Send to a local agent
AGENTX_LOCAL=true AGENTX_AGENT=marketing-agent skills/agentx-bridge/agentx-bridge.sh "draft a LinkedIn post"
```

## Two ways a send comes back

**From an agent run (receipt flow).** When the daemon runs an agent it sets `AGENTX_AGENT_ID` (and `AGENTX_CHANNEL`, `AGENTX_CHAT_ID`, `AGENTX_TASK_ID`). The script then names the caller in the send (`senderAgentId`, `callerChannel`, `callerChatId`, header `X-AgentX-Task`). The daemon answers at once with a receipt (`202`, `accepted: true`, a `taskId`), and the callee's answer arrives later in the caller's chat as a new message.

- Do not wait or poll for the answer. Carry on, or end the turn.
- Do not send the same message again. If no receipt came back within 10 s, the script says so and exits 0: the send may still have been taken.

**From a person, Claude Code or a script.** No `AGENTX_AGENT_ID`, so nothing changes. A local send waits for the answer and prints it. A mesh send is async by default (`AGENTX_ASYNC=true`): the daemon delivers the answer to the originating chat when the peer finishes.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTX_AGENT` | `atlas` | Target agent id |
| `AGENTX_PEER` | `clawd-server` | Mesh peer name (ignored when `AGENTX_LOCAL=true`) |
| `AGENTX_LOCAL` | `false` | `true` sends to a local agent |
| `AGENTX_BRIDGE_URL` | `http://127.0.0.1:18800` | Daemon address |
| `AGENTX_ASYNC` | `true` | Mesh sends only: `false` waits inline |
| `AGENTX_CURL_MAX_TIME` | `1800` | Seconds to wait for an answer (10 in an agent run) |
| `AGENTX_SPEAK` | `false` | `true` speaks short replies aloud |
| `AGENTX_AGENT_ID` | set by the daemon | Turns on the receipt flow; do not set it by hand |

## AgentX API

- Local task: `POST /task` with `{"agent", "message"}` (+ caller fields in an agent run)
- Remote task: `POST /mesh/task` with `{"peer", "agent", "message", "async"}` (+ caller fields)
- Health: `GET /health`; mesh status: `GET /mesh` (lists peers and their agents)

## Exit codes

A send with no answer fails loudly on stderr: `2` timed out or daemon unreachable, `3` empty reply, `4` the agent answered with an error. In an agent run a timeout is not a failure (see above).
