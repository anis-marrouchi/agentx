# Watch tasks that must finish

Some tasks must not stop halfway: a post scheduled for 18:00, an answer you are waiting for, work one agent handed to another. If the agent working on such a task stops before it is done, nobody notices on their own.

A **task watcher** is a small record AgentX keeps beside a task. It alerts someone if the task is not done in time, or if the agent's run ended without a result. You do not create watchers yourself: when a task starts, AgentX decides whether the task needs one.

## How it fits together

Every time a task starts, AgentX runs a short check. A task here is a message to an agent, a hand-off from one agent to another (a **delegation**), or a scheduled run.

1. **Look up.** If the task already has a watcher, nothing new is made. A [tracked plan](/jobs/tracked-plans) that follows the task also counts as a watcher.
2. **Decide.** A decision model answers one yes/no question: does this task carry a deadline, a promise to you, or a hand-off to another agent? It gives a chance between 0 and 1. The question is the `task-watch` [decision seat](/architecture/jev).
3. **Attach.** A watcher is attached unless the answer is a confident "no". If the decision model is off, fails or is unsure, a watcher is attached anyway. A watcher that was not needed costs nothing: it closes by itself when the task ends with a result (unless [only an explicit done](#what-counts-as-done) closes it).
4. **Record.** The decision, its chance and the watcher's id are kept on the watcher and on the task's trace.

A watcher fires when either of these happens first:

- The task's **due time** passes and nothing said it is done. A task that gives no due time gets one `defaultDueMinutes` after it starts.
- The agent's run **ends without a result**: an error, an empty answer, or a delegation that failed, timed out or was lost in a restart.

When it fires, it tells the agent that handed the task over. That agent gets a short turn on the `watchers` channel with the task, the reason and how to mark the task done. If the task is still not done `escalateAfterMinutes` later, you are told through your notifications. A task nobody handed over (one you sent, or a scheduled run) goes straight to you.

A run that a restart or a stop signal cut off is not reported at once, because it may resume. Its due time still applies.

### What counts as done

By default (`watchers.doneSignal` `result`), a watcher closes when the agent's run ends with a reply, or when a delegation answers. A reply that only promises the work, such as "I'll publish at 18:00", also closes it.

With `watchers.doneSignal` set to `explicit`, a reply does not close the watcher. Only a done signal does: `POST /watchers/<id>/done` ([section 4](#_4-mark-a-task-done-by-hand)). A watched task that replied but was never marked done fires at its due time. Every watched task then needs someone to mark it done, so use this mode with the `task-watch` seat `active` (step 2), or expect an alert for each watched task that nobody marks done.

## Before you start

- The AgentX daemon running with its database (the default).
- Optional: the [decision seats](/architecture/jev) set up, if you want the decision model to skip tasks that clearly need no watcher. Without it, every task gets a watcher that closes when the task ends with a result.

## 1. Turn it on

1. **Terminal:** in the folder with `agentx.json`, run:
   ```sh
   agentx config set watchers.enabled true
   ```
2. Optional: give tasks that name no due time a longer one, for example four hours:
   ```sh
   agentx config set watchers.defaultDueMinutes 240
   ```
3. Optional: leave out channels you do not want watched, for example voice turns:
   ```sh
   agentx config set watchers.skipChannels '["voice"]'
   ```
4. Optional: let only an explicit done signal close a watcher, so a promise in a reply is not taken as done (see [What counts as done](#what-counts-as-done)):
   ```sh
   agentx config set watchers.doneSignal explicit
   ```

The daemon picks up the change without a restart. All settings are in the [configuration reference](/reference/config-automation#watchers).

## 2. Let the decision model skip tasks (optional)

While the `task-watch` seat is off or in `shadow` mode, every task gets a watcher. To let the model skip the tasks it is sure about:

1. Open `agentx.json`.
2. Under `decisions.seats`, add `"task-watch": { "mode": "shadow" }` and let it record for a while.
3. When its answers look right, change `shadow` to `active`. From then on, a task whose chance is below `watchers.noBelow` (0.2 by default) gets no watcher.

## 3. Give a task a due time (for callers)

A program that starts a task through `POST /task` can give its due time in the task's context:

```json
{ "agentId": "<agent-id>", "message": "Publish the approved post", "context": { "dueAt": "2026-01-15T18:00:00Z" } }
```

`dueAt` is an ISO date or a number of milliseconds since 1970.

## 4. Mark a task done by hand

An agent, or you, can say a watched task is done:

1. **Terminal:** list what is being watched:
   ```sh
   curl -s http://127.0.0.1:18800/watchers?state=open
   ```
2. **Terminal:** mark one done, with what proves it:
   ```sh
   curl -s -X POST http://127.0.0.1:18800/watchers/<watcher-id>/done \
     -H 'Content-Type: application/json' -d '{"evidence":"https://example.com/post/1"}'
   ```

Other states are `alerted` (the agent that handed it over was told), `escalated` (you were told) and `done`. These routes answer only on this machine, or to a mesh peer with its token.

## Check it worked

1. **Terminal:** send an agent a task:
   ```sh
   agentx daemon send <agent-id> "Say hello"
   ```
2. **Terminal:** run `curl -s http://127.0.0.1:18800/watchers`. The newest watcher names that agent, with a `decision` and its `probability` (`null` while the seat is off).
3. When the agent has answered, run the same command again: the watcher's `state` is `done`. With `watchers.doneSignal` `explicit`, it stays `open` until you mark it done ([section 4](#_4-mark-a-task-done-by-hand)).
4. The daemon log has a line `[watchers] watch-<id>: attached to <agent-id>`.

## If something is wrong

- **`/watchers` answers `watchers need the database`:** the daemon could not open its database. Run `agentx doctor` and fix what it reports under storage.
- **No watcher appears:** check that `watchers.enabled` is `true` and that the task's channel is not in `watchers.skipChannels`. A task whose seat is `active` and confident it needs none gets no watcher; its trace shows `watch_decision` `no`.
- **The agent that handed over the task is not told:** it must be an agent on this machine. When it is not, or its turn cannot start, you are told instead.
- **You are told too often:** raise `watchers.defaultDueMinutes`, add busy chat channels to `watchers.skipChannels`, or move the `task-watch` seat to `active` once its answers are good.
