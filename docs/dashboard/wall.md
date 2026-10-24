# Wall — every task as a post

The Wall is the dashboard's home page. Each task a person gave an agent is a **post**. Under it, the **thread** lists what happened, in order: the runs that worked on it, hand-offs to other agents, plan steps, the questions it asked and how it closed. At the top, **Running now** shows what each connected machine is doing at this moment.

The Wall only reads. It shows the records AgentX already keeps: tasks, plans and run history. Opening a post sends nothing to anyone and changes nothing. You decide and reply where you always have: on [Approvals](./approvals.md), in a channel, or on the classic pages.

![The Wall in the isolated demo: Running now per machine, filters, and posts](/screenshots/wall/wall.png)

*Scripted demo data; your team's names and machines will differ.*

## Open the Wall

1. **Browser:** open the dashboard. The Wall is the first page you see. It is also the **Wall** tab in the top bar, and you can open it at `/wall`.
2. The row of links under the top bar goes to the classic pages: **Live**, **Operations**, **Monitor**, **Approvals**, **People**, **Activity**, **Workflows** and **Settings**. Their addresses have not changed. **Live** is still at `/live`.

## Read a post

A post shows:

- its **status** (in progress, waiting on owner, waiting on another agent, needs attention, done, declined or dropped) and a short title,
- its **owner**, the agent that has the task now, and who asked for it,
- its **group**: the chat it came from. A post only shows what was recorded for its own task, never work from another chat,
- its **project**, when its home is an issue or merge request,
- when it was opened, its **last move** and when it closed, as exact times with your time zone (for example `2026-10-24 21:05 UTC+01:00`), plus how long ago,
- how many runs worked on it, how many failed, and how many minutes they took,
- the links to its **home** (the issue, merge request or other record where the work lives), its **proof** once it is done, its **task record and trace**, and the agent's history.

**Waits on** (in amber) says who the task is waiting for, since when, and why. **Time** flags a task whose runs took longer than the agent's estimate, or one with no run recorded. **Concurrent** flags two runs that worked at the same time on one chat or in one worktree; see [Spot two runs at once](#spot-two-runs-at-once).

## Open a post's thread

1. On a post, select **Thread**.
2. The thread opens under the post. Each line shows what happened, who did it and the exact time.
   - **run**: an agent worked on it. Select the run id to open that run's task record.
   - **handoff**: the task was passed to another agent. It shows **sender → receiver**, followed by that agent's runs.
   - **→ @name**: an agent named another agent with @. That is a hand-off.
   - Issue and merge request numbers, commit ids and links are shown in small boxes so you can check them.
3. When the same line repeats several times in a row, it is folded into one line with a count, such as **×4 — show all**. Select it to see every original line.

The classic task page links back: on a task's page, select **Wall thread**.

Passwords, keys and tokens in what agents wrote are replaced with **[redacted]**.

## Use the list to sort through many tasks

1. Select **List** above the posts.
2. Each task is one row: status, title, owner, project, machine, **days since its last move**, what it waits on, run time against the estimate, and runs.
3. Select a column heading to sort by it. Select it again to reverse the order.
4. Select a title to open that post and its thread.

## Filter

The filters work for both the feed and the list:

- **Owner**, **Status** (Open, **Blocked**, Waiting on owner, In progress, Closed, All), **No move for** (1, 3 or 7 days or more), **Project**, **Node** (the machine), **Group** (the chat), **Time flags only**, **Concurrent only**, and a search box.
- **Blocked** shows every task that waits on someone or has stopped moving.

The filters are part of the page's address. Copy the address to share the same view.

### Keep your own daily view

1. Set the filters you check every day, for example your name as owner and **Blocked**.
2. Select **Save as my view**.
3. Next time, select **My view**.

The view is kept in this browser only. Nothing is stored in AgentX and nobody is notified.

## Spot two runs at once

A **concurrent** run is two runs going at the same time on the same chat, or two different agents working at the same time in the same **worktree** (the folder on disk an agent works in). It usually means one task was sent to two agents, or one agent started on it twice. The two runs can then answer twice or change the same files. One agent running two tasks on different chats in its own folder is normal and is not flagged.

![A post flagged Concurrent, with both run ids, in the isolated demo](/screenshots/wall/concurrent.png)

*Scripted demo data; your team's names will differ.*

1. **Browser:** on the Wall, look for an amber line that starts with **⚠ Concurrent**. It sits on the post, and on the task under **Running now** while both runs are still going.
2. Read the line. It names both run ids and their agents, what they shared (**on chat** or **in worktree**, which shows the folder's name only) and when both were running.
3. Select a run id to open that run's task record.
4. To see only these posts, tick **Concurrent only** in the filters. In the **List**, the **Runs** column shows **⚠ concurrent**.

Two runs where one starts as the other ends are not flagged. Neither are runs on different chats in different folders. The Wall only shows the flag; it does not stop either run.

## See failures

1. Select **Failures**. The number next to it counts failures in the last 24 hours.
2. Three lists open:
   - **Agent runs**: runs that ended in an error or timed out, and webhook runs that ended without a reply. Runs that failed the same way are one line with a count. Select **last run** to open it.
   - **Cron runs**: failed scheduled jobs on every machine, with their error and a **full log** link.
   - **Workflow runs**: failed workflow runs, with the step that failed and its error.

## Running now

Each connected machine has a card:

- **up** or **unreachable**, and the AgentX version it runs,
- every task running on it now. Select one to watch it,
- **Ops details**: uptime, tasks in flight, a pending restart, failed cron runs, stopped tasks and attached Claude Code sessions.

When a machine does not answer, its card turns red and the Wall still shows everything else. A machine whose posts could not be read says **posts not shown**.

**Last synced** at the top says when the Wall last read the records. It turns amber when the page has not refreshed for two minutes. The page refreshes every minute while it is open; select **Refresh** to read now.

## Check it worked

1. **Browser:** open the dashboard. The Wall opens, with **Running now** at the top.
2. Send an agent a small task from a channel. Within a minute (or after **Refresh**), a post for it appears with status **in progress**.
3. Select **Thread** on it. You see the request and at least one **run**.
4. Open `/live` in the browser. The classic Live page still opens.
5. To check the concurrent flag, send the same task to two agents in the same chat at once. Within a minute, the post and **Running now** show **⚠ Concurrent** with both run ids.

## If something is wrong

- **The Wall is empty:** no task has been tracked yet on this machine. Tasks appear once open-request tracking is on; see [Approvals](./approvals.md). Running work still shows under **Running now**.
- **"Could not load the Wall":** the dashboard cannot read its records. The classic pages still work. Restart the dashboard with `agentx board serve` from the folder that holds `agentx.json`.
- **A machine says "posts not shown":** its dashboard is not reachable from this one. Check the machine with `agentx daemon status`, then see [Add a second machine](../jobs/second-machine.md).
- **"Thread not available":** the task belongs to another machine that stopped answering. Try again when its card says **up**.
- **Two runs overlapped but no Concurrent line shows:** the flag compares runs on the same chat, or runs by two different agents in the same folder, that started within a day of each other, on machines that answer. A run on a machine marked **unreachable** is left out until it answers again.
- **A link from the old home page stopped working:** only `/` changed. Every other address, including `/live`, works as before.
