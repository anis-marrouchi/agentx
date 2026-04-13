# 3. Multi-agent group — Sales + Support + PM in one Telegram chat

> **Difficulty:** beginner · **Time:** 15 minutes · **Ends at:** three agents sharing one Telegram group, routed by @mention, each with its own personality and bot account

## Scenario

A startup wants three AI teammates in their main Telegram group:

- **@sales_bot** — qualifies inbound leads, drafts proposals
- **@support_bot** — answers product questions, triages bugs
- **@pm_bot** — tracks sprint status, posts standups

Humans mention the one they need. The bots can also mention each other to hand work off.

## Why one bot account per agent

Each Telegram bot is a distinct account with its own `@handle` and avatar. In a group chat, that's what lets a human see **which AI is replying**. AgentX's `accounts` map supports this directly: one account per agent, each with its own token and `agentBinding`.

## Commands

Three agents + three bot accounts — all via CLI:

```bash
# Create three bots in @BotFather first, then:

agentx agent add     # run three times — sales, support, pm
agentx channel add   # pick telegram, paste each bot token in turn

agentx daemon start
agentx daemon watch
```

Each `channel add` invocation saves the token to `.env` (under `TG_<NAME>_BOT_TOKEN`) and writes the account into `channels.telegram.accounts`. No file editing.

### What got written

For reference — the three wizards produced:

```json
{
  "agents": {
    "sales":   { "name": "Sales",   "workspace": "./agents/sales",   "tier": "claude-code", "model": "claude-sonnet-4-6", "mentions": ["@sales_bot","@sales"]     },
    "support": { "name": "Support", "workspace": "./agents/support", "tier": "claude-code", "model": "claude-sonnet-4-6", "mentions": ["@support_bot","@support"] },
    "pm":      { "name": "PM",      "workspace": "./agents/pm",      "tier": "claude-code", "model": "claude-sonnet-4-6", "mentions": ["@pm_bot","@pm"]           }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "accounts": {
        "sales":   { "token": "${TG_SALES_BOT_TOKEN}",   "agentBinding": "sales"   },
        "support": { "token": "${TG_SUPPORT_BOT_TOKEN}", "agentBinding": "support" },
        "pm":      { "token": "${TG_PM_BOT_TOKEN}",      "agentBinding": "pm"      }
      },
      "policy": { "dm": "pair", "group": "mention-required" }
    }
  }
}
```

## Personalities (the bootstrap files)

Each agent workspace can hold bootstrap identity files that get injected into every turn:

```
agents/sales/
├── CLAUDE.md      # main system prompt — always loaded
├── SOUL.md        # persistent personality (tone, values)
├── IDENTITY.md    # who I am in this org
└── AGENTS.md      # who my teammates are (optional — landscape auto-fills this)
```

Example `agents/pm/SOUL.md`:

```markdown
# PM — Soul

I write in bullet lists. I never use marketing words.
I always end with a single clear next step.
When I don't know something, I @mention the agent who does.
```

## The landscape

AgentX automatically injects a **landscape** into every agent's context — the roster of other agents in the config, their mentions, and which mesh peers are online. That's why `@pm` can write `"@support — please verify reproduction steps"` and it just works: the router sees the mention and forwards to `support`.


## Verify

In the group chat:

```
@sales_bot — draft an intro email for Acme Corp
```

Watch:

```
→ Routing [telegram/GroupName/User] -> "Sales": @sales_bot — draft an intro email…
▶ [sales] executing task
✓ [sales] completed in 6s
```

Now ask sales to delegate:

```
@sales_bot — ask @pm when the next release is, then draft the email with that date
```

You should see sales produce a reply that tags `@pm_bot`, the router dispatches pm, and sales composes the final email referencing pm's answer.

## Queueing — what happens if you message a busy agent

Each agent has a `queueMode`:

- `collect` (default) — messages that arrive while the agent is working get batched and delivered when it's idle
- `followup` — each queued message becomes a separate turn
- `drop` — discard messages during overload

Set per-agent: `"queueMode": "followup"` under the agent config.

## Concurrency

`maxConcurrent` (default `1`) limits how many turns an agent runs in parallel. Raise it only if the agent is genuinely idempotent — otherwise two concurrent turns may race on the same files.

## What's next

- **Give the team a shared knowledge base** → `agentx wiki` (V2 doc in progress — see [Concepts → Wiki](/concepts#_5-wiki))
- **Turn this into a real team with KPIs** → [Journey 7 — Business layer](/journey/07-business-layer)
- **Run them across two machines** → [Journey 8 — Mesh federation](/journey/08-mesh-federation)
