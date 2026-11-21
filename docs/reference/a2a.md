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

Remote protected daemon requests need `Authorization: Bearer <mesh-token>`. Reads that expose task content are protected the same way: task traces (`/traces`, `/traces/<id>`), which hold each task's full prompt and answer, recent events and agent memory. On the daemon's own machine they need no token. The daemon's `/mesh/task` endpoint also supports `stream: true`, which sends the peer's answer back piece by piece while it is written.

### Get the answer later, in a chat

Add `"async": true` and a `context` that names a chat (`channel` and `chatId`). The request then returns at once, and the peer's answer is sent to that chat when it is ready:

```sh
curl http://127.0.0.1:18800/mesh/task \
  -H 'Content-Type: application/json' \
  -d '{"peer":"work-machine","agent":"helper","message":"Check the build",
       "async":true,"context":{"channel":"telegram","chatId":"12345","agentId":"assistant"}}'
```

The answer comes back at once with status `202`:

```json
{ "accepted": true, "mode": "deliver", "taskId": "dlg-example", "agent": "helper", "peer": "work-machine",
  "deliverTo": "telegram:12345",
  "note": "The result will be delivered to the originating chat when the peer finishes. Read it any time with GET /a2a/delegations/dlg-example." }
```

What happens next:

1. The peer runs the work. Nobody holds a connection open for it.
2. When it answers, the answer is sent as it is to the chat in `context`, as the agent named in `context.agentId`. This includes an answer that says the work is blocked: that is still the peer's answer.
3. If the call fails, times out or AgentX restarts before it answers, that chat gets one short line instead: `Delegation to work-machine/helper failed: ...`.

Two limits to know:

- **The chat is told at most once.** AgentX records the end of the hand-off first and then sends to the chat. If AgentX stops between those two steps, the chat is never told. The answer is still in the hand-off: read it by its id.
- **The time limit is `mesh.delegation.timeoutMinutes`** (30 minutes by default). The hand-off ends `timeout` at that limit, and the chat gets the failure line. The call to the peer has its own 30-minute limit. If you set `mesh.delegation.timeoutMinutes` lower than 30, a peer that answers after your limit but within 30 minutes has its answer dropped: the hand-off has already ended.

