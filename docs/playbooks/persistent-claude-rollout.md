---
title: "Persistent claude process — rollout playbook"
---

# Persistent claude process — rollout playbook

Operator guide for flipping `agents.<id>.persistentProcess: true`. The
design and theory of operation live in
[docs/architecture/persistent-claude-process.md](../architecture/persistent-claude-process.md).
This page is the per-agent rollout, the metrics to watch, and the
rollback procedure.

## Why flip it

Each `POST /task` to a `claude-code` agent normally spawns a fresh
`claude -p` subprocess. Cold-spawn cache_create lands around 25–30K
input tokens and ~6 s of latency before the agent even starts thinking.

With `persistentProcess: true`, AgentX keeps one `claude` subprocess
alive per `(agentId, channel, chatId)` and feeds it multiple turns over
stdin via `--input-format stream-json`. The cache stays warm across
turns within a chat. Empirical numbers from the 2026-05-03 live test
on `graph-agent`:

| | Cold spawn | Warm reuse (turn 2) |
|---|---:|---:|
| Wall-clock | 16.6 s | 2.3 s |
| `cache_create_input_tokens` | 29 297 | 1 598 |
| `cache_read_input_tokens` | 0 | 29 297 |

That's a **7× speedup** on warm turns and **18× cache_create
reduction**. The win compounds for chatty agents — Telegram chats,
WhatsApp groups, GitLab MR comments.

## When NOT to flip it

- **One-shot dispatchers** — cron-fired tasks that never have a
  follow-up turn don't benefit (no warm reuse). Persistent overhead
  isn't large but isn't gain either.
- **Agents with frequent permission changes** — every
  `permissionMode` change requires kill+respawn. Stable config wins.
- **Heavy memory hosts** — each persistent `claude` Node subprocess
  holds 50–80 MB resident. At the default cap of 64 globally that's
  up to ~5 GB. Smaller hosts: drop the cap.

## Rollout order

The recommended sequence is **least-risky → most-risky**:

1. **One cron-heavy agent first** (e.g. `marketing-agent` if it
   produces multi-turn drafts that share workspace state). Soak ≥ 7
   days. The trace store + `agentx process list` are your eyes
   during this period.
2. **One chatty interactive agent** (e.g. `cx-agent`). Soak ≥ 3 days.
3. **`bypassPermissions` tool-using agents** (`devops-agent`,
   `coder-agent`). These execute commands for real — extra watchdog
   tuning may be needed if turns are long.
4. **Fleet flip** — once every agent has run persistent for ≥ 14
   days, change the config-schema default and remove the
   per-agent flag from `agentx.json`.

## Flip procedure

```bash
# 1. Edit agentx.json — add the flag to the chosen agent.
#    (Or use the safer fetch-edit-validate-push flow on clawd; see
#    skills/agentx-infra config-management section.)
jq '.agents."<agent-id>".persistentProcess = true' agentx.json > /tmp/a.json && mv /tmp/a.json agentx.json

# 2. Validate JSON locally so you don't push a broken config.
python3 -c "import json; json.load(open('agentx.json'))"

# 3. Restart the daemon.
sudo systemctl restart agentx           # clawd-server
launchctl kickstart -k gui/$(id -u)/tn.noqta.agentx    # macbook

# 4. Confirm the registry came up.
journalctl -u agentx -n 30 --no-pager | grep ProcessRegistry
# Expect: "ProcessRegistry: enabled for N agent(s)"
```

## Live verification

After the first 2–3 dispatches to the flipped agent:

```bash
# 1. Look for a row in the registry.
agentx process list
# Example output:
#   warm-hot  cx-agent:telegram:42 · pid=51234 age=2m turn#3 last=4s sess=abc12345…

# 2. Confirm the trace data shows cache amortization.
agentx trace list --agent cx-agent --limit 5
#   01XXXX  ok  cx-agent:telegram:42 · 1.8s 4/120 tok 5s ago    ← warm turn
#   01XXXY  ok  cx-agent:telegram:42 · 6.2s 3/95  tok 1m ago    ← cold first turn
agentx trace show <warm taskId>
# Look for usage.cacheReadTokens >> 0 on warm turns. cacheCreateTokens
# should be << the cold-turn baseline.
```

## Metrics to watch (during the soak)

| Metric | Where to look | What "good" looks like |
|---|---|---|
| Warm-turn latency | `agentx trace list` | P50 drops 3–10× vs cold baseline; long tail unchanged |
| Process count | `agentx process list \| wc -l` | Bounded by daemon caps (default 64 / 16 per agent); doesn't grow without bound |
| Drift kills | journalctl: `killed drifted` | Zero unless you edited a workspace's CLAUDE.md |
| Stale kills | journalctl: `killed stale` | Matches expected idle pattern (chats that go quiet > 45 min) |
| Trace error rate | `agentx trace list --status error` | No higher than spawn-per-task baseline |
| Memory | `ps -o rss -p <pid>` for each registry pid | Each ~50–80 MB; doesn't grow turn-over-turn |

If any of these regress, **flip the flag back and read journalctl** —
don't try to debug under load.

## What rotates a process (and why)

The registry kills handles automatically in five cases. Knowing which
fired tells you whether the system is healthy or stressed.

| Kill reason | Trigger | Operator response |
|---|---|---|
| `idle (Ns)` | Chat went quiet for > 30 s | Normal, no action |
| `stale (idle Ns)` | Chat idle > 45 min | Normal, no action |
| `claude-md drifted (...)` | Workspace `CLAUDE.md` edited or auto-refreshed | Normal — that's the point of drift detection |
| `evicted (cap reached)` | Global or per-agent cap hit, oldest idle handle evicted | Bump cap if frequent (`maxProcessesGlobal` / `maxProcessesPerAgent` in registry config) |
| `operator` | `agentx process kill` | Whatever you intended |

