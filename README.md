# AgentX

**Self-hosted multi-agent orchestrator.** Routes messages from Telegram, WhatsApp, Discord, GitLab, crons, webhooks, and cross-machine mesh to AI agents running on Claude Code, OpenAI, Ollama, or any LLM provider.

## Why AgentX?

Existing multi-agent frameworks (CrewAI, AutoGen, LangGraph) are SDK-first, Python-heavy, and cloud-dependent. AgentX is **infrastructure-first** — closer to systemd for AI agents than to another framework.

- **BYOAI** — Bring your own AI. Claude, OpenAI, Ollama, whatever
- **Agents = directories** — Each agent is a workspace with config files. No code required
- **Mesh federation** — Agents on different machines collaborate over Tailscale/VPN
- **Channel routing** — Telegram, GitLab, WhatsApp, Discord, webhooks — built in
- **Cross-channel messaging** — Agents receive on one channel, send to another via `/send` API
- **Wiki memory** — Agents build compounding knowledge from conversations
- **Live monitoring** — Real-time SSE event stream + debug mode with categories

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
       (10 layers, token-budgeted)
                    │
          ┌─────────┼─────────┐
       Wiki    Memory    Bootstrap
   (per-agent) (Haiku)  (SOUL.md)
```

Each agent = a workspace directory with Claude Code configuration (`.claude/`, `CLAUDE.md`, skills, hooks, MCP servers). AgentX orchestrates when and where agents run.

## Communication Matrix

AgentX supports every communication path: human-to-agent, agent-to-human, agent-to-agent, and cross-channel — across all channels.

| Path | Telegram | WhatsApp | Discord | GitLab | API |
|------|:--------:|:--------:|:-------:|:------:|:---:|
| **H2A** (human to agent) | mention/DM | route | mention/DM | @username | POST /task |
| **A2H reply** | streaming | text | text | per-agent token | JSON |
| **A2H initiate** | /send | /send | /send | /send | - |
| **A2A delegation** | per-account bot chain | shared number + name prefix | shared + name prefix | @mention webhook | - |
| **Cross-channel** | /send | /send | /send | /send | - |
| **Cross-mesh** | mesh task | mesh task | mesh task | mesh task | mesh task |

### Cross-Channel Messaging

Agents can send messages to ANY channel proactively — not just reply:

```bash
# Agent on GitLab sends a notification to Telegram
curl -X POST http://localhost:19900/send \
  -H "Content-Type: application/json" \
  -d '{"channel":"telegram","chatId":"-1001234567890","text":"Deploy complete!","agentId":"devops"}'
