---
name: agentx-bridge
description: Send messages to agents via AgentX (local or remote via mesh). Use when the user says "ask <agent>", "tell <agent>", "send to <agent>", or uses /agentx-bridge.
---

# AgentX Bridge

Send a message to an agent running on AgentX, on this machine or on a mesh peer.

**Inside an agent run, use the `agentx_send_agent` tool first.** This script is the fallback for when the tool is not loaded, and for people, Claude Code and scripts.

Needs `jq` and `curl`.

## How to use

There is no default agent or peer: name both, or the script stops with "set AGENTX_AGENT" / "set AGENTX_PEER or AGENTX_LOCAL=true".

```bash
# Send to an agent on a mesh peer
AGENTX_AGENT=devops-agent AGENTX_PEER=my-server ~/.claude/skills/agentx-bridge/agentx-bridge.sh "check server status"

# Send to an agent on this machine
AGENTX_LOCAL=true AGENTX_AGENT=marketing-agent ~/.claude/skills/agentx-bridge/agentx-bridge.sh "draft a LinkedIn post"
```

## Where the answer goes

**From an agent run (receipt flow).** When the daemon runs an agent it sets `AGENTX_AGENT_ID` (and `AGENTX_CHANNEL`, `AGENTX_CHAT_ID`, `AGENTX_TASK_ID`). The script then names the caller in the send (`senderAgentId`, `callerChannel`, `callerChatId`, header `X-AgentX-Task`). A mesh send also keeps `context` {channel, chatId}, so the remote agent gives each caller its own session, and sends no `async` flag. The daemon answers at once with a receipt (`202`, `accepted: true`, a `dlg-` `taskId`, a `mode`):

- `mode: "callback"`: the answer arrives later in the caller's chat as a new message.
- `mode: "none"`: no running turn could be named, so the answer does **not** come back to the chat. Read it by its id: `agentx_lookup` with `handoff: "dlg-…"`, or `GET /a2a/delegations/<id>?as=<you>`.

In both cases:

- Do not wait or poll for the answer. Carry on, or end the turn.
- Do not send the same message again. If no receipt came back within 10 s, the script says so and exits 0: the send may still have been taken. Find it in `GET /a2a/delegations`.

**From a person, Claude Code or a script.** No `AGENTX_AGENT_ID`, so nothing changes. A local send waits for the answer and prints it. A mesh send is async by default (`AGENTX_ASYNC=true`) when `AGENTX_CHANNEL` and `AGENTX_CHAT_ID` name a chat: the daemon delivers the answer there when the peer finishes. Without a chat it waits inline.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTX_AGENT` | none, required | Target agent id |
| `AGENTX_PEER` | none, required unless `AGENTX_LOCAL=true` | Mesh peer name |
| `AGENTX_LOCAL` | `false` | `true` sends to an agent on this machine |
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

A send with no answer fails loudly on stderr: `1` a setting, `jq` or the message is missing, `2` timed out or daemon unreachable, `3` empty reply, `4` the agent answered with an error. In an agent run a timeout is not a failure (see above).
