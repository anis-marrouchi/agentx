# AgentX

**Self-hosted multi-agent orchestrator.** Routes messages from Telegram, WhatsApp, Discord, GitLab, crons, webhooks, and cross-machine A2A mesh to AI agents running on Claude Code, OpenAI, Ollama, or any LLM provider.

> **Experimental.** Built as a self-hosted, bring-your-own-key alternative to third-party AI orchestrators affected by [Anthropic's updated terms of use](https://www.anthropic.com/policies). You run it on your own machines with your own API keys or Claude subscription.

## Install

```bash
npm install -g agentix-cli
```

## Quick start

```bash
agentx init               # Create config + workspace
agentx agent add           # Add an agent (interactive)
agentx channel add         # Add a channel (Telegram/WhatsApp/Discord/GitLab)
agentx daemon start        # Start
```

## How it works

```
  Telegram ──┐
  WhatsApp ──┤               ┌─ claude -p --cwd /workspace
  Discord ───┤   agentx      │
  GitLab  ───┤   daemon  ────┤─ openai API
  Cron ──────┤               │
  Webhook ───┤               └─ ollama generate
  A2A mesh ──┘
                    │
            Context Engine
         (8 layers, token-budgeted)
                    │
               Wiki (per-agent)
         (Karpathy LLM knowledge base)
```

Each agent = a workspace directory with Claude Code configuration (`.claude/`, `CLAUDE.md`, skills, hooks, MCP servers). AgentX orchestrates when and where agents run, and each agent builds a compounding personal wiki from its conversations.

## Features

### Channels
- **Telegram** — Multi-account bots, streaming responses, HTML formatting, typing indicators, seen reactions, bot-to-bot delegation, media handling (photos, voice, audio, video, documents)
- **WhatsApp** — Baileys integration, QR pairing, self-chat mode, per-contact/group agent routing
- **Discord** — Bot with mention-based routing, DM support
- **GitLab** — Webhook channel: comments, issues, MRs, pipeline events route to agents. Agents reply as GitLab comments. @mention-based agent resolution in comments.
- **Webhooks** — Generic `POST /webhook/:agentId` endpoint for Stripe, Sentry, GitHub, etc.

### Core
- **Multi-agent** — Named agents with custom permissions, concurrency limits, mention-based routing
- **Context engine** — 8-layer structured context with per-layer token budgets (channel, scope, identity, peers, intent, artifacts, history, wiki)
- **Session continuity** — `--resume SESSION_ID` for Claude Code, conversation history injection for other tiers
- **Bot-to-bot** — Agents mention each other on Telegram, conversation chains with loop prevention (visited set + max depth)
- **Group context** — Persistent group conversation log, agents see last 30 messages when mentioned
- **Media handling** — Photos, voice messages, audio, video, documents downloaded and passed to agent
- **Reply-to context** — When replying to a message, agent sees the original text

### Wiki Knowledge Base

Each agent has its own personal wiki — a compounding knowledge artifact built from conversations. Inspired by [Karpathy's LLM Knowledge Base](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) approach, extended with entity-aware gap detection and mesh federation.

**How it works:**
1. **Ingest** — Every conversation is saved as a raw entry in `raw/entries/`
2. **Absorb** — LLM compiles entries into wiki articles with aggressive tagging and gap detection
3. **Query** — Agents get relevant context filtered by tags (only MTGL articles when working on MTGL)
4. **Lint** — Health checks for broken links, orphans, untagged articles
5. **Sync** — Pull entries from mesh peers; federated wiki view across machines

**Three compilation modes** (`--mode`):

| Mode | Default | Strategy | Best at |
|------|---------|----------|---------|
| `unified` | Yes | Flat tags + entity thinking | Tag density (7.9/article), article count, gap specificity |
| `flat` | No | Karpathy pure — tags only, LLM-chosen paths | Simplicity, directory spread |
| `graph` | No | Knowledge graph — hierarchy, entities, events | Deep hierarchy, entity-level gaps |

Same raw entries, separate article stores per mode. Compare deterministically:
```bash
agentx wiki compare --agent devops    # Side-by-side stats for all 3 modes
```

**Key features:**
- **Worldview** — Edit `worldview.md` to describe YOUR world (company, clients, team). The LLM reads it during absorb.
- **Aggressive tagging** — Every article tagged with who, what, when, where, how (min 6 tags). Section-level tags too (`<!-- tags: runbook, staging -->`).
- **Gap detection** — Absorb identifies missing puzzle pieces with specificity ("Seif al-Arabi — MTGL stakeholder, issues deploy instructions via Telegram, no profile article")
- **LLM-chosen structure** — No rigid taxonomy. The LLM decides how to organize files. Structure emerges from data.
- **Per-agent wikis** — Each agent has its own wiki. Hub view shows all agents.
- **Mesh federation** — `wiki sync` pulls entries from peers. `wiki serve --peer` shows remote articles live.
- **Wikipedia-style UI** — `agentx wiki serve` renders the wiki as a browsable website with remote article support.

**Karpathy's 4 principles honored:**
1. **Explicit** — Memory is navigable `.md` files, not hidden in weights
2. **Yours** — Local files on your machine, not locked in a provider
3. **File over app** — Universal markdown, Unix-compatible, works with Obsidian
4. **BYOAI** — Plug in any AI. Absorb uses Sonnet but any model works

```bash
agentx wiki status                    # Per-agent article/entry counts
agentx wiki absorb                    # Compile entries → articles (all agents)
agentx wiki absorb --agent devops     # One agent only
agentx wiki absorb --mode flat        # Karpathy pure mode
agentx wiki absorb --dry-run          # Preview without running
agentx wiki serve                     # Browse at http://localhost:4200
agentx wiki serve --peer http://...   # Federated view with mesh peers
agentx wiki sync --peer http://...    # Pull entries from mesh peer
agentx wiki compare --agent devops    # Compare all 3 modes side-by-side
agentx wiki lint                      # Health check
agentx wiki entries                   # List raw entries
agentx wiki search "deploy"           # Search across all agent wikis
```

### Token Usage

Real token counts from Claude's JSON output (not estimates). Cache hit ratios, per-agent breakdowns.

```bash
agentx usage                          # Today's summary from daemon
agentx usage report                   # Full session analysis (parses JSONL)
```

### Operations
- **Cron scheduler** — Timezone-aware recurring tasks with run logging
- **A2A mesh** — Cross-machine agent communication over Tailscale/VPN
- **Rate limiting** — Per-agent, 10/min, 100/hour (configurable)
- **Token tracking** — Real token counts per agent per day, cache hit ratios, 7-day summaries
- **Process management** — PID file, graceful shutdown, uncaught exception handlers
- **83 unit tests** — Config, sessions, wiki, group log, context engine, telegram format, token tracker

## CLI Commands

### Daemon
```bash
agentx daemon start [--detach]       # Start (foreground or background)
agentx daemon stop                   # Graceful shutdown
agentx daemon status                 # Agents, crons, mesh health
agentx daemon logs [-f]              # Tail logs
agentx daemon send <agent> <msg>     # Send task to agent
agentx daemon send <agent> <msg> --peer server-2  # Remote agent
agentx daemon deploy <host> -i key [--restart]    # Deploy (runs tests first)
```

### Wiki
```bash
agentx wiki status [--mode M]        # Per-agent wiki status
agentx wiki absorb [--agent X] [--mode M]  # Compile entries → articles
agentx wiki serve [--mode M] [--peer URL]  # Wikipedia-style web UI (federated)
agentx wiki sync [--peer URL]        # Pull entries from mesh peers
agentx wiki compare --agent X        # Compare all 3 modes side-by-side
agentx wiki lint [--agent X]         # Health check
agentx wiki entries [--agent X]      # List raw entries
agentx wiki search <query>           # Search articles
# Modes: unified (default), flat, graph
```

### Usage
```bash
agentx usage                         # Token usage summary
agentx usage report [--days 7]       # Full JSONL analysis
```

### Management
```bash
agentx agent add / list / remove <id>
agentx channel add / list              # Telegram, WhatsApp, Discord, GitLab
agentx cron add / list / enable / disable <id>
agentx mesh add / list / remove <name>
agentx skill add <path> [--agent X] [--all]  / list
agentx hook add <agent>
agentx config check                    # Validate config + workspaces
agentx config show                     # Print resolved config
agentx migrate openclaw [path] [--dry-run]
agentx init [--force]
```

## Configuration

Single `agentx.json`. Environment variables expanded (`${VAR_NAME}`). Auto-loads `.env`.

```jsonc
{
  "node": { "id": "my-machine", "name": "My Machine", "bind": "127.0.0.1:18800" },

  "agents": {
    "assistant": {
      "name": "Assistant",
      "workspace": "/path/to/workspace",
      "tier": "claude-code",        // "sdk" or "orchestrator"
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
    },
    "gitlab": {
      "enabled": true,
      "host": "https://gitlab.example.com",
      "token": "${GITLAB_TOKEN}",
      "webhookPort": 18810,
      "routes": [
        { "project": "team/project-a", "agent": "pm-a" },
        { "project": "*", "agent": "atlas" }
      ]
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
    "enabled": true,
    "peers": [
      { "url": "http://100.67.108.119:19900", "name": "server-2" }
    ]
  }
}
```

## Context Engine

Every agent prompt is built from 8 structured layers, each with a token budget:

| Layer | Priority | Budget | Content |
|-------|----------|--------|---------|
| Channel | 1 | 200 | Channel type + rules (GitLab: no @handles, use GFM) |
| Scope | 2 | 200 | Group name, project path, or DM |
| Identity | 3 | 300 | Agent system prompt (first line) |
| Peers | 4 | 400 | Team roster with handles (Telegram only) |
| Intent | 5 | 200 | Extracted from message: deploy, review, bugfix... |
| Artifacts | 6 | 500 | Media, reply-to text, issue/MR references |
| History | 7 | 1200 | Group conversation or session history |
| Wiki | 8 | 1000 | Tag-matched knowledge articles |

Total budget: 4000 tokens. Lower layers truncated if over budget.

## HTTP API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Status, agents, crons, mesh, today's usage |
| `/agents` | GET | List agents |
| `/crons` | GET | List cron jobs |
| `/mesh` | GET | Mesh peers |
| `/usage` | GET | 7-day token usage per agent |
| `/task` | POST | `{ "agent": "id", "message": "..." }` |
| `/mesh/task` | POST | `{ "peer": "name", "message": "..." }` |
| `/webhook/:agentId[/:source]` | POST | Webhook callback (GitLab, GitHub, Stripe, Sentry) |
| `/v1/chat/completions` | POST | OpenAI-compatible endpoint (ElevenLabs, Cursor, any client) |
| `/llm/:agentId/v1/chat/completions` | POST | OpenAI-compatible with explicit agent |
| `/.well-known/agent-card.json` | GET | A2A agent discovery |

## OpenAI-Compatible Endpoint

Any agent can be used as an LLM backend for ElevenLabs Conversational AI, Cursor, or any OpenAI-compatible client.

```bash
curl -X POST http://your-server:18800/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "atlas", "messages": [{"role": "user", "content": "Hello"}]}'
```

Supports streaming (`"stream": true`) with SSE. The `model` field maps to the agent ID.

## Three execution tiers

| Tier | How | Auth | Best for |
|------|-----|------|----------|
| `claude-code` | Spawns `claude` CLI | Subscription | Full power: subagents, MCP, skills, hooks, 1M context |
| `sdk` | Claude Agent SDK | API key | Programmatic control, headless servers |
| `orchestrator` | AgentX's own loop | Any provider key | Non-Claude providers (OpenAI, Ollama) |

## Migrating from OpenClaw

```bash
agentx migrate openclaw    # Auto-imports agents, channels, crons, skills
```

## Use cases

- **Team of Telegram bots** — each project gets its own bot + agent
- **GitLab code review** — comment on MR, agent reviews and replies as a GitLab comment
- **WhatsApp assistant** — message yourself, agent replies in self-chat
- **Scheduled content** — cron jobs generate blog posts, reports, social media drafts
- **Multi-machine swarm** — agents on MacBook + server collaborate via mesh
- **Webhook automation** — Sentry error -> DevOps agent investigates, Stripe payment -> billing agent processes
- **Bot-to-bot delegation** — Nadia mentions @devops, DevOps picks up and responds
- **Personal wiki** — Every conversation compounds into searchable, tag-filtered knowledge

## Legal

Self-hosted, bring-your-own-key. No credentials stored or proxied. Built on official public packages (Claude API, Claude Agent SDK, Claude Code CLI). Same model as LangChain, CrewAI, AutoGen.

## License

MIT
