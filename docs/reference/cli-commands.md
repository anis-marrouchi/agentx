# CLI command reference

Every `agentx` command and flag, grouped by the first word of the command. The list comes from the command definitions in the source, so it matches this version of the docs. For the jobs you do most often, start with the shorter [CLI reference](./cli.md).

How to read it:

- Words in angle brackets, such as `<id>`, are values you must give. Words in square brackets, such as `[id]`, are optional.
- **Default** is the value used when you leave the flag out. A dash means the flag is off, or has no value, unless you give it. **required** means the command refuses to run without it.
- Commands marked **advanced** are hidden from `agentx --help` but work the same way.
- `-c, --config <path>` points a command at an `agentx.json` in another folder. Without it, commands read `agentx.json` in the current folder.

Your installed version may differ. `agentx <command> --help` always shows the flags of the version you have.

## setup

`agentx setup`: Open the web setup wizard to create or extend your AgentX install.

| Flag | Default | What it does |
|---|---|---|
| `--port <n>` | — | Dashboard port (default: from agentx.json, else 4202). |
| `--no-open` | — | Don't try to open the browser. |

## init

`agentx init`: Initialize agentx configuration in the current directory.

| Flag | Default | What it does |
|---|---|---|
| `--force` | — | Overwrite existing config. |

## connect

`agentx connect`: Connect a channel or mesh peer — no manual file editing required.

### `agentx connect telegram`

Pair a Telegram bot — persists token in .env, binds to an agent, auto-detects default chat.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | Agent to bind the bot to (skips the prompt). |
| `--account <name>` | — | Account label in channels.telegram.accounts (defaults to agent id). |
| `--skip-chat-capture` | — | Don't listen for the first message after pairing. |
| `-c, --config <path>` | — | Path to agentx.json. |

### `agentx connect whatsapp`

Pair WhatsApp via QR (prints in terminal), then writes channels.whatsapp config.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | Default agent for inbound messages. |
| `--session-dir <path>` | — | Session directory (default: .agentx/whatsapp-sessions). |
| `--skip-pair` | — | Skip QR pairing (use when session already exists). |
| `-c, --config <path>` | — | Path to agentx.json. |

### `agentx connect mesh`

Mesh invite + join — replaces manual MESH_TOKEN copy-paste.

### `agentx connect mesh invite`

Emit a single-use join link for another AgentX node.

| Flag | Default | What it does |
|---|---|---|
| `--url <url>` | — | This node's URL as peers should reach it (Tailscale IP etc.). |
| `-c, --config <path>` | — | Path to agentx.json. |

### `agentx connect mesh join <link>`

Accept an invite link from another AgentX node.

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |

## desktop

`agentx desktop`: Install and control the macOS desktop assistant.

### `agentx desktop install`

Build, install, and start voice and computer-use helpers at login.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | Pin this agent; without it, pick the agent from the menu-bar icon. |
| `--dry-run` | — | Show the installation plan without building or changing login items. |

### `agentx desktop start`

Start the installed desktop assistant.

No flags.

### `agentx desktop stop`

Stop the desktop assistant until started again or next login.

No flags.

### `agentx desktop status`

Show the desktop login service status.

No flags.

## app

`agentx app`: Pair phones with the AgentX [phone app](../dashboard/mobile-app.md) and manage paired devices. Run these from the folder that holds `agentx.json`.

### `agentx app pair`

Pair a phone — prints a QR code to scan and a one-time code to type in the installed app.

The pairing code has 8 characters (shown as `XXXX-XXXX`), works once and expires after 10 minutes. It pairs the same device as the QR code.

