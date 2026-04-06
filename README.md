# AgentX

**Self-hosted multi-agent orchestrator.** Routes messages from Telegram, WhatsApp, Discord, crons, and cross-machine A2A mesh to AI agents running on Claude Code, OpenAI, Ollama, or any LLM provider.

> **Experimental.** Built as a self-hosted, bring-your-own-key alternative to third-party AI orchestrators affected by [Anthropic's updated terms of use](https://www.anthropic.com/policies). You run it on your own machines with your own API keys or Claude subscription.

## Install

```bash
npm install -g agentix-cli
```

## Quick start

```bash
# 1. Initialize
agentx init

# 2. Add an agent (interactive)
agentx agent add

# 3. Add a Telegram bot (interactive, verifies token)
agentx channel add

# 4. Start
agentx daemon start
```

That's it. Your agent is live on Telegram.

## How it works

```
  Telegram ──┐
  WhatsApp ──┤  agentx     ┌─ claude -p --cwd /workspace
  Discord ───┤  daemon  ───┤─ openai API
  Cron ──────┤             └─ ollama generate
  A2A mesh ──┘
                 │
         routes messages to the right
         agent workspace with wiki context
```

Each agent = a workspace directory. For Claude Code agents, permissions, hooks, MCP servers, skills, and memory live in the workspace's `.claude/` directory. AgentX just orchestrates when and where agents run.

## CLI Commands

### Daemon (core)

```bash
agentx daemon start              # Start foreground
agentx daemon start --detach     # Start background
agentx daemon stop               # Stop daemon
agentx daemon status             # Show agents, crons, mesh health
agentx daemon logs -f            # Follow logs
agentx daemon send <agent> <msg> # Send a task to an agent
agentx daemon send <agent> <msg> --peer server-2  # Send to remote agent
agentx daemon deploy <host> -i ~/.ssh/key --restart  # Deploy + restart remote
```

### Agents

```bash
agentx agent add        # Interactive: creates workspace, CLAUDE.md, settings, wiki skill
agentx agent list       # List all agents
agentx agent remove <id>  # Remove from config (keeps workspace)
```

### Channels

```bash
agentx channel add      # Interactive: Telegram bot token, verify, bind to agent
agentx channel list     # List all channel bindings
```

**Supported channels:**
- **Telegram** — Multi-account bots, streaming responses, MarkdownV2, typing indicators, seen reactions, bot-to-bot delegation
- **WhatsApp** — Via Baileys (QR pairing), self-chat mode (message yourself to talk to agent), per-contact/group agent routing
- **Discord** — Via discord.js, mention-based routing, DM support

### Cron jobs

```bash
agentx cron add         # Interactive: schedule, agent, prompt, timezone
agentx cron list        # List all jobs with status
agentx cron enable <id> # Enable a job
agentx cron disable <id>  # Disable a job
```

### Mesh (multi-machine)

```bash
agentx mesh add         # Interactive: URL, name, verifies connectivity
agentx mesh list        # List peers with health status
agentx mesh remove <name>  # Remove a peer
```

### Skills

```bash
agentx skill add ./path/to/skill --agent my-agent     # Add to one agent
agentx skill add ./path/to/skill --all                 # Add to all agents
agentx skill list       # List skills per agent
```

### Hooks

```bash
agentx hook add <agent>  # Interactive: event, type (command/http), matcher
```

### Migration

```bash
agentx migrate openclaw                    # Auto-detect ~/.openclaw/
agentx migrate openclaw /path/to/config    # Explicit path
agentx migrate openclaw --dry-run          # Preview without writing
```

### Setup

```bash
agentx init             # Create agentx.json, .env, workspace dirs
agentx init --force     # Overwrite existing config
```

## Configuration

Single `agentx.json` file. Environment variables expanded (`${VAR_NAME}`). Auto-loads `.env`.

```jsonc
{
  "node": {
    "id": "my-machine",
    "name": "My Machine",
    "bind": "127.0.0.1:18800"
  },

  "providers": {
    "claude": { "apiKey": "${ANTHROPIC_API_KEY}" }
  },

  "agents": {
    "assistant": {
      "name": "Assistant",
      "workspace": "/path/to/workspace",
      "tier": "claude-code",
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
    },
    "whatsapp": {
      "enabled": true,
      "sessionDir": ".agentx/whatsapp-sessions",
      "defaultAgent": "assistant",
      "routes": [
        { "contact": "+1234567890", "agent": "assistant" },
        { "group": "Team Chat", "agent": "devops" }
      ]
    },
    "discord": {
      "enabled": true,
      "token": "${DISCORD_BOT_TOKEN}",
      "agentBinding": "assistant"
    }
  },

  "crons": {
    "daily-report": {
      "enabled": true,
      "schedule": "0 9 * * *",
      "timezone": "UTC",
      "agent": "assistant",
      "prompt": "Generate today's status report.",
      "timeout": 600
    }
  },

  "mesh": {
    "enabled": true,
    "peers": [
      { "url": "http://100.67.108.119:19900", "name": "server-2" }
    ]
  }
}
```

## Agent workspace

Each agent is a directory with Claude Code configuration:

```
my-workspace/
├── .claude/
│   ├── settings.json      # Permissions, hooks, env vars
│   ├── .mcp.json          # MCP servers
│   ├── agents/            # Subagents
│   └── skills/            # SKILL.md files (gitlab, wiki, etc.)
├── CLAUDE.md              # Agent identity and instructions
└── ... (project files)
```

New agents created via `agentx agent add` get `CLAUDE.md`, `settings.json`, and the wiki skill automatically.

## Three execution tiers

| Tier | How | Auth | Best for |
|------|-----|------|----------|
| `claude-code` | Spawns `claude` CLI | Subscription | Full power: subagents, MCP, skills, hooks, 1M context |
| `sdk` | Claude Agent SDK | API key | Programmatic control, headless servers |
| `orchestrator` | AgentX's own loop | Any provider key | Non-Claude providers (OpenAI, Ollama) |

## Session continuity

Agents remember conversations:
- **Claude Code tier**: `--resume SESSION_ID` with reliable ID from `--output-format json`
- **Other tiers**: Recent conversation history injected into each prompt
- **Wiki context**: Relevant knowledge articles injected before each response

## Wiki knowledge base

Inspired by [Karpathy's LLM knowledge base](https://x.com/karpathy/status/2040572272944324650) and [Farzapedia](https://gist.github.com/farzaa/c35ac0cfbeb957788650e36aabea836d).

Agents build a shared Markdown wiki from conversations. Token-efficient: ~1K tokens for wiki context vs ~10K for session replay.

```
.agentx/wiki/
├── WIKI.md              # Master index
├── raw/entries/          # Auto-ingested conversations
├── projects/             # Compiled knowledge
├── decisions/
└── patterns/
```

**Permissions**: `private` (owner only), `shared` (listed agents), `public` (all agents).

## A2A Mesh

Run `agentx daemon` on multiple machines. Agents communicate cross-machine via HTTP over Tailscale/VPN.

```
MacBook (Nadia, DevOps)  ←── Tailscale ──→  Server (Atlas, MTGL, KSI, ...)
        :18800                                       :19900
```

## HTTP API

The daemon exposes a REST API:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | System status, agents, crons, mesh |
| `/agents` | GET | List agents |
| `/crons` | GET | List cron jobs |
| `/mesh` | GET | Mesh peer directory |
| `/task` | POST | `{ "agent": "id", "message": "..." }` |
| `/mesh/task` | POST | `{ "peer": "name", "message": "..." }` |
| `/.well-known/agent-card.json` | GET | A2A agent discovery |

## Migrating from OpenClaw

```bash
agentx migrate openclaw
```

Auto-imports agents, Telegram bots, cron jobs, and WhatsApp config. Also ports:
- Skills to workspace `.claude/skills/`
- Permissions to `.claude/settings.json`
- Agent identity to `CLAUDE.md`
- WhatsApp sessions (reuses existing pairing)

| OpenClaw | AgentX |
|----------|--------|
| Gateway + Node | Single daemon per machine |
| OAuth proxy | Direct API key or subscription |
| `openclaw.json` | `agentx.json` |
| `exec-approvals.json` | `.claude/settings.json` per workspace |

## Use cases

- **Team of Telegram bots** — each project gets its own bot + agent with isolated workspace
- **WhatsApp assistant** — message yourself, agent replies in self-chat
- **Scheduled content** — cron jobs generate blog posts, reports, social media drafts
- **Multi-machine swarm** — agents on MacBook + server collaborate via mesh
- **Bot-to-bot delegation** — Nadia mentions @devops in her response, DevOps agent picks up
- **Wiki knowledge** — agents accumulate knowledge, share insights across the team

## Legal

AgentX is a **self-hosted, bring-your-own-key** tool:

- Each user provides their own API key or Claude subscription
- No credentials are stored, shared, or proxied by AgentX
- Built on official public packages: Claude API, Claude Agent SDK, Claude Code CLI
- Provider-agnostic — works with any LLM, not locked to Anthropic
- Same model as LangChain, CrewAI, AutoGen, Dify, n8n

## License

MIT
