# Operations — work across machines

Operations shows how agents and connected nodes fit together. Start here when a task should move to another machine, or when you want to see which node owns an agent. A second machine is optional; one-machine teams can start with the other tabs.

If a remote node is missing, check both hosts' daemon status and their mesh connection before changing agent instructions. See [Add a second machine](../jobs/second-machine.md).

![Operations view from the isolated three-node demo](/screenshots/operations.png)

*The demo has three completed runs across two active agents.*

## Routines

**Routines** lists everything AgentX runs on its own, on every machine: schedules (jobs that run at set times) and workflows that start on a timer or an event. Use it to find automations that are broken or forgotten.

![The Routines section of the Operations tab](/screenshots/operations/routines.png)

1. **Browser:** open the dashboard and select the **Operations** tab.
2. Below the summary cards, switch the view from **Activity** to **Operations**.
3. Scroll to **Routines**. Each machine has its own group.
4. To see only the ones that need attention, select **Flagged**. **Schedules** and **Events** filter by kind. The dashboard remembers your choice.
5. Select a routine's name to open its details: when it runs, which agent runs it, its last result and error, and why it's flagged.

A flag tells you what's wrong:

| Flag | What it means |
|---|---|
| **Failing** | The last 3 runs or more failed |
| **Overdue** | It missed at least 2 of its scheduled times |
| **Dormant** | An event workflow that hasn't fired in a long time |
| **Never ran** | It's switched on but has never run |
| **Disabled long** | It's been switched off for more than 30 days |

A machine that can't be reached shows **Routines unknown while this node is unreachable**. A machine running an older AgentX shows **This node does not report routines yet**.

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

## Check it worked

1. **Browser:** in the Operations tab's **Operations** view, each reachable machine lists its routines under **Routines**.
2. Select **Flagged**. Only routines with a flag stay in the list.
3. Select a schedule's row under **Today's automations**. Its drawer lists **Runs today**, each with an **Open** link.

## If something is wrong

- **A machine is missing:** check that its daemon is running and that the machines can reach each other. See [Add a second machine](../jobs/second-machine.md).
- **This node does not report routines yet:** that machine runs an older AgentX. Update it, then restart its daemon.
- **Routines unknown while this node is unreachable:** the dashboard can't reach that machine's daemon. Check its status and its mesh connection.
- **A run has no Open link:** command jobs never have one, and runs from before the machine was updated don't either.
- **The page looks out of date after an update:** the dashboard is a separate service. Restart it on each machine.
