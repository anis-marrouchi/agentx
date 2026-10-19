# Watch tasks that must finish

Some tasks must not stop halfway: a post scheduled for 18:00, an answer you are waiting for, work one agent handed to another. If the agent working on such a task stops before it is done, nobody notices on their own.

A **task watcher** is a small record AgentX keeps beside a task. It alerts someone if the task is not done in time, or if the agent's run ended without a result. You do not create watchers yourself: when a task starts, AgentX decides whether the task needs one.

## How it fits together

Every time a task starts, AgentX runs a short check. A task here is a message to an agent, a hand-off from one agent to another (a **delegation**), or a scheduled run.

1. **Look up.** If the task already has a watcher, nothing new is made. A [tracked plan](/jobs/tracked-plans) that follows the task also counts as a watcher.
2. **Decide.** A decision model answers one yes/no question: does this task carry a deadline, a promise to you, or a hand-off to another agent? It gives a chance between 0 and 1. The question is the `task-watch` [decision seat](/architecture/jev).
3. **Attach.** A watcher is attached unless the answer is a confident "no". If the decision model is off, fails or is unsure, a watcher is attached anyway. A watcher that was not needed does no harm: it closes by itself when the task ends with a result (unless [only an explicit done](#what-counts-as-done) closes it). Asking the decision model is one small model call per task while its seat is in `shadow` or `active` mode.
4. **Record.** The decision, its chance and the watcher's id are kept on the watcher and on the task's trace.

A watcher fires when either of these happens first:

- The task's **due time** passes and nothing said it is done. A task that gives no due time gets one `defaultDueMinutes` after it starts.
- The agent's run **ends without a result**: an error, an empty answer, or a delegation that failed, timed out or was lost in a restart.

When it fires, it tells the agent that handed the task over. That agent gets a short turn on the `watchers` channel with the task, the reason and how to mark the task done. If the task is still not done `escalateAfterMinutes` later, you are told through your notifications. A task nobody handed over (one you sent, or a scheduled run) goes straight to you.

A run that a restart or a stop signal cut off is not reported at once, because it may resume. Its due time still applies.

A hand-off to an agent on another machine (a mesh peer) is watched on the machine that handed it over. The machine that does the work does not watch it again.

### What counts as done

By default (`watchers.doneSignal` `result`), a watcher closes when the agent's run ends with a reply, or when a delegation answers. A reply that only promises the work, such as "I'll publish at 18:00", also closes it.

With `watchers.doneSignal` set to `explicit`, a reply does not close the watcher. Only a done signal does: `POST /watchers/<id>/done` ([section 4](#_4-mark-a-task-done-by-hand)). A watched task that replied but was never marked done fires at its due time. When a delegation answers, its result tells the agent that handed it over which watcher to close and how. A scheduled run or a message sent straight to an agent has no one who handed it over, so that run is told in its own instructions which watcher follows it and how to close it. Every watched task still needs someone to mark it done, so use this mode with the `task-watch` seat `active` (step 2), or expect an alert for each watched task that nobody marks done.

You can also ask for **proof** (also called evidence) before a task counts as done, per type of task: a passing test run, the output it produced, or a link to the result. A task of a type with such a rule is closed only by a done signal that carries the proof; its reply never closes it, whatever `doneSignal` says. See [section 5](#_5-require-proof-of-done-optional). Types without a rule work as described above.

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

The same context can name the task's type, which decides what proof its done needs ([section 5](#_5-require-proof-of-done-optional)):

```json
{ "agentId": "<agent-id>", "message": "Fix the login bug", "context": { "taskType": "code" } }
```

Other ways to give a task its type:

| Who starts the task | How to give its type |
|---|---|
| A program calling `POST /task` | `context.taskType`, as above, or `taskType` next to `message` |
| A program calling `POST /send/agent` | `taskType` next to `text` |
| An agent handing work to another agent | the `taskType` field of the `agentx_send_agent` or `agentx_task` tool. It travels with the hand-off, also to an agent on another machine. |
| A schedule | the job's `taskType` setting, for example `agentx config set crons.weekly-report.taskType report` ([crons reference](/reference/config-automation)) |

A task with no type uses its kind (`dispatch`, `delegation` or `cron`) instead.

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

When the task's type needs proof ([section 5](#_5-require-proof-of-done-optional)), the `evidence` must be the kind its rule accepts. Otherwise the answer is HTTP `422` with an `error` (why it was refused) and `required` (what would be accepted), and the watcher stays as it was.

## 5. Require proof of done (optional)

An agent can say "done" without having done the work. For the types of task where that matters, decide what counts as proof. A task type with no rule keeps working as before.

Each task has a type: the `taskType` its caller gave ([section 3](#_3-give-a-task-a-due-time-for-callers)), else its kind: `dispatch` (a message to an agent), `delegation` (a hand-off) or `cron` (a scheduled run). A rule for the `taskType` comes first; when there is none, the rule for the kind applies.

There are three kinds of proof:

| Proof | What it is | Accepted when |
|---|---|---|
| `test` | A test run: `{"type":"test","passed":12,"failed":0,"command":"pnpm test"}` | At least one test passed and none failed. |
| `output` | What the task produced: `{"type":"output","text":"..."}` | The text is at least `minOutputChars` long (40 by default). |
| `link` | Where the result is: `{"type":"link","url":"https://example.com/post/1"}` | It is an `http` or `https` address, on one of `linkHosts` when you set them. |

A plain text `evidence` counts as a `link` when it is a web address, and as an `output` otherwise.

1. **Terminal:** ask tasks of type `code` for a passing test run:
   ```sh
   agentx config set watchers.evidence.code '{"accept":["test"]}'
   ```
2. **Terminal:** ask tasks of type `publish` for a link on your own site:
   ```sh
   agentx config set watchers.evidence.publish '{"accept":["link"],"linkHosts":["example.com"]}'
   ```
3. Optional, **terminal:** ask every scheduled run for its output or a link:
   ```sh
   agentx config set watchers.evidence.cron '{"accept":["output","link"],"minOutputChars":80}'
   ```
   A rule on a kind (`cron` or `dispatch`) applies to every run of that kind. No agent handed those runs over, so each run is told in its own instructions which watcher follows it, what proof it needs and the command that marks it done. A run that does not send that command is reported to you at its due time, so expect one message for each watched run that does not. To ask only some schedules for proof, remove the `cron` rule, give those jobs a `taskType` ([section 3](#_3-give-a-task-a-due-time-for-callers)) and write a rule for that type. While the `cron` rule stays, it still applies to a typed job whose type has no rule of its own.

   The `dispatch` kind covers every message to an agent that is not a hand-off or a schedule, including your own chats with it. A `dispatch` rule, or `doneSignal: "explicit"`, adds the watcher note (a few lines) to each of those chat turns too.

When such a watcher fires, or a delegation answers, the agent that handed the task over is told which proof the done needs, with a done command whose `evidence` has the shape the rule accepts.

::: warning Proof is what the agent says it is
AgentX checks the shape of the proof, not that it is true. It does not run the tests, open the link or read the output. An agent could send `{"type":"test","passed":1,"failed":0}` without running any test. The rule makes an agent say exactly what it did, and keeps that on the watcher for you to check; it does not replace your own check of work that matters.
::: All the settings are in the [configuration reference](/reference/config-automation#watchers).

## Check it worked

1. **Terminal:** send an agent a task:
   ```sh
   agentx daemon send <agent-id> "Say hello"
   ```
2. **Terminal:** run `curl -s http://127.0.0.1:18800/watchers`. The newest watcher names that agent, with a `decision` and its `probability` (`null` while the seat is off).
3. When the agent has answered, run the same command again: the watcher's `state` is `done`. With `watchers.doneSignal` `explicit`, it stays `open` until you mark it done ([section 4](#_4-mark-a-task-done-by-hand)).
4. The daemon log has a line `[watchers] watch-<id>: attached to <agent-id>`.
5. If you set a proof rule ([section 5](#_5-require-proof-of-done-optional)): start a task of that type, then mark it done with no `evidence`. The answer is `422` and the watcher stays `open`. Mark it done again with the proof: the watcher's `state` is `done` and its `evidence` shows what you sent.

## If something is wrong

- **`/watchers` answers `watchers need the database`:** the daemon could not open its database. Run `agentx doctor` and fix what it reports under storage.
- **No watcher appears:** check that `watchers.enabled` is `true` and that the task's channel is not in `watchers.skipChannels`. A task whose seat is `active` and confident it needs none gets no watcher; its trace shows `watch_decision` `no`.
- **The agent that handed over the task is not told:** it must be an agent on this machine. When it is not, or its turn cannot start, you are told instead.
- **A done is refused with `422`:** the task's type has a proof rule. Read `required` in the answer and send that as `evidence`. A test run with a failed test, or none passed, is never proof. To stop asking a type for proof, remove its rule: `agentx config unset watchers.evidence.<type>`.
- **Every scheduled run sends you a "not finished" message:** a rule on `cron` (or `dispatch`) asks every such run for proof. Check the daemon log for `done refused` lines: a refused done says what was missing. If the agent never tries, it is not following the watcher note in its instructions. Remove the `cron` rule, give only the schedules that need proof a `taskType`, and write the rule for that type. A typed job whose type has no rule still falls back to the `cron` rule.
- **A task with a proof rule closes without one:** check its type with `curl -s http://127.0.0.1:18800/watchers/<watcher-id>`. A `taskType` with no rule of its own falls back to the rule for its kind, and to none if the kind has no rule either.
- **You are told too often:** raise `watchers.defaultDueMinutes`, add busy chat channels to `watchers.skipChannels`, or move the `task-watch` seat to `active` once its answers are good.
