# Operations — work across machines

Operations shows how agents and connected nodes fit together. Start here when a task should move to another machine, or when you want to see which node owns an agent. A second machine is optional; one-machine teams can start with the other tabs.

If a remote node is missing, check both hosts' daemon status and their mesh connection before changing agent instructions. See [Add a second machine](../jobs/second-machine.md).

![Operations view from the isolated three-node demo](/screenshots/operations.png)

*The demo has three completed runs across two active agents.*

## Open, watch and continue a scheduled run

Click a schedule's row to open its drawer. While the job is running, the row shows **running** and the drawer has a **Watch live run** link to the run's Task page, on the node that runs it. **Runs today** lists the latest 10 runs, each with an **Open** link to its archived Task page. Command jobs run a shell command, not an agent, so they have no links. Runs recorded before the node was upgraded have no link either.

On the archived Task page of a scheduled run, **Send** continues the conversation. The message becomes a new turn in the job's `cron:<jobId>` chat, so the agent picks up the run's context, and the page moves to the new run. If the agent is busy, the message waits as the next turn. If an attached Claude Code session answers it, the page says so, and there is no new run to open. Finished runs from other channels, such as Telegram or GitLab, stay read-only: a reply sent from here would never reach the person in that chat.

### Task follow-up API

The Task page calls the daemon's follow-up endpoint:

```
POST /api/tasks/<taskId>/followup
{ "message": "and tomorrow?", "sender": "operator", "replace": false, "agent": "ops-agent" }
```

Without `agent`, it only reaches a running task. With `agent`, a finished scheduled run of that agent is continued too.

| Status | Meaning |
|---|---|
| 200 | Queued for the running task: `{ ok, taskId, agentId, channel, chatId, replaced, pending }` |
| 200 | Finished scheduled run continued: `{ ok, resumed: true, fromTaskId, taskId, queued, answeredBy }`. `taskId` is the new run; it's absent when the turn was queued (`queued: true`) or answered without a new run (`answeredBy: "attached"` or `"other"`) |
| 400 | `message` is missing |
| 404 | No running task with that ID, and no stored run for `agent` |
| 409 | The task is finished but wasn't a scheduled run |
