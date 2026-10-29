# Ask the node about its machine and account

Your agents often need facts about the machine they run on: which system it is, how much memory and disk are free, which version of a program is installed, whether the Claude account has hit a usage limit, and what else is running. These facts change, some of them every hour. An agent that remembers them from an earlier conversation can repeat something that is no longer true, such as a usage limit that has already been lifted.

So the **node** (the AgentX background service on that machine) is the one source for these facts. It reads them itself and serves them with the time it checked each one. Agents ask the node instead of remembering.

## What the node reports

| Part | What it shows | When it is read |
|---|---|---|
| Machine | System name and version (for example macOS 15.1, Ubuntu 24.04), processor, memory size | When AgentX starts |
| Machine, now | Free memory, swap in use (disk space the system uses when memory runs out), free disk, load | On every question |
| Programs | The version of each program agents rely on, or "not installed" | When AgentX starts, then every 6 hours |
| Claude account | Which credential the last Claude session used, the plan's usage windows with their reset times, any usage limit holding work right now, and limits lifted in the last day | Each time Claude reports it, during agent sessions |
| Work | Sessions running, waiting and next in line (the [session queue](/jobs/session-queue)) | On every question |

When a usage limit ends, the report shows it as **lifted**, with the time, for a day. An agent that saw the limit earlier can then tell that the account has recovered.

## How agents use it

Every agent's instructions include this rule: for a fact about the machine, its programs, the Claude account or running work, call the `agentx_node` tool first, answer from it, and say when it was checked. For example, asked "is there a usage limit right now?", an agent answers "No usage limit is holding work (checked 10:42 UTC)."

Agents also stop writing these facts into their memory:

- New notes about usage limits, reset times or holds are not saved.
- A note of that kind saved before this change is shown to the agent marked **STALE**, with a pointer to `agentx_node`.
- When a session ends and the agent writes a summary for its next session, limit notes are left out of it.

## Choose which programs it checks

The node checks `claude`, `codex`, `git`, `gh`, `glab`, `node`, `pnpm`, `npm`, `python3` and `docker` unless you list others.

1. Open `agentx.json`.
2. Add an `environment` section with the programs your agents use:

```json
{
  "environment": {
    "tools": ["claude", "git", "ffmpeg", { "name": "uv", "command": "uv", "args": ["version"] }],
    "toolsRefreshHours": 6
  }
}
```

3. Save the file.
4. Restart AgentX so it reads the versions again: in a terminal, run `agentx daemon restart`.

A plain name runs `<name> --version`. Use the longer form for a program that prints its version another way.

## Check it worked

1. **Terminal:** run `agentx node`.
2. Read the output. It shows the machine, the programs and their versions, the Claude account and the work running now. Each part says when it was checked.
3. For the same data as JSON, run `agentx node --json`, or open `/api/node` on the daemon (by default `http://localhost:18800/api/node`).
4. **Chat:** ask one of your agents "What machine are you on?". It answers with the system name and the time it checked.

## If something is wrong

- **`agentx node` says HTTP 404.** The daemon is older than the command. Restart it after updating AgentX.
- **A program shows "not installed" but it is installed.** The AgentX service does not see it on its `PATH` (the list of folders it searches for programs). Give its full path as `command`, for example `{ "name": "gh", "command": "/opt/tools/bin/gh" }`.
- **The Claude account part says no session since the node started.** The node learns the account's state from Claude sessions. It fills in after the first agent reply.
- **An agent still answers a limit from memory.** Ask it to call `agentx_node`. If it says it has no such tool, its session does not load the AgentX tools; it can read the same report with `curl -s "http://localhost:18800/api/node?format=text"`.
