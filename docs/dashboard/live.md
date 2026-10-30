# Live — who's working now

**Live** is a page of the [Hub](./hub.md), the dashboard's home. It shows what runs on every connected machine right now, the tasks you paused, and one card per machine where you restart it and connect your command-line sessions. Use it when you have just sent a task and want to see whether an agent picked it up.

Live is a current view. For completed work and the route it took, use [Activity](./activity.md). For work that needs your attention, use [Monitor](./monitor.md).

The old address, `/live`, opens this page.

![The Live page: a session and a job running now, a paused task with Resume and Drop, and the machine cards](/screenshots/wall/live.png)

*Scripted demo data; your team's names and machines will differ.*

## Open Live

1. **Browser:** open the dashboard. The Hub opens.
2. **Browser:** in the nav on the left, select **Live**. On a phone, it is under **More**. The number next to it counts what runs now.

While the page is open, it updates every two seconds.

![Live on a phone: what runs now and a paused task, with the nav bar at the bottom](/screenshots/wall/live-phone.png)

## Watch, steer or stop a running task

Under **Running now**, each card is one run. **Session** is a task from a chat, mail or another message; **Job** is a scheduled job, with the job's name. A card shows the agent, what it is working on, how long it has run and, under **Latest**, the last thing it did, such as **Using Bash** or a line of its reply.

1. **Browser:** on **Live**, select the card. The run's **Task** page opens, with what it was asked and its conversation as it happens.
2. To add something, write in the box under the conversation and select **Send**. The current turn keeps running; your message goes in as the next turn.
3. To end the current turn, select **Stop**.
4. To pause the task so it can go on later, select **Pause** at the top, then select **Pause it?** to confirm. The agent writes a *resume plan* (a short note of where it got to and what is left), and the task moves to **Paused** on Live.

