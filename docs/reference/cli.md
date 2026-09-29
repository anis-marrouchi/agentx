# CLI reference

The npm package is `agentix-cli`; the executable is `agentx`. Run `agentx <command> --help` for flags and examples. The commands below are registered in the current CLI. For every command and flag, with defaults, see the [CLI command reference](./cli-commands.md).

| Job | Command |
|---|---|
| Open the web wizard | `agentx setup` |
| Start or inspect the daemon | `agentx daemon start`, `agentx daemon status`, `agentx daemon logs` |
| Check installation | `agentx doctor` |
| Manage agents | `agentx agent list`, `agentx agent add` |
| Manage channels | `agentx channel list`, `agentx channel add` |
| Pair a channel | `agentx connect telegram`, `agentx connect whatsapp` |
| Pair machines | `agentx connect mesh invite`, `agentx connect mesh join <link>` |
| Schedule work | `agentx schedule "daily at 9am" --agent <id> --do "<task>"` |
| Attach an editor session | `agentx attach <agent>` |
| Open terminal UI | `agentx tui` |
| Inspect usage | `agentx usage today`, `agentx usage report`, `agentx usage surfaces` ([understand costs](../help/costs.md)) |
| Validate configuration | `agentx config check` |
| Create a starter `agentx.json` without the browser | `agentx init` |
| Issue API tokens for peers and integrations | `agentx token create`, `agentx token list`, `agentx token revoke` |
| Check a risky command against the guardrails | `agentx guard test`, `agentx guard log` |
| Ask a typed question and get a calibrated answer | `agentx decide` |
| Let agents ring you for a voice call | `agentx call allow <agent>`, `agentx call list` |
| Pick each agent's voice | `agentx voice list`, `agentx voice set` |
| Shell tab-completion | `agentx completion` |
| Expose MCP over stdio | `agentx serve --stdio` |
| Run a scripted tour | `agentx demo` |

## Advanced commands

These are callable but hidden from `agentx --help` (its footer names them all). Use each command's `--help` rather than assuming its flags.

| Command | What it manages |
|---|---|
| `workflow` | Workflow definitions: list, show, validate, run, and manage runs |
| `cron` | Schedules in their raw form (`schedule` is the friendlier front door) |
| `webhook` | Incoming webhook entries (GitLab, GitHub, Sentry, Stripe, Vercel, custom) |
| `mesh` | Mesh peers: add, list, remove, health-check timing |
| `a2a` | A standalone agent-to-agent protocol server ([A2A](a2a.md)) |
| `notifications` | Where AgentX pings you, and the Mac banner and phone push |
| `board` | Kanban boards over configured sources, and the dashboard server (`board serve`) |
| `wiki` | The agents' knowledge base |
| `memory` | Each agent's memory notes and extracted facts |
| `procedure` | Procedures learned from recurring activity: extract, review, match |
| `graph` | The intent graph: review and label classifications |
| `watch` | Stream live daemon events: workflow runs, tasks, mesh health |
| `trace` | Per-task execution traces: list, show, replay, and `lessons` (did a lesson make a repeated task better) |
| `ledger` | The intent ledger: events, decisions, divergences |
| `decisions` | The typed-decision store: calls, labels, calibration |
| `process` | Warm agent processes: list, kill |
| `db` | Read-only views of the operational database |
| `skill`, `hook`, `plugin`, `actions`, `references`, `rag` | Extensions: skills, hooks, plugins, reusable actions, the references registry, search indexes |
| `business`, `backlog`, `plan` | The business layer: org chart and projects, a local backlog, day/week/month plans |
| `whatsapp` | WhatsApp chats and contacts, and ingesting them into the wiki |
| `retention` | Prune old workspace state |
| `migrate` | Import configuration from another tool |
| `exec` | Run one task through an agent and exit, for scripts |
| `chat` | Deprecated; use `attach` |

`agentx monitor` is hook plumbing for external CLI-session reviews; it does not open the **Monitor** dashboard tab. `agentx chat` is deprecated in favor of `attach`.

## On your Mac: experimental helpers

`point`, `look`, and `paste` require macOS, the native helper installed by `agentx desktop install`, and a terminal. **`point` shows you what it would click; it never clicks.** The native helper and `teach` lessons can click and type; inspect a lesson before running it. `--no-speak` only turns off narration.

## Before copying commands

Run commands from the directory containing your `agentx.json`, unless a command provides a configuration flag. From a source checkout, use `node dist/cli.js` instead of `agentx`. Arguments in angle brackets are placeholders; replace them without the brackets. Commands that dispatch work can incur model usage.

## Desktop assistant

```sh
agentx desktop install --agent helper
agentx desktop status
agentx desktop stop
agentx desktop start
```

`install` builds and installs both native apps and sets up login startup. `--dry-run` shows its plan without changes. Apple Silicon, macOS 14+, and Apple's command-line tools are required. [Desktop setup](../dashboard/voice.md) covers speech and permissions.

