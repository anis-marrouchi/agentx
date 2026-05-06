# CLI reference

All commands. Grouped by area. Run `agentx <command> --help` for the canonical flags.

## Quick orientation

```bash
agentx --version
agentx --help
agentx <command> --help
```

The CLI binary is `agentx`. The npm package is `agentix-cli`.

Sections below follow the order commands are registered in `src/program.ts`, so future audits diff cleanly against the source.

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

## Setup

Boots the dashboard (if it's not already running) and opens the web setup wizard in the browser. Safe on a fresh machine — fabricates a minimal config so the wizard can guide you to a real one.

| Command | Description |
|---|---|
| `agentx setup [--port <n>] [--no-open]` | Open the wizard at `http://127.0.0.1:<port>/setup`. Reads `dashboard.port` from `agentx.json` if present, else 4202. |

If `agentx.json` is missing, the wizard creates one. If it exists, the wizard extends it (channels, agents, tokens — no destructive writes).

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
| `agentx agent capability <id> --show` | Print the agent's current capability bounds + context strategy |
| `agentx agent capability <id> --intents "issue.opened,merge_request.opened"` | Set the typed intent allow-list — dispatches with intents not in the list are rejected by `canHandle()` |
| `agentx agent capability <id> --intents -` | Clear the intent allow-list (default empty = permissive) |
| `agentx agent capability <id> --max-delegation-depth 3` | Cap cascade chains — agent stops delegating after N hops |
| `agentx agent capability <id> --context-references true` | Enable the deterministic `[Verified References]` context block (requires `.agentx/references/` to be populated) |
| `agentx agent capability <id> --context-strategy planner` | Swap the per-agent context engine (e.g. `layered`, `planner`) |
| `agentx agent capability <id> --max-execution-minutes 45` | Per-agent execution-time ceiling |

These flags configure capability-bounded dispatch and per-agent context strategy. `--intents` is a typed allow-list — when set, the org-chart `canHandle()` check rejects dispatches with intents not in the list (default empty = permissive). `--max-delegation-depth` caps cascade chains; `--context-references` enables the deterministic [Verified References] context block; `--context-strategy` swaps the per-agent context engine. Without these flags, you'd hand-edit `agentx.json`.

## Channels

| Command | Description |
|---|---|
| `agentx channel list` (alias `ls`) | List channels + agent bindings |
| `agentx channel add` | Add a channel interactively (Telegram / WhatsApp / Discord / GitLab) — legacy path; prefer `connect` |

## Business layer

The `business` block in `agentx.json` describes how your team is organized — who reports to whom, which projects exist, and how Telegram/WhatsApp chat senders map to clients/projects. AgentX uses this for PM-gating (only the PM can authorize work on their project) and for activity-graph attribution (a Telegram group's chatId tells the graph which client the agent was helping). Edit it via these commands or in the Business tab at `/admin`. Restart the daemon for changes to take effect.

| Command | Description |
|---|---|
| `agentx business show` | Print orgChart, projects, contactMap (the resolved business config) |
| `agentx business orgchart add <agentId> --role <role> [--reports-to <id>] [--start 09:00] [--end 17:00] [--days mon,tue,wed,thu,fri] [--utilization 0.8]` | Add an agent to the org chart with role, reporting line, and working-hours window |
| `agentx business orgchart remove <agentId>` | Remove an agent from the org chart |
| `agentx business orgchart list` | List all org-chart entries |
| `agentx business project add <id> [--pm <agentId>] [--client <name>]` | Register a project with optional PM and client name |
| `agentx business project remove <id>` | Remove a project |
| `agentx business project list` | List all projects |
| `agentx business contact add --client <name> [--channel telegram] [--chat-id ...] [--username ...] [--sender-id ...] [--project ...] [--display-name ...]` | Map a chat sender (chatId / username / senderId) to a client and optional project |
| `agentx business contact remove [--channel] [--chat-id ...] [--username ...]` | Remove a contact mapping |
| `agentx business contact list` | List all contact mappings |

Business-layer edits ↔ `/admin` Business tab. PM-gating is gated by `INTENT_PM_GATE_ENABLED=true` (see Environment variables).

## Connect (pairing flows, recommended)

Browser-cooperating pairing flows that replace manual token + chatId + `.env` editing.

| Command | Description |
|---|---|
| `agentx connect telegram [--agent <id>] [--account <label>] [--skip-chat-capture]` | Open BotFather, verify token via `getMe`, bind to an agent, optionally listen for the first inbound message to auto-fill `notifications.destination`. Token persists to `.env` as `TG_<ACCOUNT>_BOT_TOKEN` |
| `agentx connect mesh invite [--url <routable>]` | Emit `agentx-mesh://join/<base64>` for another node. Auto-generates `MESH_TOKEN` if missing |
| `agentx connect mesh join <link>` | Accept a mesh invite. Writes shared `MESH_TOKEN` + adds peer. Health-checks the peer's agent card |

WhatsApp / Discord / GitLab flows are on the roadmap.

## Crons (low-level, raw syntax)

The escape hatch for ops who want to write cron syntax directly. Same underlying storage as `schedule`.

| Command | Description |
|---|---|
| `agentx cron list` (alias `ls`) | List cron jobs (schedule, agent, status) |
| `agentx cron add` | Add a cron interactively (raw cron syntax) |
| `agentx cron enable <id>` | Enable a cron job |
| `agentx cron disable <id>` | Disable a cron job |

Notes on `onError`: either a string or an array — `["log"]`, `["notify"]`, `["disable"]`, or any combination. See [Journey 2](/journey/02-scheduled-reports).

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

## Mesh (A2A)

| Command | Description |
|---|---|
| `agentx mesh list` (alias `ls`) | List peers + health status |
| `agentx mesh add` | Add a peer interactively (name, URL, token) |
| `agentx mesh remove <name>` (alias `rm`) | Remove a peer |

## Skills

| Command | Description |
|---|---|
| `agentx skill list` (alias `ls`) | List skills per agent |
| `agentx skill add <skillPath> [--agent <id>] [--all]` | Add a skill to one or all agents |
| `agentx skill sync <name> [--agent <id>] [--all-workspaces] [--dry-run]` | Redeploy a skill's `SKILL.md` from source to agent workspaces. Default: only workspaces that already have the skill; `--all-workspaces` to also seed missing. Prevents stale skill copies when the source is updated. |
| `agentx skill audit [--cwd <c>] [--references-cwd <c>] [--workspace <id> \| --all-workspaces] [--json]` | Lint installed skills against the references registry. Flags unresolved reference IDs, missing delegate skills, raw infrastructure facts that should cite a reference. Exits non-zero on any FAILING — wire into CI. |

## References

The deterministic references registry — operator-private facts (SSH targets, GitLab projects, paths, contacts) that skills cite by `id`. The loader resolves these into a `[Verified References]` block injected into agent context when `contextReferences: true`.

| Command | Description |
|---|---|
| `agentx references init <namespace> [--cwd <c>] [--force]` | Scaffold `.agentx/references/<namespace>/` from the example template. Creates one YAML per kind (ssh, gitlab, paths, contacts) plus a recipes entry |
| `agentx references discover <namespace> [--cwd <c>] [--references-cwd <c>] [--from <skills>] [--gitlab-host <url>] [--write] [--force]` | Scan installed skills and propose YAML for SSH targets, GitLab projects, paths, contacts. Dry-run by default — pass `--write` to commit. Best-effort guesses are tagged `needs-review` |
| `agentx references list [--cwd <c>] [--json]` (alias `ls`) | List every loaded reference (debug) |

After editing the YAML, set `contextReferences: true` on the relevant agents in `agentx.json` and run `agentx skill audit` to verify resolution.

## Database (read-only)

Operational SQLite store at `.agentx/db.sqlite` (the daemon's bus subscribers persist here). Named queries plus a raw-SQL escape hatch.

| Command | Description |
|---|---|
| `agentx db tasks [--cwd <c>] [-a <agent>] [-d <YYYY-MM-DD>] [-s ok\|error] [-n <limit>] [--json]` | Recent task_history rows |
| `agentx db rotations [--cwd <c>] [-a <agent>] [-r stale\|tier-2\|max-turns] [-n <limit>] [--summary] [--json]` | Session rotation events; `--summary` groups by agent + reason |
| `agentx db usage [--cwd <c>] [-d <YYYY-MM-DD>] [-a <agent>] [-n <limit>] [--json]` | Daily token usage rollup per agent |
| `agentx db routes [--cwd <c>] [-n <limit>] [--json]` | Inbound message routing decisions |
| `agentx db errors [--cwd <c>] [-a <agent>] [-n <limit>] [--json]` | Recent task errors with truncated stack |
| `agentx db tables` | List all tables in the store |
| `agentx db query <sql> [--cwd <c>] [--json]` | Run an arbitrary SELECT — read-only escape hatch |

## Ledger

Read-only triage CLI for the intent ledger at `.agentx/intent/ledger.sqlite` — the canonical record of every dispatch decision (Phase 1 of the architectural rescue). Use `--path` to point at an alternate ledger (e.g. one rsync'd from a remote node).

| Command | Description |
|---|---|
| `agentx ledger stats [--cwd <c>] [--path <p>] [--since <duration>] [--json]` | Overview: events by source, decisions by outcome, divergences, in-flight count |
| `agentx ledger divergences [-s <source>] [--since <d>] [-n <limit>] [--json]` | Recent divergence rows (newest first) — where the legacy router and the ledger disagreed |
| `agentx ledger active [-s <source>] [-n <limit>] [--json]` | Currently in-flight dispatched decisions (no resolution recorded yet) |
| `agentx ledger events [-s <source>] [-p <project>] [--since <d>] [-n <limit>] [--json]` | Recent intent events (newest first) |
| `agentx ledger replay [--since <d>] [-s <source>] [-n <limit>] [--json]` | Replay events onto a fresh tmp ledger and report any divergences. Phase 7 regression check in CLI form |

`--since` accepts durations like `1h`, `30m`, `7d`, or an absolute ms epoch. Mode is controlled by `INTENT_LEDGER_MODE` (`off`, `shadow`, `authoritative`) — default `shadow` once the daemon is running with the feature on.

## Backlog

Manage the structured backlog at `.agentx/backlog.json` used when `business.workSource.type=backlog`. Items can be imported from GitLab/GitHub with a stable source link; mutations push back upstream automatically.

| Command | Description |
|---|---|
| `agentx backlog list [--status <s>] [--assignee <agent>] [--source <gitlab\|github\|manual>] [-c <config>]` | List backlog items |
| `agentx backlog claim <id> <agent>` | Assign an item to an agent + set status=doing. If the item has a source, pushes assignee + Doing/-To Do labels upstream |
| `agentx backlog done <id> [--note <text>] [--close]` | Mark done. If linked, adds Done/removes Doing upstream; `--close` also closes the source issue |
| `agentx backlog remove <id>` | Remove from the local backlog (does NOT touch upstream) |
| `agentx backlog import [--source <gitlab\|github>] [--project <p>] [--assignee <agent>]` | Interactive importer: pick source → project → autocomplete-multiselect open issues → write items linked to upstream |

Item IDs follow `gitlab:<group/project>:<iid>`, `github:<owner/repo>:<n>`, or `manual:<uuid>`. The store regenerates `.agentx/backlog.md` on every save for human-readable diffing.

## Hooks

| Command | Description |
|---|---|
| `agentx hook add <agent>` | Add a hook interactively to the agent's workspace `.claude/settings.json` (event, type, matcher regex) |

Supported events: `PreToolUse`, `PostToolUse`, `SessionStart`, `Notification`, `Stop`. Types: `command` (shell), `http` (POST). See [Journey 5](/journey/05-hooks-webhooks).

## Migration

| Command | Description |
|---|---|
| `agentx migrate openclaw [<configPath>] [--dry-run]` | Import agents, channels, crons, Telegram accounts from an OpenClaw config. With no path, looks for `~/.openclaw/config.yaml` |

See [Migrate from OpenClaw](/migration/from-openclaw).

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

## Usage & tokens

```bash
# agentx usage serve  ← removed in May 2026
# the data lives at /admin/cost on the dashboard now
agentx usage today                          # quick today snapshot (still works)
agentx usage report --days 7                # Python session analyzer (still works)
```

The standalone `usage serve` HTTP server (port 4201) was folded into the dashboard's `/admin/cost` page — same data, one less port to manage.

| Command | Description |
|---|---|
| `agentx usage today` | Token usage summary — last 7 days, per agent |
| `agentx usage report [--days <n>]` | Full session analysis across Claude Code JSONL |

## Board

The Kanban dashboard. Visualizes work across configured `boards[]` (GitLab projects + label filters) and renders the live activity feed when no boards are configured.

| Command | Description |
|---|---|
| `agentx board serve [--port <n>] [--bind <host>]` | Start the dashboard server (default port 4202). Live view always available; boards only when `boards[]` is configured. Falls back to setup-only mode if `agentx.json` is missing |
| `agentx board list` | List configured boards (id, source projects, primary label, time-range window) |
| `agentx board add <id> --name <n> --projects <a,b> [--label <L>] [--days <n>] [--closed-days <n>]` | Append a GitLab board to `agentx.json`. Validates + auto-reloads the dashboard |
| `agentx board edit <id> --name <name> --projects <csv> --label <label> --days <n> --closed-days <n>` | Update an existing board's metadata (any subset of flags) |
| `agentx board remove <id>` (alias `rm`) | Drop a board by id |
| `agentx board column list <boardId>` | List the column flow for a board |
| `agentx board column add <boardId> <columnId> --title <title> --kind <kind> --scoped <label>\|--label <name>` | Append a column to the board's flow |
| `agentx board column remove <boardId> <columnId>` | Remove a column from the flow |

The `column` subcommand manages the column flow within a board (Open → Doing → Review → Closed, etc.). Each column maps a drag-drop action to a scoped label (`Status::Doing`) or a flat label, or to opening/closing the issue. The default flow is six columns following the GitLab `Status::*` convention; override per-board when you need a different shape (e.g. PR review boards with `Review::Approved` columns).

See [Boards & Kanban](/reference/boards) for the column model and label conventions.

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
| `agentx graph review [--agent <id>] [--max N] [--dry-run] [--daemon-url <url>]` | Triage pending classifications via the configured review agent. The reviewer may call `wiki query` for context before deciding approve / reject / skip. On approve, new nodes commit + the fingerprint cache populates so subsequent similar messages skip the LLM. |
| `agentx graph pull --from <peer-url> [--token <t>] [--limit <n>] [--dry-run]` | Cross-mesh sync: pull schema + nodes + approved classifications from a peer's graph. Conflicts skip silently; local always wins. Schema divergence is reported, not reconciled |
| `agentx graph migrate` | Bulk-remap `classifications.jsonl` + `index.json` from v1 → v2 schema |
| `agentx graph migrate --dry-run` | Preview the migration without writing |

When the intent-graph schema changes shape (Phase 1 of classifier-retire migrated from a 5-level v1 hierarchy to a 2-level v2 verb taxonomy), past classifications need a one-time bulk remap so the cache and audit log reference the new node IDs. Idempotent + makes a backup before writing.

## Procedure (SOPs)

Procedures are versioned standard-operating-procedures stored as markdown with frontmatter. They give agents a stable place to reference "how we do X here" without hardcoding it into prompts. v1 ships list/add/show; delta extraction (per-run one-liner deltas against the SOP) is on the roadmap.

| Command | Description |
|---|---|
| `agentx procedure list` | List procedures with their trigger line |
| `agentx procedure add --id <id> --title <t> --trigger <t> [--input <i>...] [--expected <t>] [--kpi <k>...] [--owner <id>] [--tag <t>...] [--related <r>...] [--steps <md>]` | Add a new procedure (non-interactive; pass all fields as flags) |
| `agentx procedure show <id>` | Print one procedure (frontmatter + body) |

Files land at `.agentx/procedures/<id>.md`. See [Journey 9](/journey/09-deterministic-services) for the calling pattern.

## Workflow (declarative state machines)

Declarative state machines that bind channel events to agents — at state X, run agent Y with prompt Z; transition to state W when condition C holds. Definitions live as one JSON or YAML file per workflow under `.agentx/workflows/`; runs persist as append-only jsonl on the home node. See [reference/workflows](/reference/workflows) for the full model + authoring guide.

### Authoring

| Command | Description |
|---|---|
| `agentx workflow init <id> [--template <name>] [--agent <id>] [--reviewer <id>] [--title <text>] [--json] [--force]` | Scaffold `.agentx/workflows/<id>.yaml` from a built-in template, validate it, and tell you what to edit next. Templates: `linear` (default), `branching`, `extract`, `human-in-the-loop`, `retry` |
| `agentx workflow templates` | List the available templates with their one-line description |
| `agentx workflow add <file>` | Import a YAML/JSON workflow file into `.agentx/workflows/` and `POST /reload` so the daemon picks it up without a restart. Skips reload with `--no-reload` |

### Read

| Command | Description |
|---|---|
| `agentx workflow list` | List every workflow in `.agentx/workflows/` with id, title, trigger source, and state chain. |
| `agentx workflow show <id> [--format yaml\|json]` | Print the full definition for one workflow. |
| `agentx workflow validate [file]` | Schema + lint check. With no arg, validates every file in the workflows dir. With a file path, validates that one. Exits non-zero on any failure — CI-friendly. |
| `agentx workflow draft-from-task <taskId> [--commit] [--print] [--format yaml\|json]` | Generate a disabled workflow draft from a successful task trace |
| `agentx workflow absorb [--since 24h] [--agent <id>] [--min-cluster-size 3] [--max 10] [--dry-run] [--commit]` | Mine repeated successful free-form task traces into workflow drafts |
| `agentx workflow drafts [--json]` | List workflow drafts under `.agentx/workflows/_drafts/` |
| `agentx workflow promote <draftId> [--replace]` | Promote a draft into the active workflow store and reload the daemon |
| `agentx workflow reject <draftId>` | Archive a draft under `_drafts/_rejected/` |

### Runs (read)

| Command | Description |
|---|---|
| `agentx workflow runs [id]` | List recent runs across all workflows, or filter to a single workflow. Shows run id, current state, status, home node, last transition. |

**Flags:** `--limit <n>` (default 20), `--node <id>` (override the home-node id used when reading the local run store; defaults to `$WF_NODE_ID` or `"local"`).

### Runs (control)

Manual lifecycle controls for runs. All three require the home-node's run store — pass `--node <id>` if the daemon's node id isn't set in `$WF_NODE_ID`.

| Command | Description |
|---|---|
| `agentx workflow run <id-or-file> [--input <json>] [--watch] [--force] [--daemon <url>]` | Trigger a stored workflow by id, **or** load + register + run a YAML/JSON file path (saved as `_adhoc-…` so it doesn't shadow stored ids). `--watch` polls `/traces?workflowRunId=<id>` every 500ms and prints each step (node, status, tokens, duration) until the run finishes. `--force` fires non-`manual`-trigger workflows for testing |
| `agentx workflow trace <runId-or-taskId> [--json] [--daemon <url>]` | Pretty-print the per-step execution trace for a run (or a single task). Surfaces the data behind `GET /traces[/:taskId]` as a terminal-friendly table — node id, model, tokens, duration, error |
| `agentx workflow replay-task <taskId> [--workflow <id>] [--input <json>] [--agent <id>] [--model <id>] [--validate-only] [--dry-run] [--watch]` | Replay a task through its linked draft or an ad-hoc workflow generated from the trace |
| `agentx workflow pause <runId> [--node <id>]` | Freeze a run. No new transitions will fire until `resume`. |
| `agentx workflow resume <runId> [--node <id>]` | Un-pause a paused run. |
| `agentx workflow cancel <runId> [--node <id>]` | End a run. No further transitions possible — terminal. |

### Tips

- Put `agentx workflow validate` in your CI pipeline before any merge that touches `.agentx/workflows/` — the linter catches unreachable states, unknown transition targets, and terminal-state-with-outgoing-edges.
- `agentx workflow runs --limit 5` is the fastest way to answer "what's the daemon doing right now with workflow X?" — pair it with `agentx daemon logs -f` to watch the corresponding agent dispatches.
- On multi-node mesh deployments, `runs` is per-node (runs belong to their home node). Use the dashboard `/workflows` page for a cross-node view.

## Tasks (workflow user-task inbox)

When a workflow has a `userTask` node, it pauses until a human fills the form. The dashboard `/inbox` page shows these forms with a click-to-fill UI. This CLI surface is the terminal equivalent — for scripting, headless ops, or quickly resolving a task without opening a browser. Form fields (text, long-text, number, boolean, date, select, multi-select) get prompted one at a time.

| Command | Description |
|---|---|
| `agentx task list` | List all open user-tasks (mirrors dashboard `/inbox`) |
| `agentx task list --actor <id>` | Filter to one actor |
| `agentx task list --json` | Machine-readable output |
| `agentx task show <id>` | View a task's form definition (fields, types, validation) |
| `agentx task submit <id>` | Interactive form submission — prompts one field at a time |
| `agentx task submit <id> --as <actor>` | Submit as a specific actor (overrides default identity) |
| `agentx task submit <id> --json '{"values":{"k":"v"}}'` | Non-interactive submission for scripting |
| `agentx task submit <id> --secondary` | Click the "reject"-style secondary button instead of the primary submit |

`agentx task list` ↔ dashboard `/inbox`. Use the CLI when you're already in a terminal or need to script bulk-resolution; use the dashboard when you want the click-to-fill UI.

## Actions (reusable invocations)

The action registry — named, parameterized shell or HTTP calls operators register once and invoke from CLI, dashboard, or workflows. Replaces hand-rolled `curl`/`exec` snippets sprinkled across crons and prompts. Storage: one JSON file per action under `.agentx/actions/<id>.json`. See the dedicated [Actions reference](./actions) for the integration cookbook.

| Command | Description |
|---|---|
| `agentx actions list [--json]` | List registered actions with kind + first input summary |
| `agentx actions show <id> [--json]` | Print an action's full definition (command/url, inputs, env, timeout) |
| `agentx actions add <id> --kind <shell\|http> --title <text> [...]` | Register or replace an action non-interactively. See flags below |
| `agentx actions remove <id>` (alias `rm`) | Delete an action |
| `agentx actions run <id> [--input k=v ...] [--json]` | Invoke the action and print stdout/stderr (shell) or response body (http) |

Common flags for `add`:

- `--kind shell` → `--command "<templated cmd>"`, optional `--cwd <path>`
- `--kind http` → `--url <u>`, `--method GET|POST|PUT|PATCH|DELETE`, `--headers '<json>'`, `--body '<template>'`
- `--inputs "name:type[!],..."` — comma-separated; `!` marks the input required. Types: `string`, `number`, `boolean`
- `--timeout <ms>` (default 30000, max 600000)

Templating: `{{name}}` resolves to an input value; `${ENV_VAR}` resolves against `process.env` of the agentx daemon. Output is capped at 32KB per stream.

**Examples:**

```bash
# CRM webhook — push a fresh lead from a chat into HubSpot
agentx actions add hubspot-create-contact \
  --kind http --title "Create HubSpot contact" \
  --url "https://api.hubapi.com/crm/v3/objects/contacts" \
  --method POST \
  --headers '{"Authorization":"Bearer ${HUBSPOT_TOKEN}","Content-Type":"application/json"}' \
  --body '{"properties":{"email":"{{email}}","firstname":"{{firstname}}","lastname":"{{lastname}}"}}' \
  --inputs 'email:string!,firstname:string,lastname:string'

# Transactional email via SendGrid
agentx actions add sendgrid-send \
  --kind http --title "SendGrid transactional email" \
  --url "https://api.sendgrid.com/v3/mail/send" \
  --headers '{"Authorization":"Bearer ${SENDGRID_API_KEY}","Content-Type":"application/json"}' \
  --body '{"personalizations":[{"to":[{"email":"{{to}}"}]}],"from":{"email":"noreply@example.com"},"subject":"{{subject}}","content":[{"type":"text/plain","value":"{{body}}"}]}' \
  --inputs 'to:string!,subject:string!,body:string!'

# Run on demand (or wire into a cron / workflow)
agentx actions run hubspot-create-contact \
  --input email=jane@acme.com --input firstname=Jane --input lastname=Doe
```

For a richer integration cookbook (CRM, ERP, support, billing) see the [Actions reference](./actions).

## Actors & roles (BPM)

Actors are humans who can be assigned to `userTask` nodes; roles are groups of actors with an assignment strategy.

| Command | Description |
|---|---|
| `agentx actor add <id> --name "Alice" --telegram <uid> --email <addr> --prefer <channel>` | Register an actor with one or more channel handles. Use `--prefer` to mark which channel receives task notifications. |
| `agentx actor list` | List all actors with their channel handles. |
| `agentx actor show <id>` | Dump the actor record as JSON. |
| `agentx actor remove <id>` | Delete an actor (does not clean role memberships). |
| `agentx role create <id> --name "Reviewers" --strategy <s>` | Create a role. Strategy: `first-available`, `round-robin`, `all`, `manager-of`. |
| `agentx role grant <roleId> <actor:id \| role:id>` | Add an actor or nested role to a role's members. |
| `agentx role revoke <roleId> <member>` | Remove a member. |
| `agentx role list` | List roles with member counts. |
| `agentx role show <id>` | JSON dump including resolved actor ids (walks nested roles). |

`userTask` nodes set `assignTo: "actor:alice"` or `assignTo: "role:reviewers"`. Forms render in the assignee's preferred channel (Telegram/WhatsApp/Slack one-click URLs, or the `/inbox` web UI).

## Memory (per-agent notes)

Long-lived experiential notes the agent reads on every turn — Claude-Code-style structured memory. Each memory has a kind (`user`, `feedback`, `project`, `reference`) and a one-line description; the daemon indexes them into a `MEMORY.md` table that is appended to the agent's system prompt at run time.

Use it for facts the agent should keep across sessions: who the user is, how they prefer feedback worded, project-specific context, or pointers to external systems (CRM project codes, Notion DBs, Slack channels).

| Command | Description |
|---|---|
| `agentx memory add --agent <id> --name <slug> --type <kind> --description <line> [--body <text> \| --from <file>]` | Add a memory. `--type` is `user`, `feedback`, `project`, or `reference` |
| `agentx memory list --agent <id> [--json]` | List memories for an agent |
| `agentx memory show <name> --agent <id>` | Print the full body of a memory |
| `agentx memory remove <name> --agent <id>` (alias `rm`) | Delete a memory |
| `agentx memory index --agent <id>` | Print the `MEMORY.md` index the agent sees in its prompt |

**Example:** save a CRM convention so the agent doesn't keep asking which Salesforce project codes map to which clients.

```bash
agentx memory add --agent sales-ops \
  --name salesforce-projects --type reference \
  --description "Salesforce project codes per client (avoid asking each time)" \
  --body "ACME → SF-1042; Globex → SF-1077; Initech → SF-1101"
```

## Tokens

Scoped API tokens for external access (mesh peers, integrations, dashboards). The full secret is shown only once at creation — the store keeps a hashed prefix for identification.

| Command | Description |
|---|---|
| `agentx token create --name <n> [--scope <s,s,s>] [--expires <days>]` | Mint a new token. Default scope `dashboard:read`. Prints the secret once |
| `agentx token list` (alias `ls`) | List all issued tokens with status (active / revoked / expired) |
| `agentx token revoke <id>` | Immediately invalidate a token by id |

Use the secret via `Authorization: Bearer <secret>`. Common scopes: `dashboard:read`, `dashboard:admin`, `mesh:peer`, `task:write`.

## Doctor

| Command | Description |
|---|---|
| `agentx doctor [-c <config>]` | Run health checks: config validates, workspaces exist, channel tokens resolve, providers reachable, mesh peers respond. See [Doctor](/reference/doctor) |

## Serve (MCP server)

Run agentx as an MCP server so AI editors (Claude Code, Cursor, Windsurf) can call agentx as a set of tools.

| Command | Description |
|---|---|
| `agentx serve [--stdio] [-c/--cwd <path>]` | Run on stdio (default — JSON-RPC on stdin/stdout, logs go to stderr) |

**Wire into Claude Code:**

```bash
claude mcp add agentx -- npx agentx serve --stdio
```

**Wire into Cursor / generic MCP config:**

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

See [Journey 10](/journey/10-mcp-server) for the full setup including auth and tool surface.

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

## Plugins

Plugins are npm packages exporting a default `AgentXPlugin` (`{manifest, setup}`). The daemon loads them on startup; this CLI lets you list and validate them without booting.

| Command | Description |
|---|---|
| `agentx plugin list` (default) | List packages configured in `agentx.json` `plugins: []` |
| `agentx plugin doctor` | Dynamic-import each configured plugin and report manifest validation status. Exits non-zero on any failure — wire into CI |

A plugin is an npm package with a default export `{manifest, setup}`; the `setup` callback registers channel adapters, hooks, or other extension points with the daemon.

## Environment variables

| Variable | Purpose |
|---|---|
| `AGENTX_DEBUG` | Comma-separated categories: `webhook`, `agent`, `channel`, `cron`, `mesh`, `context`, `memory`, `config`, `all` |
| `AGENTX_AUTO_RELOAD` | Set to `false` to disable the `fs.watch` on `agentx.json` that auto-fires `POST /reload` |
| `AGENTX_DAEMON_URL` | Override the daemon URL CLI subcommands hit (default `http://127.0.0.1:18800`). Useful for cross-host control |
| `AGENTX_USAGE_URL`, `AGENTX_WIKI_URL`, `AGENTX_INBOX_BASE_URL` | Override service URLs surfaced in agent-rendered links |
| `AGENTX_PLANNER_DEBUG` | Verbose logging for the context-strategy planner. See [Context strategies](/reference/context-strategies) |
| `INTENT_LEDGER_MODE` | Ledger write mode: `off`, `shadow`, `authoritative`. Default `off` |
| `INTENT_PM_GATE_ENABLED` | When `true` and `business.enabled=true`, dispatches go through the org-chart PM gate before reaching agents |
| `WF_NODE_ID` | Override the node id used for workflow run-store reads/writes (defaults to `"local"`) |
| `MESH_TOKEN` | Shared secret between mesh peers |
| `TG_*_BOT_TOKEN` | Convention for Telegram bot tokens (`${TG_FOO_BOT_TOKEN}` in `agentx.json`) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Provider credentials referenced from `${ANTHROPIC_API_KEY}` etc. in `agentx.json`'s `providers.*.apiKey` |
| `ANTHROPIC_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code subscription auth (used by tier `claude-code` agents); resolved via `agentx token create` flow or imported from your local Claude Code session |

## HTTP endpoints

Summary — full schemas in [Communication matrix](/reference/communication-matrix).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/task` | H2A: send a task to a local agent. Body: `{ agent, message, context?, freshSession?: bool, senderAgentId? }`. When `senderAgentId` is set (an agent calling another agent), `freshSession` defaults to **true** so the worker doesn't inherit the previous visitor's session — pass `false` to opt out |
| `POST` | `/send` | A2H initiate / cross-channel outbound |
| `POST` | `/mesh/task` | Cross-mesh delegation |
| `POST` | `/ask` | Short-form voice/Siri endpoint |
| `POST` | `/webhook/:agentId[/:source]` | Generic webhook receiver |
| `POST` | `/reload` | Re-read `agentx.json`; hot-swaps crons, flags sections that still need a restart. Fired automatically by `agentx config set` / `agentx schedule` / the `fs.watch` on `agentx.json` (disable with `AGENTX_AUTO_RELOAD=false`) |
| `GET`  | `/events` | SSE event stream |
| `GET`  | `/health` | Health check |
| `GET`  | `/agents/:id` | Resolved agent config (permission, tier, model, persistentProcess, toolUseRequired) |
| `POST` | `/agents/:id/selftest` | Canary probe — runs a fresh-session task against the agent and returns `{ ok, durationMs, tokens, billedModel, errorKind? }`. Body: `{ message? }` (defaults to a tiny "reply OK" prompt). Use for boot validation, CI, dashboard health badges |
| `GET`  | `/traces`, `GET /traces/:taskId` | Per-task execution trace — steps, tokens, errors, model, session id. `/traces` accepts `agentId`/`channel`/`chatId`/`workflowRunId`/`status`/`since`/`until`/`limit` filters. Returns 503 when SQLite is unavailable |
| `GET`  | `/api/processes` | Live persistent-claude pool snapshot |
| `POST` | `/api/processes/kill` | Manually evict a pool slot. Body: `{ agentId, channel, chatId, reason? }` |
| `GET`  | `/api/actions/builtin`, `POST /api/actions/builtin/:name` | List + invoke daemon-shipped built-in actions (`http.fetch`, `mesh.delegate`, `extract.structured`, `rag.lexical`, ...) |
| `GET`  | `/.well-known/agent-card.json` | Agent card for mesh peers |
| `GET`  | `/wiki/agents`, `/wiki/entries`, `/wiki/articles`, `/wiki/article` | Wiki read API |
| `POST` | `/debug/on?categories=...`, `/debug/off` | Toggle debug categories at runtime |
| `GET`  | `/business/work/list?agent=<id>`, `POST /business/work/claim`, `POST /business/work/report`, `POST /business/clock-out`, `GET /business/kpi/today`, `GET /business/kpi/week` | Business layer API |

## Persistent processes — production recipe

When `agents.<id>.persistentProcess: true`, a warm Claude subprocess per `(agent, channel, chatId)` slashes per-turn latency. Same warmth that helps a chat thread can leak conversation memory across visitors of a triage→worker pattern. The right knobs:

| Use case | Recipe |
|---|---|
| Real chat threads (Telegram/WhatsApp/Slack) | Sticky `chatId` per conversation, no `freshSession` — the warm pool is the whole point |
| Test harnesses, benchmarks | `freshSession: true` on every call + a unique per-request `chatId` for full isolation |
| Triage → sub-agent delegation | Use the `mesh.delegate` built-in (defaults `freshSession: true`), or set `senderAgentId` on `POST /task` and accept the auto-default |
| Stuck pool slot | `POST /api/processes/kill { agentId, channel, chatId }` |
| Bound long-lived warmth | Set `processPool.maxAgeSeconds` (default 2700 = 45min) in `agentx.json`. See [Config schema → processPool](./config-schema#process-pool-eviction) |

The latency / correctness tradeoff: full isolation (`freshSession: true` per call) is a cold spawn each time — measured ~+50s wall-clock vs warm pool on a 5-scenario benchmark. Warm pool is fast but only safe when the `chatId` truly identifies one conversation.

### Observing what your agents did

Every dispatched task records a trace row when SQLite is opened:

```bash
# List recent traces
curl -s http://127.0.0.1:18800/traces?agentId=devops&limit=20 | jq

# Pull one task's full step-by-step (tokens, tool calls, model, session id)
curl -s http://127.0.0.1:18800/traces/<taskId> | jq
```

When `[storage/sqlite] not opened` shows at boot, traces silently no-op. Rebuild the native module (`pnpm rebuild better-sqlite3`) — see [agentx doctor](./doctor).

### Smoke-testing an agent

```bash
curl -X POST http://127.0.0.1:18800/agents/lead/selftest \
  -H 'Content-Type: application/json' \
  -d '{"message":"Reply with the single word: OK"}' | jq
# → { ok: true, agentId: "lead", durationMs: 8421, tokens: { in: 150, out: 4 }, billedModel: "claude-sonnet-4-6" }
```

`/selftest` always uses `freshSession: true` and a synthetic `chatId`, so it never pollutes a live thread. Failure paths return `errorKind` (e.g. `out_of_credits`) plus the friendly text — useful for boot validation and CI.
