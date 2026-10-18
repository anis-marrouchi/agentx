# Watch tasks that must not be dropped

![An agent hands work on with a due time. The daemon decides whether the task needs watching and attaches one watcher, recorded on the task. If the run doing the work ends with no result, or the due time passes, the agent that handed the work on is told, and you are told 30 minutes later if it is still not done. When the work finishes in time, nothing is sent.](/diagrams/task-watcher.svg)

Some work has a deadline: a post to publish at six, a reply promised by Friday. When that work moves from one agent to another, or from a schedule to a one-off chat, it can stop halfway and nobody notices until the time has passed.

A **task watcher** prevents that. When a task starts, AgentX asks one question: does this task carry a due time, a promise to you, or work handed on by another agent? If the answer is yes, or nobody can tell, it attaches a watcher. The watcher stays quiet while the work goes well. It speaks up when the work stops.

## How it works

1. A task starts. It is checked when it is one of these:
   - **Delegation:** one agent hands work to another.
   - **Cron hand-off:** a schedule starts an agent.
   - **Dispatch:** a run that has a due time, or was started by another agent.
2. AgentX looks for a watcher already on the task. It never attaches a second one.
3. AgentX decides whether the task needs one:
   - A task with a due time, or handed on by another agent, always gets one.
   - For any other task, the `task-watch` decision seat is asked (see [Jev decisions](/architecture/jev)). It answers with a probability. A watcher is skipped only when the seat is switched to `active` and is confident the task needs none.
   - When the seat is off, not reachable or unsure, a watcher is attached anyway, to be safe.
4. AgentX records what it decided on the task: the decision, the probability and the watcher's id.
5. The watcher fires when one of these happens first:
   - The run doing the work ends with an error, or with an empty answer.
   - The due time passes and the work has not finished.
   - A task with no due time hears nothing for 24 hours.
6. When it fires, the agent that handed the work on gets a message that starts with `[agentx:watcher …]`. It says what stopped and when the work was due, so that agent can finish it or give it to someone else.
7. If the work is still not done 30 minutes later, you are told through your normal notifications. When nobody handed the work on (a schedule, for example), you are told straight away.

When the work finishes in time, the watcher closes and nothing is sent.

## Turn it on

1. Open `agentx.json` in a text editor.
2. Add `"watchers": { "enabled": true }`.
3. Save the file. The running daemon picks the change up; no restart is needed.

Every setting, with its default, is in the [configuration reference](/reference/config-automation#watchers). To send your alerts somewhere other than your normal notification channel, set `ownerChannel` and `ownerChatId`.

## Give a task a due time

A due time is what lets a watcher fire before anything goes wrong in the run itself. Write it as an ISO time, for example `2026-10-20T18:00:00Z`.

- **An agent handing work on:** the `agentx_task` tool takes a `dueAt` field. Tell the agent in plain words, for example "ask the publisher to post the video, due today at 18:00 UTC".
- **A script or another program:** add `"dueAt"` to the body of `POST /task`, next to `agent` and `message`.

## Check it worked

1. **Terminal:** run `agentx config get watchers.enabled`. It prints `true`.
2. Ask an agent to hand a small task to another agent with a due time a few minutes away, for example "ask the writer for a one-line summary of today, due in 5 minutes".
3. **Terminal:** run `agentx daemon logs`. Within a few seconds you see a line that starts with `[watchers]`, then a watcher id that starts with `wch-`, then `watching`.
4. When the writer answers in time, the logs show the same id followed by `done`, and nothing is sent to you.
5. **Terminal:** to see the decision on a run, run `agentx trace list`, then `agentx trace show <taskId>`. The step log has a step named `watcher` with the decision, the probability and the watcher id.

## If something is wrong

- **No `[watchers]` line appears:** check that `watchers.enabled` is `true` and that `watchers.sources` lists the kind of task you started. A person's ordinary chat message is not checked unless its channel is in `watchers.dispatchChannels`.
- **The log says `already watched by request`:** the task is already followed as an [open request](./open-requests.md), which tells you when the hand-off fails. Give the task a due time if you want a watcher too.
- **The agent that handed the work on got no message:** look for `alert turn on … failed` in the daemon logs. That agent may be busy or switched off; you are still told after `escalateAfterMinutes`.
- **You get no alert:** check your notification channel works (see [Get notified](./notifications.md)), or set `watchers.ownerChannel`. Alerts are held while Focus is on.
- **You hear twice about a failed schedule:** schedules already report their own failures. Remove `"cron"` from `watchers.sources` if that is enough for you.
- **You are told too soon:** raise `watchers.escalateAfterMinutes`.
- **Too many tasks get a watcher:** switch the `task-watch` seat to `active` under `decisions.seats` so it can skip tasks that need none, or remove a source from `watchers.sources`.