## Daemon and configuration

| Command | Result / useful flags |
|---|---|
| `agentx daemon start` | Foreground daemon; `--detach` for background, `--config <path>` for another config |
| `agentx daemon status` | Inspect the daemon |
| `agentx daemon logs` | Read logs; `-f` to follow, `-n <lines>` for more |
| `agentx daemon stop` | Stop the daemon after its running tasks finish ([restart without losing work](../jobs/restart-safely.md)) |
| `agentx daemon restart` | Restart through launchd, systemd, or stop + start, and wait until it answers again; `--when-idle` waits for running tasks first (`--timeout`, `--abort-on-timeout`, `--reload-service`, `--dry-run`). See [restart without losing work](../jobs/restart-safely.md) |
| `agentx config check` | Validate the configuration |
| `agentx config get <path>` | Read one configuration field |
| `agentx config set <path> <value>` | Change a field; inspect the reload/restart result |
| `agentx doctor` | Check local installation and prerequisites |
| `agentx notify "<message>"` | Notify the phone app and show a Mac banner, held during Focus; `--proof` captures the banner; see [Get notified](../jobs/notifications.md) |
| `agentx call request --reason "…"` | From inside an agent's run: ring the owner for a live voice call (`--urgent`); see [Calls from your agents](../dashboard/calls.md) |
| `agentx call list` | Recent calls (`--status missed`, `--limit`, `--json`) |
| `agentx call answer <id>`, `agentx call decline <id>`, `agentx call hangup <id>`, `agentx call later <id> [minutes]` | Act on a call from the terminal |
| `agentx call allow <agent>`, `agentx call disallow <agent>` | Who may call you (`calls.allow`; `"*"` for every agent) |
| `agentx notifications show` | Notification routing, the local banner and sound, phone app and ntfy status, and on a Mac whether AgentX Helper may post banners |
| `agentx notifications local` | `--banner`, `--sound`, `--sound-name`, `--volume`, `--icon` for the Mac banner and sound |
| `agentx notifications push` | `--subject`, `--relay-to`, `--enable`/`--disable` for notifications on the [phone app](../dashboard/mobile-alerts.md) |
| `agentx notifications channel <name>` | Where `agentx notify` sends by default (`push`) |
| `agentx notifications ntfy` | `--server`, `--topic`, `--token`, `--enable`/`--disable` for push through ntfy |

Do not share `config show` output without checking it for credentials. Starting a daemon does not start the separate browser dashboard.

## Talk to an agent

```sh
agentx daemon send helper "Explain this project's purpose"
agentx tui --agent helper
agentx tui --legacy
agentx attach as helper
```

`daemon send` runs a task. `tui` opens the interactive terminal interface. `attach as` binds an external editor/CLI session to an AgentX identity; it does not open a chat. Use `agentx attach list` to inspect bindings and `agentx attach detach` to release them. Bindings are saved in `~/.agentx/attach-bindings.json` and survive daemon restarts; they end on `detach` or when the session closes. `agentx attach watch` connects a session without an identity: it gets a short event digest on each prompt and no messages ([Work from your Claude Code session](../jobs/claude-code-session.md)).

## Workflows and schedules

| Command | Result |
|---|---|
| `agentx workflow list` | List saved workflows |
| `agentx workflow show <id>` | Inspect a workflow |
| `agentx workflow validate <file>` | Validate before importing or running |
| `agentx workflow add <file>` | Import a definition |
| `agentx workflow run <id-or-file>` | Execute a workflow; may perform external actions |
| `agentx workflow runs [id]` | Inspect runs |
| `agentx workflow trace <id>` | Inspect execution details |
| `agentx workflow cancel <runId>` | Request cancellation |
| `agentx cron list` | List schedules |
| `agentx cron disable <id>` | Disable a schedule |
| `agentx cron enable <id>` | Enable a schedule |
| `agentx schedule list` | List schedules, including agent requests awaiting approval |
| `agentx schedule approve <id>` | Approve an agent's pending create or delete ([schedules from chat](../automations/schedules-from-chat.md)) |
| `agentx schedule reject <id>` | Reject an agent's pending create or delete |

Start with the [visual workflow guide](../tutorials/first-workflow.md) before enabling a live automation.

## Approvals

One list of every decision waiting for you: [Approvals](../dashboard/approvals.md).

| Command | What it does |
|---|---|
| `agentx approvals list [--all] [--json]` | What is waiting, most urgent first; `--all` includes items put off |
| `agentx approvals approve <key> [--note] [--force]` | Say yes; `--force` approves a wiki lesson whose article changed since |
| `agentx approvals reject <key> [--note]` | Say no |
| `agentx approvals later <key> [--hours]` | Put an item off (default 24 hours) |
| `agentx approvals request --agent … --title … --ask … --recommend … --if-silent …` | Raise a decision card yourself, for example to test |
| `agentx approvals settings [options]` | Show or change expiry, "later" and the daily digest |

## Agent memory

