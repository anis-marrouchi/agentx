# CLI reference

The npm package is `agentix-cli`; the executable is `agentx`. Run `agentx <command> --help` for flags and examples. The commands below are registered in the current CLI.

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
| Inspect usage | `agentx usage` |
| Validate configuration | `agentx config check` |
| Expose MCP over stdio | `agentx serve --stdio` |
| Run a scripted tour | `agentx demo` |

Advanced commands remain callable even though they do not appear in the main help list: `board`, `workflow`, `webhook`, `cron`, `mesh`, `wiki`, `watch`, `trace`, `ledger`, `decisions`, `graph`, `procedure`, `token`, and others. Use each command's `--help` rather than assuming its flags.

`agentx monitor` is hook plumbing for external CLI-session reviews; it does not open the **Monitor** dashboard tab. `agentx chat` is deprecated in favor of `attach`.

## On your Mac: experimental helpers

`point`, `look`, and `paste` require macOS, the native helper installed by `agentx desktop install`, and a terminal. **`point` shows you what it would click; it never clicks.** The native helper and `teach` lessons can click and type; inspect a lesson before running it. `--no-speak` only turns off narration.

## Before copying commands

Run commands from the directory containing your `agentx.json`, unless a command provides a configuration flag. From a source checkout, use `node dist/cli.js` instead of `agentx`. Arguments in angle brackets are placeholders; replace them without the brackets. Commands that dispatch work can incur model usage.

## Desktop assistant

```sh
agentx desktop install --agent coder-agent
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
| `agentx daemon logs` | Read logs; check `--help` for follow options |
| `agentx daemon stop` | Stop the daemon after its running tasks finish ([restart without losing work](../jobs/restart-safely.md)) |
| `agentx config check` | Validate the configuration |
| `agentx config get <path>` | Read one configuration field |
| `agentx config set <path> <value>` | Change a field; inspect the reload/restart result |
| `agentx doctor` | Check local installation and prerequisites |
| `agentx notify "<message>"` | Push to your phone and show a Mac banner, held during Focus; see [Get notified](../jobs/notifications.md) |
| `agentx notifications show` | Notification routing, the local banner and sound, and ntfy status |
| `agentx notifications local` | `--banner`, `--sound`, `--sound-name`, `--volume`, `--icon` for the Mac banner and sound |
| `agentx notifications ntfy` | `--server`, `--topic`, `--token`, `--enable`/`--disable` for phone push |

Do not share `config show` output without checking it for credentials. Starting a daemon does not start the separate browser dashboard.

## Talk to an agent

```sh
agentx daemon send coder-agent "Explain this project's purpose"
agentx tui --agent coder-agent
agentx tui --legacy
agentx attach as coder-agent
```

`daemon send` runs a task. `tui` opens the interactive terminal interface. `attach as` binds an external editor/CLI session to an AgentX identity; it does not open a chat. Use `agentx attach list` to inspect bindings and `agentx attach detach` to release them.

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

## Agent memory

How to use these, step by step: [Review what your agents learn](../jobs/agent-memory.md).

| Command | What it does |
|---|---|
| `agentx memory facts summary` | Count each agent's facts by source trust and review state |
| `agentx memory facts held` | List facts waiting for approval |
| `agentx memory facts approve <id> --agent <id>` | Let a held fact be used |
| `agentx memory facts reject <id> --agent <id>` | Keep a held fact out for good |
| `agentx memory facts scrub [--apply]` | Count stored facts that contain credentials; `--apply` deletes them |
| `agentx wiki promote [--commit]` | Preview (or, with `--commit`, judge and propose) lessons for the shared wiki |
| `agentx wiki proposals list` | Proposed lessons waiting for review |
| `agentx wiki proposals show <id>` | The proposed article and its evidence |
| `agentx wiki proposals approve <id>` | Write it into the shared wiki; refuses if the article changed since, unless `--force` |
| `agentx wiki proposals reject <id> [--reason]` | Decline it; its sources aren't judged again until they change |

## Computer use and teaching

Install the [desktop assistant](../dashboard/voice.md) first. These tools interact with the current macOS desktop, not the browser tab displaying this documentation.

| Command | What it does |
|---|---|
| `agentx point "the search field"` | Locate and highlight; does not click |
| `agentx point "the search field" --json` | Print the selection without pointing |
| `agentx look "What is visible?"` | Capture the focused window and request a vision observation |
| `agentx look "The command palette is open" --verify --json` | Check a claim and return structured evidence |
| `agentx look "What is visible?" --screen` | Capture the full screen instead |
| `agentx teach` | List bundled lessons |
| `agentx teach <lesson>` | Run a lesson; can narrate, point, click, type, and verify |
| `agentx teach <lesson> --record --record-dir <directory>` | Record with macOS screencapture |
| `agentx paste --help` | Inspect smart-paste options before using it |

For `look --verify`, exit codes are **0 confirmed**, **3 refuted**, **4 unknown**, and **1 operational error**. A vision call sends pixels to the configured provider. `point` uses a typed decision seat; [Jev](../architecture/jev.md) explains its configuration.

## Mesh and decisions

```sh
agentx mesh list
agentx mesh health
agentx daemon send coder-agent "Reply with a short hello" --peer work-machine
agentx decisions backends
agentx decisions stats --since 1d
```

See [Tailscale pairing](../jobs/tailscale.md), [A2A communication](a2a.md), and [decision seats](../architecture/jev.md) for setup and interpretation.

## Find every command and flag

`agentx --help` lists the primary commands and names the advanced groups. Hidden groups remain callable. Use `agentx <group> --help`, then `agentx <group> <command> --help` for exact arguments, options, and defaults from your installed version. This matters when your installation differs from the documentation checkout.