```

This enables **H2A2H chains**: a human asks an agent on GitLab to notify someone on WhatsApp. The agent calls `/send` to deliver the message cross-channel.

## Features

### Channels

| Channel | Highlights |
|---------|-----------|
| **Telegram** | Multi-account bots, streaming edits, bot-to-bot delegation, media handling |
| **WhatsApp** | Baileys integration, QR pairing, per-contact/group routing, agent delegation (shared number, name-prefixed) |
| **Discord** | Mention-based routing, DM support, agent delegation |
| **GitLab** | Per-agent identity via PAT tokens, @mention routing resolved from API, bot-to-bot handoff, cascade prevention |
| **Webhooks** | Generic `POST /webhook/:agentId` for Stripe, Sentry, GitHub, etc. |

### GitLab Integration

Agents participate in GitLab as first-class team members:
- **Per-agent identity** — Each agent has its own GitLab user and PAT. Agent usernames resolved from tokens at startup via API (not manual config)
- **Deterministic @mention routing** — `@coding-agent` routes to that agent. Username-to-agent map built from token resolution
- **Bot-to-bot handoff** — QA agent can `@mention` devops in its review, devops picks it up automatically
- **Eye reaction** — Agents react with 👀 using their own token (never the global token)
- **Cascade prevention** — Hidden signature `<!-- agentx:agentId -->`, sent-note dedup, bot-user detection
- **Human mention filtering** — If @mentioned user isn't a known agent, the note is ignored

### Context Compaction

Long conversations don't lose context. When session history exceeds threshold:
1. **Memory flush** — Haiku extracts memorable facts before compaction
2. **Summarize** — Older messages compressed into a structured summary
3. **Preserve** — Last 6 messages kept verbatim, tool call pairs kept intact

### Message Queue

When an agent is busy, incoming messages are queued instead of dropped:

| Mode | Behavior |
|------|----------|
| `collect` (default) | Batch all messages, deliver as one when agent finishes |
| `followup` | Process each queued message as a separate follow-up turn |
| `drop` | Silently discard (for non-critical channels) |

Configure per agent: `agents.<id>.queueMode`

### Sub-Agent Spawning

Agents can spawn background sub-agents for parallel work:
- `spawn_agent` tool available in orchestrator tier
- Depth-limited (max 3 levels) to prevent infinite chains
- Timeout enforcement per spawn
- Results returned to parent agent

### Bootstrap Identity Files

Structured workspace files loaded into agent context automatically:

| File | Purpose | Lifecycle |
|------|---------|-----------|
| `SOUL.md` | Personality, tone, boundaries | Persistent |
| `IDENTITY.md` | Name, role, tagline | Persistent |
| `USER.md` | User profile, preferences | Persistent |
| `AGENTS.md` | Operating rules, standing orders | Persistent |
| `BOOTSTRAP.md` | First-run ritual | Auto-deleted after first load |

### Heartbeat

Periodic in-session check-ins (unlike cron which creates isolated sessions):

```jsonc
"agents": {
  "assistant": {
    "heartbeat": {
      "enabled": true,
      "intervalMinutes": 30,
      "prompt": "Check inbox, pending tasks, and system health."
    }
  }
}
```

Heartbeat runs in the agent's existing session context, preserving conversation history and memory.

### Cron with Retry & Missed Run Detection

Scheduled jobs with production-grade reliability:
- **Exponential backoff** on failure: 30s, 1m, 5m, 15m, 60m (up to 5 retries)
- **Missed run detection** — On startup, compares saved last-run times against schedule and catches up
- **Failure notifications** — Configure per-job `notify` destination (any channel)
- **Auto-disable** after 3 consecutive failures (`onError: "disable"`)
- **Health endpoint** — `GET /crons/health` returns healthy/failing/disabled/missed counts

```jsonc
"crons": {
  "daily-report": {
    "schedule": "0 9 * * *",
    "agent": "assistant",
    "prompt": "Generate today's status report.",
    "notify": {
      "channel": "telegram",
      "chatId": "-1001234567890"
    }
  }
}
```

### Smart Block Streaming

Intelligent chunking for message delivery across channels:
- **minChars** threshold — no fragment spam
- **Paragraph-aware breaks** — never splits inside code fences
- **Per-channel defaults** — Telegram (60 chars), WhatsApp (40 chars + human pacing), Discord (80 chars)
- **Coalescing** — idle debounce merges consecutive small blocks

### Observability & Debug Mode

Toggle verbose debug logging at runtime:

```bash
# Enable debug for specific categories
curl -X POST http://localhost:19900/debug/on?categories=webhook,agent

# Check debug state + recent log entries
curl http://localhost:19900/debug

# Disable
curl -X POST http://localhost:19900/debug/off

