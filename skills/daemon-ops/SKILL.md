---
name: daemon-ops
version: 1.1.0
description: Operational commands for the AgentX daemon on the current host — restart, tail logs, hot-reload config, status, Claude-auth and overage-gate troubleshooting. Works on both macOS (launchd) and Linux (systemd). Intended for the devops / main agent on the host. Other agents should not use this.
tags: [ops, daemon, platform, restart, logs, auth, overage]
triggers:
  - pattern: "restart.*daemon|daemon.*restart|reload.*config|stale.*daemon|tail.*logs|daemon.*logs|oauth.*expired|out of extra usage|overage.*disabled|setup-token|cold dispatch.*stuck"
    description: "Daemon lifecycle, logs, and Claude-auth/overage ops"
---

# AgentX Daemon Ops

You handle requests to operate the AgentX daemon on this host. Works on both macOS (launchd + `~/.agentx/logs/`) and Linux (systemd + journal). Four classic commands — restart, reload, logs, status — plus a full section on Claude-auth and overage-gate recovery.

## Gotcha — read this first

**A daemon restart kills the current in-flight HTTP/Telegram/WhatsApp response you're about to send.** The caller that asked you to restart will get no reply to that specific message — their client will show "message sent" but nothing will come back. After restart, the daemon will replay any inflight task from disk, but the *reply* is lost because the HTTP connection that was waiting for it got dropped.

Consequences by channel:

| Channel you're replying on | Effect of restart |
|---|---|
| **Telegram** | User's `sendMessage` was already accepted by Telegram; your reply is lost. They must check the dashboard or re-ask. |
| **WhatsApp** | Same — the pending reply won't send. The session comes back but silently. |
| **HTTP `/task`** | The curl call returns a connection-reset error. |
| **Dashboard modal** | The streaming task view shows "disconnected"; the task gets replayed on reconnect. |

**So: before running a restart, send a short confirmation FIRST** ("Restarting the daemon now — you'll get no further reply to this thread. Check the dashboard in ~3 seconds."), THEN run the restart. Do not restart silently.

If someone asks you to restart over a channel where a silent outage is unacceptable (e.g. a production Telegram group), either refuse and explain, or ask them to confirm from a different channel.

## Host variants

Detect once at the start of a session and reuse:

```bash
if [ "$(uname -s)" = "Darwin" ]; then HOST_OS=macos; else HOST_OS=linux; fi
```

The tables below give both variants side-by-side. Port differs by host too (local macOS = 18800, typical Linux deploy = 19900); confirm from the running config if unsure.

## Commands

### 1. Restart the daemon

| Host | Command |
|---|---|
| **macOS** | `launchctl kickstart -k gui/$(id -u)/tn.noqta.agentx` (graceful — `KeepAlive: true` respawns in ~2 s) |
| **Linux** | `sudo systemctl restart agentx` (unit at `/etc/systemd/system/agentx.service`) |

Verify:

```bash
# macOS
until curl -sSf -o /dev/null http://127.0.0.1:18800/health; do sleep 1; done && echo "daemon up"
# Linux
until curl -sSf -o /dev/null http://127.0.0.1:19900/health; do sleep 1; done && echo "daemon up"
```

After restart, pending Telegram updates drain automatically and you'll see in the logs:

```
[agentx] Bot @noqta_..._bot ready (account: ...)
[agentx] Inflight replay: telegram/<id> (agent=...)
```

### 2. Hot-reload config (no restart)

If `agentx.json` changed and the edit is covered by reload (crons, channels, agent prompts, most fields):

```bash
# macOS
curl -sS -X POST http://127.0.0.1:18800/reload
# Linux
curl -sS -X POST http://127.0.0.1:19900/reload
```

**Known limitation:** model changes on existing agents are NOT picked up by `/reload`. If the diff touches `agents.*.model`, use restart instead.

### 3. Tail logs

| Host | Command |
|---|---|
| **macOS** | `tail -n 80 -f ~/.agentx/logs/daemon-stderr.log` |
| **Linux** | `sudo journalctl -u agentx -f -n 80` (or `--since "5 minutes ago"`) |

