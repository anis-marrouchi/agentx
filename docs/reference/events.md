# Events

Everything the daemon does is published as an event on one in-process bus. Examples are a routed message, an agent task step, a workflow run changing phase, or a task forwarded to another machine. Every event shares the same envelope. You can read events live with `GET /events`, or catch up on recent ones with `GET /events/recent`.

## The envelope

| Field | Type | What it holds |
|---|---|---|
| `id` | string | Unique event ID. |
| `rootId` | string | The entry point this event comes from: an inbound message, a cron fire, a webhook or a task from another machine. Every event caused by that entry point shares this ID, including events on mesh peers. An event with no known entry point is its own root. |
| `parentId` | string, optional | The event that directly caused this one. On a mesh peer, this is the `forward` event on the sending machine. |
| `node` | string | Name of the machine that published the event (`node.name`). |
| `agentId` | string, optional | The agent involved, when there is one. |
| `kind` | string | Event family. See the table below. |
| `type` | string | The specific event within its family. |
| `at` | string | ISO-8601 time. |
| `summary` | string | A short description of at most 280 characters. It never contains a prompt or an answer. |
| `ref` | string, optional | ID of the durable record for full details: a trace ID (`agentx trace show <id>`), run ID or task ID. |

## Kinds and types

| `kind` | `type` values | `ref` |
|---|---|---|
| `message` | `message:matched`, `message:dropped` | channel message ID |
| `agent` | `task:queued`, `task:queue-flushed`, `task:queue-ended`, `task:started`, `task:step`, `task:completed`, `session:rotated` | trace ID (none for `task:queued`, `task:queue-flushed` and `task:queue-ended`: the message has no run of its own) |
| `run` | `created`, `ok`, `failed`, `paused`, `resumed`, `skipped`, `completed`, `timeout` | workflow run ID |
| `task` | `created`, `submitted`, `canceled` (workflow user tasks) | user task ID |
| `signal` | `emitted` | — |
| `mesh` | `forward` (a task sent to a peer), `recovered`, `lost`, `skills-changed`, `added`, `removed`, and from the [mesh feed](#events-from-other-machines): `feed:down`, `feed:up`, `feed:gap` | — |
| `announce` | `announce` (a note to the whole mesh, see [Announcements](#announcements)) | — |
| `reminder` | `reminder:due`, `reminder:dispatched`, `reminder:skipped` ([due reminders](/automations/reminders)) | Apple Reminders ID |
| `channel` | `in`, `out` | channel message ID |
| `status` | `status` | — |

A workflow run saves its `rootId`. Events published after the run resumes from a pause, a timer, a signal or a restart keep the root of the event that started the run.

## Read recent events

```sh
curl 'http://127.0.0.1:18800/events/recent?since=2026-09-27T09:00:00Z&kind=agent&agent=coder-agent'
```

| Parameter | What it does |
|---|---|
| `since` | An event `id` (returns the events after it) or an ISO time. |
| `kind` | Only these kinds, separated by commas. |
| `skip` | Leave out these types, separated by commas, for example `task:step`. |
| `origin` | `local` keeps only events this machine published itself. |
| `agent` | Only events with this `agentId`. |
| `limit` | At most this many events, keeping the newest. |

The answer is `{ "events": [ … ] }`, oldest first. When `since` is an event ID that has already left the buffer, the answer also has `"gap": true`: older events may be missing, and the list starts at the oldest one still held. The buffer holds the last `events.ringSize` events (default 1,000) and is empty after a restart. Traces and run records remain the durable history. Off this machine the endpoint needs `Authorization: Bearer <mesh-token>`.

## Events for one agent

An agent can follow events through its `subscriptions` setting: it reads them with the `agentx_events` tool, gets a short list when it starts a fresh conversation, or is started by them. See [Let agents follow events](/automations/event-subscriptions). The same list is served at `GET /agents/<id>/events?since=&limit=`. It returns `{ "agentId", "subscriptions", "events": [ … ], "next" }`, at most 50 events, oldest first. Without `since` you get the newest events; with `since` you get the oldest ones after it, so passing `next` back as `since` reads every event once. Off this machine it needs the mesh token too.

## Live stream

`GET /events` is a server-sent event stream. Its wire format is unchanged: `event: <kind>` with the kind's own fields as `data`, for the `run`, `task`, `signal`, `mesh`, `channel` and `status` kinds. Each frame now also includes `rootId` and `node`. Filter with `?type=run,task`, `?workflow=`, `?run=`, `?actor=` and `?channel=`. Agent task steps still arrive as `event: task` with `kind: "task:step"`. The envelope-only kinds (`message`, `agent`, `announce`, and the mesh `forward` and `feed:*` events) are read through `/events/recent` or the envelope stream.

`GET /events?format=envelope` streams every envelope, whatever its kind, as `event: envelope` frames. It takes the same `kind`, `skip`, `origin` and `agent` filters as `/events/recent`, and sends a comment line every 15 seconds while it is idle. Off this machine it needs `Authorization: Bearer <mesh-token>`.

## Events from other machines

When the mesh is on, each machine follows the events of every other machine it can reach. Events from another machine appear here with that machine's name in `node`. They reach this machine once, and are never passed on to a third machine: each machine asks its peers only for the events they published themselves (`origin=local`).

- **Catch-up:** after a peer was out of reach, this machine reads what it missed from the peer's buffer. When the peer's buffer no longer goes back that far (it restarted, or more than `events.ringSize` events happened), this machine publishes `mesh` / `feed:gap` instead.
- **Unreachable peers:** when a peer stops answering, this machine publishes `mesh` / `feed:down` once, and `feed:up` when the peer is back. A quiet peer publishes nothing; a peer that is down always says so.
- **Peers on an older AgentX:** a peer without the mesh feed is skipped quietly. This machine publishes nothing about it, writes one line to its log, and looks again every 10 minutes. After the peer is upgraded, its events start to arrive.
- **Stays on its machine:** per-step agent activity (`task:step`) is left out by default (see `mesh.feed.skipTypes` in [Operations settings](./config-operations.md#mesh)). State that belongs to one machine, such as its voice speaking queue, is never copied; only events describe it.
- **Traces:** another machine's tasks are not recorded in this machine's traces. Use the event's `ref` on the machine named in `node`.

Turn it off with `mesh.feed.enabled: false`. A change to `mesh.feed.skipTypes` applies the next time this machine reconnects to each peer.

## Announcements

An announcement is a short note to every machine in the mesh, for example planned maintenance. It is stored and shown in feeds like any other event. It does not wake an agent by itself; an agent is only woken by it if that agent subscribes to `announce` events.

1. **Terminal:** run `agentx mesh announce "Maintenance tonight at 22:00"`.
2. To sign it, add `--by <name>`. When the name is an agent ID on the receiving daemon, the event's `agentId` is that agent; otherwise the name starts the summary. Anyone allowed to announce (this machine, or a caller with the mesh token) can sign as any agent.

The daemon publishes one `announce` event, and every other machine picks it up through its feed. Programs can do the same with `POST /mesh/announce` and a body of `{ "text": "…", "by": "…" }`. Off this machine that request needs `Authorization: Bearer <mesh-token>`. Text longer than 2,000 characters is refused, and the summary keeps the first 280.

The phone app lists recent announcements from every machine in its **Alerts** tab and can send a notification for each new one. See [Announcements on the phone](/dashboard/mobile-alerts#announcements).

## In code

```ts
import { getEventBus } from "@/events/bus"

const bus = getEventBus()
bus.subscribe((e) => { /* every envelope */ })
bus.on("task:completed", (p) => { /* the typed payload, unchanged */ })
bus.publish({ kind: "status", type: "status", summary: "hello" })
```

Typed lifecycle events (`bus.emit("task:started", …)`) still reach `bus.on` subscribers with their full payload. That is how the SQLite writer records traces. The envelope published alongside them carries only the summary. Use `withNewRoot(fn)` from `@/events/envelope` when you add a new entry point.

## Check it worked

1. **Terminal:** send an agent a message, for example `agentx daemon send <agent> "Reply with a short hello"`.
2. **Terminal:** run `curl 'http://127.0.0.1:18800/events/recent?kind=agent&limit=50'`. You see `task:started` and `task:completed` for that agent. Both have the same `rootId`, and their `ref` is the trace ID.
3. **Terminal:** run `curl -N http://127.0.0.1:18800/events`. The first frame is `event: status`, and later frames include `rootId` and `node`.
4. **Terminal:** with the mesh on, run `agentx mesh announce "Feed check"` on another machine.
5. **Terminal:** on this machine, run `curl 'http://127.0.0.1:18800/events/recent?kind=announce'`. You see the note once, with the other machine's name in `node`.

## If something is wrong

- **`/events/recent` returns `401`:** the request didn't come from this machine. Send `Authorization: Bearer <mesh-token>`.
- **The list is empty:** the buffer is in memory only and starts empty after a restart. Check `since`: an unknown ID that isn't a valid time is ignored, and a time in the future matches nothing.
- **Events on a peer have a different `rootId`:** the peer runs an older AgentX that ignores the root it is sent. Upgrade the peer.
- **No events from another machine:** check that `mesh.feed.enabled` is not `false`, and that the peer is healthy in `agentx mesh list`. Look for `feed:down` events: their summary says why the peer can't be reached. A `401` there means the peer's mesh token doesn't match.
- **Events from a peer running an older AgentX never arrive:** only machines with the mesh feed serve it. The log says `peer <name> not followed`. Upgrade the peer; it is picked up within 10 minutes.
- **A `feed:gap` event:** the peer was away longer than its buffer covers. The missed events are still in the peer's traces and run records.
