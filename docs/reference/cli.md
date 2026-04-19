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
| `agentx channel add` | Add a channel interactively (Telegram / WhatsApp / Discord / GitLab) — legacy path |

## Connect (pairing flows, recommended)

Browser-cooperating pairing flows that replace manual token + chatId + `.env` editing.

| Command | Description |
|---|---|
| `agentx connect telegram [--agent <id>] [--account <label>] [--skip-chat-capture]` | Open BotFather, verify token via `getMe`, bind to an agent, optionally listen for the first inbound message to auto-fill `notifications.destination`. Token persists to `.env` as `TG_<ACCOUNT>_BOT_TOKEN` |
| `agentx connect mesh invite [--url <routable>]` | Emit `agentx-mesh://join/<base64>` for another node. Auto-generates `MESH_TOKEN` if missing |
| `agentx connect mesh join <link>` | Accept a mesh invite. Writes shared `MESH_TOKEN` + adds peer. Health-checks the peer's agent card |

WhatsApp / Discord / GitLab flows are on the roadmap.

## Schedule (natural-language cron)

Recommended for most users — takes English phrases and generates the cron entry for you.

| Command | Description |
|---|---|
| `agentx schedule "<english>" --agent <id> --do "<prompt>" [--notify me] [--on-error log,notify,disable] [--id <name>] [--timezone <tz>] [--model <m>] [--disabled] [--dry-run]` | Add a scheduled job from a natural-language phrase |
| `agentx schedule list` (alias `ls`) | List all jobs with cronstrue human-readable text |
| `agentx schedule on <id>` | Enable a scheduled job |
| `agentx schedule off <id>` | Disable a scheduled job |
| `agentx schedule remove <id>` (alias `rm`) | Remove a scheduled job |
| `agentx schedule parse "<english>"` | Preview a parse without writing anything |

**Supported phrasings:** `every morning at 9`, `weekdays at 6pm`, `every 15 minutes`, `every hour` / `hourly`, `every 2 hours`, `every monday at 10am`, `every tuesday and friday at 3pm`, `1st of every month at noon`, `daily at 9:30am`, `at midnight`, `at noon`.

**`--notify me`** resolves to `notifications.destination` from the config. Pass `channel:chatId[:accountId]` for a one-off target.

**`--on-error`** accepts any combination of `log`, `notify`, `disable` (comma-separated). Adding `--notify` auto-includes `notify`.

Every change validates against the Zod schema and signals `POST /reload` to the running daemon — crons hot-swap without restart.

## Crons (low-level, raw syntax)

The escape hatch for ops who want to write cron syntax directly. Same underlying storage as `schedule`.

| Command | Description |
|---|---|
| `agentx cron list` (alias `ls`) | List cron jobs (schedule, agent, status) |
| `agentx cron add` | Add a cron interactively (raw cron syntax) |
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
| `agentx wiki absorb [--force] [--agent <id>] [--mode <m>] [--max <n>] [--dry-run]` | **Deprecated.** Batched LLM compile of raw entries into articles — expensive and rarely retrieved. Gated behind `--force`. A focused procedure-delta replacement tied to the intent knowledge graph is planned. |
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
| `agentx config get <path> [--raw] [--json]` | Read a value by dot-path (e.g. `agents.devops.model`). `--raw` preserves `${VAR}` tokens; `--json` emits machine-readable output |
| `agentx config set <path> <value> [--string] [--dry-run]` | Write a value by dot-path. Parses as JSON first (numbers, booleans, arrays, objects), falls back to string. `"a,b,c"` shorthand produces an array. `--string` forces literal string. Validates against the Zod schema and hot-reloads the daemon |
| `agentx config unset <path> [--dry-run]` | Remove a value by dot-path (no-op on missing paths). Hot-reloads on success |

**Examples:**

```bash
agentx config get crons.wiki-absorb-midnight.onError --json
agentx config set crons.wiki-absorb-midnight.timeout 900
agentx config set crons.wiki-absorb-midnight.onError "notify,disable"
agentx config set agents.devops.model claude-sonnet-4-6
agentx config unset crons.test-cron
```

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
| `POST` | `/reload` | Re-read `agentx.json`; hot-swaps crons, flags sections that still need a restart. Fired automatically by `agentx config set` / `agentx schedule` / the `fs.watch` on `agentx.json` (disable with `AGENTX_AUTO_RELOAD=false`) |
| `GET`  | `/events` | SSE event stream |
| `GET`  | `/health` | Health check |
| `GET`  | `/.well-known/agent-card.json` | Agent card for mesh peers |
| `GET`  | `/wiki/agents`, `/wiki/entries`, `/wiki/articles`, `/wiki/article` | Wiki read API |
| `POST` | `/debug/on?categories=...`, `/debug/off` | Toggle debug categories at runtime |
| `GET`  | `/business/work/list?agent=<id>`, `POST /business/work/claim`, `POST /business/work/report`, `POST /business/clock-out`, `GET /business/kpi/today`, `GET /business/kpi/week` | Business layer API |
