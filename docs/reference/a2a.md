# Agent-to-agent communication

AgentX offers mesh task routing between configured daemons and a standalone A2A protocol server for external clients. Choose the interface that matches your caller.

## Send work to an AgentX peer

First [pair your machines](../jobs/tailscale.md). The peer name comes from `agentx mesh list`; the agent ID belongs to that peer:

```sh
agentx daemon send helper "Reply with a short hello" --peer work-machine
```

This sends a task through your local daemon to the named peer. It runs the remote agent with that agent's configured tools and provider. On the Hub, **Live** shows the work while it runs and **Activity** lists it once it ends.

The corresponding local HTTP request is:

```sh
curl http://127.0.0.1:18800/mesh/task \
  -H 'Content-Type: application/json' \
  -d '{"peer":"work-machine","agent":"helper","message":"Reply with a short hello"}'
```

Remote protected daemon requests need `Authorization: Bearer <mesh-token>`. Reads that expose task content are protected the same way: task traces (`/traces`, `/traces/<id>`), which hold each task's full prompt and answer, recent events and agent memory. On the daemon's own machine they need no token. The daemon's `/mesh/task` endpoint also supports `stream: true`. Asynchronous delivery requires an originating `context.channel` and `context.chatId` so the result has a return destination.

When an agent sends work from a conversation a person started, the request returns at once and the answer comes back to that agent as a new message. See [When an agent asks another agent](../jobs/ask-another-agent.md).

## Send work to an agent on this machine

A script on the same machine can give work to one of its agents with `POST /task`:

```sh
curl http://127.0.0.1:18800/task \
  -H 'Content-Type: application/json' \
  -d '{"agent":"helper","message":"Reply with a short hello"}'
```

The request stays open until the agent answers. If the agent is busy with other work, the request first waits for it to be free, for up to 25 minutes.

**Keep the connection open if the message must run.** A caller that disconnects (for example `curl -m 30` timing out) before the agent is free has its request dropped: it never runs, and nothing is sent back. Once the agent has started the work, a disconnect no longer stops it. There is no fire-and-forget mode for scripts: only an agent asking from a conversation a person started gets an early answer and its reply later ([When an agent asks another agent](../jobs/ask-another-agent.md)). So set your client's timeout to more than 25 minutes plus the time the work takes, and don't treat a timeout as "delivered". If you resend after a timeout, the message may run twice when the first attempt had already started.

## See the hand-offs and read one by its id

A **hand-off** is one piece of work an agent on this machine gave to another agent. Each one has an id that starts with `dlg-`. AgentX keeps every hand-off in its database (`.agentx/db.sqlite`), so the list and the answers are still there after a restart. They are deleted with old requests, after `requests.retentionDays`.

**List the newest hand-offs** with `GET /a2a/delegations`. Each entry says who asked whom, the status (`running`, `done`, `waiting`, `error`, `timeout` or `lost`) and when it started and ended. The list never holds the question or the answer. On a machine without the database it shows only the hand-offs since the last restart.

```sh
curl -s http://127.0.0.1:18800/a2a/delegations
```

**Read one hand-off and its answer** with `GET /a2a/delegations/<id>?as=<agent>`. Name the asking agent or the agent that did the work with `as`:

```sh
curl -s "http://127.0.0.1:18800/a2a/delegations/dlg-example?as=helper"
```

The answer has these fields:

| Field | Meaning |
|---|---|
| `id`, `caller`, `callee` | The hand-off, the agent that asked and the agent that did the work |
| `peer` | The other machine, when the work went to one |
| `status` | `running` until it ends, then how it ended |
| `text` | What the agent answered, or why it failed. At most 12,000 characters |
| `waiting` | For `waiting`: what it waits for (`on`), until when (`dueAt`, when given), and `kind`: `waiting` (it waits on something) or `continue` (it carries on later by itself) |
| `startedAt`, `endedAt` | When it started and ended |

Who may read a hand-off:

- On this machine: a request that names the hand-off's asking agent or the agent that did the work in `as`.
- Another machine: it needs a mesh token, and `as` names one of its own agents. With its own per-peer token it can read only hand-offs given to that machine. With the shared mesh token, the daemon cannot tell machines apart, so it can read any hand-off that went to another machine and was given to the agent it names. Give each machine its own token if that matters to you.
- A request with the operator key (`.agentx/operator.key`, sent as the `X-AgentX-Operator` header) reads every hand-off.

`GET /a2a/delegations/<id>/reply` is something else: the reply the asking agent sent back to a person on the phone app, kept for a day for the conversation thread.

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

## Check it worked

1. **Terminal:** run `agentx mesh list`. The peer you send to is listed.
2. **Terminal:** send the hello task above. The reply prints in the terminal, and the work shows on the Hub's **Activity** page.
3. **Terminal:** send the `POST /task` request above. It prints the agent's answer as JSON.
4. **Terminal:** run `curl -s http://127.0.0.1:18800/a2a/delegations`. The newest hand-offs are listed, also after AgentX restarts. Take an `id` and its `caller` from the list and run `curl -s "http://127.0.0.1:18800/a2a/delegations/<id>?as=<caller>"`. It prints the status and, once it has ended, the answer in `text`.
5. For the standalone server: `curl http://127.0.0.1:3171/.well-known/agent-card.json` returns the agent card.

## If something is wrong

- **`Mesh not enabled`:** this daemon has no mesh set up. [Pair your machines](../jobs/tailscale.md) first.
- **`401` from the peer:** the two machines don't share the same mesh token. See [Add a second machine](../jobs/second-machine.md).
- **The peer can't find the agent:** the agent ID must be one configured on that peer, not on this machine.
- **A `POST /task` message never ran:** the caller probably disconnected while the agent was busy. The daemon log shows `caller gone during slot wait — not starting`. Keep the connection open longer and send it again.
- **Reading a hand-off gives `400`:** add `?as=<agent>` with the asking agent or the agent that did the work.
- **Reading a hand-off gives `404`:** the id is wrong, the agent in `as` is neither of the two agents, or the hand-off is older than `requests.retentionDays` and was deleted. Check the id in `GET /a2a/delegations`.
- **Reading a hand-off gives `409`, or the list is empty after a restart:** the database did not open on this machine, so hand-offs are kept in memory only. `curl -s http://127.0.0.1:18800/health | jq .handoffs` prints `"memory-only"`. See [When an agent asks another agent](../jobs/ask-another-agent.md) for the fix.
- **A hand-off has no `text`:** it is still `running`, or it ended before this version of AgentX kept answers.
- **The standalone server doesn't answer:** check that the chosen `--provider` is installed and signed in on that machine.
