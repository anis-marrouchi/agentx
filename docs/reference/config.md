# Configuration reference

The setup wizard writes `agentx.json` in the working directory. Use `agentx config check` after manual edits and `agentx config show` to inspect effective settings. Keep credentials out of the JSON file when an environment-variable reference is available.

The top-level configuration covers agents, channels, schedules (`crons`), dashboard, and mesh. The checked-in [example configuration](/examples/agentx.example.json) is a starting point, not a credential store. The runtime validator in `src/daemon/config.ts` is authoritative for accepted fields.

Changing a setting does not install a missing provider CLI or sign it in. Restart the relevant service if the setting is not picked up automatically.

| Section | What it controls |
|---|---|
| `node` | Host identity, API bind address, default agent |
| `agents` | Workspace, engine (`tier`), model, mentions and concurrency per agent |
| `providers` | API credentials and provider defaults |
| `channels` | Enabled adapters and their routing rules |
| `crons` | Timed prompts or commands, timezone, failure behavior and an optional `fireToken` ([fire a routine](/jobs/fire-a-routine)) |
| `workflows` | Whether the workflow engine is enabled |
| `dashboard` | Browser bind address, port and `daemonUrl` |
| `mesh` | Peer URLs and authentication |

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
  "dependency-audit": { "schedule": "0 7 * * 1", "agent": "coder", "prompt": "Audit outdated dependencies", "autonomy": "report" }
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

**Stopping a run.** When you cancel a run, or its time limit passes, the run ends and its slot is freed, even if the step it was on never answers. The agents list (`/agents`) shows the step each running task is on, for example `classify` or `agent`, so you can see where a run is waiting.

### Check it worked

1. List the agents: `curl -s http://127.0.0.1:18800/agents`. Under the agent, `runningTasks` shows each run with its `id` and `step`.
2. Cancel the run: `curl -s -X POST http://127.0.0.1:18800/api/tasks/<id>/cancel`. The answer is `{"ok":true,…}`.
3. List the agents again. The run is gone and the agent's `active` count went down by one.

### If something is wrong

- **A run ended with "timed out after …s".** Its limit was too short for the work. Raise `timeoutMinutes` (or the job's `timeout`) and run it again.
- **A cancelled run is still listed.** Check the daemon log for a line ending in `aborted in step "<name>"`. If it is missing, the cancel did not reach this daemon: check that you cancelled on the machine running the agent.

<!-- No screenshot needed: field reference, with the web flow shown in Settings. -->
