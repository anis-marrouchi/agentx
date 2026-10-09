# Pause a task and resume it later

![You, or the agent that handed out the task, ask a running agent to stop. The task stops and is marked stopped, not failed. The agent writes a resume plan; if it does not answer in time, AgentX writes one from the record of the run. Later you, an agent or a workflow step asks to resume, and the task runs again in the same chat with its plan placed before the request.](/diagrams/pause-resume.svg)

Sometimes an agent is busy with something that has to wait: a more urgent job came in, a rule changed, or you are about to deploy. Pausing the task stops the agent cleanly and keeps a note of where it got to, so you can pick the work up later without explaining it again.

That note is the **resume plan**. Right after the stop, the agent gets one short turn to write it, under four headings:

| Heading | What it holds |
|---|---|
| Done | What is finished. |
| Left | What is still to do. |
| Next action | The first thing to do when the task is resumed. |
| Half-applied | Anything started but not finished, such as a partial edit, an open branch or an unsent message. |

The agent does nothing else in that turn. If it doesn't answer within the time limit (two minutes unless you change it), AgentX stops that turn too and writes the plan itself from the run's *trace* (the record of every tool the agent used). Such a plan says it was written by AgentX.

A paused task is marked **stopped**, not failed. It waits until someone resumes it. Resuming runs it again in the same chat, with the plan placed before the original request, so the agent continues instead of starting over.

In AgentX, a stop or resume request is called a **signal**. These are not the workflow signals that one workflow step sends another (`signal.emit` and `signal.wait` in a workflow).

## Where the answer goes after a resume

| The task came from | The resumed answer goes to |
|---|---|
| A chat (Telegram, WhatsApp, GitLab, GitHub…) | That chat, as a normal reply. |
| A chat another machine of your mesh received | That chat, through the machine that received it. |
| Another agent that asked for it | That agent, as a new message. |
| A step of a workflow run | The workflow run. The step runs again and the run goes on to its next steps. |
| Anything else (the API, a schedule, voice) | Nobody is waiting for it. The task runs, and its answer is kept on its task page and in its trace only. |

`agentx signal resume` and the `agentx_signal` tool say which of these applies.

## If AgentX restarts

- A paused task stays paused. A restart never picks it up on its own; only a resume does.
- If the restart happens while the agent is still writing its plan, AgentX writes the plan from the run's trace when it starts again, and the task can be resumed as usual.
- A resumed task that a restart cuts off is picked up again like any other cut-off work. See [restart without losing work](/jobs/restart-safely).

## Pause a task from the dashboard

1. **Browser:** open the dashboard and select the **Live** tab.
2. Find the agent's **running** card.
3. Select **❚❚ pause**.
4. Type a reason if you want one, for example `deploy at 15:00`, then select **OK**. The reason is shown to the agent and kept with the plan.
5. Wait a few seconds. Under the machine's name, **Stopped tasks** lists the task, who stopped it and when.
6. Select the line under the task (**plan by the agent** or **plan by AgentX**) to read the resume plan.

![A Live agent card with a running task and its ❚❚ pause button](/screenshots/live/pause-task.png)

## Resume a task from the dashboard

1. **Browser:** open the **Live** tab.
2. Under the machine's name, find the task in **Stopped tasks**.
3. Select **▶ resume**. The button changes to **resumed**.
4. The agent's card shows **running** again. Its answer goes to the chat the task came from, as it would have the first time.

![Stopped tasks on the Live page, with a resume plan opened and the ▶ resume button](/screenshots/live/stopped-task.png)

## Pause and resume from the terminal

1. **Terminal:** run `curl -s http://127.0.0.1:18800/agents` and copy the `id` listed under the agent's `runningTasks`. On the dashboard, the same id is in the address bar of a running task's page.
2. **Terminal:** run `agentx signal stop <taskId> --reason "deploy at 15:00"`.
3. **Terminal:** run `agentx signal list` to see stopped tasks. The plan's first line is shown under each one.
4. **Terminal:** run `agentx signal show <taskId>` to read the whole plan.
5. **Terminal:** when you're ready, run `agentx signal resume <taskId>`.

Without a task id, name the agent and its chat instead: `agentx signal stop --agent coder --channel telegram --chat 12345`. This works when that agent has exactly one task running on that chat.

For a task on another machine of your mesh (your connected AgentX machines), add `--peer <machine name>` to any of these commands.

## Let agents pause and resume

Agents use the `agentx_signal` tool with `action` set to `stop`, `resume` or `list`. A coordinating agent can, for example, pause the task it handed to another agent when something more urgent arrives, then resume it later.

A workflow can resume a task with the built-in action `signal.resume`. Give it the stopped task's `id`.

## Pause a step of a workflow

A *workflow* is a saved series of steps; each run of it is a *workflow run*. When the task you pause is an agent's step in a workflow run, the whole run pauses at that step. It is not marked failed.

1. **Browser:** on the **Live** tab, select **❚❚ pause** on the agent's running card, as for any task.
2. Wait a few seconds. In **Stopped tasks**, the task has a line `workflow run <run id> (<workflow>) paused at step <step>`.
3. **Terminal (optional):** run `agentx workflow runs <workflow>`. The run shows `paused`, and its `last` line names the step with `(paused)`.
4. **Terminal (optional):** run `agentx signal show <taskId>`. It names the step and the workflow run, and shows the resume plan.
5. **Browser:** when you're ready, select **▶ resume** on the task. In a terminal, `agentx signal resume <taskId>` does the same.