How to use these, step by step: [Review what your agents learn](../jobs/agent-memory.md).

| Command | What it does |
|---|---|
| `agentx memory facts summary` | Count each agent's facts by source trust and review state |
| `agentx memory facts held` | List facts waiting for approval |
| `agentx memory facts approve <id> --agent <id>` | Let a held fact be used |
| `agentx memory facts reject <id> --agent <id>` | Keep a held fact out for good |
| `agentx memory facts scrub [--apply]` | Count stored facts that contain credentials; `--apply` deletes them |
| `agentx memory facts flag-unsourced [--apply]` | One time: mark facts about bills, accounts, outages or deploys that name no source as unverified; `--apply` writes, with a backup (stop the daemon first) |
| `agentx trace lessons [--since 30d] [--agent <id>] [--min 2] [--json]` | Compare repeated tasks before and after each fact, procedure or wiki was first used |
| `agentx wiki promote [--commit]` | Preview (or, with `--commit`, judge and propose) lessons for the shared wiki |
| `agentx wiki promote --failures [--min-sessions <n>]` | Also propose lessons from failures that happened in at least `n` separate sessions (default 3) |
| `agentx wiki proposals list` | Proposed lessons waiting for review |
| `agentx wiki proposals show <id>` | The proposed article and its evidence |
| `agentx wiki proposals approve <id>` | Write it into the shared wiki; refuses if the article changed since, unless `--force` |
| `agentx wiki proposals reject <id> [--reason]` | Decline it; its sources aren't judged again until they change |
| `agentx wiki facts list [--stale]` | Checked facts, with where, when and by whom they were checked |
| `agentx wiki facts show <id>` | One fact and its earlier values |
| `agentx wiki facts set --subject --attribute --value --source --checked-at now` | Record a fact you checked; a different value needs a newer check or `--confirm` |
| `agentx wiki facts proposals list` | Claims from conversation summaries, waiting for a check |
| `agentx wiki facts proposals approve <id>` | Confirm a claim and record it as a fact |
| `agentx wiki facts proposals reject <id> [--reason]` | Drop a claim |

## Computer use and teaching

Install the [desktop assistant](../dashboard/voice.md) first. These tools interact with the current macOS desktop, not the browser tab displaying this documentation.

| Command | What it does |
|---|---|
| `agentx point "the search field"` | Locate and highlight; does not click |
| `agentx point "the search field" --json` | Print the selection without pointing |
| `agentx look "What is visible?"` | Capture the focused window and request a vision observation |
| `agentx look "The command palette is open" --verify --json` | Check a claim and return structured evidence |
| `agentx look "What is visible?" --screen` | Capture the full screen instead |
| `agentx look "The page has loaded" --verify --settle` | Wait for the window to stop moving before looking |
| `agentx screen capture --region notifications -- <command>` | Run a command and capture what it changed; see [Capture the screen at the right moment](../jobs/screen-capture.md) |
| `agentx screen capture --until-changed` / `--until-stable` | Capture once a region changes, or once it stops moving |
| `agentx screen recent --seconds 5` | Frames from the in-memory buffer (`screen.buffer`) |
| `agentx screen config` | Show or change the `screen` settings: size budget, waits, named regions, buffer |
| `agentx teach` | List bundled lessons |
| `agentx teach <lesson>` | Run a lesson; can narrate, point, click, type, and verify |
| `agentx teach <lesson> --record --record-dir <directory>` | Record with macOS screencapture |
| `agentx paste --help` | Inspect smart-paste options before using it |

For `look --verify`, exit codes are **0 confirmed**, **3 refuted**, **4 unknown**, and **1 operational error**. A vision call sends pixels to the configured provider. `point` uses a typed decision seat; [Jev](../architecture/jev.md) explains its configuration.

## Mesh and decisions

```sh
agentx mesh list
agentx mesh health --show
agentx daemon send helper "Reply with a short hello" --peer work-machine
agentx decisions backends
agentx decisions stats --since 1d
```

See [Tailscale pairing](../jobs/tailscale.md), [A2A communication](a2a.md), and [decision seats](../architecture/jev.md) for setup and interpretation.

## Find every command and flag

The [CLI command reference](./cli-commands.md) lists every command, argument and flag, with defaults. `agentx --help` lists the primary commands and names the advanced groups. Hidden groups remain callable. Use `agentx <group> --help`, then `agentx <group> <command> --help` for exact arguments, options, and defaults from your installed version. This matters when your installation differs from the documentation checkout.

## Check it worked

1. **Terminal:** run `agentx --version`. It prints the installed version.
2. **Terminal:** run `agentx doctor`. It checks Node, the configuration, credentials and the daemon.

## If something is wrong

- **`command not found: agentx`:** the npm package isn't installed globally, or you're in a source checkout. Use `node dist/cli.js` there.
- **`unknown command`:** check the spelling against `agentx --help` and its advanced list; your installed version may be older than these docs.
- **A command can't find your agents:** run it from the folder that holds `agentx.json`.
