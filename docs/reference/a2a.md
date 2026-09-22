# Agent-to-agent communication

AgentX offers mesh task routing between configured daemons and a standalone A2A protocol server for external clients. Choose the interface that matches your caller.

## Send work to an AgentX peer

First [pair your machines](../jobs/tailscale.md). The peer name comes from `agentx mesh list`; the agent ID belongs to that peer:

```sh
agentx daemon send coder-agent "Reply with a short hello" --peer work-machine
```

This sends a task through your local daemon to the named peer. It runs the remote agent with that agent's configured tools and provider. Check **Operations** and **Activity** to inspect the work.

The corresponding local HTTP request is:

```sh
curl http://127.0.0.1:18800/mesh/task \
  -H 'Content-Type: application/json' \
  -d '{"peer":"work-machine","agent":"coder-agent","message":"Reply with a short hello"}'
```

Remote protected daemon requests need `Authorization: Bearer <mesh-token>`. The daemon's `/mesh/task` endpoint also supports `stream: true`. Asynchronous delivery requires an originating `context.channel` and `context.chatId` so the result has a return destination.

## Serve the standalone A2A protocol

The standalone command starts a separate provider-backed server. It does not select a named daemon agent. Configure and authenticate the chosen provider first:

```sh
agentx a2a --host 127.0.0.1 --port 3171 --provider claude-code
```

Its agent card is available at `GET /.well-known/agent-card.json`. Send JSON-RPC requests to `POST /`:

```sh
curl http://127.0.0.1:3171/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tasks/send","params":{"id":"hello-1","message":{"role":"user","parts":[{"type":"text","text":"Reply with a short hello"}]}}}'
```

| Implemented method | Purpose |
|---|---|
| `tasks/send` | Run a task and return its result |
| `tasks/sendSubscribe` | Stream task updates over SSE |
| `tasks/get` | Read a task's state |
| `tasks/cancel` | Request cancellation |

These are the method names implemented by this checkout; check external clients for protocol compatibility. Task state lives in memory and is lost when the standalone server stops. It does not implement mesh bearer authentication, so keep it on loopback or provide an authenticated gateway for remote use. The command's default host is `0.0.0.0`; the example deliberately sets loopback.

For source installations, use `node dist/cli.js` in place of `agentx` in these commands.
