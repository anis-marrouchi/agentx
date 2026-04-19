---
name: daemon-ops
version: 1.0.0
description: Operational commands for the local AgentX daemon — restart, tail logs, hot-reload config, status. Intended for the devops-agent only. Other agents should not use this.
tags: [ops, daemon, platform, restart, logs]
triggers:
  - pattern: "restart.*daemon|daemon.*restart|reload.*config|stale.*daemon|tail.*logs|daemon.*logs"
    description: "Daemon lifecycle + ops commands"
---

# AgentX Daemon Ops

You handle requests to operate the local AgentX daemon. This is a narrow skill — one host, one daemon, four commands.

## Gotcha — read this first

**A daemon restart kills the current in-flight HTTP/Telegram/WhatsApp response you're about to send.** The caller that asked you to restart will get no reply to that specific message — their client will show "message sent" but nothing will come back. After restart, the daemon will replay any inflight task from disk, but the *reply* is lost because the HTTP connection that was waiting for it got dropped.

Consequences by channel:

| Channel you're replying on | Effect of restart |
|---|---|
| **Telegram** | User's `sendMessage` was already accepted by Telegram; your reply is lost. They must check the dashboard or re-ask. |
| **WhatsApp** | Same — the pending reply won't send. The session comes back but silently. |
| **HTTP `/task`** | The curl call returns a connection-reset error. |
| **Dashboard modal** | The streaming task view shows "disconnected"; the task gets replayed on reconnect. |

**So: before running a restart, send a short confirmation FIRST** ("Restarting the daemon now — you'll get no further reply to this thread. Check the dashboard at :4202 in ~3 seconds."), THEN run the restart. Do not restart silently.

If someone asks you to restart over a channel where a silent outage is unacceptable (e.g. a production Telegram group), either refuse and explain, or ask them to confirm from a different channel.

## Commands

### 1. Restart the daemon

The daemon runs under launchd with `KeepAlive: true`, so killing it triggers an automatic respawn within ~2 seconds.

```bash
# preferred — graceful, works regardless of the PID:
launchctl kickstart -k gui/$(id -u)/tn.noqta.agentx

# or, direct:
kill $(lsof -ti:18800)
```

Verify the new process is up:

```bash
until curl -sSf -o /dev/null http://127.0.0.1:18800/health; do sleep 1; done && echo "daemon up"
```

After restart, pending Telegram updates drain automatically (polling resumes from the last acknowledged `update_id`). You should see in the stderr log:

```
[agentx] Bot @noqta_..._bot ready (account: ...)
[agentx] Inflight replay: telegram/<id> (agent=...)
```

### 2. Hot-reload config (no restart)

If the operator changed `agentx.json` and the change is covered by the reload path (crons, channels, agent prompts, most fields), call:

```bash
curl -sS -X POST http://127.0.0.1:18800/reload
```

**Known limitation:** model changes on existing agents are NOT picked up by `/reload`. Those require a full daemon restart. If the diff touches `agents.*.model`, use restart instead.

### 3. Tail logs

```bash
tail -n 80 -f ~/.agentx/logs/daemon-stderr.log
```

For a targeted view:

```bash
# just telegram + polling
tail -200 ~/.agentx/logs/daemon-stderr.log | grep -iE "telegram|poll error|bot @"

# just a specific agent
tail -200 ~/.agentx/logs/daemon-stderr.log | grep -i "<agent-id>"
```

### 4. Status

```bash
curl -s http://127.0.0.1:18800/health | python3 -m json.tool
```

Returns: node info, all local agents (with active task count + errors), mesh peer health.

## When a restart is the right call

- **Stale dist** — after `pnpm run build`, the running daemon holds references to chunk filenames that have been replaced on disk. Symptoms: dynamic-import errors in logs (e.g. `Cannot find module '.../compaction-XXX.js'`), Telegram `Poll error (default): fetch failed` that doesn't recover, or agents responding with stale behavior.
- **Model config change** on an existing agent.
- **Channel token rotated** in `.env`.
- **Mesh peer URL changed** and reload didn't pick it up.
- **Uptime over ~24h and polling is erroring.**

## When a restart is NOT the right call

- A single transient `Poll error … fetch failed` — the retry/backoff will recover.
- A single agent task that timed out — that's the agent's runtime, not the daemon's.
- Config change to a NEW cron/channel/agent (not an edit of an existing one) — `/reload` handles those.