Refuses to run while `tailscale serve` shares the whole dashboard (for example after `tailscale serve --bg 4202`) rather than only `/app` and `/api/app`. Serving `/.well-known/assetlinks.json` for the Android app is fine, as long as it points to that same path, as in [Open it without an address bar](/dashboard/mobile-places#open-it-without-an-address-bar-optional).

| Flag | Default | What it does |
|---|---|---|
| `--name <name>` | `Phone` | Name for this phone (shown in `agentx app devices`). |
| `--url <origin>` | this machine's Tailscale name | Address the phone opens, e.g. `https://my-mac.tailnet-name.ts.net`. |

### `agentx app devices`

List paired phones. On the computer that sends notifications, it also lists the phones paired with other computers that turned notifications on here, with ids like `laptop:tok_…`.

No flags.

### `agentx app revoke <id>`

Unpair a phone immediately. The phone also stops getting notifications. With an id like `laptop:tok_…`, it only stops notifications from this computer; the phone stays paired with `laptop`.

No flags.

### `agentx app forget-computer <name>`

Stop notifications from this computer to every phone paired with computer `<name>`. While `<name>` is still in `mesh.peers`, its phones can turn notifications on again. Use the name as it appears in `mesh.peers` or in `agentx app devices`: spaces and punctuation are matched the same way, so `my mac` and `my-mac` both work. See [Notifications on your phone](../dashboard/mobile-alerts.md).

No flags.

### `agentx app push-keys`

Create the key pair that lets this computer send notifications to paired phones. It is saved in `channels.push.keysFile` (default `.agentx/push-keys.json`), readable only by you, and never in `agentx.json`. See [Notifications on your phone](../dashboard/mobile-alerts.md).

| Flag | Default | What it does |
|---|---|---|
| `--force` | — | Replace existing keys (every phone must turn notifications on again). |

## daemon

`agentx daemon`: Manage the agentx daemon — start, stop, status, logs.

### `agentx daemon start`

Start the daemon (default if no subcommand).

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |
| `-d, --detach` | — | Run in background (detached). |
| `--port <port>` | — | Override bind port. |

### `agentx daemon stop`

Stop the running daemon.

No flags.

### `agentx daemon restart`

Restart the daemon through launchd, systemd or a plain stop + start; --when-idle waits for running tasks first.

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |
| `--when-idle` | — | Wait until no task is running before restarting. |
| `--timeout <minutes>` | `30` | How long --when-idle waits. |
| `--abort-on-timeout` | — | With --when-idle: give up instead of restarting when the wait runs out. |
| `--interval <seconds>` | `5` | How often --when-idle checks. |
| `--reload-service` | — | Also re-read the service's settings file (launchd plist / systemd unit). |
| `--dry-run` | — | Show what would run, without restarting. |

### `agentx daemon status`

Show daemon status, agents, crons, and mesh.

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |
| `--json` | — | Output as JSON. |

### `agentx daemon logs`

Tail daemon logs.

| Flag | Default | What it does |
|---|---|---|
| `-n, --lines <n>` | `50` | Number of lines. |
| `-f, --follow` | — | Follow log output. |

### `agentx daemon watch`

Stream live agent activity (SSE).

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |

### `agentx daemon send <agent> <message...>`

Send a task to an agent via the daemon API.

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |
| `--peer <peer>` | — | Send to a mesh peer's agent. |
| `--json` | — | Output raw JSON response. |

### `agentx daemon deploy <host>`

Deploy agentx to a remote server via rsync.

| Flag | Default | What it does |
|---|---|---|
| `-i, --identity <key>` | — | SSH identity file. |
| `-u, --user <user>` | `root` | SSH user. |
| `-p, --path <path>` | `~/agentx` | Remote agentx path. |
| `--restart` | — | Restart remote daemon after deploy. |
| `--skip-checks` | — | Skip build and test before deploy. |

## doctor

`agentx doctor`: Pre-flight health check: Node, config, credentials, daemon.

| Flag | Default | What it does |
|---|---|---|
| `--no-running` | — | Skip the live daemon probe. |
| `--json` | — | Emit machine-readable JSON (stable shape for CI). |

## agent

`agentx agent`: Manage agents — add, list, remove.

### `agentx agent list`

List configured agents.

No flags.

### `agentx agent add`

Add a new agent interactively.

No flags.

### `agentx agent remove <id>`

Remove an agent from config (keeps workspace).

No flags.

### `agentx agent capability <id>`

Set agent capability flags (intents, maxDelegationDepth, contextReferences, contextStrategy).

| Flag | Default | What it does |
|---|---|---|
| `--intents <csv>` | — | Comma-separated intent allow-list (set to '-' to clear). |
| `--max-delegation-depth <n>` | — | Max distinct upstream agents on the same subject before refusal (0 disables). |
| `--context-references <bool>` | — | Render the deterministic [Verified References] block (true\|false). |
| `--context-strategy <name>` | — | Per-agent override: layered \| planner. |
| `--max-execution-minutes <n>` | — | Wall-clock cap on a single Claude Code call (1–240). |
| `--show` | — | Just print the current capability fields. |

### `agentx agent integrations`

Manage per-agent third-party credentials (telegram-bot, hubspot, gitlab-user, gmail, etc.).

### `agentx agent integrations list <agentId>`

List integrations declared on an agent.

| Flag | Default | What it does |
|---|---|---|
| `--json` | — | Emit JSON. |

### `agentx agent integrations add <agentId>`

Declare a new integration on an agent.

| Flag | Default | What it does |
|---|---|---|
| `--kind <name>` | — | Service kind (e.g. telegram-bot, hubspot, gitlab-user, gmail). |
| `--label <text>` | — | Human-readable label (must be unique within (agent, kind)). |
| `--token-env <name>` | — | Env-var holding the secret (uppercase identifier). |
| `--auth <mode>` | — | Alternative to --token-env: 'keyring' for OS keyring. |
| `--session-dir <path>` | — | For whatsapp / mtproto: file-based session directory. |
| `--metadata <kvList>` | — | Comma-separated key=value pairs (e.g. 'username=alex,email=alex@example.com'). |
| `--no-prompt` | — | Fail instead of prompting for missing values. |

### `agentx agent integrations remove <agentId> <kindOrLabel>`

Remove an integration (matched by kind, label, or 'kind:label').

No flags.

### `agentx agent integrations test <agentId> [kindOrLabel]`

Validate env vars are set for one or all integrations on an agent.

No flags.

## channel

`agentx channel`: Manage channels — add telegram/whatsapp/gitlab, list.

### `agentx channel list`

List configured channels and bindings.

No flags.

### `agentx channel add`

Add a channel (telegram, whatsapp, or gitlab).

No flags.

## schedule

`agentx schedule [when]`: Schedule agents with natural-language cron: "every morning at 9" --agent helper --do "Post standup".

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | Agent to run. |
| `--do <prompt>` | — | Prompt to run at each tick (required unless --id exists). |
| `--id <name>` | — | Explicit cron id (default: auto-slug of &lt;when&gt;-&lt;agent&gt;). |
| `--notify <target>` | — | "me" (use notifications.destination) or "channel:chatId[:accountId]". |
| `--no-deliver` | — | Send only failures to `--notify`, not each run's answer. |
| `--on-error <modes>` | — | Comma list of "log\|notify\|disable" (default: log; notify implies "notify"). |
| `--timezone <tz>` | `Africa/Tunis` | IANA timezone (default: Africa/Tunis). |
| `--timeout <seconds>` | `600` | Max run time. |
| `--model <model>` | — | Override model. |
| `--disabled` | — | Create but leave disabled. |
| `--dry-run` | — | Print what would be written without writing. |

### `agentx schedule list`

List all scheduled jobs with human-readable descriptions.

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |

### `agentx schedule on <id>`

Enable a scheduled job.

No flags.

### `agentx schedule off <id>`

Disable a scheduled job.

No flags.

### `agentx schedule remove <id>`

Remove a scheduled job.

No flags.

### `agentx schedule approve <id>`

Approve an agent's pending create/delete request (enables or removes the job).

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |

### `agentx schedule reject <id>`

Reject an agent's pending create/delete request (drops the request).

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |

### `agentx schedule parse <when...>`

Preview a natural-language parse without writing anything.

No flags.

## approvals

`agentx approvals`: One inbox for every decision waiting for you (cards, schedules, memory facts, wiki proposals, requests that are not finished).

### `agentx approvals list`

What is waiting, most urgent first.

| Flag | Default | What it does |
|---|---|---|
| `--all` | — | Include items you put off with `later`. |
| `--json` | — | Machine-readable output. |

### `agentx approvals approve <key>`

Say yes: enables the schedule, lets the fact be used, writes the wiki article, or tells the agent yes.

| Flag | Default | What it does |
|---|---|---|
| `--force` | — | Wiki: approve even if the article changed since the proposal. |
| `--note <text>` | — | Cards: a note passed to the agent with your answer. |

### `agentx approvals reject <key>`

Say no: drops the request, keeps the fact out, declines the article, or tells the agent no.

| Flag | Default | What it does |
|---|---|---|
| `--note <text>` | — | Why; kept with cards and wiki proposals. |

### `agentx approvals later <key>`

Put an item off; it leaves the list and comes back later (a card still expires on time).

| Flag | Default | What it does |
|---|---|---|
| `--hours <n>` | — | How long (default: approvals.laterHours, 24). |

### `agentx approvals request`

Raise a decision card yourself, for example to test the inbox (agents use the agentx_approval tool).

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | required | The agent the card is from; it gets the result. |
| `--title <text>` | required | What it is, in one line. |
| `--ask <text>` | required | The yes/no question. |
| `--recommend <text>` | required | The advice and why, in one line. |
| `--if-silent <value>` | required | What applies if nobody answers: discard, keep, pause. A card never approves itself. |
| `--expires <when>` | — | ISO date or time, or like 12h / 3d (default: approvals.defaultExpiryDays). |
| `--source <link>` | — | Link to the draft, PR or issue. |

### `agentx approvals settings`

Show or change expiry, "later" and digest settings (approvals in agentx.json).

| Flag | Default | What it does |
|---|---|---|
| `--expiry-days <n>` | — | Days a card gets when it doesn't say. |
| `--max-expiry-days <n>` | — | Longest a card may wait. |
| `--later-hours <n>` | — | How long `later` hides an item. |
| `--notify-agent <on\|off>` | — | Tell the agent that raised a card its result. |
| `--forward-to <peer>` | — | Send this machine's cards to that mesh peer's inbox and popup; "none" to keep them here. |
| `--digest <on\|off>` | — | The daily message about what is waiting. |
| `--digest-time <HH:MM>` | — | When the digest goes out, 24-hour local time. |
| `--digest-timezone <zone>` | — | IANA timezone for --digest-time; "local" for this machine's. |
| `--digest-to <channel:chatId>` | — | Where the digest goes; "default" for notifications.destination. |

## requests

`agentx requests`: What you asked agents for that is not finished, oldest first.

### `agentx requests list`

Open requests, oldest first.

| Flag | Default | What it does |
|---|---|---|
| `--json` | — | Machine-readable output. |

### `agentx requests show <id>`

One request and the runs, delegations and cards linked to it.

No flags.

### `agentx requests done <id>`

Close a request as finished, with a link to the evidence.

| Flag | Default | What it does |
|---|---|---|
| `--evidence <link>` | — | Link to the proof: PR, issue, message, deploy. Required. |

### `agentx requests drop <id>`

Drop a request you no longer want.

| Flag | Default | What it does |
|---|---|---|
| `--reason <text>` | — | Why it is dropped. |

### `agentx requests settings`

Show or change the requests settings (requests in agentx.json).

| Flag | Default | What it does |
|---|---|---|
| `--enabled <on\|off>` | — | Record and follow your requests. |
| `--from <id,...>` | — | Who counts as you on channels other people can reach, as channel:id (your login on GitLab and GitHub, your sender id elsewhere); "none" to clear. |
| `--channels <name,...>` | — | Channels to record on; "all" for every channel a person writes on. |
| `--stale-hours <n>` | — | Hours without activity before an open request comes back to you. |
| `--retention-days <n>` | — | Days a closed request is kept. |

## request-status

`agentx request-status [channel] [state]`: Show each person the state of their request in the thread where they asked (GitLab, GitHub).

With no arguments it lists the channels and whether each is on. With a channel (`gitlab` or `github`) and `on` or `off` it changes `requestStatus.channels` in `agentx.json` and the running daemon picks the change up. See [`requestStatus`](./config-automation.md#requeststatus).

No flags.

## attach

`agentx attach`: Wear an agentx agent identity in this Claude Code session.

### `agentx attach as <agent>`

Bind this Claude Code session to an agent identity.

| Flag | Default | What it does |
|---|---|---|
| `-m, --mode <mode>` | `notify` | Delivery mode: manual \| notify \| auto. |
| `--session <id>` | — | Claude Code session id (defaults to $CLAUDE_CODE_SESSION_ID). |
| `--url <url>` | `http://127.0.0.1:19900` | Daemon base url. |

### `agentx attach watch`

Watch this session: no identity, no messages, a short event digest on each prompt. See [Work from your Claude Code session](/jobs/claude-code-session#watch-without-answering).

| Flag | Default | What it does |
|---|---|---|
| `--kinds <list>` | — | Event kinds or types to include, comma separated (default: failures, completions, approvals waiting, peers down). |
| `--agents <list>` | — | Only events for these agents, comma separated. |
| `--match <text>` | — | Only events whose summary contains this text. |
| `--session <id>` | — | Claude Code session id (defaults to $CLAUDE_CODE_SESSION_ID). |
| `--url <url>` | `http://127.0.0.1:19900` | Daemon base url. |

### `agentx attach detach`

Stop wearing an identity or watching in this session (queued work falls back to spawned agents).

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | Release only this identity (default: all). |
| `--session <id>` | — | Claude Code session id (defaults to $CLAUDE_CODE_SESSION_ID). |
| `--url <url>` | `http://127.0.0.1:19900` | Daemon base url. |

### `agentx attach list`

Show every attached session on this machine. Sessions that answer for an agent are listed under **Identities**, watching sessions under **Watchers**.

| Flag | Default | What it does |
|---|---|---|
| `--url <url>` | `http://127.0.0.1:19900` | Daemon base url. |
| `--json` | — | Raw JSON output. |

### `agentx attach install`

Wire the attach hooks into ~/.claude/settings.json (one time, all sessions).

| Flag | Default | What it does |
|---|---|---|
| `--port <n>` | — | Daemon port the hooks should call (default: node.bind in agentx.json). |
| `--path <file>` | — | Settings file to patch (default: ~/.claude/settings.json). |
| `--no-guard` | — | Skip the PreToolUse guard hook (not recommended). |

### `agentx attach uninstall`

Remove the attach hooks from ~/.claude/settings.json.

| Flag | Default | What it does |
|---|---|---|
| `--path <file>` | — | Settings file to patch (default: ~/.claude/settings.json). |
| `--remove-guard` | — | Also remove the PreToolUse guard hook. |

## monitor

`agentx monitor`: Register external CLI sessions and report ended runs to the briefing.

### `agentx monitor register`

Register an external CLI session with the daemon so its runs can be reviewed.

| Flag | Default | What it does |
|---|---|---|
| `--session <id>` | required | Native session ID. |
| `--runtime <name>` | required | Claude, codex, gemini, opencode, or another CLI. |
| `--label <label>` | required | Human-readable task label. |
| `--url <url>` | `http://127.0.0.1:19900` | Daemon URL. |

### `agentx monitor ended`

Report one finished run of a registered session; sends the last 90 KB of its transcript for review.

| Flag | Default | What it does |
|---|---|---|
| `--session <id>` | required | Registered session ID. |
| `--run <id>` | required | Stable unique turn ID; reuse this ID when retrying delivery. |
| `--transcript <file>` | required | Local transcript file; only the last 90 KB is submitted. |
| `--url <url>` | `http://127.0.0.1:19900` | Daemon URL. |

## tui

`agentx tui`: Open the AgentX console in OpenCode.

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Daemon config file. |
| `--node <url>` | — | Daemon URL (defaults to dashboard.daemonUrl from config). |
| `--token <token>` | — | Daemon mesh bearer token for remote nodes. |
| `--agent <id>` | — | AgentX agent to use as the OpenCode model. |
| `--legacy` | — | Open the built-in Ink terminal UI. |
| `--poll <ms>` | `3000` | Legacy UI snapshot poll interval in ms. |

## guard

`agentx guard`: Destructive-action guardrails — policy, checks, audit.

### `agentx guard check`

PreToolUse hook entrypoint: read a tool-call payload on stdin, emit a Claude Code decision.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | Agent id this workspace belongs to. |
| `--root <dir>` | — | AgentX install root (holds .agentx/guardrails + .agentx/db.sqlite). |
| `--env <name>` | — | Environment scope (e.g. production). |

### `agentx guard test <command>`

Dry-run a command through the policy engine and print the verdict.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | Evaluate as this agent. |
| `--env <name>` | — | Environment scope. |
| `--tool <name>` | `Bash` | Tool name. |
| `--cwd <dir>` | current folder | Workspace cwd for $VAR/.env resolution. |
| `--root <dir>` | — | AgentX install root (policy source). |
| `--enforce` | — | Evaluate as if mode=enforce (show what WOULD block). |
| `--json` | — | Emit JSON. |

### `agentx guard log`

Read the guardrail decision audit trail (newest first).

| Flag | Default | What it does |
|---|---|---|
| `--root <dir>` | — | AgentX install root (holds .agentx/db.sqlite). |
| `--verdict <v>` | — | Filter by verdict (deny\|escalate\|warn\|allow). |
| `--agent <id>` | — | Filter by agent. |
| `--task <id>` | — | Filter by task id. |
| `-n, --limit <n>` | `30` | Max rows. |
| `--json` | — | Emit JSON. |

### `agentx guard init`

Scaffold .agentx/guardrails/ with a starter policy + protected-resource example.

| Flag | Default | What it does |
|---|---|---|
| `--root <dir>` | current folder | Where to create .agentx/guardrails/. |
| `--force` | — | Overwrite existing files. |

### `agentx guard reload`

Signal the daemon to reload (note: guard policy is read live per tool call already).

| Flag | Default | What it does |
|---|---|---|
| `--url <url>` | `http://localhost:19900` | Daemon base url. |

### `agentx guard policy`

Print the resolved (merged) policy for an agent.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | Agent id. |
| `--root <dir>` | — | AgentX install root. |

## point

`agentx point <request>`: Point at the on-screen control matching a description (does not click).

| Flag | Default | What it does |
|---|---|---|
| `--max <n>` | `40` | Candidates to consider. |
| `--json` | — | Emit the decision as JSON instead of pointing. |
| `--min-present <p>` | `0.5` | Refuse below this P(control exists). |
| `--mark <kind>` | `box` | How the character marks it: box, circle, underline, none. |
| `--hold <seconds>` | — | How long the character stays there (8 by default). |
| `--text <words>` | — | What the character's bubble says there (no bubble without it). |
| `--expression <name>` | — | The state the character shows there: idle, notices, listening, working, speaking, understood, dozing, calling, asking. |

## express

`agentx express <name>`: Have the character show one of its states for a few seconds: idle, notices, listening, working, speaking, understood, dozing, calling, asking.

| Flag | Default | What it does |
|---|---|---|
| `--hold <seconds>` | — | How long it shows it (8 by default). |

## look

`agentx look <question>`: Look at the screen with a vision model — for state the tree and OCR cannot see.

| Flag | Default | What it does |
|---|---|---|
| `--verify` | — | Treat the argument as a claim and judge it (exit 3 refuted, 4 unknown). |
| `--menubar` | — | Capture the menu bar instead of the focused window. |
| `--screen` | — | Capture the whole screen instead of the focused window. |
| `--rect <x,y,w,h>` | — | Capture an explicit region. |
| `--settle` | — | Wait for the region to stop moving before capturing it. |
| `--model <id>` | — | Vision model to use. |
| `--json` | — | Emit the result as JSON. |

## screen

`agentx screen`: Capture the screen at the right moment: after an action, a change, or once it settles.

### `agentx screen capture [command...]`

Capture a region, optionally waiting for it to change or settle, or around a command.

| Flag | Default | What it does |
|---|---|---|
| `--region <name\|x,y,w,h>` | `window` | Window, screen, menubar, notifications, a name from screen.regions, or x,y,w,h. |
| `--until-changed` | — | Wait for the region to change first. |
| `--until-stable` | — | Wait for the region to stop changing. |
| `--max-pixels <n>` | — | Pixel budget for this capture (default screen.maxPixels). |
| `--out <path>` | — | Where to write the PNG. |
| `-c, --config <path>` | — | Agentx.json to read screen settings from. |
| `--json` | — | Print the result as JSON. |

### `agentx screen recent`

Frames from the daemon's in-memory screen buffer (screen.buffer must be on).

| Flag | Default | What it does |
|---|---|---|
| `--seconds <n>` | — | How far back (default screen.buffer.seconds). |
| `--url <url>` | `http://127.0.0.1:19900` | Daemon URL. |
| `--json` | — | Print the result as JSON. |

### `agentx screen config`

Show or change screen capture settings (agentx.json `screen`).

| Flag | Default | What it does |
|---|---|---|
| `--max-pixels <n>` | — | Pixel budget for a captured frame. |
| `--timeout <ms>` | — | Longest a capture waits. |
| `--interval <ms>` | — | Time between samples while waiting. |
| `--threshold <0-1>` | — | Difference that counts as a change. |
| `--stable-ms <ms>` | — | How long a region must hold still to be stable. |
| `--region <name=x,y,w,h>` | — | Add or change a named region. |
| `--remove-region <name>` | — | Remove a named region. |
| `--buffer <state>` | — | On \| off: keep recent frames in memory. |
| `--buffer-seconds <n>` | — | How many seconds the buffer keeps. |
| `--buffer-fps <n>` | — | Samples per second. |
| `--buffer-region <name\|x,y,w,h>` | — | Region the buffer watches. |
| `--buffer-max-pixels <n>` | — | Pixel budget per buffered frame. |
| `-c, --config <path>` | — | Agentx.json to read and change (default: ./agentx.json). |

## paste

`agentx paste`: Reshape the clipboard to fit where it is being pasted.

| Flag | Default | What it does |
|---|---|---|
| `--apply` | — | Write the result back to the clipboard. |
| `--paste` | — | Apply, then press cmd-V into the focused control. |
| `--as <id>` | — | Force a transform (asIs, unwrap, bullets, quote, codeFence, prettyJson, cleanUrl, slug, collapseSpace). |
| `--min <p>` | `0.45` | Minimum P(worth changing) before transforming. |
| `--undo` | — | Restore the clipboard as it was before the last apply. |
| `--json` | — | Emit the decision as JSON. |

## notify

`agentx notify [message]`: Tell the operator something, holding it if they are in Focus.

| Flag | Default | What it does |
|---|---|---|
| `--from <who>` | `agentx` | Who is speaking. |
| `--title <text>` | `AgentX` | Notification title. |
| `--priority <n>` | `4` | 1 (min) to 5 (max). Used by ntfy only. |
| `--urgent` | — | Deliver even during Focus. |
| `--channel <name>` | `notifications.channel`, else `push` when it is on, else `ntfy` | Delivery channel. |
| `--chat-id <id>` | `default` | Channel address. |
| `--no-sound` | — | Do not play a sound on this machine. |
| `--no-banner` | — | Do not show a banner on this machine. |
| `-c, --config <path>` | — | Agentx.json to read local settings from (default: ./agentx.json). |
| `--proof` | — | Capture the banner as it shows and print the frame's path. |
| `--status` | — | Show Focus state and anything being held. |
| `--flush` | — | Deliver everything held, as one message. |
| `--json` | — | Emit the result as JSON. |

## decide

`agentx decide`: Ask a typed question about some state and get a calibrated answer back.

| Flag | Default | What it does |
|---|---|---|
| `--file <path>` | — | Spec JSON file (default: stdin). |
| `--backend <name>` | `typesafe` | Decision backend. |
| `--seat <name>` | `adhoc` | Seat name the answers are recorded under. |
| `--no-record` | — | Answer without writing a row. |
| `--timeout <ms>` | `20000` | Abandon the call after this long. |

## teach

`agentx teach [lesson]`: Walk through something on screen, speaking and pointing as it goes.

| Flag | Default | What it does |
|---|---|---|
| `--voice <voice>` | — | System voice name, "system" for the OS default, or ElevenLabs voice id (overrides the agent's). |
| `--agent <id>` | — | Speak in this agent's voice (default: AGENTX_VOICE_AGENT or node.defaultAgent). |
| `--no-speak` | — | Point only, print the narration. |
| `--no-hud` | — | Skip the on-screen callout. |
| `--record` | — | Record the screen (screencapture) around the lesson. |
| `--record-dir <path>` | — | Where to write the recording. |
| `--live <goal>` | — | No lesson: the agent reads the screen and teaches this, step by step. |
| `--mode <mode>` | — | With --live: teach (you do each step), watch (you drive, it coaches) act (it does it, if allowed) or draw (plans a tldraw offline illustration in one model turn and draws it). |
| `--app <name>` | — | With --live: open this app first. |
| `-c, --config <path>` | — | With --live: agentx.json to read the agent from. |
| `--steps <n>` | — | With --live: most steps before it stops (default 12). |
| `--model <id>` | — | With --mode draw: the planning model (default claude-sonnet-5). |
| `--out <dir>` | — | With --mode draw: where the .tldraw file and the picture go (default ~/Documents). |

## talk

`agentx talk <agentA> <agentB> <topic...>`: Two agents, local or on a mesh peer, talk a topic through out loud; type to cut in, "stop" to end.

| Flag | Default | What it does |
|---|---|---|
| `--context <text>` | — | A few lines of context both agents should know. |
| `--turns <n>` | — | Most lines before they wrap up (default 10). |
| `--local` | — | Run the talk in this process instead of the daemon. |
| `-c, --config <path>` | — | Agentx.json for --local (default: the usual lookup). |

## narrate

`agentx narrate <target> <state>`: Switch spoken task narration on or off for an agent or one task.

| Flag | Default | What it does |
|---|---|---|
| `--task` | — | The target is a task id. |

## voice

`agentx voice`: List installed system voices and pick each agent's voice.

### `agentx voice list`

Installed system voices, best first, and which agent uses which.

| Flag | Default | What it does |
|---|---|---|
| `--all` | — | Every language, not only the configured one. |
| `-c, --config <path>` | — | Agentx.json to read. |

### `agentx voice set <agent> [voice]`

Pick an agent's voice: a system voice name, a Siri voice as siri:&lt;name&gt;, "system" for the OS default, or an ElevenLabs id with --provider elevenlabs.

| Flag | Default | What it does |
|---|---|---|
| `--provider <provider>` | — | System or elevenlabs. |
| `--lang <lang>` | — | Use this voice for lines in one language only: en, fr, ar. |
| `--gender <gender>` | — | Female, male or neutral; an assigned voice matches it. |
| `-c, --config <path>` | — | Agentx.json to change. |

### `agentx voice pronounce [written] [spoken]`

How a word is said aloud without changing how it is written: list the pairs, or set one ("Okafor" "Oh-kah-for").

| Flag | Default | What it does |
|---|---|---|
| `--lang <langs>` | — | Only lines in these languages, comma-separated: en, fr, ar. |
| `--remove` | — | Take the pair for &lt;written&gt; away. |
| `-c, --config <path>` | — | Agentx.json to read or change. |

## usage

`agentx usage`: Token usage analysis and reporting.

### `agentx usage today`

Show today's token usage.

No flags.

### `agentx usage plan`

Show the Claude plan windows as Claude Code last reported them, and any hold on fresh sessions.

| Flag | Default | What it does |
|---|---|---|
| `--lift` | — | Lift the hold on fresh sessions now, without waiting for the reset time. |
| `--json` | — | Raw JSON output. |

### `agentx usage report`

Run full session analysis (parses Claude Code JSONL files).

| Flag | Default | What it does |
|---|---|---|
| `--days <n>` | `7` | Analyze last N days. |

### `agentx usage channels`

Cost per channel over a fixed range of days, next to a saved baseline.

| Flag | Default | What it does |
|---|---|---|
| `--from <date>` | — | First day, YYYY-MM-DD. Required. |
| `--to <date>` | — | Last day, YYYY-MM-DD. Required. |
| `--save <file>` | — | Write this range's figures to a JSON file. |
| `--baseline <file>` | — | A file written by --save, shown beside this range. |
| `--json` | — | Raw JSON output. |

### `agentx usage surfaces`

Which CLI commands and dashboard pages are actually used.

| Flag | Default | What it does |
|---|---|---|
| `--days <n>` | `30` | Window in days. |
| `--kind <kind>` | — | Cli \| page (default: both). |
| `--unused` | — | List registered surfaces with ZERO recorded use instead. |
| `--json` | — | Raw JSON output. |

## serve

`agentx serve`: Run agentx as an MCP server for AI editors (Claude Code, Cursor, Windsurf, etc.).

| Flag | Default | What it does |
|---|---|---|
| `--stdio` | `true` | Use stdio transport (default). |
| `--tools <set>` | `full` | Which tools to offer: `read` (looks only; sends, starts and changes nothing) or `full`. A tool outside the set is refused. |
| `-c, --cwd <cwd>` | current folder | Working directory. |

Every call to the node carries `Authorization: Bearer <token>`, taken from `AGENTX_TOKEN`, then `MESH_TOKEN`, then `dashboard.token`. Without `AGENTX_DAEMON_URL` or `node.bind`, the node is `http://localhost:18800`. Setup for each editor: [Use AgentX from your code editor](/jobs/connect-an-editor).

## token

`agentx token`: Scoped API tokens for external access (mesh peers, integrations).

### `agentx token create`

Mint a new token — prints the secret once, store it somewhere safe.

| Flag | Default | What it does |
|---|---|---|
| `--name <name>` | required | Human-readable label (e.g. 'Slack integration'). |
| `--scope <scopes>` | `dashboard:read` | Comma-separated scopes (default: dashboard:read). |
| `--expires <days>` | — | Expire after N days (default: no expiry). |

### `agentx token list`

Show all issued tokens (secrets not included).

No flags.

### `agentx token revoke <id>`

Immediately invalidate a token.

No flags.

## config

`agentx config`: Validate and inspect configuration.

### `agentx config check`

Validate agentx.json and check all workspaces.

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |

### `agentx config show`

Print the resolved configuration.

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |

### `agentx config get <path>`

Read a config value by dot-path (e.g. agents.helper.model).

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |
| `--raw` | — | Show ${VAR} tokens instead of env-expanded values. |
| `--json` | — | Output as JSON (for scripting). |

### `agentx config set <path> <value>`

Write a config value by dot-path; validates against schema and hot-reloads the daemon.

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |
| `--string` | — | Treat the value as a literal string (skip JSON parsing). |
| `--dry-run` | — | Validate and diff without writing. |

### `agentx config unset <path>`

Remove a config value by dot-path (validates + hot-reloads).

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |
| `--dry-run` | — | Validate without writing. |

### `agentx config governance`

Show resolved governance flags (read-only; flags read once at startup).

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Path to agentx.json. |
| `--json` | — | Emit JSON. |

## completion

`agentx completion`: Generate a shell completion script for agentx.

| Flag | Default | What it does |
|---|---|---|
| `-s, --shell <shell>` | `zsh` | Shell to generate completion for: zsh\|bash\|fish. |
| `-i, --install` | — | Install the completion script to a default path for the shell. |
| `-o, --output <path>` | — | Write the script to this path (overrides default install path). |
| `-y, --yes` | — | Skip confirmation prompts (non-interactive). |

## contribute

`agentx contribute`: Help you file a clear AgentX issue — check the model, find duplicates, build a pre-filled form link. See [Contribute to AgentX](../guides/contribute.md).

### `agentx contribute check-model <model>`

Check whether a model is on the recommended list (contrib/models.json).

| Flag | Default | What it does |
|---|---|---|
| `--models <pathOrUrl>` | the list on GitHub | Model list to read. |

### `agentx contribute search <words...>`

List open issues that match, most-voted first — check for duplicates before drafting.

### `agentx contribute draft <file>`

Turn a draft JSON file ({category, title, fields}) into a pre-filled issue form link; '-' reads stdin.

| Flag | Default | What it does |
|---|---|---|
| `--model <model>` | **required** | The model that wrote the draft. |
| `--models <pathOrUrl>` | the list on GitHub | Model list to read. |

## wiki (advanced)

`agentx wiki`: Wiki knowledge base management. **Advanced.**

### `agentx wiki status`

Show wiki status per agent. For each agent it counts the raw entries an article cites, the entries absorb has read but did not cite, and the entries still waiting (unabsorbed). When entries are waiting, the last line gives the total and tells you to run `agentx wiki absorb`.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--mode <mode>` | `graph` | Graph (default, canonical) \| unified \| flat (legacy, back-compat). |

### `agentx wiki lint`

Check wiki for issues per agent.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--mode <mode>` | `graph` | Graph (default, canonical) \| unified \| flat (legacy, back-compat). |
| `--agent <id>` | — | Lint a specific agent's wiki. |

### `agentx wiki absorb`

Compile unabsorbed entries into typed per-agent wiki articles.

When a run succeeds, every entry it read is recorded in `agents/<id>/_absorbed.json` under the wiki directory, including entries no article cites, so the next run moves on to new entries. When a run fails, nothing is recorded and the same entries are offered again.

Before it writes, absorb looks for the articles the entries are already about, using the same search as `agentx wiki query` (a word match against the catalog, the wiki-rerank seat when it is on, then one hop along each article's links). It gives the model those articles in full and asks it to update them rather than write new ones. The run prints them on an `Existing:` line.

Absorb then protects those articles in two ways:

- **No duplicates.** A new article whose title matches an existing one is written over the existing article. The run prints `~ <new path> → <existing path>`.
- **No lost facts.** An update that leaves out a commit hash, a web link, a `[[wikilink]]` or a number (a count, an amount, a date) from the old article is refused. The run prints `! refused <path>` and the facts that were missing. The old article stays as it was, and the entries behind it stay queued for the next run.

When an update is saved, the article keeps its creation date, its access setting and the entries it already cited.

Without `--agent`, absorb only compiles the agents in this node's `agentx.json`. It also skips an agent whose `wiki.absorb.enabled` is `false` (it prints `absorb is off for this agent`). Naming the agent with `--agent` absorbs it anyway. An agent that runs on another node is absorbed there, and its articles reach this node through `agentx wiki sync --articles`. Absorb skips an agent whose articles were copied that way.

Absorb, `wiki query`, `wiki lint` and the patch commands call the `claude` CLI (absorb uses Sonnet unless `--model` or `AGENTX_WIKI_ABSORB_MODEL` names another model). They look for it on your PATH and also in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, so they work from the daemon and from the `agentx_wiki_query` tool without a login shell's PATH.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--mode <mode>` | `graph` | Graph (default, canonical) \| unified \| flat (legacy, back-compat). |
| `--agent <id>` | — | Absorb only this agent. |
| `--dry-run` | — | Preview without running. |
| `--no-facts` | — | Skip the system-of-record lookups. |
| `--max <n>` | `10` | Max entries per agent. |
| `--since <date>` | — | Only entries dated on or after YYYY-MM-DD. |
| `--until <date>` | — | Only entries dated on or before YYYY-MM-DD. |
| `--model <model>` | `AGENTX_WIKI_ABSORB_MODEL`, else `sonnet` | The model that compiles the articles. |
| `--run-label <label>` | — | A name for this run in the run log, so `agentx wiki absorb-runs` can compare runs. |
| `--no-notes` | — | Do not read the wiki notes inbox, even for the agent set as `wikiNotes.absorbAgent`. |

When wiki notes are on and `wikiNotes.absorbAgent` names the agent being absorbed, absorb also reads the waiting [wiki notes](/jobs/wiki-notes). It runs even with no new entries when notes are waiting. The model answers each note as patched, rejected or deferred. A patch is a short find-and-replace in an existing article that absorb showed the model in full: absorb applies it, and refuses one whose edits together replace most of a page, remove a contact, role or organisation value, or delete a number, link or commit. A note's edits are saved all together or not at all. A note whose patch is refused, or that the model did not answer, is deferred. While notes are in the prompt, absorb saves only articles that cite an entry from this run, so a note never creates or rewrites a page. Each outcome is recorded on the note with a reason and the run id (`absorb/<agent>/<time>`). If a schedule answered the note while absorb was running, that answer stands. When the run fails, its notes stay waiting. A dry run lists the notes in the order a real run would take them.

When any model call in the run fails (the `claude` CLI cannot be run, it reports an error, or its answer cannot be read), absorb prints how many failed and exits with code 1. Their entries stay queued for the next run. A schedule that runs absorb as a command (`crons.<id>.command`) therefore records the run as failed and follows its `onError` setting.

Every run that is not a dry run adds lines to `_absorb-runs.jsonl` in the wiki directory: one per model call (agent, entries, articles written and refused, time before and during the call, cost and tokens as the `claude` CLI reports them, and prompt size split into entries, catalog, articles shown in full, facts and notes; with notes, how many it was given, patched and recorded) and one for the whole run, with how many of its calls failed. The file holds no entry or article text.

### `agentx wiki absorb-eval`

Score what absorb wrote against the entries each article cites. It picks a fixed sample of articles and checks each one:

- **Citations:** does the article cite entries, and does each cited entry exist and share words with the article?
- **Ungrounded facts:** commit hashes, links and numbers in the article that no cited entry and no earlier version of the article contains. These are likely made up or taken from the wrong entry.
- **Lost facts:** commit hashes and links in a cited entry that no article citing that entry contains.
- **Uncited entries:** entries absorb read in the window that no article cites, and how many of them carry a commit hash or link that no article has. Absorb does not offer those entries again.
- **Likely duplicates:** articles of the same type with nearly the same title, or with most of their sources in common.

With `--judge`, a model also reads each sampled article next to its entries and lists claims the entries don't support, claims they contradict, entries about a different subject (a wrong merge) and facts left out. That is one model call per article.

The same `--seed` and window always pick the same articles. `--sample <file>` saves the picked articles the first time and reuses them after, so you can score the same articles again after a change.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--mode <mode>` | `graph` | Graph \| unified \| flat. |
| `--agent <id>` | — | Only this agent's articles. |
| `--since <date>` | — | Only articles last updated on or after YYYY-MM-DD. |
| `--changed-after <time>` | — | Only articles whose file changed after this time, for example `2026-10-07T20:05:00Z`. Use it to score one absorb run. |
| `--n <n>` | `40` | Articles in the sample. |
| `--seed <seed>` | `absorb-eval` | Sample seed. |
| `--sample <file>` | — | Reuse the sample saved in this file, or save it there the first time. |
| `--judge` | — | Also have a model check each article's claims. |
| `--judge-model <model>` | `sonnet` | Model for `--judge`. |
| `--out <file>` | — | Write the scorecard as Markdown to this file. |
| `--json` | — | Print the scorecard and every article's checks as JSON. |

### `agentx wiki absorb-runs`

Show time, cost and throughput of absorb runs from `_absorb-runs.jsonl`, one row per run label: model calls (and how many failed), entries compiled, articles written and refused (and how many entries behind a refused update left the queue anyway because another article cites them), total time, typical and slowest call time, time spent finding articles and looking up facts before the calls, entries per minute, cost and cost per entry.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--label <label>` | — | Only this run label. Runs without a label are listed as `(none)`. |
| `--json` | — | Print the summary as JSON. |

### `agentx wiki promote`

Promote per-agent memories into shared, authoritative wiki articles.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory (default .agentx/wiki). |
| `--memory-dir <path>` | — | The .agentx dir holding agent-memory/ (default .agentx). |
| `--since <duration>` | `7d` | Memory window, e.g. 24h, 7d. |
| `--agent <id>` | — | Only this agent's memories. |
| `--types <list>` | `project,reference,feedback` | Comma-separated memory types. |
| `--max <n>` | `20` | Max candidate memories per run. |
| `--via <agentId>` | — | Route the LLM call through an agent — uses the agent's own session, no API key. |
| `--model <model>` | — | Direct Anthropic API — needs ANTHROPIC_API_KEY. |
| `--daemon <url>` | `http://127.0.0.1:18800` | Daemon API base URL for --via. |
| `--reviews` | — | Also promote findings from session-monitor reviews. |
| `--review-kinds <list>` | `decisions,warnings,friction,context` | Which review kinds. |
| `--commit` | — | Judge and write proposals for review (default: dry-run). |
| `--budget <tokens>` | `60000` | Max estimated tokens for the judge prompt. |

### `agentx wiki proposals`

Review lessons proposed for the shared wiki (list, show, approve, reject).

### `agentx wiki proposals list`

List proposals (pending by default).

| Flag | Default | What it does |
|---|---|---|
| `--all` | — | Include approved and rejected. |
| `--dir <path>` | — | Wiki directory (default .agentx/wiki). |

### `agentx wiki proposals show <id>`

The proposed article and the evidence behind it.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory (default .agentx/wiki). |

### `agentx wiki proposals approve <id>`

Write the proposed article into the shared wiki.

| Flag | Default | What it does |
|---|---|---|
| `--force` | — | Approve even if the article changed since the proposal. |
| `--dir <path>` | — | Wiki directory (default .agentx/wiki). |

### `agentx wiki proposals reject <id>`

Decline a proposal; its sources aren't judged again until they change.

| Flag | Default | What it does |
|---|---|---|
| `--reason <text>` | — | Why, kept with the decision. |
| `--dir <path>` | — | Wiki directory (default .agentx/wiki). |

### `agentx wiki notes`

Notes agents leave for the wiki observe/sweep run: add, list, handle, config. See [Let agents leave notes for the wiki run](/jobs/wiki-notes).

### `agentx wiki notes add`

Leave a note for the wiki observe/sweep run. It goes through this node's daemon, which keeps it when the inbox agent is here and forwards it over the mesh otherwise.

| Flag | Default | What it does |
|---|---|---|
| `--change <text>` | required | What changed, up to 1,000 characters. |
| `--source <text>` | required | Where you saw it: a system, URL, command, or "owner said". |
| `--date <YYYY-MM-DD>` | today | When it changed or when you saw it. |
| `--from <agent>` | the agent running it (`AGENTX_AGENT_ID`) | Your agent id. |
| `--daemon <url>` | `AGENTX_DAEMON_URL`, else `node.bind` in `agentx.json` | This node's daemon. |
| `--dir <path>` | — | Write straight into this wiki directory instead of going through the daemon. Needs `--to`. |
| `--to <agent>` | — | Inbox agent, with `--dir`. |
| `--json` | — | Print JSON. |

### `agentx wiki notes list`

Notes in this node's inbox.

| Flag | Default | What it does |
|---|---|---|
| `--status <status>` | `waiting` | waiting (open and deferred) \| open \| patched \| rejected \| deferred \| expired \| all. |
| `--dir <path>` | — | Wiki directory (default .agentx/wiki). |
| `--json` | — | Print JSON instead of a list. |

### `agentx wiki notes handle <id>`

Record what the run did with a note. A deferred note is given to the next run again, until it has been deferred `wikiNotes.maxDeferrals` times; then it expires. A note a run was given and did not record counts as deferred when the next run starts.

| Flag | Default | What it does |
|---|---|---|
| `--outcome <outcome>` | required | patched \| rejected \| deferred. |
| `--reason <text>` | required | What you patched, why you rejected it, or why it waits. |
| `--run <id>` | — | The run that used it. |
| `--by <agent>` | `operator`, or the agent running it (`AGENTX_AGENT_ID`) | Who handled it. |
| `--dir <path>` | — | Wiki directory (default .agentx/wiki). |

### `agentx wiki notes config`

Show or set the inbox agent, and the schedules and absorb pass that read it (`wikiNotes` in `agentx.json`). With no flag, it prints the current settings.

| Flag | Default | What it does |
|---|---|---|
| `--inbox <agent>` | — | Agent that runs the wiki observe/sweep schedule. `""` clears it. |
| `--cron <ids>` | — | Comma-separated schedule ids that read the inbox. `""` for none. |
| `--absorb <agent>` | — | Agent whose `agentx wiki absorb` pass reads and answers the notes. Must run on this node, the node that keeps the inbox. `""` clears it. |
| `--max <n>` | — | Most notes one run is given (1-100). |
| `--max-deferrals <n>` | — | Times a note may be deferred before it expires (1-20). |
| `--enable` | — | Turn wiki notes on. |
| `--disable` | — | Turn wiki notes off. |
| `--json` | — | Print JSON. |

### `agentx wiki facts`

Facts with a source and a check date: list, show, set, proposals. See [One rule for facts](/jobs/agent-memory#one-rule-for-facts-check-it-or-say-it-s-unverified).

### `agentx wiki facts list`

Every recorded fact, with where and when it was checked.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory (default .agentx/wiki). |
| `--stale` | — | Only facts past their time limit, or never checked (`UNCHECKED`). |
| `--json` | — | Print JSON instead of a list. |

### `agentx wiki facts show <id>`

One fact, with its earlier values.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory (default .agentx/wiki). |

### `agentx wiki facts set`

Record a fact you checked. A different value replaces the current one only with a newer `--checked-at` (and never one a person confirmed), or with `--confirm`; otherwise a question is added to `agentx wiki questions`.

| Flag | Default | What it does |
|---|---|---|
| `--subject <text>` | required | What the fact is about, e.g. "vendor account". |
| `--attribute <text>` | required | Which property, e.g. "billing status". |
| `--value <text>` | required | The value you found. |
| `--source <text>` | required | Where you checked: a system, URL, command, or "owner said". |
| `--by <id>` | `operator`, or the agent running it (`AGENTX_AGENT_ID`) | Who checked it. |
| `--checked-at <iso>` | — | When you checked it: an ISO date, or `now`. Without it the value can't replace a different one already recorded. |
| `--class <class>` | from the wording | billing \| account \| outage \| deploy \| work-state \| stable. |
| `--ttl-days <n>` | from the class | Days it stays trusted. |
| `--confirm` | — | A person confirms this value: replace a newer-dated one. Refused when run by an agent. |
| `--dir <path>` | — | Wiki directory (default .agentx/wiki). |

### `agentx wiki facts proposals`

Claims from conversation summaries, waiting for a check (list, approve, reject).

### `agentx wiki facts proposals list`

Claims waiting for a check (pending by default).

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory (default .agentx/wiki). |
| `--all` | — | Include approved and rejected. |
| `--json` | — | Print JSON instead of a list. |

### `agentx wiki facts proposals approve <id>`

Confirm a claim and record it as a fact. Only a person can approve or reject; both are refused when run by an agent.

| Flag | Default | What it does |
|---|---|---|
| `--subject <text>` | from the claim | Correct the subject. |
| `--attribute <text>` | from the claim | Correct the attribute. |
| `--value <text>` | from the claim | Correct the value. |
| `--source <text>` | the claim's | Where you checked it. |
| `--by <id>` | `operator` | Who confirms it. |
| `--dir <path>` | — | Wiki directory (default .agentx/wiki). |

### `agentx wiki facts proposals reject <id>`

Drop a claim; it is not recorded.

| Flag | Default | What it does |
|---|---|---|
| `--reason <text>` | — | Why, kept with the decision. |
| `--by <id>` | `operator` | Who rejects it. |
| `--dir <path>` | — | Wiki directory (default .agentx/wiki). |

### `agentx wiki ab-test`

Side-by-side comparison: BM25 preload (old) vs agentic query (new) on real task-history messages.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--agent <id>` | — | Which agent to test against (required). |
| `--history <path>` | `.agentx/task-history` | Task-history root. |
| `--n <n>` | `10` | Number of messages to sample (newest first). |
| `--out <path>` | — | Markdown output file (default: stdout). |
| `--selector-model <m>` | `haiku` | Agentic selector model. |
| `--synth-model <m>` | `sonnet` | Agentic synthesis model. |

### `agentx wiki interview`

Interactive interview session — Q&A with an LLM synthesizer, produces one typed wiki article.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--agent <id>` | — | Which agent's wiki to write to (required). |
| `--topic <text>` | — | What to interview about (e.g. 'Globex deployment procedure'). |
| `--type <t>` | — | Article type hint (person\|project\|place\|concept\|event\|decision\|pattern). |
| `--model <m>` | `sonnet` | Synthesis model. |
| `--no-commit` | — | Show the draft but don't write. |
| `--answers <path>` | — | Non-interactive: one answer per line (same order as questions); last line = save\|edit\|scrap. |

### `agentx wiki quiz`

Reverse interview — ask the wiki questions and patch cited articles with corrections, additions, or links.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--agent <id>` | — | Which agent's wiki to quiz (required). |
| `--selector-model <m>` | `haiku` | Candidate-selection model. |
| `--synth-model <m>` | `sonnet` | Answer synthesis model. |
| `--patch-model <m>` | `sonnet` | Article patch model. |
| `--rounds <n>` | `20` | Stop after N rounds. |
| `--script <path>` | — | Non-interactive: question line + /verdict line per entry, entries separated by blank lines. |
| `--no-commit` | — | Show proposed patches but don't write. |
| `--out <path>` | — | Write a session transcript as markdown. |

### `agentx wiki edit <agent> <titleOrPath>`

Open an article in $EDITOR (resolves by title or path), rebuild catalog on exit.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--editor <cmd>` | — | Override $EDITOR for this run. |

### `agentx wiki patch <agent> <titleOrPath> <instruction>`

LLM-patch an article from a free-form instruction; shows diff + confirms before writing.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--patch-model <m>` | `sonnet` | Patch model. |
| `--yes` | — | Skip confirmation and write immediately. |
| `--no-commit` | — | Show the patched body but don't write. |
| `--allow-fact-loss` | — | Save even when the patch shrinks the article or drops a phone number, email, role, link or number it had. |

Before saving, the patch is checked: it is refused, with the reason, when the article gets much shorter, when the result contains the model's own commentary, when a heading appears twice, when it drops a phone number, email, role, "main contact" note, link or number, or when the article changed while the patch was being made. The article's existing related links are kept. See [`wiki patch` refuses to lose facts](/jobs/wiki-contributions#wiki-patch-refuses-to-lose-facts).

### `agentx wiki contribute`

Queue sourced wiki patches from an agent's work since its last run: its chat messages, and its tasks with the tool calls it ran. Each patch adds a fact, corrects a value or creates a short page, and names its source and check date. Nothing is written to the wiki until `agentx wiki contributions merge`. See [Let agents keep the wiki up to date](/jobs/wiki-contributions).

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--agent <id>` | — | Contribute for this agent. |
| `--all` | — | Every agent with `wiki.contribute.enabled` in `agentx.json`. |
| `--since <time>` | the last 24 hours | First run only: read work from this date or time. Later runs start where the last one stopped. |
| `--max-patches <n>` | the agent's `maxPatches`, else `30` | Patches per agent per run. |
| `--max-cost <usd>` | the agent's `maxCostUsd`, else `wiki.contributions.maxCostUsd`, else `0.5` | Model spend per agent per run, in dollars. Each call is also capped at what is left. |
| `--max-items <n>` | `60` | Chat messages and tasks read per agent per run. |
| `--model <model>` | the agent's `model`, else `wiki.contributions.model`, else `AGENTX_WIKI_CONTRIBUTE_MODEL`, else `sonnet` | Model for the contribution call. |
| `--db <path>` | `.agentx/db.sqlite` | Trace database with the agents' tasks. Without it, only chat messages are read. |
| `--dry-run` | — | Show the patches without queueing them or moving the agent's starting point. |
| `--json` | — | Print the batches as JSON. |

### `agentx wiki contribute enable <agent>`

Turn on an agent's daily wiki contribution (`agents.<id>.wiki.contribute.enabled`). The daily jobs `wiki-contribute` and `wiki-contribute-merge` are then added to the schedule.

| Flag | Default | What it does |
|---|---|---|
| `--max-cost <usd>` | — | Model spend per run, in dollars. |
| `--max-patches <n>` | — | Patches per run. |
| `-c, --config <path>` | — | Path to `agentx.json`. |

### `agentx wiki contribute disable <agent>`

Turn off an agent's daily wiki contribution. Takes the same flags as `enable`.

### `agentx wiki contributions`

The daily merge of agents' wiki patches (list, merge, held, approve, reject). On its own it runs `list`.

### `agentx wiki contributions list`

Patches waiting for the merge, and what the last merge did.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--json` | — | Print as JSON. |

### `agentx wiki contributions merge`

Apply every queued patch. Facts go through the fact ledger, so the newest check wins and the older value stays in its history and on the page as "previously". A patch older than the wiki's value raises a question instead. Several new pages for the same subject become one page, and a new page whose title closely matches an existing one is held as a possible duplicate. A patch that removes a fact, or a change that would lose one, is held. Subjects with more than one page are listed.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--dry-run` | — | Show what would change without writing. |
| `--json` | — | Print the report as JSON. |

### `agentx wiki contributions held`

Patches the merge held for a person, with the reason and the facts the change would lose.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--all` | — | Include approved and rejected. |
| `--json` | — | Print as JSON. |

### `agentx wiki contributions approve <id>`

Apply a held patch as it is. The page's previous version is kept in its history.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |

### `agentx wiki contributions reject <id>`

Drop a held patch.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |

### `agentx wiki curate <agent> <titleOrPath> <instruction>`

Ask the page curator to research and edit one page, as the chat button on the page does. Needs the daemon. Prints the reply, the changed lines and the sources. See [Wiki › Ask an agent to curate a page](../dashboard/wiki.md#ask-an-agent-to-curate-a-page).

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--timeout <minutes>` | `30` | Stop waiting after this long. The change is still written when the agent finishes. |

### `agentx wiki versions <agent> <titleOrPath>`

List the saved earlier versions of one page, newest first.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |

### `agentx wiki restore <agent> <titleOrPath> [version]`

Put a page back to an earlier version. Without a version, the newest is used. The current text is kept as a version first.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |

### `agentx wiki curator`

Show or change the page curator: the chat button on wiki pages (`wiki.curator` in `agentx.json`).

| Flag | Default | What it does |
|---|---|---|
| `--on` | — | Show the button on wiki pages. |
| `--off` | — | Hide the button and refuse curator requests. |
| `--agent <id>` | — | Let this agent answer on every page. |
| `--owner` | — | Let each page's owner agent answer (the default). |

### `agentx wiki prune`

Collapse legacy flat/unified mode dirs into graph/ (dedup by title; losers archived).

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--agent <id>` | — | Prune only this agent's wiki. |
| `--commit` | — | Execute moves + archives (default: dry-run). |

### `agentx wiki migrate`

Backfill type + related on legacy articles (one-shot).

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--agent <id>` | — | Migrate only this agent's articles. |
| `--commit` | — | Write changes (default: dry-run, reports what would change). |
| `--batch <n>` | `10` | Articles per LLM call. |
| `--max <n>` | — | Cap articles this run (for spot-checks). |
| `--model <m>` | `sonnet` | Classifier model. |

### `agentx wiki entries`

List raw entries.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--agent <id>` | — | Filter by agent. |

### `agentx wiki ontology`

The wiki's pillars, types, typed relations, event importance and page lenses. See [Wiki](../dashboard/wiki.md).

| Command | What it does |
|---|---|
| `agentx wiki ontology init` | Write the defaults to `ontology.yaml` in the wiki folder, to edit. Refuses to overwrite. |
| `agentx wiki ontology check` | Report problems in `ontology.yaml`. Exits 1 when there are any. |
| `agentx wiki ontology show` | Pages per pillar and type. `--json` prints JSON. |

Each takes `--dir <path>` (default `.agentx/wiki`).

### `agentx wiki enrich [entities...]`

Write a full overview, sourced typed facts and History links on entity pages: people, organizations, projects, places and assets. With no titles, it does every entity of `--types` that changed since the last run. One model call per entity. See [Bring entity pages up to a full story](/jobs/wiki-enrich).

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | `.agentx/wiki` | Wiki directory. |
| `--types <list>` | `person,organization,project,place,device,server,app,domain,account` | Entity types to do. |
| `--max <n>` | `10` | Most entities per run (a whole number, 1 or more). |
| `--max-cost <usd>` | `1` | Stop before the next call once the run has spent this much. |
| `--model <m>` | `sonnet` | Model. |
| `--force` | — | Redo entities whose sources did not change. |
| `--dry-run` | — | Show what would be written; write nothing. |
| `--create <title>` | — | First create a page for a thing other pages only name. Needs `--as <type>` and `--owner <agent>`. |
| `--json` | — | Print the run as JSON. |

### `agentx wiki events`

Give each event page an importance level (minor, normal or major) and the pages it is about, so it shows in their History. The rules under `importance.rules` in `ontology.yaml` decide first, with no model call. The other events go to a model in batches. Events that already have a level are skipped. See [Sort wiki events by importance](/jobs/wiki-events).

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | `.agentx/wiki` | Wiki directory. |
| `--about <titles...>` | — | Only events linked to or naming these pages. Prints each page's History before and after. |
| `--max <n>` | `200` | Most events per run (a whole number, 1 or more). |
| `--batch <n>` | `20` | Events per model call. |
| `--max-cost <usd>` | `1` | Stop before the next call once the run has spent this much. |
| `--model <m>` | `haiku` | Model. |
| `--rules-only` | — | Use only the importance rules; make no model call. |
| `--force` | — | Redo events whose level this job set earlier. A level you set yourself is never redone. |
| `--dry-run` | — | Show what would be written; write nothing. |
| `--json` | — | Print the run as JSON. |

| Subcommand | What it does |
|---|---|
| `agentx wiki events set <title> <level>` | Set an event's level yourself. No later run changes it. |
| `agentx wiki events proposed` | List events a run suggests as major, waiting for you. `--json` prints JSON. |

### `agentx wiki serve`

Start a local web server to browse the wiki by pillar and type, and each agent's pages under `/agents` (local + mesh).

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--mode <mode>` | `graph` | Graph (default, canonical) \| unified \| flat (legacy, back-compat). |
| `--agent <id>` | — | Serve only this agent's wiki. |
| `--port <n>` | `4200` | Port number. |
| `--peer <urls...>` | — | Mesh peer URLs to federate. |

### `agentx wiki grade`

Grade absorbed articles with the article-quality seat.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--mode <mode>` | `graph` | Graph \| unified \| flat. |
| `--agent <id>` | — | Grade only this agent's wiki. |
| `--limit <n>` | `20` | Articles to grade. |
| `--min <n>` | `3` | Only show articles scoring below this. |
| `--fields` | — | Also check the required fields for each article's type. |
| `--type <t>` | — | Grade only articles of this type (person, place, project, …). |
| `--json` | — | Print JSON instead of a table. |

### `agentx wiki query <question>`

Answer a question from the wiki. Once at least 80% of the agent's own pages have a summary (`agentx wiki summarize`), it picks up to 3 pages from their one-line summaries, reads the live state of what they name from the sources in `wiki.query.live.sources`, and answers from both; the lines it read are printed under **Read live at the source**. Until then it picks from page titles and walks the links between pages. See [Get wiki answers checked at the source](/jobs/wiki-live-answers).

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--agent <id>` | the calling agent (`AGENTX_AGENT_ID`), else the first one with a catalog | Which agent's wiki to search first. |
| `--method <m>` | `wiki.query.method` (`auto`) | How pages are picked: `auto`, `summaries` or `catalog`. |
| `--no-live` | — | Skip the live read of the summaries method. |
| `--linked <n>` | `wiki.query.linkedPages` (`0`) | Also open up to `n` pages that the picked pages link to (summaries method). |
| `--no-notes` | — | Leave the agent's own notes out when `wiki.query.notes.enabled` is on. |
| `--selector-model <m>` | `haiku` | Model that picks the pages. Overrides `wiki.query.navigatorModel`. |
| `--synth-model <m>` | `sonnet` | Model that writes the answer. Overrides `wiki.query.answerModel`. |
| `--max-candidates <n>` | `3` | Candidates from selector (catalog method). |
| `--max-hops <n>` | `2` | Wikilink hops from candidates (catalog method). |
| `--max-articles <n>` | `8` | Cap on total articles walked (catalog method). |
| `--json` | — | Emit full result as JSON (for A/B harnesses). |
| `--trace` | — | Print the method, the live reads asked and answered, and the time of each step. |
| `--own-only` | — | Search only the agent's own articles, not the shared wiki. |

Besides the agent's own articles, the query reads other agents' articles the agent may see (public, or shared with it) and the shared lessons. Their paths show as `@<agent>/<path>`. The answer names the agent and date of the page it used and prefers the newer page when two disagree. The agent's own pages are walked first and other agents' pages take at most half of `--max-articles` (slots the agent's own pages leave empty go to them); each picked page also opens up to 3 of the newest pages that link to it by its title or an alias. `wiki.query.shared: false` in `agentx.json` turns this off for every query. The half-of-`--max-articles` rule and the linking pages belong to the catalog method; the summaries method shows the picking model `wiki.query.sharedCandidates` of other agents' pages beside the agent's own. With `wiki.query.notes.enabled`, the summaries method also searches the agent's own notes; a note it used is cited with the type `note` and a `note:` path. See [Search the agent's own notes](/jobs/wiki-live-answers#search-the-agent-s-own-notes).

When the query cannot run, the command exits with code 1: the model call failed (status `error`) or no agent has a catalog yet (status `no-catalog`). A question the wiki has no page for (status `no-candidates`) is not a failure and exits 0. Each query adds one line to `_query-runs.jsonl` in the wiki directory: the time, the agent, the status, how the pages were picked, where the query came from and how long it took. Queries an agent makes with the `agentx_wiki_query` tool are written to the same file, marked `tool`; queries from this command are marked `cli`. A query that stops with an unexpected error is written with status `error`. The file holds no question, answer or error text. Once it passes 1 MB, the oldest lines are removed so that about 500 KB of the newest remain. `agentx wiki query-runs` counts them.

### `agentx wiki query-runs`

Count the queries recorded in `_query-runs.jsonl`: how many ran, how many failed (status `error` or `no-catalog`), how many ended in each status, how many came from this command (`cli`) and how many from the agents' `agentx_wiki_query` tool (`tool`), and the typical (p50) and slowest (p95) time. Only the newest queries are kept (about 500 KB of lines, once the file passes 1 MB), so a count over a long period may start later than you asked for.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--since <date>` | — | Only queries on or after this date or time, for example `2026-10-09` or `2026-10-09T08:00:00Z`. |
| `--json` | — | Print the counts as JSON. |

### `agentx wiki summarize`

Write the one-line page summaries `agentx wiki query` picks pages from. Only pages with no summary, or whose text changed since it was written, are summarised; the line of a page that is gone is removed. The lines are saved in `_summaries.json` beside each agent's pages, and no page is edited. See [Get wiki answers checked at the source](/jobs/wiki-live-answers).

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | `.agentx/wiki` | Wiki directory. |
| `--agent <id>` | the calling agent (`AGENTX_AGENT_ID`) | Summarise this agent's pages. |
| `--all` | — | Summarise every agent's pages and the shared pages. |
| `--model <m>` | `wiki.summaries.model` (`haiku`) | Model. |
| `--batch <n>` | `wiki.summaries.batchSize` (`20`) | Pages per model call. |
| `--workers <n>` | `4` | Model calls running at once. |
| `--limit <n>` | `0` | Most pages to summarise per agent in this run. `0` is all. |
| `--dry-run` | — | Show how many pages are due; call no model, write nothing. |
| `--json` | — | Print the run as JSON. |

### `agentx wiki score`

Score the wiki's answers to a question set, or compare two saved scores. A question file is a JSON array or one JSON object per line: `{"id": "q1", "question": "…", "expect": ["fact", "…"]}`. Each answer scores the share of its expected facts it contains (case and spacing ignored; a fact of five or more digits also matches on its digits; `"a|b"` accepts either spelling). A report also records the settings of the run, and how long each question took and what it cost (cost for the summaries method only). `--compare` prints the time and cost per question of both runs and the settings that differ, and warns when more than one setting differs or the question sets differ. See [Measure the difference](/jobs/wiki-contributions#measure-the-difference).

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--questions <file>` | — | The question set. Required unless `--compare`. |
| `--agent <id>` | the calling agent | Ask as this agent. |
| `--own-only` | — | Search only the agent's own articles. |
| `--out <file>` | — | Save the report as JSON. |
| `--compare <files...>` | — | Compare two saved reports: `before.json after.json`. |
| `--method <m>` | `wiki.query.method` (`auto`) | How pages are picked: `auto`, `summaries` or `catalog`. |
| `--no-live` | — | Skip the live read of the summaries method. |
| `--linked <n>` | `wiki.query.linkedPages` (`0`) | Also open up to `n` pages that the picked pages link to (summaries method). |
| `--no-notes` | — | Leave the agent's own notes out, to measure what they add. |
| `--selector-model <m>` | `haiku` | Candidate-selection model. |
| `--synth-model <m>` | `sonnet` | Synthesis model. |
| `--json` | — | Print the report as JSON. |

### `agentx wiki search <query>`

Search wiki articles.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--mode <mode>` | `graph` | Graph (default, canonical) \| unified \| flat (legacy, back-compat). |
| `--agent <id>` | — | Search specific agent's wiki. |

### `agentx wiki backfill-graphpath`

Populate graphPath on existing articles by looking up source-entry classifications.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--agent <id>` | — | Backfill only this agent. |
| `--dry-run` | — | Preview without writing. |

### `agentx wiki sync`

Pull raw entries from mesh peers into local wiki. With `--articles`, copy the articles of the agents that run on each peer instead, so this node can query them.

Copied articles are read-only on this node: `wiki absorb` skips the agent, and `wiki patch`, `wiki edit`, `wiki interview` and `wiki quiz` refuse to change it. Change them on the node that runs the agent, then sync again. Agents listed in this node's `agentx.json` are never copied over. An article whose last-updated date matches the local copy is not downloaded again, and a copied article the peer no longer has is deleted. A dry run does not count those deletions.

The command sends the peer's token from `mesh.peers` in `agentx.json`. Peers ask for it on their `/wiki/*` routes; a request from the same machine needs no token.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--peer <url>` | — | Sync from a specific peer URL (e.g., `http://peer.example.com:19900`). |
| `--articles` | — | Copy the articles of agents this node does not run, instead of raw entries. |
| `--dry-run` | — | Show what would be synced without writing. |

To copy a peer's articles:

1. In a terminal on this node, go to the folder that holds `agentx.json`.
2. Preview the copy: `agentx wiki sync --articles --dry-run`. Each peer agent is listed with how many articles it would copy.
3. Run it: `agentx wiki sync --articles`.
4. Query a copied agent: `agentx wiki query "your question" --agent <peer-agent-id>`.

### `agentx wiki compare`

Compare all wiki compilation modes for an agent.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--agent <id>` | required | Agent to compare. |

### `agentx wiki export [output]`

Export the entire wiki tree to a .tar.gz.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory to archive (default: .agentx/wiki). |
| `--include-raw` | — | Also include raw entries (.agentx/wiki/raw/) — bigger archive. |

### `agentx wiki gaps`

What each article still needs, most load-bearing first.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--mode <mode>` | `graph` | Graph \| unified \| flat. |
| `--agent <id>` | — | Only this agent's wiki. |
| `--type <t>` | — | Only articles of this type. |
| `--max-tier <tier>` | `pillar` | Stop at this layer: foundation\|pillar\|walls\|openings\|furniture. |
| `--limit <n>` | `40` | Articles to check. |
| `--auto` | — | Only gaps a system of record can close without asking anyone. |
| `--ask` | — | Queue the gaps that need a person onto the questions list. |
| `--notify` | — | Push the load-bearing ones to notifications.destination. |
| `--notify-tier <tier>` | `pillar` | Tier at or above which to push. |
| `--unclear` | — | Include fields the grader was unsure about. |
| `--json` | — | Print JSON instead of a table. |

### `agentx wiki backfill`

Write resolved identifiers into articles that are missing them.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--mode <mode>` | `graph` | Graph \| unified \| flat. |
| `--agent <id>` | — | Only this agent's wiki. |
| `--limit <n>` | `40` | Articles to consider. |
| `--apply` | — | Write the changes (default: show them only). |
| `--json` | — | Print JSON instead of a table. |

### `agentx wiki questions`

Gaps waiting on a person.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--status <s>` | `open` | Open \| answered \| dismissed. |
| `--json` | — | Print JSON instead of a table. |

### `agentx wiki answer <id> [value]`

Answer a queued question; writes it into the article. For a disagreement between facts, the value is the true one and replaces the fact.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--mode <mode>` | `graph` | Graph \| unified \| flat. |
| `--dismiss` | — | Close the question without answering it. |

### `agentx wiki triage-backtest`

Grade the entry-triage gate against what absorb actually kept.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--n <n>` | `200` | Entries to sample (half positive, half negative). |
| `--min-worth <n>` | — | P(useful in six months) required to keep. |
| `--min-durability <n>` | — | Expected durability required to keep. |
| `--min-type <n>` | — | Type confidence required to keep. |
| `--sweep` | — | Search thresholds for the most filtering that still keeps ~all positives. |
| `--min-recall <n>` | `0.95` | Recall floor for --sweep. |
| `--save <file>` | — | Write the graded outcomes so sweeps can be re-run for free. |
| `--load <file>` | — | Re-sweep saved outcomes without paying for the calls again. |
| `--json` | — | Print JSON instead of a table. |

### `agentx wiki import <archive>`

Restore a wiki archive (created with `agentx wiki export`).

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Where to restore (default: .agentx/wiki). |
| `--force` | — | Overwrite existing wiki without prompting. |

## graph (advanced)

`agentx graph`: Intent knowledge graph — review, inspect, manage. **Advanced.**

### `agentx graph review`

Triage pending classifications via the configured review agent (the agent uses `wiki query` for context before deciding).

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | Override the review agent (defaults to graph.reviewAgent or graph.draftAgent). |
| `--max <n>` | `20` | Cap reviews this run. |
| `--dry-run` | — | Show the agent's decision but don't apply approvals/rejections. |
| `--daemon-url <url>` | — | Daemon URL (default: `http://localhost:18800`). |

### `agentx graph migrate`

Remap past classifications from v1 (scope/location/org/unit/activity) to v2 (category/verb) via keyword heuristics. No LLM calls. Idempotent.

| Flag | Default | What it does |
|---|---|---|
| `--dry-run` | — | Report what would change, don't write. |

### `agentx graph pull`

Pull schema + nodes + approved classifications from a peer's graph.

| Flag | Default | What it does |
|---|---|---|
| `--from <url>` | required | Peer daemon URL (e.g. `http://peer.example.com:19900`). |
| `--token <t>` | — | Bearer token for the peer (if it requires auth). |
| `--limit <n>` | `500` | Max approved classifications to pull. |
| `--dry-run` | — | Show what would change, don't write. |

### `agentx graph label`

Human verdicts on classifications — the labels calibration needs.

### `agentx graph label next`

What to check next, spread across the confidence range.

| Flag | Default | What it does |
|---|---|---|
| `--n <n>` | `10` | How many. |
| `--strategy <s>` | `stratified` | Stratified \| uncertain. |
| `--json` | — | Print JSON instead of a table. |

### `agentx graph label mark <hash> <verdict>`

Record a verdict: correct \| wrong \| unsure.

| Flag | Default | What it does |
|---|---|---|
| `--path <p>` | — | For `wrong`: the path it should have been, slash-separated. |
| `--note <t>` | — | Why, when it is worth remembering. |
| `--by <who>` | `operator` | Reviewer. |

### `agentx graph label stats`

How many labels so far, and what they say.

| Flag | Default | What it does |
|---|---|---|
| `--json` | — | Print JSON instead of a table. |

## memory (advanced)

`agentx memory`: Audit + edit agent-memory (per-agent experiential notes). **Advanced.**

### `agentx memory add`

Add a memory for an agent.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | required | Agent id. |
| `--type <type>` | required | One of: user, feedback, project, reference. |
| `--name <slug>` | required | Short slug, unique per agent (e.g. deep-backend). |
| `--description <line>` | required | One-line hook shown in MEMORY.md. |
| `--body <text>` | — | Memory body (markdown); repeat --body or use --file. |
| `--file <path>` | — | Read body from a file (use '-' for stdin). |

### `agentx memory list`

List memories for an agent.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | required | Agent id. |
| `--type <type>` | — | Filter by memory type. |

### `agentx memory show <name>`

Print the full body of a memory.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | required | Agent id. |

### `agentx memory remove <name>`

Remove a memory.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | required | Agent id. |

### `agentx memory check`

List an agent's notes and whether each has a `source` and a `checked` date in its header. Read only. See [Check which notes say where and when they were checked](/jobs/agent-memory#_10-check-which-notes-say-where-and-when-they-were-checked).

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | required | Agent id. |
| `--dir <path>` | the AgentX store, `.agentx/agent-memory/<id>/` | Read notes from this folder instead, such as the one a `claude-code` agent keeps. |
| `--missing` | — | List only notes missing a source or a check date. |
| `--json` | — | Print the result as JSON. |

### `agentx memory index`

Print the MEMORY.md index content an agent sees in its prompt.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | required | Agent id. |

### `agentx memory facts`

Review facts extracted from conversations (held, approve, reject, scrub).

### `agentx memory facts summary`

Count facts per agent by source trust and review state.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | One agent (default: all). |

### `agentx memory facts held`

List facts waiting for review before they are used.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | One agent (default: all). |

### `agentx memory facts approve <id>`

Let a held fact be used in prompts.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | required | Agent id. |

### `agentx memory facts reject <id>`

Keep a held fact out of prompts for good.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | required | Agent id. |

### `agentx memory facts scrub`

Find stored facts that contain credentials; --apply deletes them.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | One agent (default: all). |
| `--apply` | — | Delete them (default: count only). |

### `agentx memory facts flag-unsourced`

Mark facts about billing, accounts, outages or deploys that name no source as unverified; --apply writes (with a backup in `.agentx/memory/_backup/`); stop the daemon first. Running it again changes nothing.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | One agent (default: all). |
| `--apply` | — | Flag them (default: list only). |

## procedure (advanced)

`agentx procedure`: Procedures (SOPs) — extract from activity, review drafts, match, schedule. **Advanced.**

### `agentx procedure extract`

Mine recurring user activity into procedure drafts (dry-run by default).

| Flag | Default | What it does |
|---|---|---|
| `--path <path>` | `.agentx/db.sqlite` | SQLite db path. |
| `--since <duration>` | `7d` | Activity window, e.g. 24h, 7d, or ms epoch. |
| `--agent <id>` | — | Only mine one agent's activity. |
| `--min-occurrences <n>` | `3` | Recurrences before a pattern becomes a draft. |
| `--max <n>` | `5` | Max clusters distilled per run. |
| `--via <agentId>` | — | Route the LLM call through a running agent — uses the agent's own session. |
| `--model <model>` | — | Direct Anthropic API model — needs ANTHROPIC_API_KEY. |
| `--daemon <url>` | `http://127.0.0.1:18800` | Daemon API base URL for --via. |
| `--commit` | — | Write drafts and persist recurrence counts. |

### `agentx procedure watch`

Set the extraction cadence: registers the cron + config the daemon runs on.

| Flag | Default | What it does |
|---|---|---|
| `--hourly` | — | Extract every hour. |
| `--daily` | — | Extract daily at 03:00. |
| `--cron <expr>` | — | Custom 5-field cron expression. |
| `--on-task` | — | Also count patterns live after each completed task. |
| `--off` | — | Disable scheduled extraction. |
| `--via <agentId>` | — | Agent that runs the extraction (LLM distillation goes through its session). |
| `--min-occurrences <n>` | `3` | Recurrences before a pattern becomes a draft. |
| `--timezone <tz>` | `Africa/Tunis` | IANA timezone (default: this machine's). |
| `-c, --config <path>` | — | Path to agentx.json. |
| `--dry-run` | — | Print what would be written without writing. |

### `agentx procedure list`

List procedures with their trigger line.

| Flag | Default | What it does |
|---|---|---|
| `--drafts` | — | List unreviewed drafts instead. |
| `--all` | — | List active procedures and drafts. |

### `agentx procedure add`

Add a new procedure (non-interactive; pass all fields as flags).

| Flag | Default | What it does |
|---|---|---|
| `--id <id>` | required | Procedure id (lower-kebab, e.g. deploy-peer). |
| `--title <t>` | required | Human-readable title. |
| `--trigger <t>` | required | When this procedure applies (one sentence). |
| `--input <i...>` | — | Required input (repeatable). |
| `--expected <t>` | — | Expected output / success criterion. |
| `--kpi <k...>` | — | KPI (repeatable). |
| `--owner <id>` | — | Owning agent or person. |
| `--tag <t...>` | — | Tag (repeatable). |
| `--related <r...>` | — | Related procedure id or wiki article title (repeatable). |
| `--steps <md>` | — | Markdown body — usually numbered steps. |

### `agentx procedure show <id>`

Show a single procedure (active or draft).

No flags.

### `agentx procedure promote <id>`

Promote a draft into the active procedure set.

No flags.

### `agentx procedure reject <id>`

Reject a draft (kept under _drafts/_rejected/ so it is never re-mined).

No flags.

### `agentx procedure deprecate <id>`

Retire an active procedure (kept, but never surfaced to agents).

No flags.

### `agentx procedure match <text>`

Find active procedures matching a task description.

| Flag | Default | What it does |
|---|---|---|
| `--limit <n>` | `3` | Max matches. |
| `--min-score <s>` | `0.2` | Minimum score 0..1. |

## references (advanced)

`agentx references`: Manage the deterministic references registry — facts cited by skills and resolved into agent context. **Advanced.**

### `agentx references init <namespace>`

Scaffold .agentx/references/&lt;namespace&gt;/ from the example template (operator-private).

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `--force` | — | Overwrite existing files. |

### `agentx references discover <namespace>`

Scan installed skills and write detected facts to .agentx/references/&lt;namespace&gt;/.

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Where to scan for skills. |
| `--references-cwd <cwd>` | — | Where to WRITE the YAML files (defaults to --cwd; useful when skills live under ~/.claude and references live in the agentx repo). |
| `--from <skills>` | — | Comma-separated skill name/tag substrings to filter by (default: namespace itself). |
| `--gitlab-host <url>` | — | Validate project URLs against this host (e.g. `https://gitlab.example.com`). |
| `--write` | — | Write the YAML files (default: dry-run preview). |
| `--force` | — | Overwrite existing files when --write is set. |

### `agentx references list`

List every loaded reference (debug).

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `--json` | — | Emit JSON. |

## rag (advanced)

`agentx rag`: Manage per-agent lexical (BM25) RAG indexes. **Advanced.**

### `agentx rag add <agentId> <globs...>`

Build or refresh an agent's lexical index from one or more globs.

| Flag | Default | What it does |
|---|---|---|
| `-v, --verbose` | — | Log each indexed file. |

### `agentx rag list`

List every agent's index, sizes, paths.

| Flag | Default | What it does |
|---|---|---|
| `-c, --cwd <path>` | current folder | Search root. |

### `agentx rag search <agentId> <query>`

Query an agent's index — useful for debugging recall before the agent calls rag.lexical.

| Flag | Default | What it does |
|---|---|---|
| `-k, --k <n>` | `5` | Top-k results. |
| `--json` | — | Emit JSON. |

### `agentx rag clear <agentId>`

Delete an agent's index.

No flags.

## workflow (advanced)

`agentx workflow`: Workflow definitions — list, show, validate, manage runs. **Advanced.**

### `agentx workflow list`

List all workflows with their trigger + state count.

No flags.

### `agentx workflow show <id>`

Show a single workflow's full definition.

| Flag | Default | What it does |
|---|---|---|
| `--format <fmt>` | `json` | Output format: json (default) or yaml. |

### `agentx workflow validate [file]`

Validate all workflows in .agentx/workflows (or a single file).

No flags.

### `agentx workflow init <id>`

Scaffold a new workflow YAML from a template (linear by default).

| Flag | Default | What it does |
|---|---|---|
| `--template <name>` | `linear` | Which template to use (linear \| branching \| extract \| retry \| release-follow-up). `release-follow-up` puts a release live, checks it and tells the client after your approval: [use the release template](../jobs/follow-up-workflows.md#use-the-release-template). |
| `--agent <id>` | `default` | Fill the agent placeholder with this agent id. |
| `--reviewer <id>` | `alice` | Fill the reviewer placeholder for human-in-the-loop templates. |
| `--title <text>` | `` | Workflow title. |
| `--json` | — | Scaffold as .json instead of .yaml. |
| `--force` | — | Overwrite an existing workflow with the same id. |

### `agentx workflow templates`

List the available workflow templates for `init`.

No flags.

### `agentx workflow add <file>`

Import a YAML/JSON workflow file into .agentx/workflows and hot-reload.

| Flag | Default | What it does |
|---|---|---|
| `--daemon <url>` | `http://127.0.0.1:18800` | Daemon API base URL. |
| `--no-reload` | — | Skip the POST /reload after writing. |

### `agentx workflow runs [id]`

List recent runs (optionally filtered to a single workflow).

| Flag | Default | What it does |
|---|---|---|
| `--limit <n>` | `20` | Max runs to show. |
| `--node <id>` | — | Home-node id for this daemon (defaults to WF_NODE_ID env or "local"). |

### `agentx workflow run <id-or-file>`

Manually trigger a workflow by id, or load + register + run a YAML/JSON file.

| Flag | Default | What it does |
|---|---|---|
| `--input <json>` | — | JSON object merged into the trigger event payload. |
| `--force` | — | Fire even if the trigger isn't `trigger.manual` (uses a synthesized event). |
| `--watch` | — | Tail per-step traces while the run executes. |
| `--daemon <url>` | `http://127.0.0.1:18800` | Daemon API base URL. |
| `--follow` | — | Follow it to the end: reminders, nudges and one summary for you when it ends. See [Let a workflow follow a request](../jobs/follow-up-workflows.md). |
| `--title <text>` | — | With `--follow`: what this run is for, in a few words. |
| `--tag <kind:name...>` | — | With `--follow`: what it concerns, e.g. `client:example-co employee:sam`. Repeatable. |

### `agentx workflow trace <id>`

Pretty-print a task's execution trace (taskId or runId).

| Flag | Default | What it does |
|---|---|---|
| `--daemon <url>` | `http://127.0.0.1:18800` | Daemon API base URL. |
| `--json` | — | Raw JSON output. |

### `agentx workflow pause <runId>`

Pause an active run.

| Flag | Default | What it does |
|---|---|---|
| `--node <id>` | — | Home-node id. |

### `agentx workflow resume <runId>`

Resume a paused run. A run that a pause signal stopped at an agent's step is refused here: resume it with `agentx signal resume <taskId>`, which brings back the agent's resume plan.

| Flag | Default | What it does |
|---|---|---|
| `--node <id>` | — | Home-node id. |

### `agentx workflow cancel <runId>`

Cancel an active run. When the daemon runs, it cancels the run there: a followed run's reminders and nudges stop and you get its summary. Without a running daemon, it marks the run canceled on disk.

| Flag | Default | What it does |
|---|---|---|
| `--node <id>` | — | Home-node id. |
| `--daemon <url>` | `http://127.0.0.1:18800` | Daemon API base URL. |

### `agentx workflow progress`

Follow-up runs still going, grouped by who or what they concern (their tags). Reads the runs on this computer.

| Flag | Default | What it does |
|---|---|---|
| `--tag <kind:name>` | — | Only this tag, e.g. `client:example-co`. |
| `--json` | — | Machine-readable output. |

### `agentx workflow follow-up`

Show or change how follow-up workflows run: reminders, approvals, which agents may start them. With no flags it shows the settings. See [Let a workflow follow a request](../jobs/follow-up-workflows.md#change-the-settings).

| Flag | Default | What it does |
|---|---|---|
| `--enabled <on\|off>` | — | Agents may start follow-up workflows. |
| `--stall-minutes <n>` | — | Minutes without progress before an agent step gets a reminder. |
| `--max-nudges <n>` | — | Reminders before the step counts as blocked and you are told (0 to 20). |
| `--approval <start\|step>` | — | Approve messages to people all at once when a run starts, or each before it is sent. |
| `--agent <id>` | — | With `--agent-enabled`: the agent to turn it on or off for. |
| `--agent-enabled <on\|off>` | — | Turn follow-up workflows on or off for `--agent`. |

### `agentx workflow required`

Show or change whether every task runs through a workflow (`workflows.required`). With no flags it shows the settings. Turning it on also turns the workflow engine on. See [Run every task through a workflow](../jobs/every-task-a-workflow.md).

| Flag | Default | What it does |
|---|---|---|
| `--enabled <on\|off>` | — | Every task of every agent runs inside a workflow run. |
| `--exempt-questions <on\|off>` | — | A plain question that changed nothing leaves no run (the setting's default is `on`). |
| `--retention-days <n>` | — | Remove task runs that ended more than `n` days ago (the setting's default is `30`; `0` keeps them all). |
| `--agent <id>` | — | With `--agent-required`: the agent to set it for. |
| `--agent-required <on\|off\|default>` | — | On or off for `--agent` whatever `--enabled` says; `default` follows `--enabled` again. |

### `agentx workflow records`

One line of JSON per workflow run, newest first: the steps taken, how long each took and where it failed. For analysis across runs. Reads the runs on this computer. See [Read the records](../jobs/every-task-a-workflow.md#read-the-records).

| Flag | Default | What it does |
|---|---|---|
| `--workflow <id>` | — | Only runs of this workflow. `task` is the runs that wrapped a task. |
| `--agent <id>` | — | Only runs of this agent. |
| `--days <n>` | — | Only runs started in the last `n` days. |
| `--limit <n>` | `500` | At most this many runs. |

## webhook (advanced)

`agentx webhook`: Manage webhook entries (gitlab, github, sentry, stripe, vercel, custom). **Advanced.**

### `agentx webhook list`

List webhook entries.

| Flag | Default | What it does |
|---|---|---|
| `--json` | — | Emit JSON. |

### `agentx webhook add [id]`

Register a new webhook entry.

| Flag | Default | What it does |
|---|---|---|
| `--source <source>` | — | One of: gitlab, github, sentry, stripe, vercel, odoo, hubspot, discord, slack, custom. |
| `--agent <agentId>` | — | Agent that receives the webhook. |
| `--secret-env <name>` | — | Env var holding the signing secret (recommended). |
| `--description <text>` | — | Free-text description. |
| `--node <peer>` | — | Forward to a mesh peer (skips local agent check; validates against mesh.peers). |
| `--no-prompt` | — | Fail instead of prompting for missing values. |

### `agentx webhook remove <id>`

Delete a webhook entry.

| Flag | Default | What it does |
|---|---|---|
| `--yes` | — | Skip confirmation. |

### `agentx webhook enable <id>`

Enable a webhook entry.

No flags.

### `agentx webhook disable <id>`

Disable a webhook entry.

No flags.

### `agentx webhook triggers`

Manage event-type → workflow mappings on a webhook.

### `agentx webhook triggers set <id> <eventType> <workflowId>`

Map an event-type to a workflow id.

No flags.

### `agentx webhook triggers remove <id> <eventType>`

Remove an event-type → workflow mapping.

No flags.

### `agentx webhook triggers default <id> <workflowId>`

Set the default workflow when no event-type matches (use '-' to clear).

No flags.

### `agentx webhook sources`

List known webhook source types.

| Flag | Default | What it does |
|---|---|---|
| `--json` | — | Emit JSON. |

## board (advanced)

`agentx board`: Kanban board dashboard — visual work view over configured sources. **Advanced.**

### `agentx board serve`

Start the dashboard server (live view always; boards if configured).

| Flag | Default | What it does |
|---|---|---|
| `--port <n>` | — | Override dashboard.port. |
| `--bind <host>` | — | Override dashboard.bind (e.g. 0.0.0.0). |

### `agentx board list`

List configured boards.

No flags.

### `agentx board add <id>`

Add a GitLab board to agentx.json.

| Flag | Default | What it does |
|---|---|---|
| `--name <name>` | required | Human-readable board name. |
| `--projects <paths>` | required | Comma-separated GitLab project paths (e.g. 'globex/system,globex/website'). |
| `--label <label>` | — | Primary tool label ANDed into every query (e.g. 'Tool::Claude'). |
| `--days <n>` | `30` | Open-window time range in days. |
| `--closed-days <n>` | `30` | Closed-window in days. |

### `agentx board edit <id>`

Edit board fields without re-creating it.

| Flag | Default | What it does |
|---|---|---|
| `--name <name>` | — | Rename. |
| `--projects <paths>` | — | Comma-separated GitLab project paths (replaces the list). |
| `--label <label>` | — | Primary tool label (set to '-' to clear). |
| `--days <n>` | — | Open-window time range in days. |
| `--closed-days <n>` | — | Closed-window in days. |

### `agentx board column`

Manage a board's columns (add / remove / edit / list).

### `agentx board column list <boardId>`

List columns on a board, in order.

No flags.

### `agentx board column add <boardId> <columnId>`

Add a column to a board.

| Flag | Default | What it does |
|---|---|---|
| `--title <title>` | required | Column title. |
| `--kind <kind>` | `scoped-label` | Open-backlog \| scoped-label \| closed \| label. |
| `--scoped <label>` | — | For kind=scoped-label, the full label (e.g. 'Status::Doing'). |
| `--label <label>` | — | For kind=label, the label name to add/remove. |
| `--scoped-prefix <prefix>` | `Status` | For kind=open-backlog/scoped-label. |
| `--accent <color>` | — | Hex/CSS color for the column accent bar. |

### `agentx board column remove <boardId> <columnId>`

Remove a column from a board.

No flags.

### `agentx board remove <id>`

Remove a board from agentx.json.

No flags.

## backlog (advanced)

`agentx backlog`: Manage the local backlog used by business workSource=backlog. **Advanced.**

### `agentx backlog list`

List backlog items.

| Flag | Default | What it does |
|---|---|---|
| `--status <status>` | — | Filter by status (todo\|doing\|blocked\|done). |
| `--assignee <agent>` | — | Filter by assignee. |
| `--source <type>` | — | Filter by source.type (gitlab\|github\|manual). |
| `-c, --config <path>` | — | Config path. |

### `agentx backlog claim <id> <agent>`

Assign an item to an agent and set status=doing.

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Config path. |

### `agentx backlog done <id>`

Mark an item as done; closes the upstream issue if linked.

| Flag | Default | What it does |
|---|---|---|
| `--note <text>` | — | Comment to post upstream. |
| `--close` | — | Also close the upstream issue (default: only labels change). |
| `-c, --config <path>` | — | Config path. |

### `agentx backlog remove <id>`

Remove an item from the local backlog (does NOT touch upstream).

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Config path. |

### `agentx backlog import`

Import open issues from gitlab/github into the backlog (interactive).

| Flag | Default | What it does |
|---|---|---|
| `--source <type>` | — | Source type (gitlab\|github). |
| `--project <id>` | — | Project id (group/repo for gitlab, owner/repo for github). |
| `--assignee <agent>` | — | Assign all imported items to this agentId. |
| `-c, --config <path>` | — | Config path. |

## business (advanced)

`agentx business`: Manage the business layer in agentx.json — orgChart, projects, contactMap. **Advanced.**

### `agentx business show`

Print the current business config (orgChart, projects, contactMap).

| Flag | Default | What it does |
|---|---|---|
| `--json` | — | Machine-readable JSON. |

### `agentx business orgchart`

Manage business.orgChart — agentId → { role, reportsTo, schedule }.

### `agentx business orgchart list`

List orgChart entries.

| Flag | Default | What it does |
|---|---|---|
| `--json` | — | JSON output. |

### `agentx business orgchart add <agentId>`

Add or update an orgChart entry for an agent.

| Flag | Default | What it does |
|---|---|---|
| `--role <role>` | required | Role title (e.g. 'PM', 'Coder', 'DevOps'). |
| `--reports-to <agentId>` | — | Manager's agentId. |
| `--start <hh:mm>` | `09:00` | Schedule start. |
| `--end <hh:mm>` | `17:00` | Schedule end. |
| `--days <csv>` | `mon,tue,wed,thu,fri` | Working days (mon,tue,wed,thu,fri). |
| `--utilization <0..1>` | `0.8` | Target utilization. |

### `agentx business orgchart remove <agentId>`

Remove an orgChart entry.

No flags.

### `agentx business project`

Manage business.projects — id, pm, client.

### `agentx business project list`

List projects.

| Flag | Default | What it does |
|---|---|---|
| `--json` | — | JSON output. |

### `agentx business project add <id>`

Add or update a project entry.

| Flag | Default | What it does |
|---|---|---|
| `--pm <agentId>` | — | PM responsible for this project (drives PM gate). |
| `--client <name>` | — | Client this project belongs to (drives activity-graph attribution). |

### `agentx business project remove <id>`

Remove a project entry.

No flags.

### `agentx business contact`

Manage business.contactMap — chatId/username/senderId → client/project.

### `agentx business contact list`

List contact map entries.

| Flag | Default | What it does |
|---|---|---|
| `--json` | — | JSON output. |

### `agentx business contact add`

Add a contactMap entry.

| Flag | Default | What it does |
|---|---|---|
| `--client <name>` | required | Client this contact belongs to. |
| `--channel <name>` | — | Telegram \| whatsapp \| slack \| discord. |
| `--chat-id <id>` | — | Native chat id (e.g. -100…, JID). |
| `--username <handle>` | — | Sender username/handle. |
| `--sender-id <id>` | — | Numeric sender id (when username is unstable). |
| `--project <id>` | — | Project this traffic should attribute to. |
| `--display-name <name>` | — | Display-name override for the initiator pill. |

### `agentx business contact remove`

Remove a contactMap entry by matching field(s).

| Flag | Default | What it does |
|---|---|---|
| `--channel <name>` | — | Only remove entries on this channel. |
| `--chat-id <id>` | — | Only remove entries with this chat id. |
| `--username <handle>` | — | Only remove entries with this username. |
| `--sender-id <id>` | — | Only remove entries with this sender id. |

## plan (advanced)

`agentx plan`: Set / read / list day-week-month plans that drive the standup-tick. **Advanced.**

### `agentx plan set <tier>`

Write a plan for today \| week \| month (priorities-as-bullets).

| Flag | Default | What it does |
|---|---|---|
| `-p, --priority <text...>` | — | Bullet line — repeat for multiple priorities. |
| `-m, --markdown <md>` | — | Raw markdown body (overrides --priority). |
| `-f, --file <path>` | — | Read markdown from a file. |

### `agentx plan show [tier]`

Print the plan that the next standup will use (default: resolve day→week→month).

No flags.

### `agentx plan list`

Recent plans across all tiers.

| Flag | Default | What it does |
|---|---|---|
| `-n, --limit <n>` | `20` | Max rows. |

### `agentx plan clear <tier>`

Remove the plan for today \| week \| month.

No flags.

## ledger (advanced)

`agentx ledger`: Inspect the intent ledger (.agentx/intent/ledger.sqlite). **Advanced.**

### `agentx ledger stats`

Overview: events by source, decisions, divergences, in-flight count.

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `--path <path>` | `.agentx/intent/ledger.sqlite` | Ledger path relative to cwd. |
| `--since <duration>` | — | Limit to events newer than (e.g. 1h, 24h, 7d). |
| `--json` | — | Emit JSON. |

### `agentx ledger divergences`

Recent divergence rows (newest first).

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `--path <path>` | `.agentx/intent/ledger.sqlite` | Ledger path relative to cwd. |
| `-s, --source <name>` | — | Filter by source (telegram, gitlab, workflow, cron, mesh, github). |
| `--since <duration>` | — | Limit to divergences newer than (e.g. 1h, 24h). |
| `-n, --limit <n>` | `50` | Max rows. |
| `--json` | — | Emit JSON. |

### `agentx ledger active`

Currently in-flight dispatched decisions (no resolution yet).

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `--path <path>` | `.agentx/intent/ledger.sqlite` | Ledger path relative to cwd. |
| `-s, --source <name>` | — | Filter by source. |
| `-n, --limit <n>` | `50` | Max rows. |
| `--json` | — | Emit JSON. |

### `agentx ledger events`

Recent events (newest first).

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `--path <path>` | `.agentx/intent/ledger.sqlite` | Ledger path relative to cwd. |
| `-s, --source <name>` | — | Filter by source. |
| `-p, --project <name>` | — | Filter by project. |
| `--since <duration>` | — | Limit to newer than (e.g. 1h, 24h). |
| `-n, --limit <n>` | `30` | Max rows. |
| `--json` | — | Emit JSON. |

### `agentx ledger lineage <eventOrSubject>`

Walk the dispatch chain on the same (project, subject) and print every decision + resolution.

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `--path <path>` | `.agentx/intent/ledger.sqlite` | Ledger path relative to cwd. |
| `--by-subject` | — | Treat the argument as `<project>:<subject>` instead of an event id. |
| `--json` | — | Emit JSON. |

### `agentx ledger replay`

Replay the source ledger onto a fresh tmp ledger; report divergences.

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `--path <path>` | `.agentx/intent/ledger.sqlite` | Ledger path relative to cwd. |
| `--since <duration>` | — | Limit to events newer than (e.g. 1h, 24h, 7d). |
| `-s, --source <name>` | — | Filter to one source. |
| `-n, --limit <n>` | — | Max events to replay (defaults to all). |
| `--json` | — | Emit JSON. |

## decisions (advanced)

`agentx decisions`: Inspect the typed-decision shadow store (.agentx/decisions/decisions.sqlite). **Advanced.**

### `agentx decisions stats`

Per-seat call counts, failure rate, repair rate and latency.

| Flag | Default | What it does |
|---|---|---|
| `--path <file>` | `.agentx/decisions/decisions.sqlite` | Store path. |
| `--since <window>` | — | E.g. 7d, 12h, or an ISO date. |
| `--json` | — | Raw JSON. |

### `agentx decisions calls`

Recent calls.

| Flag | Default | What it does |
|---|---|---|
| `--path <file>` | `.agentx/decisions/decisions.sqlite` | Store path. |
| `--seat <seat>` | — | Only calls from this seat. |
| `--since <window>` | — | Only calls newer than this: `7d`, `12h`, `30m` or a date. |
| `--limit <n>` | `20` | Default 20. |
| `--json` | — | Print JSON instead of a table. |

### `agentx decisions answers <callId>`

Every answer on one call, with its incumbent and label.

| Flag | Default | What it does |
|---|---|---|
| `--path <file>` | `.agentx/decisions/decisions.sqlite` | Store path. |
| `--json` | — | Print JSON instead of a table. |

### `agentx decisions label <callId> <question> <value>`

Attach ground truth to one answer (append-only; newest wins).

| Flag | Default | What it does |
|---|---|---|
| `--path <file>` | `.agentx/decisions/decisions.sqlite` | Store path. |
| `--kind <kind>` | `human` | Human \| outcome \| replay. |
| `--by <who>` | — | Who gave the label. |
| `--note <text>` | — | A note stored with the label. |

### `agentx decisions unlabeled`

Lowest-confidence unlabeled answers first — the most informative to label.

| Flag | Default | What it does |
|---|---|---|
| `--path <file>` | `.agentx/decisions/decisions.sqlite` | Store path. |
| `--seat <seat>` | — | Only answers from this seat. |
| `--limit <n>` | `20` | Default 20. |
| `--json` | — | Print JSON instead of a table. |

### `agentx decisions backfill-labels`

Derive ground truth from what actually happened (monitor-prefilter seat).

| Flag | Default | What it does |
|---|---|---|
| `--path <file>` | `.agentx/decisions/decisions.sqlite` | Store path. |
| `--db <file>` | `.agentx/db.sqlite` | Observability db holding session_reviews. |

### `agentx decisions calibrate`

Is this seat's confidence worth anything? reliability, ECE, Brier, temperature.

| Flag | Default | What it does |
|---|---|---|
| `--path <file>` | `.agentx/decisions/decisions.sqlite` | Store path. |
| `--seat <seat>` | required | The seat to grade. |
| `--question <name>` | — | Only this question. |
| `--backend <name>` | — | Grade one backend in isolation. |
| `--model <id>` | — | Only rows from this model. |
| `--structure-mode <mode>` | — | Never pool verbalized and logprob rows. |
| `--since <window>` | — | Only rows newer than this: `7d`, `12h`, `30m` or a date. |
| `--explored` | — | Only rows the policy wanted to skip — the unbiased skip-region sample. |
| `--min-n <n>` | `100` | Refuse to report below this many labeled rows. |
| `--bins <n>` | `10` | Default 10. |
| `--json` | — | Print JSON instead of a table. |

### `agentx decisions recalibrate`

Is one global temperature enough, or does calibration differ by group?

| Flag | Default | What it does |
|---|---|---|
| `--path <file>` | `.agentx/decisions/decisions.sqlite` | Store path. |
| `--seat <seat>` | required | The seat to compare. |
| `--question <name>` | — | Only this question. |
| `--since <window>` | — | Only rows newer than this: `7d`, `12h`, `30m` or a date. |
| `--by <names>` | `agent,question` | Comma-separated covariates. |
| `--folds <n>` | `5` | Cross-validation folds. |
| `--min-n <n>` | `100` | Default 100. |
| `--json` | — | Print JSON instead of a table. |

### `agentx decisions coverage`

Accuracy at each threshold against the traffic it keeps — read this to pick one.

| Flag | Default | What it does |
|---|---|---|
| `--path <file>` | `.agentx/decisions/decisions.sqlite` | Store path. |
| `--seat <seat>` | required | The seat to read. |
| `--question <name>` | — | Only this question. |
| `--since <window>` | — | Only rows newer than this: `7d`, `12h`, `30m` or a date. |
| `--explored` | — | Only rows the policy wanted to skip. |
| `--steps <n>` | `20` | Default 20. |
| `--json` | — | Print JSON instead of a table. |

### `agentx decisions consistency`

Does the question hold still? resample one recorded state N times.

| Flag | Default | What it does |
|---|---|---|
| `--path <file>` | `.agentx/decisions/decisions.sqlite` | Store path. |
| `--seat <seat>` | required | The seat whose recorded state is resampled. |
| `--backend <name>` | — | Default: the backend that recorded the row. |
| `--model <id>` | — | Model to resample with. |
| `--call <id>` | — | A specific call id; default is the newest with stored state. |
| `-n, --samples <n>` | `15` | Default 15. |
| `--json` | — | Print JSON instead of a table. |

### `agentx decisions backends`

Registered decision backends and what they claim.

No flags.

### `agentx decisions ask`

One-off smoke test against a backend (does not record).

| Flag | Default | What it does |
|---|---|---|
| `--state <text>` | required | The state to evaluate. |
| `--backend <name>` | `mock` | Default mock. |
| `--model <id>` | — | Model to ask. |
| `--choice <labels>` | — | Comma-separated options for a choice question. |
| `--noul <question>` | — | A yes/no question. |

## trace (advanced)

`agentx trace`: Inspect per-task execution traces (.agentx/db.sqlite). **Advanced.**

### `agentx trace list`

List recent traces (newest first).

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `--path <path>` | `.agentx/db.sqlite` | Db path relative to cwd. |
| `--agent <id>` | — | Filter by agentId. |
| `--channel <name>` | — | Filter by channel (telegram\|whatsapp\|gitlab\|...). |
| `--chat <id>` | — | Filter by chatId. |
| `--workflow <runId>` | — | Filter by workflowRunId. |
| `--status <s>` | — | Filter by status (in-flight\|ok\|error\|timeout). |
| `--since <duration>` | — | Limit to traces newer than (e.g. 1h, 24h, 7d). |
| `--limit <n>` | `50` | Max rows. |
| `--json` | — | Emit JSON. |

### `agentx trace show <taskId>`

Show one trace with its full ordered step log.

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `--path <path>` | `.agentx/db.sqlite` | Db path relative to cwd. |
| `--json` | — | Emit JSON. |

### `agentx trace replay <taskId>`

Re-run a recorded task against the current agent config.

| Flag | Default | What it does |
|---|---|---|
| `--cwd <dir>` | current folder | Project root. |
| `--path <p>` | `.agentx/db.sqlite` | Sqlite db path (relative to --cwd). |
| `--daemon <url>` | `http://127.0.0.1:18800` | Daemon API base URL. |
| `--diff` | — | Show original input + output vs new output side-by-side. |
| `--no-fresh` | — | Do NOT freshSession (default is fresh — required for clean replay). |

## retro (advanced)

`agentx retro <taskId>`: Turn one run that struggled into fix choices on a decision card. **Advanced.** Refused when `approvals.forwardTo` is set: retro cards stay on the machine that raised them. See [Stop a mistake from coming back](../jobs/retro.md).

| Flag | Default | What it does |
|---|---|---|
| `--model <model>` | `AGENTX_RETRO_MODEL`, else `AGENTX_MONITOR_MODEL`, else `opus` | The reviewer model. |
| `--dry-run` | — | Show the card without raising it. |
| `--force` | — | Raise a card even when the run shows no struggle, or one about the same failure is open. |
| `--path <db>` | `.agentx/db.sqlite` | Trace database. |

### `agentx retro sweep`

Rank the day's struggled runs and raise retro cards for the worst, at most `--max` in any 24 hours. Only previews unless `--commit` is given. Refused with `--commit` when `approvals.forwardTo` is set.

| Flag | Default | What it does |
|---|---|---|
| `--since <window>` | `24h` | How far back to read, in hours or days (`24h`, `2d`). |
| `--max <n>` | `3` | Retro cards allowed in any 24 hours, counting ones raised by hand. |
| `--commit` | — | Ask the reviewer and raise the cards (default: rank only). |
| `--model <model>` | `AGENTX_RETRO_MODEL`, else `AGENTX_MONITOR_MODEL`, else `opus` | The reviewer model. |
| `--path <db>` | `.agentx/db.sqlite` | Trace database. |

### `agentx retro checks`

List the guard rules a retro added (tagged `retro:<taskId>`), how often each fired in the last 30 days, and how the agent's runs did before and after it. With `--commit`, raise a keep / loosen / remove card for each rule that fired often on runs that went well, at most once every 30 days per rule. Refused with `--commit` when `approvals.forwardTo` is set.

| Flag | Default | What it does |
|---|---|---|
| `--min-fires <n>` | `5` | Fires on runs that went well, in the last 30 days, before a rule is reviewed. |
| `--max <n>` | `3` | Review cards raised in one pass. |
| `--commit` | — | Raise the review cards (default: list only). |
| `--path <db>` | `.agentx/db.sqlite` | Trace database. |

## process (advanced)

`agentx process`: Inspect / rotate persistent claude processes (--persistentProcess agents). **Advanced.**

### `agentx process list`

List every live persistent claude process.

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Daemon config file. |
| `--node <url>` | — | Daemon URL (defaults to dashboard.daemonUrl). |
| `--token <token>` | — | Bearer token (defaults to dashboard.token). |
| `--json` | — | Emit JSON. |

### `agentx process kill <agentId> <channel> <chatId>`

Force-kill one persistent process (the next dispatch will spawn fresh).

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Daemon config file. |
| `--node <url>` | — | Daemon URL (defaults to dashboard.daemonUrl). |
| `--token <token>` | — | Bearer token (defaults to dashboard.token). |
| `-r, --reason <reason>` | `operator-cli` | Kill reason (recorded on the dead-process snapshot). |

## signal (advanced)

`agentx signal`: Pause a running agent task with a resume plan, and resume it later. **Advanced.** See [Pause a task and resume it later](/jobs/pause-and-resume).

Every subcommand takes these flags:

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Daemon config file. |
| `--node <url>` | — | Daemon URL (defaults to dashboard.daemonUrl). |
| `--token <token>` | — | Bearer token (defaults to dashboard.token). |
| `--peer <name>` | — | Send to this mesh machine instead. |

### `agentx signal stop [taskId]`

Stop a running task; the agent writes a resume plan.

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | With `--channel` and `--chat`: the agent's only task on that chat. |
| `--channel <channel>` | — | The task's channel. |
| `--chat <chatId>` | — | The task's chat id. |
| `-r, --reason <reason>` | — | Why: shown to the agent and on the Live page. |

### `agentx signal list`

Stopped tasks and their resume plans.

| Flag | Default | What it does |
|---|---|---|
| `--all` | — | Include tasks already resumed. |
| `--agent <id>` | — | Only this agent's. |

### `agentx signal show <id>`

One stopped task with its whole resume plan. For a step of a workflow run, it also names the step and the run.

### `agentx signal resume <id>`

Resume a stopped task from its plan, in the same chat. A step of a workflow run runs again inside its run, which then goes on to its next steps.

| Flag | Default | What it does |
|---|---|---|
| `-r, --reason <reason>` | — | Why: recorded on the resume event. |

### `agentx signal drop <id>`

Forget a stopped task and its resume plan, when it won't be resumed. It can no longer be resumed afterwards. Refused while the agent is still writing its plan or while the task is being resumed. The same people and agents that may resume a task may drop it.

## watch (advanced)

`agentx watch`: Stream live daemon events — workflow runs, user tasks, signals, mesh health. **Advanced.**

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Daemon config file. |
| `-t, --type <kinds>` | — | Comma-separated event kinds (run,task,signal,mesh,channel,status). |
| `-w, --workflow <id>` | — | Only events for this workflow id. |
| `-a, --actor <id>` | — | Only task events involving this actor id. |
| `-r, --run <id>` | — | Only events for this run id. |
| `--channel <name>` | — | Only channel events on this channel (telegram/whatsapp/…). |
| `--node <url>` | — | Daemon URL (defaults to dashboard.daemonUrl from config). |
| `--token <token>` | — | Bearer token (defaults to dashboard.token from config). |

## events (advanced)

`agentx events`: Recent events on this node, or those matching one agent's subscriptions. **Advanced.** See [Let agents follow events](/automations/event-subscriptions).

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Daemon config file. |
| `-a, --agent <id>` | — | Only events matching this agent's subscriptions. |
| `-s, --since <id\|iso>` | — | Only events after this event id or ISO time. |
| `-k, --kind <kind>` | — | Only this event kind (without --agent). |
| `-n, --limit <n>` | `50` (with --agent: `20`, max `50`) | Most events to show. |
| `--json` | — | Emit JSON. |
| `--node <url>` | — | Daemon URL (defaults to dashboard.daemonUrl from config). |
| `--token <token>` | — | Bearer token (defaults to dashboard.token from config). |

## db (advanced)

`agentx db`: Explore the operational SQLite store at .agentx/db.sqlite. **Advanced.**

### `agentx db tasks`

Recent task_history rows (one per agent task).

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `-a, --agent <id>` | — | Filter by agent id. |
| `-d, --day <YYYY-MM-DD>` | — | Filter by start day (UTC). |
| `-s, --status <status>` | — | Ok \| error. |
| `-n, --limit <n>` | `20` | Max rows. |
| `--json` | — | Emit JSON. |

### `agentx db rotations`

Session rotation events (stale \| tier-2 \| max-turns).

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `-a, --agent <id>` | — | Filter by agent id. |
| `-r, --reason <r>` | — | Stale \| tier-2 \| max-turns. |
| `-n, --limit <n>` | `20` | Max rows. |
| `--summary` | — | Group by agent + reason. |
| `--json` | — | Emit JSON. |

### `agentx db usage`

Token usage rolled up per (agent, model, day).

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `-a, --agent <id>` | — | Filter by agent id. |
| `-d, --day <YYYY-MM-DD>` | — | Filter by day (UTC). |
| `--json` | — | Emit JSON. |

### `agentx db routes`

Inbound routing decisions captured by the pipeline trace.

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `-c, --channel <ch>` | — | Filter by channel (telegram, gitlab, github, ...). |
| `-k, --kind <k>` | — | Match \| drop. |
| `-n, --limit <n>` | `20` | Max rows. |
| `--summary` | — | Group by channel + kind + deciding stage. |
| `--json` | — | Emit JSON. |

### `agentx db errors`

Failed tasks (status='error') with their error message.

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `-a, --agent <id>` | — | Filter by agent id. |
| `-n, --limit <n>` | `20` | Max rows. |
| `--json` | — | Emit JSON. |

### `agentx db tables`

List tables + row counts.

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `--json` | — | Emit JSON. |

### `agentx db query <sql>`

Run an arbitrary read-only SQL query (escape hatch).

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Working directory. |
| `--json` | — | Emit JSON. |

## mesh (advanced)

`agentx mesh`: Manage mesh peers — add, list, remove. **Advanced.**

### `agentx mesh list`

List mesh peers.

No flags.

### `agentx mesh add`

Add a mesh peer (another agentx server).

No flags.

### `agentx mesh remove <name>`

Remove a mesh peer.

No flags.

### `agentx mesh health`

Tune mesh peer health checks (interval + timeout, in seconds).

| Flag | Default | What it does |
|---|---|---|
| `--interval <s>` | — | Seconds between health probes (default 60). |
| `--timeout <s>` | — | Per-probe timeout in seconds (default 10). |
| `--show` | — | Just print the current values. |

### `agentx mesh announce <text...>`

Send a short note to every machine in the mesh (shown in event feeds). See [Announcements](./events.md#announcements).

| Flag | Default | What it does |
|---|---|---|
| `--by <name>` | — | Who the note is from (an agent id or a person's name). |
| `--node <url>` | — | Daemon to publish on (default: dashboard.daemonUrl, else this machine on port 18800). |
| `--token <token>` | — | Mesh token, needed only when --node is another machine (default: MESH_TOKEN). |

## a2a (advanced)

`agentx a2a`: Start an A2A (Agent-to-Agent) protocol server for external agent integration. **Advanced.**

| Flag | Default | What it does |
|---|---|---|
| `--port <port>` | `3171` | Server port. |
| `--host <host>` | `0.0.0.0` | Server host. |
| `-p, --provider <provider>` | `claude-code` | AI provider. |
| `-m, --model <model>` | — | Model to use. |
| `--api-key <key>` | — | API key for the provider. |
| `-c, --cwd <cwd>` | current folder | Working directory. |
| `--no-cors` | — | Disable CORS headers. |

## skill (advanced)

`agentx skill`: Manage skills — add to agent(s), list. **Advanced.**

### `agentx mesh guests invite`

Open a grant to a guest mesh and print the one-time code it joins with. See [Let another organisation into part of your mesh](/jobs/guest-mesh).

| Flag | Description |
|---|---|
| `--name <name>` | What you call it, e.g. "Support session for company X" (required) |
| `--guest <name>` | The other organisation's name (required) |
| `--agent <id>` | The agent of this node that works for them (required) |
| `--folders <list>` | Folders that agent may touch for them, comma-separated |
| `--skills <list>` | Skills it may use for them, comma-separated |
| `--commands <list>` | Commands it may run for them, comma-separated |
| `--level <level>` | `report` (read only), `propose` (no merge, deploy or delete) or `act` (default: `propose`) |
| `--days <n>` | How long the grant lasts, 1 to 365 (default: `7`) |
| `--url <origin>` | The address the guest reaches this node on (default: `dashboard.daemonUrl`) |

### `agentx mesh guests [list]`

Every grant: state, guest, agent, level, end date, usage. `--json` for machine-readable output.

### `agentx mesh guests show <id>`

One grant, what it opens and what the guest did.

### `agentx mesh guests pause <id>` / `resume <id>` / `end <id>`

Stop the guest at once (running turns are cancelled), let it work again, or end the grant for good. These go through the running daemon.

### `agentx mesh guests set <id>`

Widen or narrow a grant while it is in use.

| Flag | Description |
|---|---|
| `--folders <list>` | Folders, comma-separated (`none` clears) |
| `--skills <list>` | Skills, comma-separated (`none` clears) |
| `--commands <list>` | Commands, comma-separated (`none` clears) |
| `--level <level>` | `report`, `propose` or `act` |
| `--days <n>` | New length, counted from now |

### `agentx mesh join <url>`

Join another organisation's mesh as a guest, with the code its owner sent you.

| Flag | Description |
|---|---|
| `--code <code>` | The one-time code from the host (required) |
| `--name <name>` | What you call the host, e.g. `company-x` (required) |

### `agentx mesh hosts`

The meshes this node has joined as a guest, and where each grant stands.

### `agentx mesh ask <host> <message...>`

Ask the host's agent something, inside the grant.

### `agentx mesh leave <host>`

Forget a host you joined as a guest.

### `agentx skill add <skillPath>`

Add a skill to agent(s).

| Flag | Default | What it does |
|---|---|---|
| `-a, --agent <agents...>` | — | Target agent ID(s). |
| `--all` | — | Add to all agents. |

### `agentx skill list`

List skills per agent.

No flags.

### `agentx skill sync <name>`

Redeploy a skill's SKILL.md from source to agent workspaces (by default, only those that already have it).

| Flag | Default | What it does |
|---|---|---|
| `--source <path>` | — | Explicit source path (defaults to src/&lt;name&gt;/SKILL.md or skills/&lt;name&gt;/SKILL.md). |
| `--agent <id>` | — | Restrict to a single agent's workspace. |
| `--all-workspaces` | — | Also seed into workspaces that don't have the skill yet. |
| `--dry-run` | — | Report what would change, don't write. |

### `agentx skill audit`

Lint installed skills against the references registry; exits non-zero on FAILING.

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Where to load skills from. |
| `--references-cwd <cwd>` | — | Where to load references and recipes from (defaults to --cwd; useful when references live in the agentx repo and skills live under ~/.claude). |
| `--json` | — | Emit JSON instead of a human report. |
| `--workspace <id>` | — | Audit a single agent workspace by id (skills + references; overrides --cwd). |
| `--all-workspaces` | — | Audit every agent workspace in agentx.json; references default to the current cwd. |

### `agentx skill suggest <task>`

Rank an agent's skills against a task (suggests, never loads).

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | Whose skills to rank. |
| `--min <p>` | `0.6` | Minimum P(any skill applies). |
| `--json` | — | Emit the ranking as JSON. |

## plugin (advanced)

`agentx plugin`: Manage agentx plugins. **Advanced.**

### `agentx plugin list`

List plugins configured in agentx.json.

No flags.

### `agentx plugin init <name>`

Scaffold a new plugin package (npm-publishable, with manifest + setup hook).

| Flag | Default | What it does |
|---|---|---|
| `--cwd <cwd>` | current folder | Directory to create the package under. |
| `--description <text>` | — | Short package description. |
| `--force` | — | Overwrite an existing directory. |

### `agentx plugin doctor`

Dynamic-import each configured plugin and report status.

No flags.

## hook (advanced)

`agentx hook`: Manage hooks — add to agent workspace. **Advanced.**

### `agentx hook add <agent>`

Add a hook to an agent's workspace settings.

No flags.

## actions (advanced)

`agentx actions`: Manage the action registry — reusable shell/http invocations. **Advanced.**

### `agentx actions list`

List registered actions.

| Flag | Default | What it does |
|---|---|---|
| `--json` | — | JSON output. |

### `agentx actions show <id>`

Show an action's full definition.

| Flag | Default | What it does |
|---|---|---|
| `--json` | — | JSON output. |

### `agentx actions add <id>`

Add (or replace) an action non-interactively.

| Flag | Default | What it does |
|---|---|---|
| `--title <text>` | required | The action's title. |
| `--kind <kind>` | required | Shell \| http. |
| `--description <text>` | — | A longer description of the action. |
| `--command <text>` | — | [shell] templated shell command. |
| `--cwd <path>` | — | [shell] working directory. |
| `--url <url>` | — | [http] URL. |
| `--method <m>` | `POST` | [http] GET\|POST\|PUT\|PATCH\|DELETE. |
| `--headers <json>` | — | [http] headers as JSON object. |
| `--body <text>` | — | [http] body template. |
| `--inputs <csv>` | — | Comma-separated list of name:type[!] (e.g. amount:number!,note:string). |
| `--timeout <ms>` | `30000` | Timeout in ms (default 30000). |

### `agentx actions remove <id>`

Delete an action.

No flags.

### `agentx actions run <id>`

Invoke an action and print its output.

| Flag | Default | What it does |
|---|---|---|
| `--input <kv...>` | — | Input as key=value (repeat for each). |
| `--json` | — | JSON output (full ActionRunResult). |

### `agentx actions builtin [name]`

List registered built-in actions, or run one with --input.

| Flag | Default | What it does |
|---|---|---|
| `--input <json>` | — | JSON input matching the action's inputSchema. |
| `--daemon <url>` | `http://127.0.0.1:18800` | Daemon API base URL. |
| `--json` | — | Raw JSON output (omit chrome). |
| `--schema` | — | Show the action's input/output schema instead of running it. |

## people (advanced)

`agentx people`: The humans who talk to your agents: one person per human, whatever channel they use. **Advanced.**

### `agentx people list`

Everyone, with their channel identities.

| Flag | Default | What it does |
|---|---|---|
| `--json` | — | Machine-readable output. |

### `agentx people add <id>`

Add a person.

| Flag | Default | What it does |
|---|---|---|
| `--name <name>` | required | Their name. |
| `--role <role>` | `member` | owner \| member \| client \| guest. A client is someone you do work for; their page is "Your project". |
| `--identity <channel:id>` | — | A login, a Telegram id or a WhatsApp number (repeatable). |
| `--agent <id>` | — | An agent this person may reach; repeat for several. None: every agent. Not for an owner. |

### `agentx people allow <id> <agents...>`

Limit a person to these agents (ids, space-separated). `all` lifts the limit. A message to any other agent is answered with a note and no run starts. An owner cannot be limited. An id that is not an agent on this machine is saved with a warning: keep it only if the agent runs on another node.

No flags.

### `agentx people deny <id> <level> <names...>`

Stop a person's work using these tools or skills. `<level>` is `tools` or `skills`. Names match without case; `*` is a wildcard (quote it). `none` lifts the limit for that level. Every tool call of their runs is checked and a denied one is blocked. An owner cannot be limited. Example: `agentx people deny sara tools Bash "mcp__mail__*"`.

No flags.

### `agentx people link <id> <identity>`

Add a channel identity to a person, written channel:id (gitlab:sara, whatsapp:21620123456).

No flags.

### `agentx people unlink <id> <identity>`

Take a channel identity away from a person.

No flags.

### `agentx people say <id> [spoken...]`

How the person's name is said aloud, for example "Shiv-awn Oh-kah-for"; the written name stays. `none` clears it. With no spoken form, shows the current one.

No flags.

### `agentx people remove <id>`

Remove a person. Their past runs keep the id; new messages from them are unknown; every machine of theirs stops at once.

No flags.

### `agentx people invite <id>`

A one-time code that pairs one of this person's machines with their own page (`/member`): **My work** for a teammate, **Your project** for a client. The output names the page the person gets and ends with a message to forward to them as it is. Refuses to run while `tailscale serve` publishes the whole dashboard. See [Invite a teammate to their work page](/jobs/members) and [Give a client a page of their own](/jobs/clients).

| Flag | Description |
|---|---|
| `--url <origin>` | Address the person opens, e.g. `https://my-mac.tailnet-name.ts.net` (default: this computer's Tailscale name) |

The output ends with a block marked **Message to forward**, between two dashed lines: the person's page named for their role, the address, the code, that it works once for 10 minutes, the two steps on their side (accept the Tailscale share, open the address in Edge or Chrome), and what happens next. It names no command to run on your computer. For a client, the message says nothing about agents.

```text
  Message to forward (copy everything between the two lines; the rest of this output is for you)
----------------------------------------------------------------
Hi Sara B,

I use AgentX to give our AI agents their jobs. It has a page for you, "My work": what you asked the agents for, and where each request stands.

To open it:
1. Accept the Tailscale share I sent you. Tailscale is a small program that connects your computer to mine, privately.
2. Open https://my-mac.tailnet-name.ts.net/member in Edge or Chrome, give your computer a name and type this code: 7KQ4-M2XH
   The code works once, for 10 minutes. If it has stopped working, tell me and I will send you a new one.

I then approve your machine, and the page opens by itself.
----------------------------------------------------------------
```

### `agentx people devices [id]`

The machines paired to people's own pages (My work, Your project): state, where from, first and last use. With an id, one person's machines.

| Flag | Description |
|---|---|
| `--json` | Machine-readable output |

### `agentx people revoke-device <tokenId>`

End one machine's access at once. The id is in `agentx people devices`.

No flags.

### `agentx people show <id>`

One person and what they asked for, on every channel.

| Flag | Default | What it does |
|---|---|---|
| `--limit <n>` | `20` | How many runs to list. |
| `--json` | — | Machine-readable output. |

## cron (advanced)

`agentx cron`: Manage cron jobs — add, list, enable, disable. **Advanced.**

### `agentx cron list`

List cron jobs.

No flags.

### `agentx cron add`

Add a cron job.

No flags.

### `agentx cron enable <id>`

Enable a cron job.

No flags.

### `agentx cron disable <id>`

Disable a cron job.

No flags.

## migrate (advanced)

`agentx migrate`: Import configuration from OpenClaw or other tools. **Advanced.**

### `agentx migrate openclaw [configPath]`

Import agents, channels, and crons from OpenClaw config.

| Flag | Default | What it does |
|---|---|---|
| `--dry-run` | — | Show what would be imported without writing. |

## retention (advanced)

`agentx retention`: Prune old workspace state (sessions, drift, router traces, pattern store). **Advanced.**

### `agentx retention show`

Show how much each retention target currently weighs.

No flags.

### `agentx retention prune`

Delete files older than --days from each retention target.

| Flag | Default | What it does |
|---|---|---|
| `--days <n>` | `30` | Max age in days; everything older is deleted. |
| `--dry-run` | — | List candidates, don't delete. |
| `--target <name>` | — | Limit to one target dir (e.g. .agentx/sessions). |

## notifications (advanced)

`agentx notifications`: Manage notifications routing — destination, event toggles, long-task threshold. **Advanced.**

### `agentx notifications show`

Print current notifications config.

| Flag | Default | What it does |
|---|---|---|
| `--json` | — | JSON output. |

### `agentx notifications route`

Set the destination channel/chatId for notifications.

| Flag | Default | What it does |
|---|---|---|
| `--channel <name>` | required | Telegram \| whatsapp \| slack \| discord. |
| `--chat-id <id>` | required | Native chat id (e.g. -100…, JID, channel id). |
| `--account-id <id>` | — | Channel account id when the channel is multi-account (telegram with multiple bots). |
| `--clear` | — | Clear the destination instead of setting it. |

### `agentx notifications event <name> <state>`

Toggle an event: name in {taskComplete, taskError, taskQueued}; state in {on, off}.

No flags.

### `agentx notifications threshold <seconds>`

Set the long-task threshold in seconds (0 disables long-task pings).

No flags.

### `agentx notifications local`

Set what `agentx notify` does on this Mac: banner, sound, sound name, volume, banner icon.

| Flag | Default | What it does |
|---|---|---|
| `--banner <state>` | — | On \| off. |
| `--sound <state>` | — | On \| off. |
| `--sound-name <name>` | — | A macOS system sound, e.g. Glass, Ping, Tink. |
| `--volume <n>` | — | 0 to 1. |
| `--icon <path>` | — | Image for the banner icon (.png, .jpg, .icns); "" for the AgentX logo. |

### `agentx notifications channel <name>`

Set the channel `agentx notify` uses when `--channel` is not given: `push`, `ntfy`, `telegram`… Unset: `push` when phone app notifications are on, otherwise `ntfy`.

No flags.

### `agentx notifications push`

Set up notifications on the phone app: on/off, contact, or relay to the node that hosts the app.

| Flag | Default | What it does |
|---|---|---|
| `--subject <contact>` | — | Contact for the push services: `mailto:you@example.com` or an `https://` URL. |
| `--relay-to <peer>` | — | Mesh peer that hosts the phone app (on every other node); "" makes this node the host. |
| `--enable` | — | Turn the channel on. |
| `--disable` | — | Turn the channel off. |

### `agentx notifications ntfy`

Set up phone push through ntfy: server, topic, token, on/off.

| Flag | Default | What it does |
|---|---|---|
| `--server <url>` | — | Ntfy server (default `https://ntfy.sh`). |
| `--topic <topic>` | — | Topic to publish to; a secret on ntfy.sh — "${NTFY_TOPIC}" reads it from .env. |
| `--token <token>` | — | Access token for a protected topic; "${NTFY_TOKEN}" reads it from .env; "" removes it. |
| `--enable` | — | Turn the channel on. |
| `--disable` | — | Turn the channel off. |

## whatsapp (advanced)

`agentx whatsapp`: List WhatsApp chats/contacts and ingest them into the wiki as a data source. **Advanced.**

### `agentx whatsapp list-chats`

List chats observed by the WhatsApp socket (cached, no live fetch).

| Flag | Default | What it does |
|---|---|---|
| `--format <format>` | `table` | Output format: table \| json. |
| `--group` | — | Groups only. |
| `--dm` | — | DMs only. |

### `agentx whatsapp list-contacts`

List contacts observed by the WhatsApp socket (cached, no live fetch).

| Flag | Default | What it does |
|---|---|---|
| `--format <format>` | `table` | Output format: table \| json. |

### `agentx whatsapp ingest-all`

Run a full ingest sweep against the configured allowlist (writes raw wiki entries).

| Flag | Default | What it does |
|---|---|---|
| `--dry-run` | — | Compute entries without writing them — review before enabling. |
| `--agent <id>` | — | Owner agent for the entries (defaults to channels.whatsapp.defaultAgent). |
| `--force` | — | Bypass the channels.whatsapp.ingest.enabled guard. |

### `agentx whatsapp ingest-contact <jid>`

Ingest one contact (skips scope allowlist for this JID only).

| Flag | Default | What it does |
|---|---|---|
| `--dry-run` | — | Compute entries without writing them. |
| `--agent <id>` | — | Owner agent for the entries. |

### `agentx whatsapp ingest-chat <jid>`

Ingest one chat (DM or group) including message window if `--messages` is set.

| Flag | Default | What it does |
|---|---|---|
| `--dry-run` | — | Compute entries without writing them. |
| `--messages` | — | Include the bounded message window for this chat (overrides config mode). |
| `--agent <id>` | — | Owner agent for the entries. |

### `agentx whatsapp status`

Show WhatsApp channel + ingest status.

No flags.

### `agentx whatsapp triage status`

Show WhatsApp triage settings, watch rules, and whether the webhook secret is set in this shell. See [Watch a WhatsApp chat](../jobs/watch-whatsapp.md).

No flags.

### `agentx whatsapp triage on`

Turn WhatsApp triage on.

No flags.

### `agentx whatsapp triage off`

Turn WhatsApp triage off.

No flags.

### `agentx whatsapp triage log`

The latest triage results: chat, class, summary, and the draft's approval key.

| Flag | Default | What it does |
|---|---|---|
| `--limit <n>` | `20` | How many. |

### `agentx whatsapp triage rule add <id>`

Watch a chat (or people) and send its messages to an agent.

| Flag | Default | What it does |
|---|---|---|
| `--agent <agent>` | required | The agent that triages. |
| `--chat <jid>` | — | A chat to watch: phone number, contact JID or group JID (repeatable). |
| `--sender <jid>` | — | Only messages from this person (repeatable). |
| `--prompt <text>` | — | Extra instructions for the agent. |
| `--quiet <range>` | — | No notifications in this window, e.g. 22:00-07:00. |
| `--auto-ack` | — | Send short acknowledgements without asking (also needs allowAutoAck). |

### `agentx whatsapp triage rule remove <id>`

Delete a watch rule.

No flags.

### `agentx whatsapp triage rule enable <id>`

Enable a watch rule.

No flags.

### `agentx whatsapp triage rule disable <id>`

Disable a watch rule.

No flags.

## demo (advanced)

`agentx demo`: Zero-key demo: three daemons, a real A2A mesh, a scripted scenario. **Advanced.**

| Flag | Default | What it does |
|---|---|---|
| `--base-port <port>` | `18921` | First of three consecutive loopback ports. |
| `--once` | — | Play the scenario once and exit (default: keep daemons up until Ctrl-C). |
| `--keep` | — | Keep the .agentx-demo directory on exit. |
| `--no-open` | — | Don't open the dashboard in a browser. |
| `--reuse` | — | Resume an existing .agentx-demo instead of starting fresh (implies --keep). |
| `--bind <host>` | `127.0.0.1` | Dashboard bind address. |
| `--startup-timeout <seconds>` | — | Seconds each startup step may take. Unset: `AGENTX_DEMO_STARTUP_TIMEOUT`, then [`demo.startupTimeoutSeconds`](./config-operations.md#demo), else 60 (longer when the machine is busy, up to 300). |

## exec (advanced)

`agentx exec [message]`: Run one task through an agent and exit — for scripts and benchmarks. **Advanced.**

| Flag | Default | What it does |
|---|---|---|
| `-a, --agent <id>` | required | Agent id from the config. |
| `-c, --config <path>` | — | Config file (default: ./agentx.json). |
| `-m, --model <model>` | — | Override the agent's model for this task. |
| `--timeout <minutes>` | — | Upper bound on the task's run time. |
| `--setup-workspace` | — | Write the managed workspace files first, as daemon boot does. |
| `--json` | — | Print one JSON result object instead of the reply text: the reply, any error, the token counts, the number of turns, the cost the Claude Code CLI reported for the run (`costUsd`, when the engine reports one), the billed model and the duration. |
| `--channel <name>` | `exec` | Channel name the task runs under, as a channel adapter would set it. Decides the session profile, see [Lean sessions](./config-agents.md#lean-sessions). |
| `--chat-id <id>` | a fresh one | Chat id for the session, so repeated runs share a history. |
| `--profile <full\|lean>` | — | Session profile for this run's channel, overriding `session.profileByChannel`. |

## chat (advanced)

`agentx chat [agent]`: [deprecated — see agentx attach] interactive chat with a daemon-registered agent. **Advanced.**

| Flag | Default | What it does |
|---|---|---|
| `-c, --config <path>` | — | Daemon config file. |
| `--node <url>` | — | Daemon URL (defaults to dashboard.daemonUrl from config). |
| `--token <token>` | — | Bearer token (defaults to dashboard.token from config). |
| `--channel <name>` | `chat-cli` | Logical channel name passed in context. |
| `--chat-id <id>` | — | Resume an existing chatId (otherwise a fresh one is generated). |

## Check it worked

1. **Terminal:** run `agentx --version`. It prints the installed version.
2. **Terminal:** run `agentx <command> --help` for a command on this page, for example `agentx daemon logs --help`. The flags it lists match the table above.

## If something is wrong

- **`unknown option`:** your installed version is older or newer than these docs. Use the flags that `agentx <command> --help` shows.
- **`claude: command not found` from a wiki command:** the `claude` CLI isn't installed in any of the folders listed under `agentx wiki absorb`. Install it, or add its folder to the daemon's PATH.
- **`wiki absorb` keeps printing `! refused <path>`:** the model's update left out facts the article already had, so the same entries come back each run. Check the facts listed under the message. If one is really wrong, correct it in the article with `agentx wiki edit`, then run absorb again.
- **`wiki absorb` prints `note <id> deferred: patch refused: …`:** the model's patch broke a rule (it replaced most of a page, removed a contact or role value, or quoted text the article does not have). The note comes back on the next run. Read the reason with `agentx wiki notes list --status all`.
- **`wiki absorb-runs` prints `no absorb runs recorded yet`:** no absorb has run since the run log was added, or `--dir` points at another wiki. Run `agentx wiki absorb` once, then try again.
- **A schedule running `wiki absorb` as a command shows as failed:** absorb exits with code 1 when a model call fails. Run `agentx wiki absorb --dry-run` to check the setup, then `agentx wiki absorb-runs` to see how many calls failed. The entries stay queued, so the next good run catches up.
- **`wiki query-runs` prints `no queries recorded yet`:** no query has run against this wiki since the query log was added, or `--dir` points at another wiki. Run `agentx wiki query "a question"` once, then try again.
- **`wiki absorb-eval` prints `no articles … to score`:** nothing changed in the window you gave. Widen `--since` or `--changed-after`, or leave both out to sample every article.
- **`unknown command`:** check the spelling and the command group. Advanced commands don't appear in `agentx --help`, but they still run.
- **`error: required option … not specified`:** the flag is marked **required** above. Add it and run the command again.
- **A command can't find your agents or settings:** run it from the folder that holds `agentx.json`, or pass `--config <path>` where the command offers it.
