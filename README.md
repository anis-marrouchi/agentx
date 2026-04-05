# AgentX

**Self-hosted multi-agent orchestrator.** Routes messages from Telegram, WhatsApp, crons, and cross-machine A2A mesh to AI agents running on Claude Code, OpenAI, Ollama, or any LLM provider.

> **Experimental.** This project is a rapid response to [Anthropic's updated terms of use](https://www.anthropic.com/policies) restricting third-party OAuth integrations (affecting tools like OpenClaw). AgentX is a self-hosted, bring-your-own-key alternative — you run it on your own machines with your own API keys or Claude subscription.

## How it works

AgentX is **not** an AI runtime. It's a thin orchestration layer:

```
                     ┌──────────────┐
  Telegram ──────────┤              │
  WhatsApp ──────────┤   agentx     │──── claude -p "task" --cwd /workspace
  Cron trigger ──────┤   daemon     │──── openai API call
  A2A remote call ───┤              │──── ollama generate
                     └──────┬───────┘
                            │
                    routes messages to
                    the right workspace
                    with the right prompt
```

Each agent = a workspace directory. For Claude Code agents, permissions, hooks, MCP servers, skills, and memory are all configured in the workspace's `.claude/` directory — no AgentX code needed.

## Features

- **Multi-channel**: Telegram (polling, multi-account), WhatsApp (planned)
- **Multi-agent**: Named agents with custom permissions, concurrent limits, mention routing
- **Cron scheduler**: Timezone-aware recurring tasks with run logging
- **A2A mesh**: Cross-machine agent communication via HTTP, peer discovery, health checks
- **Streaming**: Real-time response streaming to Telegram with progressive message edits
- **Typing indicators**: Bots show typing status while processing
- **Bot-to-bot**: Agents can mention each other to delegate tasks
- **Session memory**: One conversation session per agent/chat/day for context continuity
- **Hooks**: Pre/post hooks for channels, crons, and A2A tasks (command, script, or LLM-based)
- **Provider abstraction**: Switch providers per-agent via config, with capability warnings
- **Markdown rendering**: Claude's markdown output converted to Telegram MarkdownV2

## Three execution tiers

| Tier | How | Auth | Best for |
|------|-----|------|----------|
| `claude-code` | Spawns `claude` CLI | Subscription | Full power: subagents, MCP, skills, hooks, 1M context |
| `sdk` | Claude Agent SDK | API key | Programmatic control, headless servers |
| `orchestrator` | AgentX's own loop | Any provider key | Non-Claude providers (OpenAI, Ollama, Gemini) |

## Quick start

```bash
npm install -g @nooqta/agentx

# Copy and edit the example config
cp node_modules/@nooqta/agentx/agentx.example.json agentx.json

# Start the daemon
agentx daemon
```

Or clone and run from source:

```bash
git clone https://github.com/nooqta/agentx.git
cd agentx
npm install && npm run build
cp agentx.example.json agentx.json
# Edit agentx.json with your agents, channels, etc.
node dist/cli.js daemon
```

## Configuration

AgentX uses a single `agentx.json` file. Environment variables are expanded (`${VAR_NAME}`).

```jsonc
{
  "node": {
    "id": "my-machine",
    "name": "My Machine",
    "bind": "127.0.0.1:18800"
  },

  "providers": {
    "claude": { "apiKey": "${ANTHROPIC_API_KEY}" },
    "openai": { "apiKey": "${OPENAI_API_KEY}" }
  },

  "agents": {
    "assistant": {
      "name": "Assistant",
      "workspace": "/path/to/workspace",
      "tier": "claude-code",
      "model": "claude-sonnet-4-6",
      "mentions": ["@my_bot"],
      "maxConcurrent": 2,
      "systemPrompt": "You are a helpful assistant.",
      "permissionMode": "default"
    }
  },

  "channels": {
    "telegram": {
      "enabled": true,
      "accounts": {
        "default": {
          "token": "${TG_BOT_TOKEN}",
          "agentBinding": "assistant"
        }
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
      "prompt": "Generate today's status report.",
      "timeout": 600
    }
  },

  "mesh": {
    "enabled": true,
    "peers": [
      { "url": "http://100.67.108.119:18800", "name": "server-2" }
    ]
  }
}
```

### Agent workspace setup (Claude Code tier)

Each agent's workspace is a directory with Claude Code configuration:

```
my-workspace/
├── .claude/
│   ├── settings.json      # Permissions, hooks, model
│   ├── .mcp.json          # MCP servers
│   ├── agents/            # Subagents
│   └── skills/            # Domain skills
├── CLAUDE.md              # Agent identity & instructions
└── ... (project files)
```

## HTTP API

The daemon exposes a REST API:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | System status, agents, crons, mesh |
| `/agents` | GET | List agents and their status |
| `/crons` | GET | List cron jobs |
| `/mesh` | GET | Mesh peer directory |
| `/task` | POST | Execute a task: `{ "agent": "id", "message": "..." }` |
| `/mesh/task` | POST | Send task to remote peer: `{ "peer": "name", "message": "..." }` |
| `/.well-known/agent-card.json` | GET | A2A agent discovery |

## A2A Mesh

Run `agentx daemon` on multiple machines. Each node discovers peers and exposes agents via A2A agent cards. Tasks are routed to the correct node automatically.

```
MacBook (Nadia, DevOps)  ←─── Tailscale ───→  Server (Atlas, MTGL)
        :18800                                        :18800
```

Peers communicate over HTTP. Use Tailscale or a VPN for secure cross-machine communication.

## Migrating from OpenClaw

AgentX is designed as a drop-in replacement for OpenClaw's agent orchestration:

| OpenClaw | AgentX |
|----------|--------|
| `openclaw.json` agents | `agentx.json` agents section |
| `openclaw.json` channels.telegram | `agentx.json` channels.telegram |
| `cron/jobs.json` | `agentx.json` crons section |
| `exec-approvals.json` | Workspace `.claude/settings.json` permissions |
| Gateway + Node architecture | Single daemon per machine |
| OAuth proxy | Direct API key or CLI subscription |

### Migration steps

1. **Stop OpenClaw**
   - macOS: `launchctl unload ~/Library/LaunchAgents/ai.openclaw.*.plist`
   - Linux: `systemctl --user stop openclaw-gateway openclaw-node`
2. **Install AgentX**: `npm install -g @nooqta/agentx`
3. **Convert config**: Map your `openclaw.json` agents, channels, and cron jobs to `agentx.json` (see `agentx.example.json`)
4. **Set up workspaces**: Ensure each agent's workspace has a `.claude/` directory with permissions and hooks
5. **Move secrets to `.env`**: Bot tokens, API keys — AgentX auto-loads `.env` from the working directory
6. **Start daemon**: `agentx daemon`

### Key differences from OpenClaw

- **No OAuth proxy**: You run your own daemon with your own credentials
- **Workspace = Agent**: Permissions, hooks, and tools live in the workspace `.claude/` dir
- **Claude Code native**: `tier: "claude-code"` gives you the full Claude Code feature set (subagents, MCP, skills, hooks, memory, worktrees, 1M context)
- **Provider-agnostic**: Switch any agent to OpenAI, Ollama, or other providers via config
- **A2A mesh**: Agents across machines communicate natively (OpenClaw required a gateway)

## Built with

- [Claude Code CLI](https://claude.ai/code) — AI agent runtime (subscription or API)
- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — Programmatic agent control
- [Telegram Bot API](https://core.telegram.org/bots/api) — Channel adapter (zero dependencies)
- [Zod](https://github.com/colinhacks/zod) — Config validation
- [Commander](https://github.com/tj/commander.js) — CLI framework

## Legal

AgentX is a **self-hosted, bring-your-own-key** tool:

- Each user provides their own API key or Claude subscription
- No credentials are stored, shared, or proxied by AgentX
- Built on official public packages: Claude API, Claude Agent SDK, Claude Code CLI
- Provider-agnostic — works with any LLM, not locked to Anthropic
- Same model as LangChain, CrewAI, AutoGen, Dify, n8n

## License

MIT
