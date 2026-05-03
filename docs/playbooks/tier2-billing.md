---
title: "Tier-2 billing lifecycle"
---

# Tier-2 billing lifecycle

Anthropic bills Claude requests at **1.5×** when total input (input + cacheRead + cacheCreate) crosses 200K tokens on a single request. AgentX's session manager rotates Claude `--resume` sessions proactively to dodge this — but tuning the threshold and watching for hotspots is on you.

This page explains the model, the knobs, and the dashboards.

## The tier-2 multiplier

Anthropic's pricing tiers:

| Total input tokens | Multiplier |
|---|---|
| 0 – 200,000 | 1.0× |
| 200,001+ | 1.5× |

That number includes `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`. The session manager sums these from the prior turn's response and decides whether the next turn would push past the threshold.

## How AgentX rotates

Three rotation triggers in the session manager (`src/agents/session.ts`):

| Reason | When | Cost effect |
|---|---|---|
| `stale` | Idle > `session.staleMinutes` (default 45) | New session — colder cache, but past idle limit the cache value was eroding anyway |
| `tier-2` | Prior turn's total input > `session.tierTwoThresholdTokens` (default 195K) | Avoids the 1.5× multiplier on the next turn |
| `max-turns` | Turn count > `session.maxTurnsPerSession` (default 15) | Bounds `--resume` replay size |

The `tier-2` threshold defaults to 195,000 (5K headroom under 200K). Lower it if your turns include a lot of tool-result expansion that pushes past 200K despite the headroom.

## Dashboards

### CLI

```bash
agentx db rotations --reason tier-2 --summary
```

Output:

```
agent_id        reason  n   avg_input_tokens  max_input_tokens
mtgl-v2         tier-2  47  198234             199821
devops-agent    tier-2  12  197102             199541
```

`avg_input_tokens` close to the threshold means the rotator is firing right at the limit — healthy. Values consistently >199K mean the threshold is too high; lower it.

For per-day:

```bash
agentx db rotations --reason tier-2 -n 50
```

### Usage dashboard

```bash
agentx usage serve --port 4203
```

Open `http://127.0.0.1:4203`. The "Rotation reasons" section breaks down `stale` / `tier-2` / `max-turns` per agent. The "Tier-2 hotspots" section flags agents that crossed the threshold > N times in the window.

See [Usage dashboard reference](/reference/dashboard/usage).

## Tuning

### Lower the threshold (more rotations, lower per-turn cost)

```bash
agentx config set session.tierTwoThresholdTokens 180000
```

Trade-off: a fresh session costs a full prompt-cache reload on the next turn (cache miss). For agents with a 50K-token system prompt + skill bundle, that's a one-time 50K input charge per rotation — usually cheaper than the 1.5× multiplier on a 230K-token turn.

### Raise the threshold (fewer rotations, more cache reuse)

Don't go above 199,000 — at 200,001 you're already in tier-2 land for the next turn.

### Reduce per-turn input

The other lever: shrink the input that flows into each turn. Strategies in [Context strategies](/reference/context-strategies):

- Switch the agent to `contextStrategy: "planner"` — Haiku pre-call selects a smaller context bundle. Trades a small extra LLM call for a much smaller main-call input.
- Cap `maxOutputTokens` on cron entries that don't need long replies — keeps the session's output history smaller.
- Tighten `maxTurnsPerSession` to bound `--resume` replay growth.

## Soft-budget guardrails for `claude-code`-tier agents

Beyond per-session rotation, agentx has a fleet-level soft budget:

```json
"session": {
  "maxClaudeCodeDispatchesPerHour": 80,
  "maxClaudeCodeDispatchesPer5h": 180
}
```

When the rolling counter exceeds the cap, **cold dispatches** (no warm Claude session for the agent) are short-circuited until the window resets. **Warm sessions** are always allowed — the budget only delays new conversations, not in-flight ones.

Sized for Anthropic Max 5×; raise for Max 20×. Lower if your workload stays under the cap naturally and you want a safety net.

## Issuing scoped tokens

External integrations (Slack apps, dashboards on a peer machine) should authenticate with scoped tokens, not raw provider keys:

```bash
agentx token create --name "slack-billing-bot" --scope task:write --expires 90
```

Tokens persist hashed in `.agentx/tokens.json`; the secret is shown once. Revoke with `agentx token revoke <id>`. See [Tokens CLI](/reference/cli#tokens).

## Quotas (per-agent)

If one agent dominates the budget (e.g. an aggressive coder running on 100K-token diffs), cap it at the agent level:

```bash
agentx config set agents.mtgl-v2.maxConcurrent 1
agentx config set agents.mtgl-v2.maxExecutionMinutes 15
```

`maxConcurrent: 1` prevents the agent from running multiple turns in parallel (each parallel turn is a separate Claude session and counts independently against the soft budget). `maxExecutionMinutes` SIGTERMs after 15 minutes — bounds runaway investigations.

## Telemetry

The bus event you want to subscribe to (from a [plugin](./plugin-authoring)):

```ts
ctx.on("session:rotated", (payload) => {
  // payload: { agentId, reason: "stale" | "tier-2" | "max-turns", lastTurnInputTokens }
  if (payload.reason === "tier-2") {
    metrics.tier2_rotations.inc({ agent: payload.agentId })
  }
})
```

Pipe to your Prometheus / Grafana stack. The same data is in `.agentx/db.sqlite`'s `rotations` table — same field names — for batch analysis.

## Renewal

Tokens that expire need renewal. Schedule a monthly cron:

```bash
agentx schedule "1st of every month at 03:00" \
  --agent ops-agent \
  --do "List tokens that expire in the next 14 days. For any tagged 'rotating-' in the name, mint a replacement and notify the integration owner via the channel listed in token metadata. See: agentx token list."
```

Document each token's purpose in its `name` (e.g. `rotating-slack-billing-90d`) so the cron knows what to renew vs let expire.

## Next

- [Usage dashboard](/reference/dashboard/usage)
- [Context strategies](/reference/context-strategies) — `layered` vs `planner`, with bench results
- [Session config schema](/reference/config-schema#session)
- [Capability audit playbook](./capability-audit) — bound delegation chains so a single inbound can't trigger 50 sub-dispatches