# Or via environment variable
AGENTX_DEBUG=webhook,agent agentx daemon start
```

**Categories:** `webhook`, `agent`, `channel`, `cron`, `mesh`, `context`, `memory`, `config`, `all`

### Live Monitoring

```bash
agentx daemon watch            # Color-coded live feed
```

Or connect via SSE:
```bash
curl -N http://localhost:19900/events
```

### Wiki Knowledge Base

Each agent has a personal wiki — a compounding knowledge artifact built from conversations.

1. **Ingest** — Every conversation saved as raw entry
2. **Absorb** — LLM compiles entries into wiki articles
3. **Query** — Agents get relevant context filtered by tags
4. **Sync** — Federated wiki view across mesh peers

Three compilation modes: `unified` (default), `flat`, `graph`. Wikipedia-style UI at `agentx wiki serve`.

### Persistent Agent Memory

Haiku-powered cross-session memory:
- Facts, preferences, commitments extracted after each conversation
- BM25 full-text search across memories
- Injected into context for future conversations
- Auto-pruning with configurable expiry

### Skills

Reusable capabilities installed per-agent or globally:

```bash
agentx skill add skills/my-skill --all
agentx skill list
```

### Mesh Federation

Agents on different machines collaborate:

```bash
agentx mesh add server-2 http://100.x.x.x:19900
agentx daemon send devops "check disk space" --peer server-2
```

- Static or mDNS peer discovery
- Health checks every 60s
- Wiki sync across peers
- Cross-machine agent delegation via A2A protocol

## CLI Reference

```bash
# Daemon
agentx daemon start [--detach]
agentx daemon stop
agentx daemon status
agentx daemon watch
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
  "node": { "id": "my-machine", "name": "My Machine", "bind": "0.0.0.0:19900" },

  "agents": {
    "assistant": {
      "name": "Assistant",
      "workspace": "/path/to/workspace",
      "tier": "claude-code",        // "sdk" or "orchestrator"
      "model": "claude-sonnet-4-6",
      "mentions": ["@my_bot", "my-gitlab-user"],
      "maxConcurrent": 2,
      "queueMode": "collect",       // "followup" or "drop"
      "systemPrompt": "You are a helpful assistant.",
      "heartbeat": {
        "enabled": false,
        "intervalMinutes": 30,
        "prompt": "Check inbox and pending tasks."
      }
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
      "prompt": "Generate today's status report.",
      "onError": "notify",
      "notify": {
        "channel": "telegram",
        "chatId": "-1001234567890"
      }
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
| `/events` | GET | SSE live event stream |
| `/agents` | GET | List agents |
| `/channels` | GET | List registered channels |
| `/crons` | GET | List cron jobs |
| `/crons/health` | GET | Cron health: healthy/failing/disabled/missed |
| `/task` | POST | `{ "agent": "id", "message": "..." }` |
| `/send` | POST | `{ "channel": "telegram", "chatId": "...", "text": "...", "agentId": "..." }` |
| `/mesh/task` | POST | `{ "peer": "name", "message": "..." }` |
| `/webhook/:agentId[/:source]` | POST | Webhook callback |
| `/v1/chat/completions` | POST | OpenAI-compatible endpoint |
| `/debug` | GET | Debug state + recent log entries |
| `/debug/on` | POST | Enable debug (`?categories=webhook,agent`) |
| `/debug/off` | POST | Disable debug |
| `/.well-known/agent-card.json` | GET | A2A agent discovery |

## Context Engine

Every agent prompt is built from structured layers, each with a token budget:

| Layer | Priority | Budget | Content |
|-------|----------|--------|---------|
| Channel | 1 | 200 | Channel type + formatting rules |
| Scope | 2 | 200 | Group name, project path, or DM |
| Landscape | 3 | 800 | Team roster, mesh peers, rules, /send API docs |
| Identity | 4 | 200 | Agent system prompt |
| Bootstrap | 4.5 | 500 | SOUL.md, IDENTITY.md, AGENTS.md |
| Intent | 5 | 200 | Extracted: deploy, review, bugfix... |
| Artifacts | 6 | 500 | Media, reply-to text, issue refs |
| Memory | 6.5 | 600 | Cross-session facts (Haiku-extracted) |
| History | 7 | 1200 | Conversation or session history |
| Cross-chat | 7 | 800 | Context from other active chats |
| Wiki | 8 | 1000 | Tag-matched knowledge articles |

Total budget: 6000 tokens. Context always injected, even on resumed sessions.

## Three Execution Tiers

| Tier | How | Auth | Best for |
|------|-----|------|----------|
| `claude-code` | Spawns `claude` CLI | Subscription | Full power: subagents, MCP, skills, hooks, 1M context |
| `sdk` | Claude Agent SDK | API key | Programmatic control, headless servers |
| `orchestrator` | AgentX's own loop | Any provider key | Non-Claude providers (OpenAI, Ollama) |

## Daemon Management

Single-instance guard via PID file — prevents orphan processes on restart:

```bash
agentx daemon start            # Checks .agentx/daemon.pid, exits if another is running
agentx daemon stop              # Graceful shutdown, saves cron last-run times
systemctl --user restart agentx-daemon.service  # Safe — PID guard prevents duplicates
```

## Use Cases

- **Team of Telegram bots** — each project gets its own bot + agent
- **GitLab CI/CD team** — coder, QA, devops, PM agents collaborate on issues via @mentions
- **Cross-channel notifications** — GitLab agent notifies humans on Telegram/WhatsApp
- **WhatsApp delegation** — shared phone number, agents identified by name prefix
- **Scheduled automation** — cron jobs with retry, missed-run catch-up, failure alerts
- **Multi-machine swarm** — agents on laptop + server collaborate via mesh
- **Webhook automation** — Sentry error -> DevOps investigates, Stripe payment -> billing processes
- **Personal wiki** — Every conversation compounds into searchable knowledge

## Contributing

```bash
git clone https://github.com/anis-marrouchi/agentx.git
cd agentx
npm install
npm run build              # ESM build via tsup
npm test                   # Run tests
agentx init --force        # Create local config
agentx daemon start        # Start dev daemon
agentx daemon watch        # See what's happening
```

Areas we're looking for help:
- **Testing** — Unit and integration tests
- **Channels** — Slack, Microsoft Teams adapters
- **Dashboard** — Web UI for agent management
- **Security** — Audit of token handling and permission boundaries

## License

MIT
