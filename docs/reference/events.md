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
| `agent` | `task:started`, `task:step`, `task:completed`, `session:rotated` | trace ID |
| `run` | `created`, `ok`, `failed`, `paused`, `resumed`, `skipped`, `completed`, `timeout` | workflow run ID |
| `task` | `created`, `submitted`, `canceled` (workflow user tasks) | user task ID |
| `signal` | `emitted` | — |
| `mesh` | `forward` (a task sent to a peer), `recovered`, `lost`, `skills-changed`, `added`, `removed` | — |
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
| `kind` | Only this `kind`. |
| `agent` | Only events with this `agentId`. |
| `limit` | At most this many events, keeping the newest. |

The answer is `{ "events": [ … ] }`, oldest first. The buffer holds the last `events.ringSize` events (default 1,000) and is empty after a restart. Traces and run records remain the durable history. Off this machine the endpoint needs `Authorization: Bearer <mesh-token>`.

## Live stream

`GET /events` is a server-sent event stream. Its wire format is unchanged: `event: <kind>` with the kind's own fields as `data`, for the `run`, `task`, `signal`, `mesh`, `channel` and `status` kinds. Each frame now also includes `rootId` and `node`. Filter with `?type=run,task`, `?workflow=`, `?run=`, `?actor=` and `?channel=`. Agent task steps still arrive as `event: task` with `kind: "task:step"`. The envelope-only kinds (`message`, `agent`, and the mesh `forward` event) are read through `/events/recent`.

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

## If something is wrong

- **`/events/recent` returns `401`:** the request didn't come from this machine. Send `Authorization: Bearer <mesh-token>`.
- **The list is empty:** the buffer is in memory only and starts empty after a restart. Check `since`: an unknown ID that isn't a valid time is ignored, and a time in the future matches nothing.
- **Events on a peer have a different `rootId`:** the peer runs an older AgentX that ignores the root it is sent. Upgrade the peer.
