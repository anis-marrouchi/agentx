# AgentX

**Self-hosted multi-agent orchestrator.** Routes messages from Telegram, WhatsApp, Discord, GitLab, crons, webhooks, and cross-machine mesh to AI agents running on Claude Code, OpenAI, Ollama, or any LLM provider.

> **Early stage — not production-ready.** We're actively building and looking for contributors. See [Contributing](#contributing) below.

## Why AgentX?

Existing multi-agent frameworks (CrewAI, AutoGen, LangGraph) are SDK-first, Python-heavy, and cloud-dependent. AgentX is **infrastructure-first** — closer to systemd for AI agents than to another framework.

- **BYOAI** — Bring your own AI. Claude, OpenAI, Ollama, whatever
- **Agents = directories** — Each agent is a workspace with config files. No code required
- **Mesh federation** — Agents on different machines collaborate over Tailscale/VPN
- **Channel routing** — Telegram, GitLab, WhatsApp, Discord, webhooks — built in
- **Wiki memory** — Agents build compounding knowledge from conversations
- **Live monitoring** — Real-time SSE event stream of all agent activity

## Install

```bash
npm install -g agentix-cli
```

## Quick Start

```bash
agentx init                    # Create config + workspace
agentx agent add               # Add an agent (interactive)
agentx channel add             # Add a channel (Telegram/WhatsApp/Discord/GitLab)
agentx daemon start            # Start the daemon
agentx daemon watch            # Live activity feed (color-coded)
```

## Architecture

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

Each agent = a workspace directory with Claude Code configuration (`.claude/`, `CLAUDE.md`, skills, hooks, MCP servers). AgentX orchestrates when and where agents run. Each agent builds a compounding personal wiki from its conversations.

## Features

### Channels

| Channel | Highlights |
|---------|-----------|
| **Telegram** | Multi-account bots, streaming edits, bot-to-bot delegation, media handling |
| **WhatsApp** | Baileys integration, QR pairing, per-contact/group routing |
| **Discord** | Mention-based routing, DM support |
| **GitLab** | Webhook-driven: issues, MRs, pipeline events. Per-agent tokens — each agent posts as its own GitLab user. @mention routing, bot-to-bot handoff, eye reaction acknowledgment |
| **Webhooks** | Generic `POST /webhook/:agentId` for Stripe, Sentry, GitHub, etc. |

### GitLab Integration

Agents participate in GitLab as first-class team members:
- **Per-agent identity** — Each agent has its own GitLab user and PAT. Comments show the correct author, not a shared bot account
- **@mention routing** — `@coding-agent` in a comment routes to that agent using the same registry as Telegram
- **Bot-to-bot handoff** — QA agent can `@mention` devops in its review, devops picks it up automatically
- **Eye reaction** — Agents react with 👀 on comments they're processing (using their own token)
- **Cascade prevention** — Bot comments only route when they @mention a *different* agent. No echo loops
- **Brevity rules** — Agents respond in 3-5 lines with `<details>` collapsible sections for verbose output

### Core

- **Multi-agent** — Named agents with permissions, concurrency limits, mention-based routing
- **Context engine** — 8-layer structured context with per-layer token budgets
- **Session continuity** — `--resume SESSION_ID` for Claude Code, history injection for other tiers
- **Stable session keying** — Sessions keyed by chat context (e.g. issue path), not sender name
- **Bot-to-bot** — Agents mention each other on Telegram, conversation chains with loop prevention
- **Group context** — Persistent group conversation log, agents see last 30 messages
- **Media handling** — Photos, voice, audio, video, documents downloaded and passed to agent
- **Reply-to context** — When replying to a message, agent sees the original text
- **Brevity by default** — Agents lead with action/result, skip preamble. Channel-specific formatting rules

### Live Monitoring

Real-time visibility into what agents are doing right now:

```bash
agentx daemon watch            # Color-coded live feed
# ▶ [devops-mtgl] executing task (1/1)
# → Routing [gitlab/Anis] -> "DevOps MTGL"
# ✓ [devops-mtgl] completed in 35652ms
# ✗ [pm-mtgl] error: Agent busy
```

