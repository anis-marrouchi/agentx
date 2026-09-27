# Let agents follow events

An agent normally only works when someone messages it. With **event subscriptions**, an agent can also hear about what happened on its machine while it was idle. For example, another agent finished a task, a workflow run failed, or a task was handed to another machine. An event is one short record of something that happened. The [events reference](/reference/events) lists them all.

You choose, per agent, which events it follows and how it hears about them.

## How an agent hears about events

Each subscription has a **delivery** mode:

| Delivery | What happens |
|---|---|
| `pull` (default) | Nothing happens on its own. The agent asks when it wants to know, with the `agentx_events` tool. You can ask too, with `agentx events --agent <id>`. |
| `digest` | When the agent starts a **fresh** conversation (not a continued one), a short list of matching events since its last finished task is added to what it reads first. At most 10 events are listed. A continued conversation gets nothing added, so it never grows turn after turn. |
| `wake` | A matching event starts a task for the agent straight away. Use it with care. It is off unless you choose it. |

Every subscription can also be read with `pull`, whatever its delivery.

A woken agent is protected against loops and floods:

- An agent is never woken by its own events.
- An agent is never woken by an event that came out of its own work. Events share a `rootId` with the message, schedule or webhook that started them. When an agent has worked on a `rootId`, later events with that `rootId` don't wake it.
- One `rootId` wakes an agent at most once.
- An agent is woken at most `maxPerHour` times in any hour. Further events are skipped, and the daemon log says `wake skipped for <agent>: rate-limit`.

## The settings

Subscriptions go in `agentx.json`, under `agents.<id>.subscriptions`. It is a list; each entry has these fields:

| Field | Type | Default | What it does |
|---|---|---|---|
| `kinds` | list of text | required | Which events. Each entry is an event `kind`, such as `run`, or a `type`, such as `task:completed`. `*` means every event. |
| `agents` | list of text | — | Only events about these agents. |
| `nodes` | list of text | — | Only events from these machines (their `node.name`). |
| `match` | text | — | Only events whose summary contains this text. Upper and lower case count as the same. |
| `delivery` | `"pull"` \| `"digest"` \| `"wake"` | `"pull"` | How the agent hears about a match (see the table above). |
| `maxPerHour` | number (1–60) | `4` | For `wake` only: the most times the agent is woken in an hour. |

An agent does not see its own events unless it lists its own id in `agents`.

Events are kept in memory only, up to `events.ringSize` (1,000 by default), and the list starts empty when the daemon restarts. Only events published on the agent's own machine are included.

## Set up a subscription

1. **Editor:** open `agentx.json` in the folder where the daemon runs.
2. **Editor:** under your agent, add a `subscriptions` list. This example makes the agent `helper` follow tasks that `reviewer` finishes, and briefs it on failed workflow runs when it starts fresh:
   ```json
   "agents": {
     "helper": {
       "name": "Helper",
       "workspace": "./workspaces/helper",
       "subscriptions": [
         { "kinds": ["task:completed"], "agents": ["reviewer"] },
         { "kinds": ["run"], "match": "failed", "delivery": "digest" }
       ]
     }
   }
   ```
3. **Editor:** save the file. The daemon reads the change on its own within a few seconds.
4. **Terminal:** run `agentx config check`. It prints `✓ Config valid`.

To wake the agent instead, set `"delivery": "wake"` and, if you like, a lower `maxPerHour`:

```json
{ "kinds": ["task:completed"], "agents": ["reviewer"], "match": "failed", "delivery": "wake", "maxPerHour": 2 }
```

A woken task runs on the `events` channel, in a conversation of its own (`events:<agent-id>`). Its answer stays in that conversation and is not sent anywhere. Ask the agent in its instructions to message someone when an event needs attention.

## Read events yourself

1. **Terminal:** run `agentx events --agent helper`. You see the events that match `helper`'s subscriptions, oldest first, with each event's ID.
2. **Terminal:** to see only newer ones, copy the command printed on the last line, for example `agentx events --agent helper --since <event-id>`, and run it.

Without `--agent`, `agentx events` lists the recent events of the whole machine. All flags are in the [CLI reference](/reference/cli-commands#events-advanced).

The agent reads the same list with the `agentx_events` tool. Each answer ends with `next: <event-id>`, which the agent passes back as `since` to read only newer events.

## Check it worked

1. **Terminal:** send the followed agent a task, for example `agentx daemon send reviewer "Reply with a short hello"`.
2. **Terminal:** when it has answered, run `agentx events --agent helper`. You see a `task:completed reviewer@<machine>` line.
3. For a `wake` subscription, **Terminal:** run `agentx daemon logs`. You see `waking helper`, followed by a task for `helper` on the `events` channel.

## If something is wrong

- **`agentx events --agent helper` says the agent has no subscriptions:** the daemon hasn't read the change yet, or the list is under the wrong agent. Check the spelling of the agent id, then run `agentx daemon restart`.
- **No events show up:** the event list is in memory only and starts empty after a restart. Events from other machines are not included. Check `kinds`: use a `type` such as `task:completed` or a `kind` such as `agent`, as listed in the [events reference](/reference/events#kinds-and-types).
- **`config check` names a field under `subscriptions`:** a value is wrong, for example an unknown `delivery` or an empty `kinds` list. Compare it with the settings table above.
- **The agent isn't woken:** look in `agentx daemon logs` for `wake skipped for <agent>`. The reason follows: `rate-limit` (raise `maxPerHour` or wait), `own-root` (the event came from the agent's own work) or `duplicate-root` (it was already woken for that `rootId`).
- **A fresh conversation shows no digest:** only events since the agent's last finished task are listed, and only for `digest` subscriptions. A continued conversation never gets one. The agent can call `agentx_events` instead.
- **`agentx events` returns `401`:** the command reached a daemon on another machine. Pass `--token <mesh-token>`.
