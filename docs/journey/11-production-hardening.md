---
title: "11. Production hardening — permissions, debug, observability"
---

# 11. Production hardening — permissions, debug, observability

> **Difficulty:** advanced · **Time:** ~60 minutes

Your agents have been running in `bypassPermissions` mode while you iterated. They're about to talk to real customers, real merge requests, real money. This page is the lockdown checklist plus the observability you need to know it's working.

## Posture checklist

Before flipping to production:

- [ ] Per-agent `permissionMode` set appropriately (most agents: `default` or `acceptEdits`; only trusted utility agents: `bypassPermissions`)
- [ ] All `bypassPermissions` agents have explicit `.claude/settings.json` allow/deny globs
- [ ] `dashboard.bind` is `127.0.0.1` or a Tailscale `100.x` IP — not `0.0.0.0`
- [ ] `dashboard.token` set; mint scoped tokens via `agentx token create`
- [ ] Webhook `secretEnv` set on every entry; secrets in `.env` not `agentx.json`
- [ ] `notifications.destination` configured so long tasks and errors page someone
- [ ] systemd / launchd unit installed for auto-restart
- [ ] Backup of `.agentx/` (state, logs, ledger) in a cron
- [ ] [Doctor](/reference/doctor) runs clean
- [ ] Token-cost budget — `session.maxClaudeCodeDispatchesPerHour` sized for your tier; `agentx usage today` reviewed weekly

## Permission modes

Per-agent in `agentx.json`. Picker:

| Mode | When | Risk |
|---|---|---|
| `default` | Almost every agent. Claude pauses on writes; user (or `allow` glob) confirms | Low |
| `acceptEdits` | Agent that does scoped editing (e.g. wiki absorber, code formatter) | Medium — every Edit/Write goes through unconfirmed |
| `plan` | Agents in research/planning mode that should never write | Lowest |
| `bypassPermissions` | Utility agents owned by you (devops, deploy bots) where the agent itself is trusted | High — Bash/Edit/Write all run without confirmation |

The `bypassPermissions` mode is the one to audit. Combine with `.claude/settings.json` glob lists to bound what the agent can touch:

```json
{
  "permissions": {
    "allow": ["Edit:**/*.md", "Bash:git ${BRANCH_PATTERN}"],
    "deny":  ["Edit:**/.env*", "Bash:rm -rf*", "Bash:sudo *"]
  }
}
```

`deny` always wins. `confirm` is the third option (prompt the operator for tools matching the glob). See `src/permissions/manager.ts` for the matcher.

## Reverse proxy + TLS

For the dashboard or webhook port, terminate TLS at a reverse proxy. Caddy is the smallest option:

```caddy
agentx.example.com {
    reverse_proxy 127.0.0.1:4202
}

webhooks.example.com {
    reverse_proxy 127.0.0.1:18810
}
```

Nginx / Traefik / Apache are equivalent. Always:

- Bind agentx to `127.0.0.1`, never `0.0.0.0`
- Let the proxy handle TLS and rate-limiting
- Forward `X-Real-IP` so logs show the real source

## Tailscale-only bind

For internal-only dashboards, skip the proxy entirely and bind to your Tailscale interface:

```json
"dashboard": { "bind": "100.x.x.x", "port": 4202 }
"node":      { "bind": "100.x.x.x:19900" }
```

…then add the IP to the Tailscale ACL so only your nodes can reach it. See [Tailscale setup](/reference/tailscale-setup).

## Token rotation

`agentx token create` mints; `agentx token revoke` invalidates. Rotation cron:

```json
"crons": {
  "token-rotation": {
    "schedule": "0 3 1 * *",
    "agent": "ops-agent",
    "prompt": "Run agentx token list. Revoke any token where lastUsedAt > 90 days ago. Mint replacements for tokens whose name starts with 'rotating-' and notify the integration owner via the channel listed in the token name's metadata.",
    "onError": ["log", "notify"]
  }
}
```

Document each token's purpose in its `name` so the rotation cron can decide what to mint.

## Backup of `.agentx`

The `.agentx/` directory holds:

- `db.sqlite` — task history, rotations, usage, routes, errors
- `intent/ledger.sqlite` — every dispatch decision (Phase 1)
- `whatsapp-sessions/` — Baileys auth state (re-pair if lost)
- `wiki/`, `graph/`, `procedures/` — knowledge artefacts (already git-tracked? if not, they should be)
- `backlog.json`, `boards/` — work pool
- `task-history/`, `cron/`, `references/`, …

