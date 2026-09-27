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

Pair a phone — prints a QR code to scan with the phone's camera.

Refuses to run while `tailscale serve` shares the whole dashboard (for example after `tailscale serve --bg 4202`) rather than only `/app` and `/api/app`.

| Flag | Default | What it does |
|---|---|---|
| `--name <name>` | `Phone` | Name for this phone (shown in `agentx app devices`). |
| `--url <origin>` | this machine's Tailscale name | Address the phone opens, e.g. `https://my-mac.tailnet-name.ts.net`. |

### `agentx app devices`

List paired phones.

No flags.

### `agentx app revoke <id>`

Unpair a phone immediately. The phone also stops getting notifications.

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

`agentx approvals`: One inbox for every decision waiting for you (cards, schedules, memory facts, wiki proposals).

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
| `--if-silent <value>` | required | What applies if nobody answers: discard, keep, pause, approve. |
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
| `--digest <on\|off>` | — | The daily message about what is waiting. |
| `--digest-time <HH:MM>` | — | When the digest goes out, 24-hour local time. |
| `--digest-timezone <zone>` | — | IANA timezone for --digest-time; "local" for this machine's. |
| `--digest-to <channel:chatId>` | — | Where the digest goes; "default" for notifications.destination. |

## attach

`agentx attach`: Wear an agentx agent identity in this Claude Code session.

### `agentx attach as <agent>`

Bind this Claude Code session to an agent identity.

| Flag | Default | What it does |
|---|---|---|
| `-m, --mode <mode>` | `notify` | Delivery mode: manual \| notify \| auto. |
| `--session <id>` | — | Claude Code session id (defaults to $CLAUDE_CODE_SESSION_ID). |
| `--url <url>` | `http://127.0.0.1:19900` | Daemon base url. |

### `agentx attach detach`

Stop wearing an identity in this session (queued work falls back to spawned agents).

| Flag | Default | What it does |
|---|---|---|
| `--agent <id>` | — | Release only this identity (default: all). |
| `--session <id>` | — | Claude Code session id (defaults to $CLAUDE_CODE_SESSION_ID). |
| `--url <url>` | `http://127.0.0.1:19900` | Daemon base url. |

### `agentx attach list`

Show every attached session on this machine.

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

## usage

`agentx usage`: Token usage analysis and reporting.

### `agentx usage today`

Show today's token usage.

No flags.

### `agentx usage report`

Run full session analysis (parses Claude Code JSONL files).

| Flag | Default | What it does |
|---|---|---|
| `--days <n>` | `7` | Analyze last N days. |

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
| `-c, --cwd <cwd>` | current folder | Working directory. |

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

## wiki (advanced)

`agentx wiki`: Wiki knowledge base management. **Advanced.**

### `agentx wiki status`

Show wiki status per agent.

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

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--mode <mode>` | `graph` | Graph (default, canonical) \| unified \| flat (legacy, back-compat). |
| `--agent <id>` | — | Absorb only this agent. |
| `--dry-run` | — | Preview without running. |
| `--no-facts` | — | Skip the system-of-record lookups. |
| `--max <n>` | `10` | Max entries per agent. |
| `--since <date>` | — | Only entries dated on or after YYYY-MM-DD. |

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

### `agentx wiki serve`

Start a local web server to browse agent wikis (local + mesh).

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

Agentic wiki query — walks the catalog + wikilink graph, synthesizes an answer.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--agent <id>` | — | Which agent's wiki to query (default: first one with a catalog). |
| `--selector-model <m>` | `haiku` | Candidate-selection model. |
| `--synth-model <m>` | `sonnet` | Synthesis model. |
| `--max-candidates <n>` | `3` | Candidates from selector. |
| `--max-hops <n>` | `2` | Wikilink hops from candidates. |
| `--max-articles <n>` | `8` | Cap on total articles walked. |
| `--json` | — | Emit full result as JSON (for A/B harnesses). |
| `--trace` | — | Print selector + walk trace. |

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

Pull raw entries from mesh peers into local wiki.

| Flag | Default | What it does |
|---|---|---|
| `--dir <path>` | — | Wiki directory. |
| `--peer <url>` | — | Sync from a specific peer URL (e.g., `http://peer.example.com:19900`). |
| `--dry-run` | — | Show what would be synced without writing. |

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

Answer a queued question; writes it into the article.

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
| `--template <name>` | `linear` | Which template to use (linear \| branching \| extract \| retry). |
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

Resume a paused run.

| Flag | Default | What it does |
|---|---|---|
| `--node <id>` | — | Home-node id. |

### `agentx workflow cancel <runId>`

Cancel an active run.

| Flag | Default | What it does |
|---|---|---|
| `--node <id>` | — | Home-node id. |

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

## exec (advanced)

`agentx exec [message]`: Run one task through an agent and exit — for scripts and benchmarks. **Advanced.**

| Flag | Default | What it does |
|---|---|---|
| `-a, --agent <id>` | required | Agent id from the config. |
| `-c, --config <path>` | — | Config file (default: ./agentx.json). |
| `-m, --model <model>` | — | Override the agent's model for this task. |
| `--timeout <minutes>` | — | Upper bound on the task's run time. |
| `--setup-workspace` | — | Write the managed workspace files first, as daemon boot does. |
| `--json` | — | Print one JSON result object instead of the reply text. |

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
- **`unknown command`:** check the spelling and the command group. Advanced commands don't appear in `agentx --help`, but they still run.
- **`error: required option … not specified`:** the flag is marked **required** above. Add it and run the command again.
- **A command can't find your agents or settings:** run it from the folder that holds `agentx.json`, or pass `--config <path>` where the command offers it.