Each such request is a **hand-off** with a `dlg-` id, like the ones agents make. So you can read its status and answer later with `GET /a2a/delegations/<id>` ([see below](#see-the-hand-offs-and-read-one-by-its-id)), and the same request sent again while the first still runs starts nothing ([see below](#what-happens-when-the-same-message-is-sent-twice)). With no `agent`, the peer picks one, and the hand-off names it `default`.

Without `async`, or without a chat in `context`, `/mesh/task` from a caller that names no agent (the command line, a script, the phone app) works as before: it waits for the answer, or streams it with `stream: true`. `async: true` with no chat in `context` gets `400`, because there is nowhere to send the answer.

A request from an agent never waits: see [Agents get a receipt, never a wait](#agents-get-a-receipt-never-a-wait).

## Send work to an agent on this machine

A script on the same machine can give work to one of its agents with `POST /task`:

```sh
curl http://127.0.0.1:18800/task \
  -H 'Content-Type: application/json' \
  -d '{"agent":"helper","message":"Reply with a short hello"}'
```

The request stays open until the agent answers. If the agent is busy with other work, the request first waits for it to be free, for up to 25 minutes. This holds for a caller that names no agent. An agent gets a receipt instead ([below](#agents-get-a-receipt-never-a-wait)).

**Keep the connection open if the message must run.** A caller that disconnects (for example `curl -m 30` timing out) before the agent is free has its request dropped: it never runs, and nothing is sent back. Once the agent has started the work, a disconnect no longer stops it. There is no fire-and-forget mode for scripts that name no agent: only an agent gets an early answer and its reply later ([below](#agents-get-a-receipt-never-a-wait)). So set your client's timeout to more than 25 minutes plus the time the work takes, and don't treat a timeout as "delivered". If you resend after a timeout, the message may run twice when the first attempt had already started.

## Agents get a receipt, never a wait

On `POST /send/agent`, `POST /task` and `POST /mesh/task`, who asks decides whether the request waits, not its options. The daemon works out the caller first:

| Caller | Answer |
|---|---|
| An agent with a running turn that can be called back | `202`, `"mode": "callback"`. The answer arrives later as a new message in that agent's conversation |
| An agent that cannot be called back: only `senderAgentId` names it (from this machine), it asks from a person's chat, it is four hops deep, or `mesh.delegation.callbackSends` is `false` | `202`, `"mode": "none"`. Read the answer by its id. The agent gets a short notice when it ends |
| An agent on `/mesh/task` with `"async": true` and a chat in `context` | `202`, `"mode": "deliver"`: the answer goes to that chat ([above](#get-the-answer-later-in-a-chat)) |
| Nobody names an agent: the command line, workflow steps, another machine, the phone app, `agentx mesh ask`, a stream proxy | `/task` and `/mesh/task` wait for the answer (or stream it), as before. `/send/agent` answers `202` with `"mode": "none"` |
| A `/mesh/task` to a guest host (a machine this one joined as a guest) | Always one request that waits for the answer, for an agent too |

From an agent, `"stream": true`, an `Accept: text/event-stream` header and `"async": false` are ignored. The `202` says so with `"streamIgnored": true` or `"asyncIgnored": true`. An agent named only by `senderAgentId` counts only when the request comes from this machine and is not forwarded by another machine: an agent of the same name on another machine stays a caller that waits.

On `/mesh/task`, the request's `context` still goes to the other machine, which uses it to keep one conversation per chat. Only an explicit `"async": true` sends the answer to that chat; without it the answer comes back to the agent.

A `none` receipt looks like this:

```json
{ "accepted": true, "mode": "none", "taskId": "dlg-…", "agent": "helper",
  "note": "Sent to helper (task dlg-…). … read the answer with agentx_lookup or GET /a2a/delegations/dlg-…?as=<you>. Do not wait or poll for it." }
```

Every one of these is a hand-off with a `dlg-` id. The old `snd-…` ids are gone, and `"async": false` no longer makes `/send/agent` wait. A `snd-` send that was still running when you upgraded is not reported, as on any restart before.

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
| `wayHome` | `deliver` for a `/mesh/task` sent with `async: true`: the answer went to the chat the request named. `none` when no turn could be called back: read it here. Absent when the answer goes back to the asking agent as a message |

**An empty answer.** Sometimes the agent that did the work ends its run without writing an answer. The hand-off then ends `error` with the text `empty answer from <agent>`, but only when that agent said nothing else either. It did not state its job's state ([Say where the work stands when a run ends](../jobs/end-of-run-state.md)), did not say it was waiting (`agentx_waiting`), and did not write back to the asking agent during the work. If it did any of those, the empty end is on purpose, and the hand-off ends as that says: `done`, `waiting`, or `error` for a blocked job.

Who may read a hand-off:

- On this machine: a request that names the hand-off's asking agent or the agent that did the work in `as`.
- Another machine: it needs a mesh token, and `as` names one of its own agents. With its own per-peer token it can read only hand-offs given to that machine. With the shared mesh token, the daemon cannot tell machines apart, so it can read any hand-off that went to another machine and was given to the agent it names. Give each machine its own token if that matters to you.
- A request with the operator key (`.agentx/operator.key`, sent as the `X-AgentX-Operator` header) reads every hand-off.

`GET /a2a/delegations/<id>/reply` is something else: the reply the asking agent sent back to a person on the phone app, kept for a day for the conversation thread.

## What happens when the same message is sent twice

An agent sometimes sends the same hand-off again, for example after its tool call timed out. AgentX runs it only once.

Two sends count as **the same** when all five match:

- the agent that asks,
- the agent that does the work,
- the work's home (the issue or merge request named in `home`, or none),
- the conversation the asking agent sends from,
- the full message text.

While the first hand-off is still `running`, the second send starts nothing. It gets back the first hand-off's id, with `"duplicate": true`:

```json
{ "accepted": true, "mode": "callback", "taskId": "dlg-example", "agent": "helper", "duplicate": true,
  "note": "Already handed off as task dlg-example; this repeat started nothing. ..." }
```

The answer still comes back once, to the conversation that asked. A duplicate does not count against the [hand-off budget](../jobs/ask-another-agent.md) and adds nothing to the Activity page.

When the work is new:

- **A different message** is new work, even on the same home. It gets its own hand-off, and the two run one after the other, as before.
- **The same text from another conversation** of the same agent runs again. The daemon log says so once for each such send: `same text already open from another chat (...) as dlg-...; runs again (N since start)`. N counts these sends since the daemon started.
- **A hand-off that has ended** frees its message: sending it again starts a new run. This includes a hand-off that ended `waiting` on something, such as a review.
- **One exception:** a hand-off that ended `waiting` with `kind` `continue` (the agent carries on later by itself) keeps its message until its due time, or for 10 minutes after it ended when it gave no due time. A resend inside that time gets the same id with `"duplicate": true`, so the same job does not run twice.

For a `/mesh/task` sent with `async: true`, "the agent that asks" is the agent named in `context.agentId` (or `senderAgentId`), "the agent that does the work" includes its peer, and "the conversation" is the chat named in `context`. A repeat gets the first `taskId` with `"mode": "deliver"` and `"duplicate": true`, and the chat gets the answer once.

This applies to hand-offs with a `dlg-` id. A machine without the database (`/health` shows `handoffs: "memory-only"`) keeps the older check: the same message from the same sender to the same agent within 10 minutes gets the first task id back.

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
5. **Terminal:** for a hand-off that ended `error`, read it as in step 4. The text `empty answer from <agent>` means that agent ended its run with nothing at all. Any other text is the real failure.
6. **Terminal:** while a hand-off from an agent is still `running`, have that agent send the same message again from the same conversation. The answer has the same `taskId` and `"duplicate": true`, and `GET /a2a/delegations` lists only one hand-off for it. The daemon log shows `the same message again ... joined`.
7. **Terminal:** send the `async: true` request above with a chat of your own in `context`. It returns at once with `"mode": "deliver"` and a `dlg-` `taskId`. The answer arrives in that chat. Then run `curl -s "http://127.0.0.1:18800/a2a/delegations/<taskId>?as=<context.agentId>"`: it shows `"wayHome": "deliver"`, the status, and the answer in `text`.
8. **Terminal:** from a script, send as an agent of this machine and check the receipt comes at once, even when you ask to wait:
   ```sh
   curl -s -m 10 http://127.0.0.1:18800/task -H 'Content-Type: application/json' \
     -d '{"agent":"helper","senderAgentId":"asker","message":"Reply with a short hello","async":false}'
   ```
   The answer has `"accepted": true`, `"mode": "none"`, a `dlg-` `taskId` and `"asyncIgnored": true`. The same request without `senderAgentId` waits and returns the hello.
9. **Terminal:** run `curl -s "http://127.0.0.1:18800/a2a/delegations/<taskId>?as=asker"`. It shows `"wayHome": "none"` and, once the work is done, the answer in `text`.
10. For the standalone server: `curl http://127.0.0.1:3171/.well-known/agent-card.json` returns the agent card.

## If something is wrong

- **`Mesh not enabled`:** this daemon has no mesh set up. [Pair your machines](../jobs/tailscale.md) first.
- **`401` from the peer:** the two machines don't share the same mesh token. See [Add a second machine](../jobs/second-machine.md).
- **The peer can't find the agent:** the agent ID must be one configured on that peer, not on this machine.
- **A `POST /task` message never ran:** the caller probably disconnected while the agent was busy. The daemon log shows `caller gone during slot wait — not starting`. Keep the connection open longer and send it again.
- **Reading a hand-off gives `400`:** add `?as=<agent>` with the asking agent or the agent that did the work.
- **Reading a hand-off gives `404`:** the id is wrong, the agent in `as` is neither of the two agents, or the hand-off is older than `requests.retentionDays` and was deleted. Check the id in `GET /a2a/delegations`.
- **Reading a hand-off gives `409`, or the list is empty after a restart:** the database did not open on this machine, so hand-offs are kept in memory only. `curl -s http://127.0.0.1:18800/health | jq .handoffs` prints `"memory-only"`. See [When an agent asks another agent](../jobs/ask-another-agent.md) for the fix.
- **A hand-off ended `error` with `empty answer from <agent>`:** that agent ended its run without an answer, a job state, a waiting note or a message back. Open its run on the Hub's **Activity** page to see why it stopped. Then ask it again, or check that its instructions tell it to answer or to state its job's state.
- **A hand-off ended `done` but its text is `(empty answer)`:** the agent that did the work wrote back to the asking agent during the work, or stated `done`, and then ended without a final answer. What it wrote earlier is the answer: look for it in the asking agent's conversation.
- **A hand-off has no `text`:** it is still `running`, or it ended before this version of AgentX kept answers.
- **A resend got `"duplicate": true` but you wanted a second run:** the first hand-off with that exact message is still `running` (or carries on as `continue`). Wait for it to end, or change the message.
- **The same message ran twice:** check that both sends came from the same conversation and named the same `home`. A different conversation or home is new work. If they match, look in the daemon log for `duplicate guard off for this send`: the database could not record the hand-off, so the check was skipped for that send.
- **`async: true` gets `400` (`async requires context.channel and context.chatId`):** add a `context` with both `channel` and `chatId`, the chat the answer should go to.
- **An `async: true` answer never reached the chat:** read the hand-off by its `taskId`. If it ended, its `text` holds the answer or the failure, and the daemon log shows `delivery to <channel>:<chatId> failed: ...` with the reason (for example, no such channel on this machine). If it ended and the log shows no delivery line, AgentX stopped between ending the hand-off and sending: the chat is not told again, so read the answer from the hand-off. If it is still `running`, the peer is still working; it ends `timeout` after `mesh.delegation.timeoutMinutes`.
- **An `async: true` hand-off ended `timeout` but the peer finished the work:** `mesh.delegation.timeoutMinutes` is set lower than the time the peer took. Its late answer was dropped. Raise the setting (up to 30 minutes keeps it within the peer call's own limit), or read the result on the peer.
- **An `async: true` request got `"duplicate": true`:** the same request to the same peer and agent, for the same chat, is still running. Wait for it, or change the message.
- **A script expected an answer but got `202`:** it named an agent (`senderAgentId`, or the `X-AgentX-Task` header). An agent never waits. Read the answer by the `taskId`, or leave the agent out if a person runs the script.
- **An agent's request still waited:** it did not name the agent, or it went to a guest host. Send `senderAgentId`, and from inside a run the `X-AgentX-Task: $AGENTX_TASK_ID` header. The daemon log line `an agent gets a receipt, never a wait` shows when a request asked to wait and got a receipt.
- **An agent never heard about a `none` hand-off:** the notice reaches it at the start of its next run, or as a run of its own after an hour. Search the daemon log for `told with a notice`. A sender recorded as `?` named no agent of this machine, so nobody is told.
- **You need to go back to the version before agents got receipts:** an older daemon cannot read open `none` or `deliver` hand-offs and leaves them open for good. Before you start it, close them in the database (**Terminal**, in the folder that holds `agentx.json`):
  ```sh
  sqlite3 .agentx/db.sqlite "UPDATE handoffs SET status='lost', ended_at=strftime('%s','now')*1000, updated_at=strftime('%s','now')*1000 WHERE status IS NULL AND way_home IN ('none','deliver')"
  ```
- **The standalone server doesn't answer:** check that the chosen `--provider` is installed and signed in on that machine.
