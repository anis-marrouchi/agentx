---
title: "10. MCP server — drive AgentX from Claude Code or Cursor"
---

# 10. MCP server — drive AgentX from Claude Code or Cursor

> **Difficulty:** advanced · **Time:** ~25 minutes

You're coding in Cursor or Claude Code. You type `@agentx send the deploy summary to the team Telegram` — the IDE calls AgentX's MCP tools to dispatch the message. Or you ask `@agentx what are Nadia's crons today?` — the same MCP surface answers from the daemon's live state. Any MCP-capable client becomes a remote control for your AgentX fleet.

This is the inverse of [Journey 5](/journey/05-hooks-webhooks): there, external systems poke AgentX. Here, your IDE pulls AgentX into its own tool surface.

## What MCP gives you

MCP (Model Context Protocol) is the lingua franca between Claude/GPT clients and external tool servers. AgentX exposes its core verbs as MCP tools:

| Tool | What it does |
|---|---|
| `agentx_send` | Cross-channel outbound (the same `POST /send` you saw in [Journey 4](/journey/04-cross-channel)) |
| `agentx_task` | Delegate a task to an agent and get the result |
| `agentx_generate` | Tech-stack-aware code generation (uses the agent's skills) |
| `agentx_agents` | List configured agents + status |
| `agentx_health` | Daemon health + version |
| `agentx_crons` | List + describe scheduled jobs |
| `agentx_debug` | Toggle debug categories at runtime |

When your Claude Code session is wired to AgentX as MCP, asking it to "send something to the team Telegram" doesn't require shelling out to `curl` — Claude calls `agentx_send` directly and the IDE shows the tool result inline.

## `agentx serve` modes

Today there's one mode: **stdio**. JSON-RPC over stdin/stdout, all logging routed to stderr so the protocol stays clean. HTTP transport is on the roadmap; for now, every MCP client supports stdio so it's not blocking.

```bash
agentx serve --stdio
```

The daemon **does not need to be running** for MCP — the server reads `agentx.json` directly and proxies tool calls to the daemon's HTTP API. If the daemon is down, tools that need live state (`agentx_agents`, `agentx_health`) error cleanly; tools that just read config keep working.

## Wiring Claude Code

```bash
claude mcp add agentx -- npx agentx serve --stdio
```

That's it. Restart Claude Code; the new server shows up in `/mcp` with `agentx_*` tools. Type `@agentx <something>` and the IDE picks the right tool.

For project-scoped wiring (the `agentx` server is only available in this repo):

```bash
claude mcp add --scope project agentx -- npx agentx serve --stdio
```

Writes to `.mcp.json` in the repo root. Commit it for team-shared config.

## Wiring Cursor / generic MCP

Cursor's MCP config lives at `~/.cursor/mcp.json` (global) or `<project>/.cursor/mcp.json` (per-project). Add:

```json
{
  "mcpServers": {
    "agentx": {
      "command": "npx",
      "args": ["agentx", "serve", "--stdio"]
    }
  }
}
```

Restart Cursor. The server appears under `Settings → MCP`. Tools are now available to Cursor's agent chat.

The same JSON pattern works for any other MCP-capable client (Windsurf, Continue, Zed when their MCP support lands).

## Auth and token scopes

The MCP server runs as **you** — it inherits your shell's environment. It reads `agentx.json` from the cwd (or `AGENTX_DAEMON_URL` if set) and uses your local credentials.

For automated agents driving MCP (e.g. a Cursor session running as a CI bot), mint a scoped token:

```bash
agentx token create --name "cursor-bot" --scope task:write,dashboard:read
```

…and pass it via `AGENTX_DAEMON_TOKEN`:

```json
{
  "mcpServers": {
    "agentx": {
      "command": "npx",
      "args": ["agentx", "serve", "--stdio"],
      "env": {
        "AGENTX_DAEMON_URL": "http://my-server:18800",
        "AGENTX_DAEMON_TOKEN": "atx_..."
      }
    }
  }
}
```

The token's scope determines which tools the MCP server exposes. A `task:write`-only token cannot list crons or toggle debug; the corresponding tools are filtered out of the surface.

## Worked example: ship a release note

In Cursor, after merging a PR:

> @agentx draft a 3-bullet release note from the diff between `main..origin/main~1` and send it to the team Telegram with `agentx_send`.

Behind the scenes:

1. Cursor's agent runs `git diff main..origin/main~1` (its built-in shell tool).
2. Drafts the bullets.
3. Calls `agentx_send` with `channel=telegram, chatId=<team-id>, text=<bullets>`.
4. AgentX's MCP server proxies to `POST /send` on the running daemon.
5. The daemon dispatches via the Telegram adapter.
6. The team sees the message; Cursor shows "✓ sent" inline.

No `curl`, no copy-paste, no leaving the editor.

## Elicitation

MCP supports **elicitation** — the server can ask the user for input mid-tool-call, and the client renders a form. AgentX uses this for tools that need confirmation (e.g. `agentx_send` to a public group asks "are you sure?" before executing). Today the elicitation forms are minimal (text + select); the schema lives in `src/mcp/elicitation.ts`.

## Troubleshooting

- **"agentx is not recognised."** The CLI isn't on `PATH`, or `npx` is resolving to a different version. Use the absolute path: `command: "/usr/local/bin/agentx"`.
- **MCP server starts but tools error with "ECONNREFUSED."** The daemon isn't running. Either start it (`agentx daemon start`) or scope your IDE chat to config-only tools (`agentx_agents` works without a daemon, `agentx_send` doesn't).
- **Tool result is `{"error": "scope mismatch"}`.** The token doesn't include the required scope. Re-mint with the right scope set.
- **MCP server hangs on stdio.** Check stderr — most likely a `loadDaemonConfig` failure (no `agentx.json` in the cwd).

## Next

- [`agentx serve` reference](/reference/cli#serve-mcp-server): flags + transport details.
- [Communication matrix](/reference/communication-matrix): the same actions over raw HTTP, useful when MCP isn't available.
- [Plugin authoring](/playbooks/plugin-authoring): write a plugin that registers a custom channel adapter or bus subscriber.
