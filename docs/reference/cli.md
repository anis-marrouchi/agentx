# CLI reference

All commands. Grouped by area. Run `agentx <command> --help` for the canonical flags.

## Quick orientation

```bash
agentx --version
agentx --help
agentx <command> --help
```

The CLI binary is `agentx`. The npm package is `agentix-cli`.

## Init

| Command | Description |
|---|---|
| `agentx init` | Create `agentx.json`, `.env`, runtime dirs in current directory |

## Daemon

| Command | Description |
|---|---|
| `agentx daemon start [-c <config>] [-d/--detach] [--port <n>]` | Start the daemon |
| `agentx daemon stop` | Stop the running daemon |
| `agentx daemon status [--json]` | Show daemon PID, agents, channels, crons, mesh peers |
| `agentx daemon logs [-n <lines>] [-f]` | Tail daemon logs |
| `agentx daemon watch` | Live, color-coded SSE activity feed |
| `agentx daemon send <agent> <message> [--peer <name>] [--json]` | Send a task to an agent (local or mesh peer) |
| `agentx daemon deploy <host> [-i <key>] [-u <user>] [-p <path>] [--restart] [--skip-checks]` | Rsync deploy to a remote host |

## Agents

| Command | Description |
|---|---|
| `agentx agent list` (alias `ls`) | List configured agents with workspace and mentions |
| `agentx agent add` | Add an agent interactively |
| `agentx agent remove <id>` (alias `rm`) | Remove agent from config (workspace is preserved) |

## Channels

| Command | Description |
|---|---|
| `agentx channel list` (alias `ls`) | List channels + agent bindings |
| `agentx channel add` | Add a channel interactively (Telegram / WhatsApp / Discord / GitLab) |

## Crons

| Command | Description |
|---|---|
| `agentx cron list` (alias `ls`) | List cron jobs (schedule, agent, status) |
| `agentx cron add` | Add a cron interactively |
| `agentx cron enable <id>` | Enable a cron job |
| `agentx cron disable <id>` | Disable a cron job |

Notes on `onError`: either a string or an array — `["log"]`, `["notify"]`, `["disable"]`, or any combination. See [Journey 2](/journey/02-scheduled-reports).

## Mesh (A2A)

| Command | Description |
|---|---|
| `agentx mesh list` (alias `ls`) | List peers + health status |
| `agentx mesh add` | Add a peer interactively (name, URL, token) |
| `agentx mesh remove <name>` (alias `rm`) | Remove a peer |

## Wiki

| Command | Description |
|---|---|
| `agentx wiki status [--mode <unified\|graph\|flat>]` | Status per agent (entries, articles, unabsorbed) |
| `agentx wiki entries [--agent <id>]` | List raw entries |
| `agentx wiki absorb [--agent <id>] [--mode <m>] [--max <n>] [--dry-run]` | Compile raw entries into articles |
| `agentx wiki lint [--agent <id>]` | Check wiki for broken links, orphans |
| `agentx wiki search <query> [--agent <id>]` | Search articles |
| `agentx wiki serve [--port <n>] [--peer <url>...]` | Wikipedia-style web browser (local + mesh peers) |
| `agentx wiki sync [--peer <url>] [--dry-run]` | Pull raw entries from mesh peers |
| `agentx wiki compare --agent <id>` | Deterministic side-by-side comparison of all three modes |

## Skills

| Command | Description |
|---|---|
| `agentx skill list` (alias `ls`) | List skills per agent |
| `agentx skill add <skillPath> [--agent <id>] [--all]` | Add a skill to one or all agents |

## Hooks

| Command | Description |
|---|---|
| `agentx hook add <agent>` | Add a hook interactively (event, type, matcher regex) |

Supported events (PreToolUse, PostToolUse, SessionStart, Notification, Stop); types: `command`, `http`.

## Usage & tokens

| Command | Description |
|---|---|
| `agentx usage today` | Token usage summary — last 7 days, per agent |
| `agentx usage serve [--port <n>]` | Web dashboard |
| `agentx usage report [--days <n>]` | Full session analysis across Claude Code JSONL |

## Config

| Command | Description |
|---|---|
| `agentx config check` | Validate `agentx.json` + workspaces |
| `agentx config show` | Print the resolved configuration (env expanded) |

## Migration

| Command | Description |
|---|---|
| `agentx migrate openclaw [<configPath>] [--dry-run]` | Import agents, channels, crons, Telegram accounts from an OpenClaw config |

See [Migrate from OpenClaw](/migration/from-openclaw).

## Environment variables

| Variable | Purpose |
|---|---|
| `AGENTX_DEBUG` | Comma-separated categories: `webhook`, `agent`, `channel`, `cron`, `mesh`, `context`, `memory`, `config`, `all` |
| `MESH_TOKEN` | Shared secret between mesh peers |
| `TG_*_BOT_TOKEN` | Convention for Telegram bot tokens (`${TG_FOO_BOT_TOKEN}` in `agentx.json`) |

## HTTP endpoints

Summary — full schemas in [Communication matrix](/reference/communication-matrix).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/task` | H2A: send a task to a local agent |
| `POST` | `/send` | A2H initiate / cross-channel outbound |
| `POST` | `/mesh/task` | Cross-mesh delegation |
| `POST` | `/ask` | Short-form voice/Siri endpoint |
| `POST` | `/webhook/:agentId[/:source]` | Generic webhook receiver |
| `GET`  | `/events` | SSE event stream |
| `GET`  | `/health` | Health check |
| `GET`  | `/.well-known/agent-card.json` | Agent card for mesh peers |
| `GET`  | `/wiki/agents`, `/wiki/entries`, `/wiki/articles`, `/wiki/article` | Wiki read API |
| `POST` | `/debug/on?categories=...`, `/debug/off` | Toggle debug categories at runtime |
| `GET`  | `/business/work/list?agent=<id>`, `POST /business/work/claim`, `POST /business/work/report`, `POST /business/clock-out`, `GET /business/kpi/today`, `GET /business/kpi/week` | Business layer API |
