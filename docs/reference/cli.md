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
| Inspect usage | `agentx usage today`, `agentx usage plan`, `agentx usage report`, `agentx usage surfaces` ([understand costs](../help/costs.md)) |
| Validate configuration | `agentx config check` |
| Create a starter `agentx.json` without the browser | `agentx init` |
| Issue API tokens for peers and integrations | `agentx token create`, `agentx token list`, `agentx token revoke` |
| Check a risky command against the guardrails | `agentx guard test`, `agentx guard log` |
| Ask a typed question and get a calibrated answer | `agentx decide` |
| Let agents ring you for a voice call | `agentx call allow <agent>`, `agentx call list` |
| Pick each agent's voice | `agentx voice list`, `agentx voice set` |
| Check what a live lesson did | `agentx voice lessons` |
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
| `whatsapp` | WhatsApp chats and contacts, ingesting them into the wiki, and triage of watched chats |
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
| `agentx daemon status` | Which version is running, since when, what restarted it last, then agents, schedules and connected machines; `--json` for the same as data. See [what the daemon is running](#see-what-the-daemon-is-running) |
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
| `agentx call allow <agent>`, `agentx call disallow <agent>` | Who may call you (`calls.allow`; `"*"` for every agent). The same list lets an agent ask to see through your phone camera |
| `agentx camera ask --reason "…"` | From inside an agent's run: ask you to show the phone camera (`--urgent`); see [Share your phone camera](../dashboard/mobile-camera.md#when-an-agent-asks-to-see) |
| `agentx camera look` | From inside an agent's run, while you share: the newest picture, saved as a PNG the agent opens |
| `agentx camera list`, `agentx camera watching` | Recent camera asks (`--status`, `--limit`, `--json`); agents watching a camera right now |
| `agentx camera decline <id>`, `agentx camera stop <id>` | Turn down an ask; end a live watch from the terminal |
| `agentx notifications show` | Notification routing, the local banner and sound, phone app and ntfy status, and on a Mac whether AgentX Helper may post banners |
| `agentx notifications local` | `--banner`, `--sound`, `--sound-name`, `--volume`, `--icon` for the Mac banner and sound |
| `agentx notifications push` | `--subject`, `--relay-to`, `--enable`/`--disable` for notifications on the [phone app](../dashboard/mobile-alerts.md) |
| `agentx notifications channel <name>` | Where `agentx notify` sends by default (`push`) |
| `agentx notifications ntfy` | `--server`, `--topic`, `--token`, `--enable`/`--disable` for push through ntfy |

Do not share `config show` output without checking it for credentials. Starting a daemon does not start the separate browser dashboard.

### See what the daemon is running

`agentx daemon status` opens with a short block about the daemon (the AgentX background service) itself, before the list of agents:

```text
AgentX 1.4.0 (abc1234)   node demo-laptop
Running since   2026-03-10 12:21 (Europe/Paris), 2h 05m ago, pid 1827
Last restart    2026-03-10 12:21 by agentx daemon restart (SIGTERM), previous boot 2026-03-10 06:41
Restarts        3 today, 9 in the last 7 days
Build on disk   dist newer than process: no
Service         launchd com.example.agentx (KeepAlive)
```

| Line | What it tells you |
|---|---|
| First line | The version and the commit (the exact state of the source code it was built from) that the daemon loaded when it started, and the name of this machine in `agentx.json` |
| **Running since** | When the daemon started, in your time zone, and its process number (`pid`) |
| **Last restart** | When it last started, what stopped the daemon before it, and when that one had started. `by agentx daemon restart` or `by agentx daemon stop` is a command; `by restart-when-idle from …` is the dashboard's **Restart when idle** button or the same request from a terminal; `by launchd (…)` or `by systemd` means the stop came with no request on record, on a daemon that service manager runs: the service manager itself, a plain `kill` or a deploy script. It names what manages the daemon, not who asked. **no clean stop on record before it** means the daemon before crashed, was killed or lost power |
| **Restarts** | How many times the daemon started today and in the last seven days. Every start counts, so the first start of the day reads **1 today**. **on record since** appears while the record is younger than a week |
| **Build on disk** | **yes** when the AgentX files on disk were rebuilt or upgraded after the daemon started. The daemon keeps running the old code until it restarts. It looks at the folder the daemon was started from: a release installed into a new folder does not show here until the service points at it and restarts |
| **Service** | What starts the daemon again after it stops: a launchd job (macOS), a systemd unit (Linux), or nothing when it was started from a terminal |

`agentx daemon status --json` prints the same facts as data: `version`, `commit`, `startedAt`, `pid`, `lastRestart` (`at`, `by`, `reason`, `previousBootAt`), `restarts` (`today`, `last7d`, `since`), `build` (`newer`, `changedAt`, `version`) and `service`. The daemon's `/health` address answers with the same fields except `service`, so one call per machine is enough to compare a fleet.

When the daemon is stopped, the command says so and prints the last start on record:

```text
AgentX is stopped   node demo-laptop
Last boot       2026-03-10 12:21 (Europe/Paris), 2h 05m ago
```

Run it from the folder that holds `agentx.json`: the record of starts is kept there, in `.agentx/boot-log.json`. It keeps the last 500 starts.

## People

The humans who talk to your agents, one person per human whatever channel they use: [Tell agents who is who](../jobs/people.md).

| Command | What it does |
|---|---|
| `agentx people list [--json]` | Everyone, with their channel identities |
| `agentx people add <id> --name … [--role] [--identity channel:id]` | Add a person; `--identity` can be given several times |
| `agentx people link <id> <channel:id>` | Add a login, Telegram id or WhatsApp number to a person |
| `agentx people unlink <id> <channel:id>` | Take one away |
| `agentx people remove <id>` | Remove a person; their past tasks keep the id |
| `agentx people show <id> [--limit] [--json]` | One person and what they asked for, on every channel |

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
| `agentx workflow run <id-or-file>` | Execute the named workflow; may perform external actions. Fails if the workflow is not active |
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

## Request status

One comment per request in a GitLab or GitHub thread, kept up to date by AgentX: [`requestStatus`](./config-automation.md#requeststatus).

| Command | What it does |
|---|---|
| `agentx request-status` | Which channels show request status |
| `agentx request-status <gitlab\|github> <on\|off>` | Turn it on or off for one channel |

## Approvals

One list of every decision waiting for you: [Approvals](../dashboard/approvals.md).

| Command | What it does |
|---|---|
| `agentx approvals list [--all] [--json]` | What is waiting, most urgent first; `--all` includes items put off |
| `agentx approvals approve <key> [--note] [--force] [--choice] [--text]` | Say yes; `--force` approves a wiki lesson whose article changed since; `--choice` and `--text` answer a card that offers choices |
| `agentx approvals reject <key> [--note]` | Say no |
| `agentx approvals later <key> [--hours]` | Put an item off (default 24 hours) |
| `agentx approvals request --agent … --title … --ask … --recommend … --if-silent … [--choice …] [--draft] [--say] [--context]` | Raise a decision card yourself, for example to test |
| `agentx approvals popup <key>` | Show one card on the Mac now and record your answer (macOS) |
| `agentx approvals popup --sample [--theme] [--capture file.png]` | Show a sample card; nothing is recorded |
| `agentx approvals checkin [--daily]` | Run a check-in now: waiting cards come back, open reminders get cards (daemon, macOS) |
| `agentx approvals settings [options]` | Show or change expiry, "later", the daily digest, the Mac card and check-ins |

## Open requests

What you asked agents for that is not finished: [Keep track of what you asked for](../jobs/open-requests.md).

| Command | What it does |
|---|---|
| `agentx requests list [--json]` | Open requests, oldest first |
| `agentx requests show <id>` | One request and the runs, delegations and cards linked to it |
| `agentx requests done <id> --evidence <link>` | Close a request as finished, with a link to the proof |
| `agentx requests drop <id> [--reason]` | Drop a request you no longer want |
| `agentx requests settings [options]` | Show or change who counts as you, the channels, the quiet time and how long closed requests are kept |

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
| `agentx point "the search field"` | Locate and highlight; does not click. With the [character](../dashboard/voice.md#the-character-shows-you-something) on screen, the character goes there and marks it |
| `agentx point "the search field" --mark circle --hold 20` | How the character marks it (`box`, `circle`, `underline`, `none`) and for how many seconds |
| `agentx point "the search field" --text "Search starts here"` | What the character's bubble says while it stands there. Without it there is no bubble at the stop |
| `agentx point "the search field" --expression speaking` | The [state](../dashboard/voice.md#ask-for-a-state-by-name) the character shows while it stands there |
| `agentx point "the search field" --json` | Print the selection without pointing |
| `agentx express listening --hold 5` | The character shows a state where it rests for that many seconds: `idle`, `notices`, `listening`, `working`, `speaking`, `understood`, `dozing`, `calling` or `asking` |
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
3. **Terminal:** run `agentx daemon status`. The first line names the same version as step 1, and **Build on disk** says `no`.

## If something is wrong

- **`command not found: agentx`:** the npm package isn't installed globally, or you're in a source checkout. Use `node dist/cli.js` there.
- **`unknown command`:** check the spelling against `agentx --help` and its advanced list; your installed version may be older than these docs.
- **A command can't find your agents:** run it from the folder that holds `agentx.json`.
- **`agentx daemon status` shows an older version than `agentx --version`, or Build on disk says `yes`:** the daemon is still running the code it started with. Restart it: `agentx daemon restart --when-idle`. See [restart without losing work](../jobs/restart-safely.md).
- **Last restart says "no clean stop on record before it":** the daemon before this one did not shut down in the normal way. Read the end of its log with `agentx daemon logs -n 200`. The first start after upgrading to this version also shows it once.
- **The block has only two lines:** the daemon that answers is older than this page. Restart it to load the installed version.
- **Service says "none":** nothing starts the daemon again after a crash or a reboot. Set it up as a service: [restart without losing work](../jobs/restart-safely.md).