A weekly tar of the whole tree to S3-equivalent storage covers ~all recovery paths. SQLite is safe to copy via `sqlite3 db.sqlite ".backup '/tmp/db.sqlite.bak'"` — using `cp` while writes are in flight produces a corrupt copy.

## systemd unit

```ini
# /etc/systemd/system/agentx.service
[Unit]
Description=AgentX daemon
After=network.target

[Service]
Type=simple
User=agentx
WorkingDirectory=/home/agentx/agentx
EnvironmentFile=/home/agentx/agentx/.env
ExecStart=/usr/bin/node /home/agentx/agentx/dist/cli.js daemon start
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` (not `Restart=always`) so manual `systemctl stop` actually stops. Tail with `journalctl -u agentx -f`.

For macOS, the equivalent is a `launchd` plist under `~/Library/LaunchAgents/` — see [install.md](/install#run-in-the-background).

## Observability

Five live signals worth wiring before going to production:

### 1. The ledger (Phase 1)

Once `INTENT_LEDGER_MODE` is set to at least `shadow`, every dispatch decision is recorded. CLI:

```bash
agentx ledger stats --since 24h
agentx ledger active                # in-flight
agentx ledger divergences --since 24h
agentx ledger replay --since 24h    # reproducibility check
```

The ledger answers: did this dispatch happen? Why? Did the legacy router and the new logic disagree? Run `replay` weekly — divergences > 0 mean something non-deterministic crept in.

### 2. SSE event stream

Pipe the daemon's event firehose into your monitoring stack:

```bash
curl -N http://127.0.0.1:18800/events | jq
```

Every channel inbound, agent dispatch, tool result, error emits an event. Persist to your log aggregator of choice. The same stream powers the [Live page](/reference/dashboard/live).

### 3. Doctor

```bash
agentx doctor --json
```

Schedule daily; alert on any non-OK row. Catches expired tokens, unreachable mesh peers, missing workspaces, broken provider creds.

### 4. Notifications

```json
"notifications": {
  "longTaskThreshold": 60,
  "destination": { "channel": "telegram", "chatId": "-100..." },
  "on": { "taskComplete": false, "taskError": true, "taskQueued": false }
}
```

The threshold + destination give you a paging surface for free — any task running > 60s pings the on-call channel. Pair with the `--on-error notify` flag on cron entries.

### 5. Token-cost dashboard

```bash
agentx usage serve --port 4203
```

Per-agent cost, tier-2 hotspots, rotation reasons. Run weekly. Set `session.maxClaudeCodeDispatchesPerHour` from the observed peak, not from a guess. See [Usage dashboard](/reference/dashboard/usage).

## Debug categories

When something is wrong, turn on focused debug:

```bash
curl -X POST 'http://127.0.0.1:18800/debug/on?categories=webhook,channel,context'
# ...reproduce the issue, watch logs...
curl -X POST 'http://127.0.0.1:18800/debug/off'
```

Or set permanently via env: `AGENTX_DEBUG=webhook,cron,mesh,all`. Categories: `webhook`, `agent`, `channel`, `cron`, `mesh`, `context`, `memory`, `config`, `all`. See [CLI env vars](/reference/cli#environment-variables).

## Incident playbook

When an agent goes off the rails in production, the recovery tree is in [Rollback runbook](/reference/rollback-runbook). The four levers in order of severity:

1. **Disable the offending cron / webhook** — `agentx config set crons.<id>.enabled false` (hot-reloads).
2. **Demote the agent's permissions** — set `permissionMode: plan` to stop further writes while you investigate.
3. **Rotate the credential** — if a leaked token is suspected.
4. **Stop the daemon** — last resort; everything pauses, but in-flight tasks are lost.

Each lever is reversible; the rollback runbook walks through when each is appropriate.

## Next

- [Rollback runbook](/reference/rollback-runbook): the four-lever recovery tree in detail.
- [Doctor reference](/reference/doctor): every health check the daemon ships with.
- [Tailscale setup](/reference/tailscale-setup): private-mesh-only deployments.
- [Token usage dashboard](/reference/dashboard/usage): cost forensics and tier-2 tuning.
