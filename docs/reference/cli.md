# CLI reference

All commands. Grouped by area. Run `agentx <command> --help` for the canonical flags.

## Quick orientation

```bash
agentx --version
agentx --help
agentx <command> --help
```

The CLI binary is `agentx`. The npm package is `agentix-cli`.

## Completion

Shell autocomplete is shipped with the global install. After `npm install -g agentix-cli`:

| Command | Description |
|---|---|
| `agentx completion [--shell zsh\|bash\|fish]` | Print the completion script to stdout |
| `agentx completion --install [--shell zsh\|bash\|fish] [--yes]` | Write the script to the shell's default completion path and print the rc hook to add (use `--yes` to auto-patch `~/.zshrc` or `~/.bashrc`) |
| `agentx completion --output <path> [--shell ...]` | Write the script to a custom path |

Default install paths:

- zsh: `~/.zsh/completions/_agentx` (add the dir to `fpath` once; OMZ/compinit pick it up)
- bash: `~/.bash_completion.d/agentx.bash` (source from `~/.bashrc`)
- fish: `~/.config/fish/completions/agentx.fish` (auto-loaded)

The script is generated from the live commander tree, so it stays in sync with the CLI automatically when you upgrade.

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

The wiki is a Karpathy/Farzapedia-shaped knowledge base — typed articles, `[[wikilinks]]` as the nav surface, `_index.md` as the catalog, agentic query at read time. See [Journey 6](/journey/06-shared-wiki) for the full story.

### Read

| Command | Description |
|---|---|
| `agentx wiki query <question>` | **Agentic query** — walks `_index.md` → picks candidates by `type` → follows `[[related]]` 2–3 hops → synthesizes an answer with citations. Primary retrieval path. |
| `agentx wiki search <query> [--agent <id>]` | Raw BM25 escape hatch when the agentic path is too slow. |
| `agentx wiki serve [--port <n>] [--peer <url>...]` | Wikipedia-style web browser (local + mesh peers). Default port 4200. |
| `agentx wiki status [--mode <graph\|unified\|flat>]` | Status per agent — entries, articles, unabsorbed count. |
| `agentx wiki entries [--agent <id>]` | List raw entries (the source log before absorb). |
| `agentx wiki lint [--agent <id>]` | Check wiki for broken wikilinks, orphans, stubs. |

### Write

| Command | Description |
|---|---|
| `agentx wiki interview --agent <id> [--topic <t>] [--type <t>] [--answers <file>]` | Interactive Q&A with an LLM synthesizer. Produces one typed article from operator answers. `--answers <file>` for scripted/non-interactive runs. |
| `agentx wiki quiz --agent <id> [--script <file>] [--rounds N]` | Reverse interview — ask the wiki questions, grade with `/ok` `/correct` `/add` `/link`, the top-cited article gets patched. |
| `agentx wiki patch <agent> <title-or-path> <instruction> [--yes] [--no-commit]` | One-shot LLM-patch from a plain-English instruction. Resolves title or path, shows diff, confirms. |
| `agentx wiki edit <agent> <title-or-path> [--editor <cmd>]` | Opens the article in `$EDITOR` directly. No LLM. Catalog rebuilds on exit. |
| `agentx wiki absorb [--agent <id>] [--max <n>] [--dry-run]` | Batch: compile unabsorbed raw entries into typed articles. Safe to schedule as nightly cron. |

### Housekeeping

| Command | Description |
|---|---|
| `agentx wiki migrate [--dry-run] [--commit]` | One-shot: backfill `type` + `related` on legacy articles via LLM classification. |
| `agentx wiki prune [--dry-run] [--commit]` | One-shot: collapse legacy `flat/` + `unified/` mode dirs into canonical `graph/`. Losers archived to `_versions/`. |
| `agentx wiki ab-test --agent <id> [--n N] [--out <file>]` | Sample N recent task-history messages, run each through OLD BM25 preload vs NEW agentic query, emit a side-by-side markdown report for manual rating. |
| `agentx wiki sync [--peer <url>] [--dry-run]` | Pull raw entries from mesh peers. |
| `agentx wiki share <article> <agent>` | Share a private article with another agent. |

## Graph (intent knowledge)

Per-message intent classification into a fixed-axis taxonomy. Typed paths feed Layer 6 of the context engine and can be used as article-tags for targeted wiki retrieval. See [reference/graph](/reference/graph) for the full story.

| Command | Description |
|---|---|
| `agentx graph review [--agent <id>] [--max N] [--dry-run]` | Triage pending classifications via the configured review agent. The reviewer may call `wiki query` for context before deciding approve / reject / skip. On approve, new nodes commit + the fingerprint cache populates so subsequent similar messages skip the LLM. |

## Workflow (declarative state machines)

Declarative state machines that bind channel events to agents — at state X, run agent Y with prompt Z; transition to state W when condition C holds. Definitions live as one JSON file per workflow under `.agentx/workflows/`; runs persist as append-only jsonl on the home node. See [reference/workflows](/reference/workflows) for the full model + authoring guide.