![A running task's page with the Pause button at the top](/screenshots/wall/task-pause.png)

More on the Task page: [Watch and steer a run](./hub.md#watch-and-steer-a-run).

## Resume a paused task

A task you or an agent paused is listed under **Paused**, newest first. Each card says who stopped it and when, why (when a reason was given), what it was asked, and its resume plan.

1. **Browser:** on **Live**, find the task under **Paused**.
2. **Browser:** to read the plan first, select **Resume plan, by …**.
3. **Browser:** select **Resume**. The note at the top of the page says **Resumed: it goes on from its plan.**
4. The task leaves **Paused** and shows under **Running now** again. Its answer goes to the chat it came from, as it would have the first time.

**Pausing…** means the agent is still writing its plan. **Resume** shows once the plan is saved.

You can also resume from the task's own page: select **Open the run** on the card, then **Resume** at the top.

![A paused task on Live: who stopped it, why, the request, its resume plan, and the Resume and Drop buttons](/screenshots/wall/live-paused.png)

## Drop a paused task you won't resume

1. **Browser:** on **Live**, find the task under **Paused**.
2. **Browser:** select **Drop**. The button turns red and reads **Drop it for good?**
3. **Browser:** select it again within a few seconds. The task and its plan are deleted, and it can no longer be resumed. If you wait, the button goes back to **Drop** and nothing happens.

More about pausing: [Pause a task and resume it later](../jobs/pause-and-resume.md).

## Restart a machine when it is idle

Under **Machines**, each card is one machine running AgentX. A machine can restart itself as soon as no task runs, so no work is cut off. This needs a service manager (launchd on a Mac, systemd on Linux) to start AgentX again.

1. **Browser:** on **Live**, find the machine under **Machines**. It says how many tasks run on it now.
2. **Browser:** select **Restart when idle**. The button turns red and reads **Restart once idle?**
3. **Browser:** select it again to confirm.
4. The card shows **Restart waiting · 2 running · until 14:30** while tasks still run. It waits up to 30 minutes, then restarts anyway. To call it off, select **Cancel restart**.
5. When no task runs, the card shows **Restarting…**. The machine is unreachable for a few seconds, then comes back **up**.

More: [Restart without losing work](../jobs/restart-safely.md#restart-from-the-dashboard).

![Machine cards on Live: Restart when idle, the Claude Code sessions attached with their agent and start time, and Connect a CLI session](/screenshots/wall/live-machines.png)

## See which Claude Code session answers for an agent

When you run `agentx attach as <agent>` in a Claude Code session, messages for that agent go to your session instead of starting a new run. The machine's card lists these sessions under **Claude Code sessions**:

- the agent the session answers for (or **answers for no agent**),
- the project folder it runs in,
- when it started, and when it last reported,
- how it handles new messages: **tells you about new messages**, **answers new messages**, or **you read its inbox**.

**waiting for the session to report again** means the link to the agent is saved, but the session has not reported since AgentX restarted or since it sat idle. It gets the link back as soon as you type in that session again.

With none attached, the card says **No Claude Code session attached.** Only the machine the dashboard runs on lists its sessions; other machines keep this list private.

## Connect a CLI session

AgentX can review each turn of a command-line AI session (Claude Code, Codex, Gemini or OpenCode) on a machine, and tell you on [Monitor](./monitor.md) what needs you.

1. **Browser:** on **Live**, find the machine under **Machines**.
2. **Browser:** under **Connect a CLI session**, select **Find CLI sessions**.
3. The card lists what it found. **Claude Code in** *folder* reports its turns itself. Other CLIs are listed by name and start time.
4. **Browser:** select **Connect** next to the one you want. It shows **Connected**.

Only the programs the machine's AgentX account runs are found. To connect another one, use **Register manually** on [Monitor](./monitor.md).

## A lesson on a machine's screen

When an agent runs an on-screen lesson through [AgentX Voice](./voice.md), it is listed under **Spaces and lessons**. Select **Stop** on it to end the lesson and give the screen back.

## A machine does not answer

If a machine is slow to answer, Live keeps its last known data for up to five minutes and its card says **not responding**. After that, it says **unreachable**, with the reason. Its buttons come back as soon as it answers again.

## Check it worked

1. **Browser:** open `/live` on your dashboard. Hub Live opens, with every machine under **Machines**.
2. Send an agent a small task from a channel or [in-page chat](./chat.md). Within a few seconds, its card shows under **Running now**.
3. Select the card, then **Pause** and **Pause it?**. Within the time limit, the task is under **Paused** with **Resume plan, by** *agent*.
4. Select **Resume**. The task shows under **Running now** again, and its answer reaches the original chat.
5. On a machine started by launchd or systemd, select **Restart when idle** twice. The card shows **Restart waiting**, then **Restarting…**, then **up** again.
6. **Terminal:** in a Claude Code session, run `agentx attach as <agent>`, then type anything in that session. Within a few seconds, the machine's card lists the session with that agent and its start time.

## If something is wrong

- **No machine appears:** the daemon (the AgentX background service) isn't running or the dashboard can't reach it. See [It's not answering](../help/its-not-answering.md).
- **The agent never shows under Running now:** the message didn't reach AgentX. Check that the channel is connected in [Settings](./settings.md).
- **A machine is missing:** its daemon or the connection to it is down. See [Add a second machine](../jobs/second-machine.md).
- **"Not done: Only the owner writes on the Hub…":** the page was opened without your dashboard key. Open the dashboard from the same machine, or sign in again. Only you can resume, drop, pause or restart.
- **A machine says it cannot restart from here:** it runs an AgentX from before this feature. Update it, or use `agentx daemon restart --when-idle` in a terminal on it.
- **"Not done: … would not start AgentX again":** nothing would start AgentX after it exits. See [Restart from the dashboard](../jobs/restart-safely.md#restart-from-the-dashboard).
- **Resume is missing on a paused task:** the agent is still writing its plan (**Pausing…**), or the task's chat can no longer be reached. Wait a few seconds; if it stays, drop the task and send it again.
- **An attached session doesn't appear:** type a message in that session so its hooks report to the daemon, then check `agentx attach list`. If the session isn't listed there, run `agentx attach install` once and restart the session.
- **Find CLI sessions says "No CLI found":** the CLI runs under another account, or is not running. Register it by hand on [Monitor](./monitor.md).