`agentx workflow resume <run id>` does not work on such a run: it says to use `agentx signal resume` instead, which brings back the plan.

The step runs again with its resume plan placed before the step's prompt, so the agent continues where it stopped. When the step is done, the run goes on to its next steps as usual. Only that step gets the plan.

If you cancel the workflow run while it is paused, the stopped task can no longer be resumed. The resume is refused and says the run was canceled.

![Stopped tasks on the Live page: a workflow step, with the run it paused and the ▶ resume button](/screenshots/live/stopped-workflow-step.png)

### Tasks every agent runs inside a workflow

With [every task in a workflow](/jobs/every-task-a-workflow) switched on, each task runs inside a run of its own. Pausing such a task closes its run as `canceled`. Resuming it starts a new run, and that run names the one it continues:

1. **Terminal:** run `agentx workflow records`.
2. Find the line of the resumed task. Its `continues` field holds the id of the run the pause closed.

## Who may pause or resume a task

| Who | May signal |
|---|---|
| You (dashboard, terminal) | Any task, always. |
| The agent that handed out the task | That task. |
| An agent listed in `signals.allowAgents` | Any task on this machine. |
| Another machine of your mesh | Only when `signals.allowPeers` names it. An agent on that machine still needs one of the rows above. |

An agent can never pause its own task, and the plan-writing turn cannot send signals.

A machine is recognised by its own token in `mesh.peers`. A request that carries the token every machine shares (`MESH_TOKEN`) is believed about which machine it comes from. If your machines are not all equally trusted, give each one its own token in `mesh.peers`.

To let a coordinating agent pause any task on this machine:

1. **Terminal:** run `agentx config set signals.allowAgents lead` (use your agent's id).
2. **Terminal:** run `agentx config get signals` and check that `allowAgents` lists it.

## The settings

The settings live under `signals` in `agentx.json`. Change them with `agentx config set signals.<key> <value>`, or in the dashboard under **Settings › Advanced**. The [configuration reference](/reference/config-automation#signals) lists them all.

| Setting | Default | What it does |
|---|---|---|
| `signals.enabled` | `true` | Turns pausing and resuming on. |
| `signals.windDownSeconds` | `120` | How long the agent gets to write its plan. |
| `signals.allowAgents` | `[]` | Agents that may pause or resume any task. `"*"` allows every agent. |
| `signals.allowPeers` | `[]` | Mesh machines whose signals are accepted. |
| `signals.maxPerRoot` | `6` | Most signals one request may carry in a day. |

The last setting is a brake against loops between agents. Everything that comes from one request (a chat message, a schedule, a webhook) shares one id, its *root*. A paused and resumed task keeps its root. When signals keep bouncing, for example one agent resumes what another keeps pausing, the seventh signal from agents or other machines in a day is refused. Your own pauses and resumes are never counted or refused.

Each pause and resume is also published as an event of kind `signal` (`signal:stop`, `signal:stopped`, `signal:resume`, `signal:resume-failed`), so an agent can [follow events](/automations/event-subscriptions) about it.

## Check it worked

1. **Browser:** send an agent a task that takes a while, then select **❚❚ pause** on its card on the **Live** tab.
2. Within the time limit, **Stopped tasks** shows the task with **plan by the agent**.
3. **Terminal:** run `agentx trace list --agent <agent>`. The task's status is `stopped`, not `error`.
4. **Browser:** select **▶ resume**. The agent's card shows **running**, and the answer reaches the original chat.
5. **Terminal:** run `curl 'http://127.0.0.1:18800/events/recent?kind=signal'`. You see `signal:stop`, `signal:stopped` and `signal:resume` with the same `rootId`.
6. For a workflow step: after **▶ resume**, **Terminal:** run `agentx workflow runs <workflow>`. The run is `running` again, then `completed` once its last step is done.

## If something is wrong

- **"is not in signals.allowAgents":** an agent tried to signal a task it didn't hand out. Add it to `signals.allowAgents`, or pause the task yourself.
- **"mesh peer … is not in signals.allowPeers":** on the machine that runs the task, add the other machine's name to `signals.allowPeers`.
- **"no running task matches":** the task finished before the signal arrived, or several tasks run on that chat. Use the task id.
- **"still writing its resume plan":** wait for the plan (at most `signals.windDownSeconds`), then resume.
- **"is a step of workflow run …, which cannot pause here":** the workflow engine is off on this machine, or the run is not on that agent's step any more. Cancel the workflow run instead.
- **"resume failed: workflow run … is not paused by a stop":** the workflow run was canceled, or went on, after the pause. Start the workflow again.
- **"carried 6 signals today":** the loop brake stopped an agent's signal. Check which agents keep pausing and resuming this task before you raise `signals.maxPerRoot`.
- **The plan says "written by AgentX":** the agent didn't answer in time. Raise `signals.windDownSeconds` if your agents need longer.
- **Resume does nothing in a chat:** the chat's channel isn't running on this machine any more. Check it in [Settings](/dashboard/settings).
