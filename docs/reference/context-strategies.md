# Context strategies

::: tip TL;DR for operators
Use the default (`layered`). The only reason to switch to `planner` is if your agent consistently gives wrong answers on hard questions — try `planner` for one day, see if quality improves, decide. Change it with: `agentx agent capability <agentId> --context-strategy planner`. Everything below is for engineers tuning the cache budget.
:::

AgentX offers two strategies for assembling the context each agent sees on every turn: **layered** (default) and **planner**. This page explains what each does, when to use which, the per-turn token/cost profile, and the session-rotation knobs that tame the default strategy's worst case.

The source of truth:
- [`src/agents/context.ts`](https://github.com/anis-marrouchi/agentx/blob/master/src/agents/context.ts) — layered assembly
- [`src/agents/context-planner.ts`](https://github.com/anis-marrouchi/agentx/blob/master/src/agents/context-planner.ts) — planner
- [`src/agents/sessions.ts`](https://github.com/anis-marrouchi/agentx/blob/master/src/agents/sessions.ts) — session rotation
- [`src/daemon/config.ts`](https://github.com/anis-marrouchi/agentx/blob/master/src/daemon/config.ts) — config knobs

## TL;DR

- **Default to `layered`.** It's cheaper on the typical chat workload when combined with session rotation (the defaults).
- **Use `planner` selectively** for very long sessions, tool-heavy agents that routinely push past the 200K tier-2 threshold, or non-interactive paths (crons, webhooks) where a small pre-call latency is acceptable.
- **Don't rely on `staleMinutes` alone.** `maxTurnsPerSession` caps the size of any single Claude CLI `--resume` session so the cache-read replay never snowballs.
- **Watch tier-2 hits in the daemon log.** A `TIER-2 HIT` warning means the prior turn crossed 200K input tokens; the next turn auto-rotates. Frequent warnings on the same agent are a signal to switch it to `planner`.

## What the layered strategy does

On every turn, the daemon assembles a structured prompt from up to eight layers:

1. **Channel** — channel name + channel-specific rules (Telegram / WhatsApp / GitLab / Discord)
2. **Scope** — group / project / personal, plus verified channel metadata (prevents hallucinated group members)
3. **Landscape** — cached world model: team roster, peer agents, mesh peers, cross-channel messaging API
4. **Identity** — first line of the agent's `systemPrompt`
5. **Intent** — graph classifier path (when enabled)
6. **Artifacts** — attached media, reply-to text, issue/MR references
7. **History** — session history (`.agentx/sessions/<agentId>:<channel>:<chatId>:<date>.json`)
8. **Wiki** — an `[Institutional Wiki]` hint telling the agent to call `agentx wiki query …` when it needs institutional knowledge

Each layer has a per-layer token budget (see [`DEFAULT_CONFIG` in context.ts](https://github.com/anis-marrouchi/agentx/blob/master/src/agents/context.ts)), capped at a total of 6000 tokens.

The stable parts of the preamble (`agent.systemPrompt` + bootstrap identity files) are delivered via Claude CLI's `--append-system-prompt` so they sit inside the cached system prompt across turns. The per-turn context is injected into the user-message body.

Between turns the daemon uses `claude --resume <sessionId>` so Claude's server-side prompt cache hits instead of re-creating. That's what makes layered cheap on multi-turn chats — until the session grows too large, at which point the replay itself becomes the cost.

## What the planner strategy does

On every turn, before spawning the main agent, the daemon makes a small Haiku call ([`planContext`](https://github.com/anis-marrouchi/agentx/blob/master/src/agents/context-planner.ts)) that:

1. Reads the current message and the last few tail messages
2. Returns a plan: how many recent turns to keep verbatim, whether to retrieve memory (with a search query), whether to include cross-chat hints
3. The daemon runs only the retrievals the planner asked for — no session history blob, no unconditional wiki hint
4. The Claude CLI session is rotated to a fresh one (no `--resume`), because the curated bundle is incompatible with replaying prior tool-result state

On planner failure (Haiku timeout, bad JSON, API error) the daemon falls back to layered automatically — so flipping the knob on is safe.

Planner latency: ~1–3 s per turn on warm Haiku SDK calls. Negligible vs. the main agent turn on Opus/Sonnet.

## Config knobs

All under `session` in `agentx.json`:

```json
{
  "session": {
    "staleMinutes": 45,
    "maxTurnsPerSession": 15,
    "tierTwoThresholdTokens": 180000,
    "contextStrategy": "layered"
  }
}
```

| Field | Default | Purpose |
|---|---|---|
| `staleMinutes` | `45` | Idle-timeout for `--resume`. After this many minutes of no activity the session is dropped and the next turn starts fresh. |
| `maxTurnsPerSession` | `15` | Hard cap on turns per Claude CLI session. Once hit, the next turn rotates. Prevents `--resume` replay growing unbounded across a long chat. |
| `tierTwoThresholdTokens` | `180000` | If the prior turn's total input (input + cacheRead + cacheCreate) crosses this, rotate before the next turn. Claude bills tier-2 at 1.5× above 200K; rotating at 180K leaves headroom before re-entering the multiplier. |
| `contextStrategy` | `"layered"` | Assembly strategy — `"layered"` or `"planner"`. Per-task override via the `contextStrategy` field in `POST /task` or `AgentTask`. |

### Per-task override

`POST /task` accepts a `contextStrategy` field that wins over the config default. Used by the bench harness to A/B the same request:

```bash
curl -X POST http://127.0.0.1:18800/task \
  -H 'Content-Type: application/json' \
  -d '{
    "agent": "devops-agent",
    "message": "...",
    "contextStrategy": "planner",
    "context": { "channel": "bench", "chatId": "bench-1", "sender": "anis" }
  }'
```

## Benchmarking

The `agentx bench context` command posts the same message twice (once per strategy) and prints a side-by-side token/cost/latency comparison:

```bash
agentx bench context \
  --agent devops-agent \
  --message "In one short sentence, what is your role?" \
  --channel bench \
  --chat-id bench-1 \
  --runs 1
```

::: warning Don't bench with command-shaped messages
Agents like `devops-agent` and `coder-agent` run with `permissionMode: "bypassPermissions"` and will execute a message like "restart daemond" for real. Use observation-only phrasing for bench scenarios.
:::

## Cost model

Opus 4.6 pricing (per million tokens, consistent with [`CACHE_AWARE_PRICING`](https://github.com/anis-marrouchi/agentx/blob/master/src/daemon/token-tracker.ts)):

| | Price |
|---|---|
| Input | $5.00 |
| Output | $25.00 |
| Cache read (5-min ephemeral) | $0.50 (10× cheaper than input) |
| Cache create | $6.25 (1.25× input) |
| Tier-2 multiplier | 1.5× all four rates, applies when total input > 200K |

Two things follow from those numbers:

1. **Cache-read is very cheap.** Each turn of layered's `--resume` replay pays cache-read rates. Until the replay approaches the tier-2 threshold, per-turn cost is dominated by the small cache-create delta for the new user message.
2. **Cache-create is expensive.** Forcing cache-create every turn (what `planner` does by rotating sessions) is ~12× the per-token cost of cache-read.

That's why `planner` looks worse than intuition expects on short interactive chats — the session rotation it performs to stay lean is itself costly in cache-create terms.

## End-to-end bench results

Real measurements, devops-agent (Opus 4.6), `POST /task` against a local daemon. The message is the same short observation-only question on every turn. Each turn runs sequentially on the same `chatId` so layered accumulates `--resume` replay and planner rotates each time.

### Input tokens per turn

| Turn | Layered total input | Planner total input |
|---|---|---|
| 1 | 27 875 | 27 875 |
| 2 | 29 191 | 27 824 |
| 3 | 30 484 | 27 819 |
| 4 | 31 783 | 27 819 |
| 5 | 33 083 | 27 819 |

Layered grows by ~1 300 tokens per turn as `--resume` replay accumulates. Planner stays flat because the Claude session is rotated each turn.

### Cost per turn

| Turn | Layered cost | Planner cost (incl. Haiku plan) |
|---|---|---|
| 1 | $0.105 | $0.105 |
| 2 | **$0.022** | $0.105 |
| 3 | $0.023 | $0.105 |
| 4 | $0.023 | $0.105 |
| 5 | $0.024 | $0.105 |
| **5-turn total** | **$0.197** | **$0.53** |

Layered is ~2.7× cheaper over 5 turns on this workload.

### Where planner wins

Real devops-agent traffic on 2026-04-20:

- 57 tasks, 14.3M tier-2 cache-read tokens
- Average ~290K cache-read per tier-2 turn (bash outputs, file reads, GitLab dumps accumulated in `--resume`)
- Estimated cost ~$18.77 for the day

Projected planner cost for the same 57 turns: 57 × ~$0.105 + Haiku overhead ≈ **$6.02**. That's a **~68% reduction** — because the replay bloat crossed tier-2 on most turns, where cache-read is billed at 1.5× and the absolute token count is huge.

**Big picture:**

- Short & clean Q&A turns → layered wins
- Long tool-heavy sessions that push past tier-2 → planner wins
- `maxTurnsPerSession = 15` (the default) caps the worst case of layered, keeping it below tier-2 on most workloads

## Which to pick

| Workload | Recommended strategy |
|---|---|
| Telegram / WhatsApp Q&A, short-to-medium chats | `layered` (default) |
| GitLab MR comments, webhook replies | `layered` |
| Tool-heavy agents routinely hitting the 200K tier-2 threshold | `planner` |
| Crons, scheduled reports, batch pipelines | `planner` (latency doesn't matter) |
| Debugging a runaway context | `planner` (or just lower `maxTurnsPerSession`) |

## Observability

The daemon logs these lines so you can spot regressions without reading usage JSON:

- `[<agent>] large context for <chan>:<chat>: N bytes (history=…, sysPrompt=…, message=…)` — your assembled context crossed 16K chars. Usually a runaway layer.
- `[<agent>] TIER-2 HIT on <chan>:<chat>: N total input tokens … — next turn will rotate` — prior turn paid the 1.5× multiplier. Next turn auto-rotates.
- `[<agent>] tier-2 rotation for <chan>:<chat> …` / `[<agent>] max-turns rotation for <chan>:<chat> …` — rotation happened; fresh Claude session will be started.
- `[<agent>] planner: turns=N, mem=yes/no, xchat=yes/no (Xms) — <reasoning>` — planner's decision for this turn (when `contextStrategy = "planner"`).

## FAQ

**Does planner affect quality?**
Not in our bench — the planner preserves the same "always-on core" (channel, scope, landscape, identity, intent) and only re-curates session history, memory, and cross-chat. Fall-back to layered on errors means quality never regresses below the default.

**Can I use planner for some agents but not others?**
Not at the agent level today. Use per-task override (`contextStrategy` in `POST /task`) or flip the global default. An agent-level setting is a reasonable enhancement — file an issue if you need it.

**What if the Haiku planner call fails?**
`planContext` returns `null` and the registry falls back to the layered path for that turn. Set `AGENTX_PLANNER_DEBUG=1` to log the underlying error.

**Do the session rotation knobs affect other providers?**
They apply only to `claude-code` tier (Claude CLI `--resume`). Other tiers don't use `--resume` and aren't affected.
