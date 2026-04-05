# AgentX

**Self-hosted multi-agent orchestrator.** Routes messages from Telegram, WhatsApp, crons, and cross-machine A2A mesh to AI agents running on Claude Code, OpenAI, Ollama, or any LLM provider.

> **Experimental.** This project is a rapid response to [Anthropic's updated terms of use](https://www.anthropic.com/policies) restricting third-party OAuth integrations (affecting tools like OpenClaw). AgentX is a self-hosted, bring-your-own-key alternative — you run it on your own machines with your own API keys or Claude subscription.

## How it works

```
  Telegram ──┐
  WhatsApp ──┤  agentx     ┌─ claude -p --cwd /workspace
  Cron ──────┤  daemon  ───┤─ openai API
  A2A mesh ──┘             └─ ollama generate
                 │
         routes messages to the right
         agent workspace with wiki context
```

Each agent = a workspace directory. For Claude Code agents, permissions, hooks, MCP servers, skills, and memory are all configured in the workspace's `.claude/` directory. AgentX just orchestrates when and where they run.

## Features

- **Telegram** — Multi-account bot polling, streaming responses, MarkdownV2 rendering, typing indicators, seen reactions, bot-to-bot delegation
- **Multi-agent** — Named agents with custom permissions, concurrency limits, mention-based routing
- **Wiki knowledge base** — Karpathy/Farzapedia-inspired Markdown wiki with permissions (private/shared/public). Agents compile conversations into articles, retrieve relevant context before responding. Optimizes token usage.
- **Cron scheduler** — Timezone-aware recurring tasks with run logging
- **A2A mesh** — Cross-machine agent communication over Tailscale/VPN, peer discovery, health checks
- **Session memory** — One Claude Code session per agent/chat/day via `--resume`
- **Hooks** — Pre/post hooks for channels, crons, A2A tasks
- **Provider abstraction** — Switch providers per-agent via config with capability warnings

## Quick start

### 1. Initialize

```bash
npx agentix-cli init
# Creates agentx.json, .env template, .agentx/ directory
```

### 2. Configure

Edit `agentx.json`:

```jsonc
{
  "node": { "id": "my-machine", "name": "My Machine", "bind": "127.0.0.1:18800" },

  "agents": {
    "assistant": {
      "name": "Assistant",
      "workspace": "/path/to/workspace",
      "tier": "claude-code",       // or "sdk" or "orchestrator"
      "model": "claude-sonnet-4-6",
      "mentions": ["@my_bot"],
      "maxConcurrent": 2,
      "systemPrompt": "You are a helpful assistant."
    }
  },

  "channels": {
    "telegram": {
      "enabled": true,
      "accounts": {
        "default": { "token": "${TG_BOT_TOKEN}", "agentBinding": "assistant" }
      },
      "policy": { "dm": "pair", "group": "mention-required" }
    }
  },

  "crons": {
    "daily-report": {
      "enabled": true,
      "schedule": "0 9 * * *",
      "timezone": "UTC",
      "agent": "assistant",
      "prompt": "Generate today's status report."
    }
  },

  "mesh": {
    "enabled": false,
    "peers": []
  }
}
```

### 3. Set up agent workspace

```
my-workspace/
├── .claude/
│   ├── settings.json   # Permissions, hooks
│   ├── .mcp.json       # MCP servers
│   └── skills/         # SKILL.md files (gitlab, wiki, etc.)
├── CLAUDE.md           # Agent identity
└── ... (project files)
```

### 4. Start

```bash
agentx daemon start           # foreground
agentx daemon start --detach  # background
```

## CLI Commands

```
agentx daemon start [--detach] [-c config]   Start the daemon
agentx daemon stop                           Stop the daemon
agentx daemon status                         Show agents, crons, mesh status
agentx daemon logs [-f] [-n lines]           Tail daemon logs
agentx daemon send <agent> <message>         Send a task to an agent
agentx daemon send <agent> <msg> --peer X    Send to a remote mesh agent
agentx daemon deploy <host> [-i key] [--restart]  Deploy to remote server
agentx init                                  Initialize config and workspace
```

## Three execution tiers

| Tier | How | Auth | Best for |
|------|-----|------|----------|
| `claude-code` | Spawns `claude` CLI | Subscription ($200/mo flat) | Full power: subagents, MCP, skills, hooks, 1M context |
| `sdk` | Claude Agent SDK | API key (pay-per-token) | Programmatic control, headless servers |
| `orchestrator` | AgentX's own loop | Any provider key | Non-Claude providers (OpenAI, Ollama) |

## Wiki knowledge base

Inspired by [Karpathy's LLM knowledge base](https://x.com/karpathy/status/2040572272944324650) and [Farzapedia](https://gist.github.com/farzaa/c35ac0cfbeb957788650e36aabea836d). Agents build a shared Markdown wiki from their conversations and work.

```
.agentx/wiki/
├── WIKI.md              # Master index
├── raw/entries/          # Ingested conversations
├── projects/mtgl-v2.md  # Compiled knowledge
├── decisions/...
└── patterns/...
```

**Permission model:**
- `private` — only the owning agent reads/writes
- `shared` — owner writes, listed agents read
- `public` — owner writes, all agents read

**Token optimization** — instead of replaying conversation history (~10K tokens), agents read 2-3 relevant wiki articles (~1K tokens). Articles are distilled knowledge, not raw transcripts.

## A2A Mesh

Run agentx on multiple machines. Each node discovers peers and agents communicate cross-machine.

```
MacBook (Nadia, DevOps)  ←── Tailscale ──→  Server (Atlas, MTGL, KSI, ...)
        :18800                                       :19900
```

## Migrating from OpenClaw

| OpenClaw | AgentX |
|----------|--------|
| `openclaw.json` agents | `agentx.json` agents |
| `openclaw.json` channels | `agentx.json` channels |
| `cron/jobs.json` | `agentx.json` crons |
| `exec-approvals.json` | Workspace `.claude/settings.json` |
| Gateway + Node | Single daemon per machine |
| OAuth proxy | Direct API key or subscription |

```bash
# 1. Stop OpenClaw
launchctl unload ~/Library/LaunchAgents/ai.openclaw.*.plist  # macOS
systemctl --user stop openclaw-*                              # Linux

# 2. Install and init
npx agentix-cli init

# 3. Edit agentx.json (port agents, channels, crons)
# 4. Start
agentx daemon start
```

## Legal

AgentX is a **self-hosted, bring-your-own-key** tool:

- Each user provides their own API key or Claude subscription
- No credentials are stored, shared, or proxied
- Built on official public packages: Claude API, Claude Agent SDK, Claude Code CLI
- Same model as LangChain, CrewAI, AutoGen, Dify, n8n

## License

MIT
