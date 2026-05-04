# Install

Pick the path that matches you. All three end up at the same place: a working daemon and a dashboard at `http://127.0.0.1:4202`.

## Option A: One-line installer (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/anis-marrouchi/agentx/master/install.sh | bash
```

This:

1. Checks for Node.js 20+ (uses nvm if available).
2. Installs `agentix-cli` globally.
3. Runs `agentx setup` — the daemon starts in the background and **your browser opens at `http://127.0.0.1:4202/setup`**.

![AgentX setup wizard opens automatically after install](/screenshots/setup.png)

The wizard collects: team name, first agent (name, trigger words, personality), optional Telegram bot token, optional Anthropic API key. It writes `agentx.json` + `.env` + scaffolds the agent's folder for you — no hand-editing.

From that moment on, **everything is in the dashboard**: agents, channels, schedules, webhooks, mesh peers, tokens, the intent graph. The CLI is always there as a parallel control plane — every button maps to a verb — but you never need to open an editor.

Jump straight into → [Journey 1 — Your first agent on Telegram](/journey/01-telegram-qa-bot) for a guided walkthrough.

## Option B: Docker

Best for servers you don't want to install Node on.

```bash
git clone https://github.com/anis-marrouchi/agentx.git
cd agentx
cp agentx.example.json agentx-data/agentx.json   # or empty, and run `docker compose run daemon setup`
cp .env.example .env                              # add your API keys here
docker compose up -d
```

The `docker-compose.yml` runs two containers (daemon + dashboard) sharing a bind-mounted `./agentx-data` directory — nothing is stored inside the image, so upgrades are `docker compose pull && up -d`.

## Option C: Manual npm

```bash
npm install -g agentix-cli
agentx setup               # opens the wizard
```

If you'd rather skip the wizard and edit JSON by hand, `agentx init` still works:

```bash
mkdir my-agentx && cd my-agentx
agentx init
```

This creates:

- `agentx.json` — the main config file
- `.env` — template for secrets (loaded automatically at startup)
- `.agentx/` — runtime data directory (sessions, wiki, cron logs, task history, tokens — gitignored)

## Prerequisites (reference)

- **Node.js 20+** — `node --version`
- **Claude Code CLI** (for `claude-code` tier agents) — [install guide](https://docs.anthropic.com/en/docs/claude-code). Other providers (OpenAI, Ollama) don't require it.
- A channel credential: a Telegram bot token from [@BotFather](https://t.me/BotFather), a Discord bot token, a GitLab API token, or a WhatsApp session. Telegram is the fastest to get started.

## 3. Add your first agent

```bash
agentx agent add
```

You'll be asked for:

| Prompt | What it means |
|---|---|
| ID | Short slug, e.g. `support` |
| Name | Display name, e.g. `Support Assistant` |
| Workspace | Directory for this agent's instructions, skills, MCP config. Defaults to `./agents/<id>` |
| Tier | `claude-code` uses the `claude` CLI; `codex-cli` uses the `codex` CLI; `sdk` uses the Claude Agent SDK; `orchestrator` uses AgentX's built-in loop with any LLM provider |
| Model | e.g. `claude-sonnet-4-6`, `claude-haiku-4-5` |
| Mentions | Handles that route to this agent, e.g. `@support_bot`, `@support` |

An agent is just a directory with configuration files. No code required.

## 4. Add a channel

```bash
agentx channel add
```

Pick one:

::: code-group
```text [Telegram]
- Account name (free label): default
- Bot token: <from @BotFather>
- Bind to agent: <your agent>
```

```text [Discord]
- Bot token: <from Discord Developer Portal>
- Bind to agent: <your agent>
```

```text [GitLab]
- GitLab host: https://gitlab.com (or self-hosted)
- API token: <personal access token>
- Webhook port: 18811
- Secret: <random string>
- Project routes: <project_id>:<agent_id>
```

```text [WhatsApp]
- Default agent: <your agent>
- Session dir: .agentx/whatsapp-sessions
- First run prints a QR code — scan with WhatsApp on your phone
```
:::

## 5. Start the daemon

```bash
agentx daemon start
```

You'll see each channel come up, each agent register, and (if configured) mesh peers health-check.

### Watch it live

In a second terminal:

```bash
agentx daemon watch
```

Color-coded activity feed:

```text
10:31:08 → Routing [telegram/You] -> "Support": Hello!
10:31:08 ▶ [support] executing task (1/2)
10:31:15 ✓ [support] completed in 7234ms
```

## 6. Verify

```bash
agentx daemon status   # PID, channels, agents, crons, mesh peers
agentx config check    # Validate agentx.json + workspaces
agentx config show     # Print resolved configuration
```

DM your Telegram bot — the reply should arrive within a couple of seconds.

::: tip No manual JSON edits required
From now on every config change has a CLI verb:

```bash
agentx config set agents.support.model claude-sonnet-4-6
agentx schedule "every morning at 9" --agent support --do "..."
```

The daemon hot-reloads crons automatically. Sections that still need a restart (agents, channels, mesh) are flagged in the output.
:::

## Run in the background

```bash
agentx daemon start --detach
```

For auto-start on boot, use systemd (Linux) or launchd (macOS). A minimal systemd unit:

```ini
[Unit]
Description=AgentX Daemon
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/your/agentx
ExecStart=/usr/bin/node /path/to/agentx/dist/cli.js daemon start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Where to next

- **"I just want a Telegram Q&A bot."** → [Journey 1](/journey/01-telegram-qa-bot)
- **"I want a scheduled report that pages me on failure."** → [Journey 2](/journey/02-scheduled-reports)
- **"I want the big picture first."** → [Concepts](/concepts)