Drift detection only fires on idle handles to avoid disturbing a
running turn. A handle that's mid-turn during an edit picks up the new
CLAUDE.md on its next idle transition.

## Stickiness on cross-agent delegation (Run-3 finding)

Found in benchmark Run 3 (2026-05-04): when a triage agent delegates a
task to a sub-agent (e.g. triage → lead → "Welcome to Bean & Code, what's
your name?"), the sub-agent's persistent process at `chatId=default`
holds the **previous visitor's** conversation. The sub-agent replies
with the prior turn's confirmation instead of greeting the new visitor.

Two fixes, in priority order:

### 1. Pass `freshSession: true` (defensive, recommended)

Triage agents that delegate to sub-agents on a chatId that may collide
with prior conversations should pass `freshSession: true` on the
delegated `POST /task`. The dispatcher kills any warm handle for that
key BEFORE acquire, so the next call spawns a fresh process with no
state from prior visitors.

```bash
# From the triage agent's bash tool:
curl -s -X POST http://localhost:18800/task \
  -H "Content-Type: application/json" \
  -d '{"agent":"lead","message":"<visitor message>","freshSession":true}'
```

For workflow YAMLs that call sub-agents, future work will add
`freshSession: true` as an `agent` node config field. Until then,
agents that delegate via Bash should pass the flag explicitly.

### 2. Use a unique chatId per visitor (caller-side convention)

When the triage already knows a stable visitor identifier (e.g. the
Telegram user_id, an email address, a session_uuid), pass it as the
delegated chatId. Each visitor then has their own pool slot — no
collision possible.

```bash
curl -s -X POST http://localhost:18800/task \
  -H "Content-Type: application/json" \
  -d '{"agent":"lead","message":"hi","context":{"chatId":"visitor-12345"}}'
```

This is the cleanest pattern for high-volume sub-agent delegation
because each visitor builds their own warm cache, and cleanup is the
registry's idle-eviction sweep.

## Rollback procedure

Three options, in increasing severity:

### 1. Disable per-agent (safest)

```bash
jq '.agents."<agent-id>".persistentProcess = false' agentx.json > /tmp/a.json && mv /tmp/a.json agentx.json
sudo systemctl restart agentx
```

That agent reverts to spawn-per-task. Other persistent-flagged agents
unaffected. Daemon log shows `ProcessRegistry: enabled for N-1 agent(s)`
(or skips the registry entirely if N-1 = 0).

### 2. Force-rotate one stuck process (no config change)

```bash
agentx process kill <agentId> <channel> <chatId> --reason "<why>"
```

Next dispatch spawns fresh. No restart needed.

### 3. Disable the entire registry (full rollback)

Set `persistentProcess: false` on every agent + restart. The registry
singleton stays null; routing falls through to `executeClaudeCode` /
`executeClaudeCodeStreaming` exactly as before the feature shipped.

There is **no state migration** — the registry is in-memory only,
nothing on disk to clean up. SessionStore (which holds
`claudeSessionId` for `--resume`) is shared across both modes, so
conversational continuity survives the flip in both directions.

## Troubleshooting

### "ProcessRegistry: enabled for 1 agent(s)" but `agentx process list` shows nothing

Either no traffic for that agent yet, or the persistent path silently
fell back to spawn-per-task. Check the daemon log around the dispatch
time for `RegistryCapExceeded` — it'd appear if you've hit caps with
no idle handle to evict. Bump caps or accept the fall-back.

### Process count growing past expectation

Per-agent cap is 16 by default. If you see > 16 handles for one agent,
that's a registry bug — file an issue with `agentx process list --json`
output and the daemon log around the spawn time. As a workaround,
`agentx process kill` the oldest handles or restart the daemon.

### Trace data shows cache_create not dropping on warm turns

The per-turn `init` event fires before EVERY turn even on a warm
process — the SDK behavior is to re-emit the tools list. Cache savings
show up in `cache_read_input_tokens > 0` on turn 2+, not in
`cache_create == 0`. If `cache_read` stays 0 across consecutive turns
on the same chat: the registry isn't being used. Check that the agent
actually has `persistentProcess: true` and the daemon was restarted
after the edit.

### Daemon shutdown is slow

The stop hook kills every persistent child with SIGTERM, waits 5 s,
then SIGKILL. With many handles + slow children, this can add seconds
to systemd's `TimeoutStopSec`. If you bump the global cap above 32,
also bump systemd's `TimeoutStopSec` proportionally
(N_handles × 5 s + 30 s margin).

### "claude-md drifted" kills firing repeatedly without edits

Check whether the daemon's startup auto-refresh is rewriting CLAUDE.md
on every restart (see improvement-plan fix #1, the managed-marker
hash regen). The hash should be deterministic — same systemPrompt →
same hash. If the hash changes without a `systemPrompt` edit, that's
a bug in the marker generator.

## What this playbook does NOT cover

- **`claude-api` tier** (improvement plan #5) — different feature,
  different doc when it ships.
- **Tier-2 / max-turns rotation strategy** — currently kill+respawn
  with `--resume`; revisit if soak shows rotation is frequent enough
  for application-level summary to pay off.
- **Pre-warm pools** / dynamic sizing — v2 work.

When v1 has soaked across the fleet, this playbook is the source for
"how to use this feature in production"; the architecture doc stays
as the source for "how it works inside".
