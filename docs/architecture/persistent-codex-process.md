# Persistent Codex processes

AgentX normally starts `codex exec` for every request. To retain a Codex
app-server between requests, enable the following on a `codex-cli` agent:

```json
{
  "tier": "codex-cli",
  "persistentProcess": true
}
```

Restart the AgentX daemon after changing this setting, once active work has drained.
The first request starts the process; subsequent requests to the same conversation
reuse it. Model inference and context processing still take time. This setting
does not change the selected model or enable a cheaper fallback model.

## Requirements and configuration

Install and authenticate Codex first (`codex login`). Your installation must support
`codex app-server` with `initialize`, `thread/start`, `thread/resume` and `turn/start`.
See the [official app-server documentation](https://developers.openai.com/codex/app-server/).
An older CLI or failed initialization falls back to the existing `codex exec` path
before any turn is submitted. Codex itself must still be installed for that fallback.

**Configuration difference:** app-server loads the operator's Codex configuration;
it does not support the exec path's `--ignore-user-config` flag. Review your Codex
configuration (including additional MCP servers) before opting in. AgentX explicitly
sets the workspace, configured model, AgentX MCP connection, sandbox and approval
policy for each thread. Interactive approval requests are rejected. Default agents
use `workspace-write`; only `bypassPermissions` agents use `danger-full-access`.

## Lifecycle and isolation

- Each agent/channel/chat combination has its own process and MCP environment.
- Workspace, model, permission or environment changes replace the idle process.
- A fresh session replaces the process. Otherwise, only a supplied session ID is
  resumed; requests without a session ID start a new thread.
- The pool retains at most eight processes and closes idle processes after five
  minutes. At capacity it evicts an idle process or uses the CLI fallback.
- Cancellation, process crashes and turn deadlines close the affected process.
  Requests are never automatically replayed after `turn/start` is sent.
- Daemon shutdown closes the pool after draining work.

These Codex limits are currently fixed; the `processPool` configuration and
`agentx process` commands manage the separate Claude pool. OpenCode still starts
its CLI for each request.

## Measuring startup

Execution events include `codex.ready` (`reused`, `startupMs`) and
`codex.first_output` (`elapsedMs`, `reused`). Compare cold and reused requests in
execution logs. Ready time includes initialization and thread start/resume;
first-output time also includes model latency. No production speedup is assumed
without these measurements.
