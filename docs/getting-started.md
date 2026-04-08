# Getting Started with AgentX

Go from zero to a working Telegram bot in 5 minutes.

## Prerequisites

- **Node.js 20+** (`node --version`)
- **Claude Code CLI** installed (`claude --version`) — [install guide](https://docs.anthropic.com/en/docs/claude-code)
- A **Telegram bot token** — get one from [@BotFather](https://t.me/BotFather) on Telegram

## 1. Install

```bash
npm install -g agentix-cli
```

Verify:

```bash
agentx --version
```

## 2. Initialize

```bash
mkdir my-agent && cd my-agent
agentx init
```

This creates:
- `agentx.json` — main configuration
- A workspace directory for your first agent

## 3. Create Your Agent

```bash
agentx agent add
```

Follow the prompts:
- **Name**: `Assistant` (or whatever you like)
- **Workspace**: Press enter for default (current directory)
- **Tier**: `claude-code` (uses your Claude subscription)
- **Model**: `claude-sonnet-4-6` (fast and capable)
- **Mentions**: `@my_bot` (the Telegram handle)

This creates a workspace with `CLAUDE.md` where you define your agent's personality and capabilities.

Edit `CLAUDE.md` to give your agent instructions:

```markdown
# My Assistant

You are a helpful assistant. Keep responses concise.
```

## 4. Connect Telegram

```bash
agentx channel add
```

Select **Telegram**, then:
- **Bot token**: Paste the token from BotFather
- **Bind to agent**: Select your agent

Or edit `agentx.json` directly:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "accounts": {
        "default": {
          "token": "YOUR_BOT_TOKEN_HERE",
          "agentBinding": "assistant"
        }
      },
      "policy": {
        "dm": "pair",
        "group": "mention-required"
      }
    }
  }
}
```

## 5. Start

```bash
agentx daemon start
```

That's it. Message your bot on Telegram — it responds using Claude Code with full access to your workspace (files, tools, MCP servers, skills).

## 6. Watch It Work

In another terminal:

```bash
agentx daemon watch
```

You'll see live, color-coded activity:

```
10:31:08 → Routing [telegram/You] -> "Assistant": Hello!
10:31:08 ▶ [assistant] executing task (1/2)
10:31:15 ✓ [assistant] completed in 7234ms
```

## What Just Happened?

```
You on Telegram ──→ AgentX daemon ──→ claude -p "Hello!" --cwd /your/workspace
                         │
                    Context engine
                  (channel + identity
                   + history + wiki)
                         │
                    Response ──→ Telegram
```

AgentX:
1. Received your Telegram message
2. Built a structured prompt with channel context, agent identity, and conversation history
3. Spawned a Claude Code session in your agent's workspace
4. Sent the response back to Telegram (with streaming edits)

## Next Steps

### Add more agents

```bash
agentx agent add    # Interactive
```

Each agent gets its own workspace, personality, skills, and Claude sessions. They can mention each other on Telegram to delegate work.

### Add skills

Skills are markdown files that give agents specialized capabilities:

```bash
# Install a skill to your agent
agentx skill add path/to/skill --agent assistant

# Or to all agents
agentx skill add path/to/skill --all
```

A skill is a directory with a `SKILL.md` file:

```markdown
---
name: my-skill
description: What this skill does
tags: [tag1, tag2]
triggers:
  - pattern: "keyword|another keyword"
    description: "When to use this skill"
---

# Instructions for the agent

When triggered, do this...
```

### Add a cron job

Schedule recurring tasks:

```json
{
  "crons": {
    "morning-report": {
      "enabled": true,
      "schedule": "0 9 * * *",
      "timezone": "UTC",
      "agent": "assistant",
      "prompt": "Generate a morning status report."
    }
  }
}
```

### Connect GitLab

Agents can participate in GitLab issues and MRs as team members:

```bash
agentx channel add    # Select GitLab
```

Each agent can have its own GitLab user and token — comments show the correct author.

### Set up mesh (multi-machine)

Run agents across multiple machines:

```bash
# On machine 2
agentx init
agentx daemon start

# On machine 1 — add machine 2 as a peer
agentx mesh add server-2 http://MACHINE_2_IP:18800
```

Agents on different machines can delegate work to each other.

### Run in background

```bash
agentx daemon start --detach
```

For auto-start on boot:

**macOS (launchd):**
```bash
# Create ~/Library/LaunchAgents/agentx.plist with RunAtLoad=true
```

**Linux (systemd):**
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

## Configuration Reference

All configuration lives in `agentx.json`. Environment variables are expanded (`${VAR_NAME}`). A `.env` file is auto-loaded.

See the [full configuration example](../README.md#configuration) in the README.

## Troubleshooting

### Bot doesn't respond

```bash
agentx daemon status    # Is the daemon running?
agentx daemon watch     # See what's happening in real-time
```

Check that:
- The bot token is correct
- Claude Code is installed and authenticated (`claude --version`)
- The agent workspace exists

### "Permission denied" errors

Claude Code needs permission to run tools. Set up your agent's `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Read", "Write", "Edit", "Glob", "Grep", "Bash(git *)"]
  }
}
```

Or for full access (development only):

```json
{
  "permissions": {
    "allow": ["*"]
  }
}
```

### Telegram 409 conflict errors

```
Conflict: terminated by other getUpdates request
```

Another process is polling the same bot token. Stop it:
- Kill any other bot instances using the same token
- Check for duplicate AgentX daemons: `agentx daemon status`

### Port already in use

```
Error: listen EADDRINUSE: address already in use
```

Another process holds the port. Find and kill it:

```bash
fuser -k 18800/tcp    # Linux
lsof -ti:18800 | xargs kill    # macOS
```

AgentX will automatically retry after 5 seconds for webhook ports.
