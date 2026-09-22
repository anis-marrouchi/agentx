# Persistent OpenCode servers

Enable `persistentProcess` on an OpenCode agent to keep its server running between
requests:

```json
{
  "tier": "opencode",
  "model": "provider/your-model",
  "persistentProcess": true
}
```

Use a model available through your configured OpenCode provider. This setting
preserves that model; it does not select a cheaper one. Restart AgentX after
changing the setting, once active tasks have finished.

## Requirements

Install OpenCode v2 and configure a provider using the
[OpenCode setup guide](https://opencode.ai/v2/docs/cli/).
Check your installation with `opencode --version`. This implementation was tested
with v2.0.12 and its `serve --stdio` and `run --server` interfaces. See the
[official command reference](https://opencode.ai/v2/docs/cli/commands/).

Missing or older installations retain the existing CLI path and its installation
error reporting. A failed server startup falls back before submitting the request.
For v2, that fallback uses `--standalone` so the private server receives AgentX's
environment. A dispatched request is never automatically replayed.

## What stays warm

Each agent/channel/chat combination gets a dedicated loopback server with a random
password. Provider and MCP services remain in that server. A small `opencode run`
client still starts per turn to stream JSON output using the existing runtime.
OpenCode v2 normally uses its own shared background service; AgentX's dedicated
servers preserve each conversation's environment and MCP identity.

The pool has eight slots and closes servers after five idle minutes. Busy servers
are never evicted. Model, workspace, permission or environment changes replace an
idle server. Fresh-session requests also replace it and omit the resume ID.
Cancellation, timeout, or failed execution invalidates the server. Daemon shutdown
closes the pool after draining active work.

These limits are fixed for now. `processPool` settings and `agentx process` commands
apply to the Claude pool, not this OpenCode pool.

## Measuring startup

Execution events expose `opencode.ready` with `startupMs` and `reused`, plus
`opencode.first_output` with `elapsedMs`. Ready time measures server acquisition;
it excludes the small per-turn CLI client and model latency. Compare repeated
requests before drawing conclusions about end-to-end response speed.
