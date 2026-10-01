# Configuration reference

The setup wizard writes `agentx.json` in the working directory. Use `agentx config check` after manual edits and `agentx config show` to inspect effective settings. Keep credentials out of the JSON file when an environment-variable reference is available.

The top-level configuration covers agents, channels, schedules (`crons`), dashboard, and mesh. The checked-in [example configuration](/examples/agentx.example.json) is a starting point, not a credential store. The runtime validator in `src/daemon/config.ts` is authoritative for accepted fields.

Changing a setting does not install a missing provider CLI or sign it in. Restart the relevant service if the setting is not picked up automatically.

| Section | What it controls |
|---|---|
| `node` | Machine identity, API bind address, default agent |
| `agents` | Workspace, engine (`tier`), model, mentions and concurrency per agent |
| `providers` | API credentials and provider defaults |
| `channels` | Enabled adapters and their routing rules ([channels](./channels.md)) |
| `crons` | Timed prompts or commands, timezone, failure behavior and an optional `fireToken` ([fire a routine](/jobs/fire-a-routine)) |
| `services` | Named services with trigger patterns and allowed contacts |
| `notifications` | Where AgentX pings you about finished, failed or long tasks ([get notified](/jobs/notifications)) |
| `shutdown` | How long a stop waits for running tasks ([restart without losing work](/jobs/restart-safely#change-how-long-it-waits)) |
| `resume` | What happens to work a restart cut off ([restart without losing work](/jobs/restart-safely)) |
| `voice`, `meshVoices` | How agents speak aloud ([desktop assistant](/dashboard/voice)) |
| `workflows` | Whether the workflow engine is enabled, where definitions live, and the editor mode |
| `webhooks` | Incoming webhook sources and the workflows they start |
| `session` | When a conversation's memory is rotated or considered stale |
| `processPool` | How long warm agent processes are kept |
| `decisions` | Typed-decision backends ([Jev](/architecture/jev)) |
| `procedures`, `graph`, `business`, `boards`, `plugins` | Optional layers: learned procedures, the intent graph, org chart and projects, kanban boards, and plugins |
| `dashboard` | Browser bind address, port and `daemonUrl` |
| `mesh` | Peer URLs and authentication |
| `approvals` | How long decision cards wait, what "later" means, and the daily digest ([Approvals](/dashboard/approvals#settings)) |
| `requests` | Records what you asked agents for and follows it until it is closed; off by default ([Configuration: automation](./config-automation.md#requests)) |

Every field, with its type, default and what it does, is listed on four pages:

| Page | Sections |
|---|---|
| [Agents and runtime](./config-agents.md) | `node`, `providers`, `agents`, `session`, `processPool`, `plugins` |
| [Channels](./config-channels.md) | `channels`: Telegram, WhatsApp, GitLab, GitHub, phone app notifications, ntfy, browser calls |
| [Automation](./config-automation.md) | `crons`, `services`, `webhooks`, `workflows`, `procedures`, `notifications`, `approvals`, `requests`, `shutdown`, `resume` |
| [Dashboard, mesh and optional layers](./config-operations.md) | `dashboard`, `mesh`, `meshVoices`, `voice`, `screen`, `business`, `boards`, `graph`, `decisions` |

These pages are checked against the schema in `src/daemon/config.ts`. If your installed version differs, that file is the final word.

For a local installation, `node.bind` normally stays `127.0.0.1:18800` and `dashboard.daemonUrl` points to `http://127.0.0.1:18800`. In the supplied Compose setup they are `0.0.0.0:18800` and `http://daemon:18800`; host port bindings remain local.

String values can contain environment references such as `${ANTHROPIC_API_KEY}`. Missing variables expand to empty strings, which may fail validation or leave a provider unusable. The daemon loads `.env` from its working directory. Run configuration commands from that same directory.

Use `agentx config get <path>` to inspect one value and `agentx config set <path> <value>` to change it. For example, `agentx config set workflows.enabled true` enables the engine. Treat `config show` output as sensitive because effective configuration can contain expanded credentials.

## Routine autonomy

A cron job, or an `agent` step in a workflow, can run with less than its agent's full permissions by setting `autonomy`:

| Level | What the routine may do |
|---|---|
| `report` | Read only. No file writes, no mutating shell commands, no posting through tools. Its final answer is the only output. |
| `propose` | Edit files, commit, push a named feature branch, open a merge request or draft. It cannot merge, deploy, delete, force-push, push to protected branches or operate hosts. |
| `act` (default) | The agent's normal permissions, as before. |

```json
"crons": {
  "dependency-audit": { "schedule": "0 7 * * 1", "agent": "reviewer", "prompt": "Audit outdated dependencies", "autonomy": "report" }
}
```

The level applies to that run only. It is enforced by a guard hook on the run's own `claude` process, not by the prompt, so other conversations with the same agent are not affected. Blocked tool calls are denied, written to the guard log (`agentx guard log`), and listed under `autonomyBlocks` in the cron run record or the workflow step output.

Only the `claude-code` tier can enforce `report` and `propose`. On any other tier, or when the agent is only reachable through a mesh peer, the run fails with an error; it is never run with full permissions instead. A restricted run always starts its own process and does not reuse a warm persistent process. `report` is an allowlist. `propose` is a denylist of act-level steps, so an agent that tries hard enough can get around it through indirection. Use `report` when you need a hard boundary.

## Time limits and cancel

A run is one piece of work an agent does, such as answering a message or running a scheduled job. Each run takes one of the agent's slots (`maxConcurrent`). A run that never finishes keeps its slot, so AgentX gives runs a time limit and lets you stop them.

**Scheduled jobs (`crons`).** Every job has a `timeout` in seconds (default 600).

- For a **command** job, `timeout` is the limit for the shell command.
- For an **agent** job, the limit is the larger of `timeout` and 2 hours. Agent jobs often take longer than their `timeout`, so a short `timeout` does not cut them off. The 2-hour minimum exists to end a run that is stuck.
- The run record for an agent job stores the limit that was used, in seconds, as `timeout`.

```json
"crons": {
  "weekly-review": { "schedule": "0 8 * * 1", "agent": "writer", "prompt": "Review last week", "timeout": 10800 }
}
```

Here the limit is 3 hours, because 10800 seconds is longer than the 2-hour minimum.

**Other runs.** A workflow `agent` step, `agentx exec --timeout <minutes>` and a workflow API request can set `timeoutMinutes`. When set, the run is stopped once that many minutes have passed, including runs on this machine. Leave room for slow work: an agent that edits code or reviews a pull request can take 20 minutes or more.

**Every run: getting ready.** Before an agent process starts, a run goes through a few preparation steps, such as reading the conversation history and choosing a model. Each agent's `preSpawnTimeoutSec` (default 300 seconds) limits that preparation. If the agent process has not started by then, the run is stopped and its slot is freed. This covers every run, including runs started by a chat message or a webhook, which have no other time limit. The run's record in the task history is marked `"status": "timeout"`, with `step` naming where it was stuck.

```json
"agents": {
  "helper": { "name": "Helper", "workspace": "./helper", "preSpawnTimeoutSec": 600 }
}
```

The daemon log has one line per preparation step, for example `[helper] step classify task=<id> chat=<channel>:<chat> at=<time>`. The `executing task`, `busy, message queued`, `flushing` and `completed` lines carry the same run id and time, so you can follow one run through the log.

**Stopping a run.** When you cancel a run, or its time limit passes, the run ends and its slot is freed, even if the step it was on never answers. The agents list (`/agents`) shows the step each running task is on, for example `classify` or `agent`, so you can see where a run is waiting.

### Try a cancel

1. **Terminal:** list the agents: `curl -s http://127.0.0.1:18800/agents`. Under the agent, `runningTasks` shows each run with its `id` and `step`.
2. **Terminal:** cancel the run: `curl -s -X POST http://127.0.0.1:18800/api/tasks/<id>/cancel`. The answer is `{"ok":true,…}`.
3. **Terminal:** list the agents again. The run is gone and the agent's `active` count went down by one.

### When a run is cut short

- **A run ended with "timed out after …s".** Its limit was too short for the work. Raise `timeoutMinutes` (or the job's `timeout`) and run it again.
- **A run ended with `timed out before spawn after …s in step "<name>"`.** A preparation step never finished. The step name tells you which one; search the daemon log for the run's `task=<id>` to see the steps it went through. If the step is slow but working, raise the agent's `preSpawnTimeoutSec`.
- **A cancelled run is still listed.** Check the daemon log for a line ending in `aborted in step "<name>"`. If it is missing, the cancel did not reach this daemon: check that you cancelled on the machine running the agent.

<!-- No screenshot needed: field reference, with the web flow shown in Settings. -->

## Check it worked

1. **Terminal:** in the folder with `agentx.json`, run `agentx config check`. It prints `✓ Config valid`.
2. **Terminal:** run `agentx config get <path>` for the field you changed, for example `agentx config get workflows.enabled`. It prints the new value.
3. **Terminal:** run `agentx daemon status` to confirm the daemon is running with it.

## If something is wrong

- **`config check` reports an error:** it names the field. Fix that field, or restore a backup: every dashboard save leaves a copy named `agentx.json.bak.<timestamp>` next to the file.
- **A value is empty at runtime:** an `${ENV_VAR}` reference points at a variable missing from `.env`. Add it, then restart the daemon.
- **The change isn't picked up:** `config set` and dashboard saves reload the daemon, but some settings (such as a model change) only apply after a full restart: `agentx daemon stop`, then `agentx daemon start --detach`.