Targeted filters:

```bash
# macOS — just a specific agent
tail -200 ~/.agentx/logs/daemon-stderr.log | grep -i "<agent-id>"
# Linux — same idea via journal
sudo journalctl -u agentx --since "15 minutes ago" --no-pager | grep -i "<agent-id>"
```

### 4. Status

```bash
curl -s http://127.0.0.1:<PORT>/health | python3 -m json.tool
curl -s http://127.0.0.1:<PORT>/agents | python3 -m json.tool
```

Returns: node info, all local agents (with active task count + errors), mesh peer health.

## When a restart is the right call

- **Stale dist** — after rebuild, the running daemon holds references to chunk filenames that have been replaced. Symptoms: dynamic-import errors in logs (e.g. `Cannot find module '.../compaction-XXX.js'`), `Poll error … fetch failed` that doesn't recover, or agents responding with stale behavior.
- **Model config change** on an existing agent.
- **Channel token rotated** in `.env`.
- **Mesh peer URL changed** and reload didn't pick it up.
- **In-memory state is sticky** — e.g. overage-gate `cached` in `overage-status.ts` is keyed on a 60 s TTL but survives `.claude.json` edits; if you just cleared the grant cache and agents still get gated, restart.
- **Uptime over ~24 h and polling is erroring.**

## When a restart is NOT the right call

- A single transient `Poll error … fetch failed` — the retry/backoff will recover.
- A single agent task that timed out — that's the agent's runtime, not the daemon's.
- Config change to a NEW cron/channel/agent (not an edit of an existing one) — `/reload` handles those.

---

## Claude auth & overage — diagnostic playbook

These are the failure modes we've actually hit in production. Each entry has **symptom → cause → fix**.

### Symptom: all claude-code agents 500 / "out of extra usage"

The agentx friendly error reads:
> `Claude Max-plan overage is unavailable (disabled or depleted at the org level)`
> or: `The agent is out of Anthropic credits`

**This is NOT always a billing problem.** Four possible real causes, ordered by what we've seen most often:

1. **OAuth token expired** — `~/.claude/.credentials.json` has an `expiresAt` in the past. Any real API call returns 401 `authentication_error "Invalid authentication credentials"`. The overage gate masks this because it short-circuits *before* the API call based on a stale `.claude.json` grant cache. Always check `expiresAt` first.
2. **Overage toggle off at claude.ai** — you can verify by reading `overageCreditGrantCache.*.info.available === false` in `~/.claude.json`. Operator action: visit https://claude.ai/settings/usage and enable overage.
3. **Stale grant cache** — `overageCreditGrantCache` timestamp is hours old and disagrees with current account state. `claude --print` calls don't refresh it. Fix: clear the entry, then trigger a real API call.
4. **In-memory daemon cache sticky** — agentx's `overage-status.ts` caches the overage decision for 60 s, but if the daemon loaded a stale value at startup and nothing invalidates it explicitly, the in-memory state outlives the file changes. Fix: daemon restart.

### Diagnostic sweep (one command)

```bash
python3 -c "
import json, datetime, os
d = json.load(open(os.path.expanduser('~/.claude/.credentials.json')))
exp = d.get('claudeAiOauth', {}).get('expiresAt', 0)
print('expiresAt:', datetime.datetime.fromtimestamp(exp/1000, datetime.timezone.utc).isoformat() if exp else '<missing>')
print('now:      ', datetime.datetime.now(datetime.timezone.utc).isoformat())
print('expired  :', exp and exp/1000 < datetime.datetime.now(datetime.timezone.utc).timestamp())
cj = json.load(open(os.path.expanduser('~/.claude.json')))
print('cachedExtraUsageDisabledReason:', cj.get('cachedExtraUsageDisabledReason'))
gc = cj.get('overageCreditGrantCache', {})
for k, v in gc.items():
    info = v.get('info', {})
    ts = v.get('timestamp', 0)
    print(' grant:', info)
    print(' cached at:', datetime.datetime.fromtimestamp(ts/1000, datetime.timezone.utc).isoformat())
"
```