### Read

| Command | Description |
|---|---|
| `agentx workflow list` | List every workflow in `.agentx/workflows/` with id, title, trigger source, and state chain. |
| `agentx workflow show <id>` | Print the full JSON for one workflow. |
| `agentx workflow validate [file]` | Schema + lint check. With no arg, validates every file in the workflows dir. With a file path, validates that one. Exits non-zero on any failure — CI-friendly. |

### Runs (read)

| Command | Description |
|---|---|
| `agentx workflow runs [id]` | List recent runs across all workflows, or filter to a single workflow. Shows run id, current state, status, home node, last transition. |

**Flags:** `--limit <n>` (default 20), `--node <id>` (override the home-node id used when reading the local run store; defaults to `$WF_NODE_ID` or `"local"`).

### Runs (control)

Manual lifecycle controls for runs. All three require the home-node's run store — pass `--node <id>` if the daemon's node id isn't set in `$WF_NODE_ID`.

| Command | Description |
|---|---|
| `agentx workflow run <id> [--input <json>] [--daemon <url>]` | Manually trigger a workflow whose trigger is `source: manual`. The daemon must be running — this is a POST to `/workflows/:id/run` on `--daemon` (default `http://127.0.0.1:18800`). `--input` is merged into the trigger event payload. |
| `agentx workflow pause <runId> [--node <id>]` | Freeze a run. No new transitions will fire until `resume`. |
| `agentx workflow resume <runId> [--node <id>]` | Un-pause a paused run. |
| `agentx workflow cancel <runId> [--node <id>]` | End a run. No further transitions possible — terminal. |

### Tips

- Put `agentx workflow validate` in your CI pipeline before any merge that touches `.agentx/workflows/` — the linter catches unreachable states, unknown transition targets, and terminal-state-with-outgoing-edges.
- `agentx workflow runs --limit 5` is the fastest way to answer "what's the daemon doing right now with workflow X?" — pair it with `agentx daemon logs -f` to watch the corresponding agent dispatches.
- On multi-node mesh deployments, `runs` is per-node (runs belong to their home node). Use the dashboard `/workflows` page for a cross-node view.

## Skills

| Command | Description |
|---|---|
| `agentx skill list` (alias `ls`) | List skills per agent |
| `agentx skill add <skillPath> [--agent <id>] [--all]` | Add a skill to one or all agents |
| `agentx skill sync <name> [--agent <id>] [--all-workspaces] [--dry-run]` | Redeploy a skill's `SKILL.md` from source to agent workspaces. Default: only workspaces that already have the skill; `--all-workspaces` to also seed missing. Prevents stale skill copies when the source is updated. |

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

## WhatsApp

Ingest WhatsApp contact/group data into the wiki as a data source. See [WhatsApp as a data source](/reference/whatsapp-ingest) for the architecture + walkthrough.

| Command | Description |
|---|---|
| `agentx whatsapp list-chats [--format json] [--group] [--dm]` | List cached chats (no live fetch) |
| `agentx whatsapp list-contacts [--format json]` | List cached contacts |
| `agentx whatsapp ingest-all [--dry-run] [--agent <id>] [--force]` | Run a sweep against the configured allowlist |
| `agentx whatsapp ingest-contact <jid> [--dry-run] [--agent <id>]` | Ingest one contact (bypasses allowlist) |
| `agentx whatsapp ingest-chat <jid> [--dry-run] [--messages] [--agent <id>]` | Ingest one DM or group (bypasses allowlist). `--messages` forces a message-window pull for this pass |
| `agentx whatsapp status` | Connection + cache counts |

::: warning
`ingest-*` commands issue real reads against the Baileys session on the running daemon. They use a central throttle, but aggressive runs on a personal account still risk a ban — start with `--dry-run` and one allowlisted contact.
:::

## Bench

A/B the context-assembly strategies (`layered` vs `planner`) on the same message. Posts twice to the running daemon's `/task` endpoint and prints a side-by-side token/cost/latency comparison. See [Context strategies](/reference/context-strategies) for the background.

| Command | Description |
|---|---|
| `agentx bench context --agent <id> --message <text> [--channel <name>] [--chat-id <id>] [--sender <name>] [--runs <n>] [--preview <chars>] [--url <url>]` | Run the same message under both strategies and compare |

**Example:**

```bash
agentx bench context \
  --agent devops-agent \
  --message "In one short sentence, what is your role?" \
  --channel bench \
  --chat-id bench-1 \
  --runs 1
```

::: warning
`bench context` issues real agent tasks. Agents with `permissionMode: "bypassPermissions"` (e.g. `devops-agent`, `coder-agent`) will execute command-shaped messages for real — e.g. "restart daemond" will actually restart the daemon. Use observation-only phrasing for bench scenarios.
:::

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