Or connect directly via SSE:
```bash
curl -N http://localhost:18800/events
```

Every routing decision, execution, completion, and error streams in real-time.

### Wiki Knowledge Base

Each agent has its own personal wiki — a compounding knowledge artifact built from conversations. Inspired by [Karpathy's LLM Knowledge Base](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), extended with entity-aware gap detection and mesh federation.

**How it works:**
1. **Ingest** — Every conversation is saved as a raw entry
2. **Absorb** — LLM compiles entries into wiki articles with aggressive tagging and gap detection
3. **Query** — Agents get relevant context filtered by tags
4. **Sync** — Pull entries from mesh peers; federated wiki view across machines

**Three compilation modes** (`--mode`):

| Mode | Strategy | Best at |
|------|----------|---------|
| `unified` (default) | Flat tags + entity thinking | Tag density, article count, gap specificity |
| `flat` | Karpathy pure — tags only, LLM-chosen paths | Simplicity |
| `graph` | Knowledge graph — hierarchy, entities, events | Deep hierarchy, entity-level gaps |

**Key features:**
- **Worldview** — Edit `worldview.md` to describe YOUR world. The LLM reads it during absorb.
- **Aggressive tagging** — Every article tagged with who, what, when, where, how. Section-level tags too.
- **Gap detection** — Absorb identifies missing pieces with specificity
- **LLM-chosen structure** — No rigid taxonomy. Structure emerges from data.
- **Mesh federation** — `wiki sync` pulls entries from peers. `wiki serve --peer` shows remote articles live.
- **Wikipedia-style UI** — `agentx wiki serve` at http://localhost:4200

### Skills

Reusable capabilities installed per-agent or globally:

```bash
agentx skill add skills/my-skill --all    # Install to all agents
agentx skill add skills/my-skill --agent devops  # One agent
agentx skill list                          # List per agent
```

Skills are markdown files (`SKILL.md`) with frontmatter (name, tags, triggers). Agents auto-load skills from `.claude/skills/` in their workspace. Share skills across the mesh — agents discover each other's capabilities.

### Mesh Federation

Agents on different machines collaborate:

```bash
agentx mesh add server-2 http://100.x.x.x:19900
agentx daemon send devops "check disk space" --peer server-2
```

- Static or mDNS peer discovery
- Health checks every 60s
- Wiki sync across peers
- Cross-machine agent delegation via HTTP

### Token Usage

Real token counts from Claude's JSON output (not estimates).

```bash
agentx usage                   # Today's summary
agentx usage report --days 7   # Per-agent breakdown
```

## CLI Reference

```bash
# Daemon
agentx daemon start [--detach]
agentx daemon stop
agentx daemon status
agentx daemon watch              # Live activity stream (NEW)
agentx daemon logs [-f]
agentx daemon send <agent> <msg> [--peer <name>]
agentx daemon deploy <host> -i key [--restart]

# Wiki
agentx wiki status [--mode M]
agentx wiki absorb [--agent X] [--mode M] [--dry-run]
agentx wiki serve [--mode M] [--peer URL]
agentx wiki sync [--peer URL]
agentx wiki compare --agent X
agentx wiki lint [--agent X]
agentx wiki search <query>

# Management
agentx agent add | list | remove <id>
agentx channel add | list
agentx cron add | list | enable | disable <id>
agentx mesh add | list | remove <name>
agentx skill add <path> [--agent X] [--all] | list
agentx hook add <agent>
agentx config check | show
agentx init [--force]

# Usage
agentx usage [report] [--days N]
```

## Configuration

Single `agentx.json`. Environment variables expanded (`${VAR_NAME}`). Auto-loads `.env`.

```jsonc
{
  "node": { "id": "my-machine", "name": "My Machine", "bind": "0.0.0.0:18800" },

  "agents": {
    "assistant": {
      "name": "Assistant",
      "workspace": "/path/to/workspace",
      "tier": "claude-code",        // "sdk" or "orchestrator"
      "model": "claude-sonnet-4-6",
      "mentions": ["@my_bot", "my-gitlab-user"],
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
    "gitlab": {
      "enabled": true,
      "host": "https://gitlab.example.com",
      "token": "${GITLAB_TOKEN}",
      "webhookPort": 18810,
      "routes": [
        { "project": "team/project-a", "agent": "pm-a" },
        { "project": "*", "agent": "default-agent" }
      ],
      "agentMappings": [
        {
          "agentId": "coder",
          "gitlabUsernames": ["coder-bot"],
          "keywords": [],
          "token": "${CODER_GITLAB_TOKEN}"
        }
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
      { "url": "http://100.x.x.x:19900", "name": "server-2" }
    ]
  }
}
```

## HTTP API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Status, agents, crons, mesh, usage |
| `/events` | GET | **SSE live event stream** — all agent activity in real-time |
| `/agents` | GET | List agents |
| `/task` | POST | `{ "agent": "id", "message": "..." }` |
| `/mesh/task` | POST | `{ "peer": "name", "message": "..." }` |
| `/webhook/:agentId[/:source]` | POST | Webhook callback |
| `/v1/chat/completions` | POST | OpenAI-compatible endpoint |
| `/.well-known/agent-card.json` | GET | A2A agent discovery |

## Context Engine

Every agent prompt is built from 8 structured layers, each with a token budget:

| Layer | Priority | Budget | Content |
|-------|----------|--------|---------|
| Channel | 1 | 200 | Channel type + formatting rules |
| Scope | 2 | 200 | Group name, project path, or DM |
| Identity | 3 | 300 | Agent system prompt |
| Peers | 4 | 400 | Team roster with handles |
| Intent | 5 | 200 | Extracted: deploy, review, bugfix... |
| Artifacts | 6 | 500 | Media, reply-to text, issue refs |
| History | 7 | 1200 | Conversation or session history |
| Wiki | 8 | 1000 | Tag-matched knowledge articles |

## Three Execution Tiers

| Tier | How | Auth | Best for |
|------|-----|------|----------|
| `claude-code` | Spawns `claude` CLI | Subscription | Full power: subagents, MCP, skills, hooks, 1M context |
| `sdk` | Claude Agent SDK | API key | Programmatic control, headless servers |
| `orchestrator` | AgentX's own loop | Any provider key | Non-Claude providers (OpenAI, Ollama) |

## Use Cases

- **Team of Telegram bots** — each project gets its own bot + agent
- **GitLab CI/CD team** — coder, QA, devops, PM agents collaborate on issues via @mentions
- **WhatsApp assistant** — message yourself, agent replies in self-chat
- **Scheduled automation** — cron jobs generate reports, content, social media drafts
- **Multi-machine swarm** — agents on laptop + server collaborate via mesh
- **Webhook automation** — Sentry error → DevOps investigates, Stripe payment → billing processes
- **Personal wiki** — Every conversation compounds into searchable knowledge

## Current Status

AgentX is in active development. It works and we use it daily, but expect rough edges:

- GitLab per-agent identity is functional but recently added
- Session management was recently overhauled
- The DTS build has pre-existing type errors (ESM build works fine)
- Some error handling is still being hardened (e.g., port conflicts now retry instead of crashing)
- Test coverage exists for core paths but needs expansion

## Contributing

We're looking for contributors in these areas:

- **Testing** — Unit and integration tests for GitLab routing, session management, bot-to-bot chains
- **Documentation** — Getting-started guide, skill authoring guide, deployment guide
- **Channels** — Slack adapter, Microsoft Teams adapter
- **Providers** — Better OpenAI/Ollama tier support
- **Dashboard** — Web UI for the `/events` SSE stream and agent management
- **Security** — Audit of token handling, webhook validation, permission boundaries

To contribute:

```bash
git clone https://github.com/anis-marrouchi/agentx.git
cd agentx
npm install
npm run build              # ESM build (ignore DTS warnings)
npm test                   # Run tests
agentx init --force        # Create local config
agentx daemon start        # Start dev daemon
agentx daemon watch        # See what's happening
```

## Legal

Self-hosted, bring-your-own-key. No credentials stored or proxied. Built on official public packages (Claude API, Claude Agent SDK, Claude Code CLI).

## License

MIT