Read the four outputs and decide which fix applies.

### Fix 1 — OAuth expired → install a long-lived token

`claude auth login --claudeai` is interactive and silently hangs on headless servers because its raw-mode stdin doesn't accept paste reliably. Use `claude setup-token` instead — it prints a URL, you sign in in a browser, and the generated token is good for ~1 year.

On macOS (launchd):
```bash
claude setup-token       # run interactively; copy the sk-ant-oat01-... token
# Then put it in the daemon's env — location depends on how the daemon is launched
# (launchd plist: add to EnvironmentVariables; or wrap the ExecStart with a shim).
```

On Linux (systemd), use a systemd override so the token is injected without editing the main unit file:

```bash
sudo mkdir -p /etc/systemd/system/agentx.service.d
sudo tee /etc/systemd/system/agentx.service.d/override.conf <<'EOF' >/dev/null
[Service]
Environment=CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-<PASTE_TOKEN_HERE>
EOF
sudo chmod 600 /etc/systemd/system/agentx.service.d/override.conf
sudo chown root:root /etc/systemd/system/agentx.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart agentx
```

After restart, verify:

```bash
# Linux
P=$(pgrep -f 'dist/cli.js daemon' | head -1)
sudo tr '\0' '\n' < /proc/$P/environ | grep CLAUDE_CODE_OAUTH_TOKEN | sed 's/=.*/=<redacted>/'
# should print: CLAUDE_CODE_OAUTH_TOKEN=<redacted>
```

### Fix 2 — Overage toggle off

Operator action only — no code fix. Ask the human to visit https://claude.ai/settings/usage on the account authenticated in `~/.claude/.credentials.json` and enable "Extra usage" (or equivalent billing toggle). Then run Fix 3 to purge the stale cache.

### Fix 3 — Stale grant cache

```bash
# Back up first — this file is 30 KB+ and contains unrelated CLI state.
cp ~/.claude.json ~/.claude.json.bak.$(date +%s)

python3 -c "
import json
p = __import__('os').path.expanduser('~/.claude.json')
d = json.load(open(p))
d.pop('overageCreditGrantCache', None)
d.pop('cachedExtraUsageDisabledReason', None)
json.dump(d, open(p, 'w'), indent=2)
print('cleared')
"

# Trigger a real API call so the CLI refreshes the cache (use a warm workspace):
cd ~/some-workspace && claude --print --max-turns 1 'reply with exactly: refresh-ok'
```

Then **daemon restart** (Fix 4) to clear the in-memory overage cache. Without the restart, the daemon keeps using the stale boolean even though the file is fresh.

### Fix 4 — In-memory cache sticky

Daemon restart (section above). No subtler intervention works — `clearOverageStatusCache()` is exported but not reachable via HTTP endpoint.

### Known bug to watch for

When the overage gate short-circuits a cold dispatch, `state.runningTasks` is not decremented because the early return bypasses the `finally` block. After N gated dispatches, the affected agent is stuck at `active=N` and rejects new tasks. Fixed in **PR #3** (`fix/preflight-cleanup-leak`); confirm that's merged and deployed before relying on gated cold dispatches being safe. Until then, if you see `active=N, total=N, errors=N` and no real activity, restart the daemon to reset counters.

## Headless-login tunnel (rarely needed)

If `claude auth login --claudeai` is chosen over `setup-token` on a headless host: the CLI also spins up a localhost listener for an optional browser callback. That listener's port is not documented — find it with:

```bash
ss -lntp | grep '\[::1\]:' | grep -v '<daemon-port>'
# owner is "node" with the auth-login PID; port is the number you want.
```

Then from the operator's workstation:

```bash
ssh -L <PORT>:localhost:<PORT> -N -i <KEY> <USER>@<HOST>
```

Open the CLI's printed URL in the workstation's browser; claude.com's JS will POST the code to `localhost:<PORT>` on the workstation, SSH forwards it to the server listener, and the login completes in the server terminal.

**In practice `claude setup-token` is easier** — prefer it unless there's a specific reason to do the browser-callback flow.
