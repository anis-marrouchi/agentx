# AgentX

**The AI operations layer for your team.** Plug in the channels your team already uses — Telegram, WhatsApp, Discord, GitLab — set schedules, and watch your agents work. Self-hosted. No Python, no YAML, no code.

## Who it's for

**Teams running AI agents on real channels.** Support queues, devops squads, ops teams, internal automation. You want multiple agents handling different jobs, coordinating across machines, answering on the tools your people already use.

> **Running AgentX solo for yourself?** [OpenClaw](https://github.com/openclaw/openclaw) is built for single-user assistants and has a lighter install path. If you outgrow it, we import your config — see [Migrate from OpenClaw](docs/migration/from-openclaw.md).

## What you get out of the box

- **Answer on Telegram, WhatsApp, Discord, GitLab** — one config, all channels
- **Agents = folders, not code** — each agent has its own persona, knowledge, and tools in plain Markdown
- **Multiple machines, one team** — run AgentX across a laptop + a server and they'll share work automatically
- **Scheduled jobs in plain English** — `agentx schedule "every Monday at 9am" --agent sales`
- **Live dashboard** — a browser view of what every agent is doing right now, with full task history and replay
- **Scoped API tokens** — let external apps message an agent with a time-bound, scope-limited token (see [Tokens](docs/reference/tokens.md) and [Public agents](docs/reference/public-agents.md))
- **Bring your own AI** — Claude Code (deep reasoning + tools), OpenAI / Anthropic API, Ollama, or anything in between
- **Wiki memory** — conversations compound into a shared knowledge base each agent draws from

## Install

**One line:**

```bash
curl -fsSL https://raw.githubusercontent.com/anis-marrouchi/agentx/master/install.sh | bash
```

Installs the CLI and launches the web setup wizard — no YAML, no JSON.

**Docker:**

```bash
git clone https://github.com/anis-marrouchi/agentx.git && cd agentx
cp agentx.example.json agentx-data/agentx.json    # or run `agentx setup` later
docker compose up -d
```

**Manual:**

```bash
npm install -g agentix-cli
agentx setup               # opens the web wizard
```

Open the dashboard at **http://127.0.0.1:4202** — a plain-English control view, with a `?`-Glossary link if anything looks unfamiliar.

See the [full install guide](docs/install.md) for advanced setups.

## Docs

Full documentation: **[https://agentx-docs.pages.dev](https://agentx-docs.pages.dev)** (or `pnpm docs:dev` locally).

**Start here:**
- [Install](docs/install.md) — from zero to a running daemon in 5 minutes
- [Concepts](docs/concepts.md) — what an agent, channel, schedule, and team network are (glossary also lives at `/glossary` in the dashboard)

**Worked examples, simple → advanced:**
- [1. Telegram Q&A bot](docs/journey/01-telegram-qa-bot.md) — one agent, one channel, one conversation
- [2. Scheduled reports with failure alerts](docs/journey/02-scheduled-reports.md)
- [3. Multi-agent group chat](docs/journey/03-multi-agent-group.md)
- [7. Run a team with AI agents](docs/journey/07-business-layer.md) — roles, KPIs, org chart
- [8. Two machines, one team](docs/journey/08-mesh-federation.md) — mesh federation

**For configuration:**
- [CLI reference](docs/reference/cli.md) · [Config schema](docs/reference/config-schema.md) · [Communication matrix](docs/reference/communication-matrix.md)
- [Scoped API tokens](docs/reference/tokens.md) — mint / scope / revoke
- [Public agents](docs/reference/public-agents.md) — expose an agent over HTTP
- [`agentx doctor`](docs/reference/doctor.md) — pre-flight health check

**Moving from another tool:**
- [Migrate from OpenClaw](docs/migration/from-openclaw.md) — we import the bulk of your config in one shot

[Contributing](docs/contributing.md)

## Architecture

```mermaid
graph LR
  T[Telegram] --> R(Router)
  W[WhatsApp] --> R
  D[Discord] --> R
  G[GitLab] --> R
  C[Cron] --> R
  H[Webhook] --> R
  M[Mesh peer] --> R
  R --> CTX[Context Engine<br/>10 layers, token-budgeted]
  CTX --> AG[Agent workspace]
  AG --> P1[claude -p]
  AG --> P2[OpenAI]
  AG --> P3[Ollama]
  AG -.-> MEM[(Wiki + Memory)]
  AG -.-> R
```

Each agent = a workspace directory with Claude Code configuration (`.claude/`, `CLAUDE.md`, skills, hooks, MCP servers). AgentX orchestrates when and where agents run.

## License

MIT.
