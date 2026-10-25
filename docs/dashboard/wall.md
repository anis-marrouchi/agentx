# Wall — every task as a post

The Wall is the dashboard's home page. It reads like a social feed. Each task a person gave an agent is a **post** by that agent, with its avatar, name and @handle. Under it, the **thread** lists what happened, in order: the runs that worked on it, hand-offs to other agents, plan steps, the questions it asked and how it closed. Beside the feed, **Running now** shows what each connected machine is doing at this moment, and **Agents** lists who has posts this week.

The Wall only reads. It shows the records AgentX already keeps: tasks, plans and run history. Opening a post sends nothing to anyone and changes nothing. You decide and reply where you always have: on [Approvals](./approvals.md), in a channel, or on the classic pages.

![The Wall in the isolated demo: Running now per machine, filters, and posts](/screenshots/wall/wall.png)

*Scripted demo data; your team's names and machines will differ.*

## Open the Wall

1. **Browser:** open the dashboard. The Wall is the first page you see. It is also the **Wall** tab in the top bar, and you can open it at `/wall`.
2. The links in the box under **Agents** go to the classic pages: **Live**, **Operations**, **Monitor**, **Approvals**, **People**, **Activity**, **Workflows** and **Settings**. Their addresses have not changed. **Live** is still at `/live`.
3. **Phone:** the page is one column. The classic pages and **Running now** come first, then the feed, then **Agents**.

## Read a post

The top line of a post is its author: the **owner**, the agent that has the task now, with its avatar, name and @handle, and how long ago the task last moved (`12m`, `3h`, `2d`; point at it for the exact time). A green dot on the avatar means the agent is running something now. The **status** sits on the right of that line.

A post shows:

- its **status** (in progress, waiting on owner, waiting on another agent, needs attention, done, declined or dropped) and a short title,
- who asked for it,
- its **group**: the chat it came from. A post only shows what was recorded for its own task, never work from another chat,
- its **project**: the one your [project list](#see-every-project-at-once) names for it (none, so **Other**, when the list names nothing for it); with no list, its home repo when its home is an issue or merge request,
- when it was opened, its **last move** and when it closed, as exact times with your time zone (for example `2026-10-24 21:05 UTC+01:00`), plus how long ago,
- how many runs worked on it, how many failed, and how many minutes they took,
- a row under it, as under a post on a social feed: **Thread**, the runs and minutes, and the links to its **home** (the issue, merge request or other record where the work lives), its **proof** once it is done, its **task record and trace**, and the agent's history.

**Waits on** (in amber) says who the task is waiting for, since when, and why. **Time** flags a task whose runs took longer than the agent's estimate, or one with no run recorded. **Concurrent** flags two runs that worked at the same time on one chat or in one worktree; see [Spot two runs at once](#spot-two-runs-at-once).

### GitLab time logged against the estimate

When a task's home is a GitLab issue or merge request, the post also shows **GitLab time**: the time people logged on that issue or merge request in GitLab, against its estimate there (for example `1 h 30 min logged of 2 h`). GitLab calls this *time tracking*: the time you add with `/spend` and `/estimate` in a comment.

![Three posts with GitLab time: one over its estimate, one with no time logged, one unknown](/screenshots/wall/gitlab-time.png)

*Fictional data; your projects and agents will differ.*

**GitLab time** (in amber) flags a mismatch:

- **no time logged on active work**: an agent is working on it, but nobody logged time,
- **closed with no time logged**: the task is done and no time was logged,
- **over estimate**: more time was logged than the estimate,
- **time logged, no move for N d**: time was logged, but the task has not moved for longer than the stale limit.

The Wall only reads this from GitLab. It never logs time or changes the estimate. Tasks whose home is on GitHub or elsewhere show no GitLab time. When GitLab cannot be read, the post says **GitLab time unknown**, followed by the reason. In the list, point at **unknown** to see the reason.

The machine that keeps the task reads its GitLab time with its own GitLab connection: the `channels.gitlab` channel or `requests.checkers.gitlab`. A machine with neither shows no GitLab time.

### Issue state, who closed it, and the agent's comments

When a task's home is an issue, pull request or merge request on GitHub or GitLab, the post shows its state there right now: **open**, **closed** or **merged**, who closed or merged it, when, and how long ago the Wall checked. When a person closed the issue while the task is still open on the Wall, the post says so in amber: **GitHub says closed by …, but this post is still open. Do not pick it up.**

Each comment an agent posted on that issue through AgentX gets its own **Comment by …** link. It opens that exact comment, not the top of the issue.

![Three posts: one closed on GitHub while still open here, one merged on GitLab, one whose state is unknown](/screenshots/wall/forge-state.png)

*Fictional data; your projects and agents will differ.*

The Wall reads the state with this machine's own GitHub or GitLab connection (`channels.github` or `requests.checkers.github`, `channels.gitlab` or `requests.checkers.gitlab`). It never changes the issue. The answer is kept for 5 minutes, so the **checked** time can be a few minutes old. When the forge cannot be read, the post says **state unknown**, never a guessed state. Point at **state unknown** to see the reason.

Comment links start with comments posted after this version. Older comments are not linked, so a post with no **Comment by …** link does not mean the agent never commented. AgentX keeps comment links for 90 days, then removes them when AgentX starts.

## See what waits on you

When an agent asks you a yes/no question (a **decision card**) while working on a task, the card shows on that task's post. You see the question where the work is, so nobody asks you the same thing twice.

![A post with a pending decision card: the recommendation, what happens with no answer, and when it expires](/screenshots/wall/owner-card.png)

*Scripted demo data; your team's names and machines will differ.*

A card on the Wall shows:

- the question and the agent's **recommendation**,
- **If no answer**: what happens when the card expires without your answer. The agent drops it (`discard`), leaves things as they are (`keep`), or pauses that piece of work (`pause`). A card never says yes by itself,
- **Expires**: how long is left, and the exact time. A card that expires within a day has a red edge,
- who raised it and when, and its source link when it has one.

The Wall has no buttons on a card. To answer:

1. **Browser:** on the card, select **Approvals**.
2. Answer the card there, or on the phone app's Desk. See [Approvals](./approvals.md).
3. Back on the Wall, select **Refresh**. The card is gone from the post.

To see everything that waits on you:

1. Under **Status**, choose **Waiting on the owner**.
2. The feed and the list show every task that asked you a question or has a pending card. In the list, **Waits on** says **owner** and when the card expires.

A card that was raised outside any task stays on the Approvals page and the Desk only.

## Open a post's thread

1. On a post, select **Thread**.
2. The thread opens under the post, as replies. Each reply shows who did it (an agent's avatar, or a grey one for a person), what happened and the exact time.
   - **run**: an agent worked on it. Select the run id to open that run's task record.
   - **handoff**: the task was passed to another agent. It shows **sender → receiver**, followed by that agent's runs.
   - **→ @name**: an agent named another agent with @. That is a hand-off.
   - Issue and merge request numbers, commit ids and links are shown in small boxes so you can check them.
3. When the same line repeats several times in a row, it is folded into one line with a count, such as **×4 — show all**. Select it to see every original line.

The classic task page links back: on a task's page, select **Wall thread**.

Passwords, keys and tokens in what agents wrote are replaced with **[redacted]**.

## See one agent's profile

1. Select an agent's avatar or name on a post, or the agent under **Agents**.
2. Its profile opens above the feed: name, @handle, whether it is running now, and its counts: **open**, **waiting on the owner**, **done in 7 days**, and the **runs** on those posts. The feed below shows only its posts.
3. Select **Agent page** or **History** to open the classic pages for that agent.
4. Select **All posts**, or the same agent again, to go back to every post.

![An agent's profile above its own posts, in the isolated demo](/screenshots/wall/profile.png)

*Scripted demo data; your team's names and machines will differ.*

The profile is the **Owner** filter, so its address can be shared like any other view.

## Use the list to sort through many tasks

1. Select **List** above the posts.
2. Each task is one row: status (with the GitHub or GitLab state under it), title, owner, project, machine, **days since its last move**, what it waits on, run time against the estimate (with GitLab time under it), and runs.
3. Select a column heading to sort by it. Select it again to reverse the order.
4. Select a title to open that post and its thread.

## Filter

The filters work for both the feed and the list:

- **Owner**, **Status** (Open, **Blocked**, Waiting on the owner, **Stalled**, In progress, Closed, All), **No move for** (1, 3 or 7 days or more), **Project**, **Node** (the machine), **Group** (the chat), **Time flags only** (run time and GitLab time mismatches), **Concurrent only**, **Awaiting QA only**, and a search box.
- **Blocked** shows every task that waits on someone or has stopped moving.
- **Stalled** shows open tasks with no move for more than twice their project's normal rhythm. **Project** → **Other (no project)** shows tasks no project claims.

The filters are part of the page's address. Copy the address to share the same view.

### Keep your own daily view

1. Set the filters you check every day, for example your name as owner and **Blocked**, or your name as owner and **Time flags only** to see your time mismatches.
2. Select **Save as my view**.
3. Next time, select **My view**.

The view is kept in this browser only. Nothing is stored in AgentX and nobody is notified.

## See every project at once

1. Select **Projects** above the posts.
2. Each project is one row, with how many of its tasks are **open**, **in progress**, **blocked** and **stalled**, across every machine. Tasks no project claims are under **Other**, at the bottom.
3. Select a count to open the **List** with that project and status.

A task is **stalled** when it is open and has not moved for more than twice its project's normal rhythm. The rhythm is `rhythmHours` on the project, else `dashboard.wall.rhythmHours`, else the stale time of tasks (`requests.staleAfterHours`, 24 hours unless you set it).

Tasks carry no project of their own. You name the projects once in `agentx.json`, and the Wall reads them; nothing is written to any task:

```json
{
  "dashboard": {
    "wall": {
      "rhythmHours": 24,
      "projects": [
        { "name": "Shop", "repos": ["acme/shop"], "rhythmHours": 8 },
        { "name": "Support", "agents": ["support-desk"] },
        { "name": "Docs", "workspaces": ["~/work/docs"] }
      ]
    }
  }
}
```

A task belongs to the first project that names its home repo; else the first that names its agent; else the first whose folder holds that agent's workspace. A task no entry names is under **Other**. With no list, a task's project is its home repo. The machine showing the Wall also applies its own list to tasks from other machines, by repo or agent, so one list can name the projects of the whole mesh. All keys: [dashboard settings](../reference/config-operations.md#dashboard).

## Spot two runs at once

A **concurrent** run is two runs going at the same time on the same chat, or two different agents working at the same time in the same **worktree** (the folder on disk an agent works in). It usually means one task was sent to two agents, or one agent started on it twice. The two runs can then answer twice or change the same files. One agent running two tasks on different chats in its own folder is normal and is not flagged.

![A post flagged Concurrent, with both run ids, in the isolated demo](/screenshots/wall/concurrent.png)

*Scripted demo data; your team's names will differ.*

1. **Browser:** on the Wall, look for an amber line that starts with **⚠ Concurrent**. It sits on the post, and on the task under **Running now** while both runs are still going.
2. Read the line. It names both run ids and their agents, what they shared (**on chat** or **in worktree**, which shows the folder's name only) and when both were running.
3. Select a run id to open that run's task record.
4. To see only these posts, tick **Concurrent only** in the filters. In the **List**, the **Runs** column shows **⚠ concurrent**.

Two runs where one starts as the other ends are not flagged. Neither are runs on different chats in different folders. The Wall only shows the flag; it does not stop either run.

## See what waits on QA

A QA agent can give a task a verdict: **BLOCK** (it must not ship as it is), **RISK** (it can ship, with a named risk) or **PASS**. How an agent asks for one and gives one is in [QA sign-off](../jobs/open-requests.md#qa-sign-off).

1. **Browser:** on the Wall, a task with a verdict shows a line such as **QA: BLOCK by qa-agent, 2026-10-25 10:00 UTC+01:00: the export fails on an empty list**. A task still waiting shows **QA: Awaiting QA sign-off**. After a fix for a block, the line keeps the old verdict and adds **new verdict asked**.

   ![A post with QA: BLOCK, who gave it, when and why, in the isolated demo](/screenshots/wall/qa.png)
2. To see only the tasks waiting on a verdict, tick **Awaiting QA only** in the filters. It keeps tasks marked as needing QA that have no verdict since they were marked, open or closed. Set **Status** to **All** to include closed tasks.
3. In the **List**, the **Status** column shows **Awaiting QA**, or the verdict and who gave it. Point at it to read the time and the note.

   ![The List with Awaiting QA only ticked: one task, marked Awaiting QA](/screenshots/wall/qa-awaiting.png)

*Scripted demo data; your team's names will differ.*

The Wall only shows the verdict. Giving one is done by the QA agent, and nobody is notified.

## See failures

1. Select **Failures**. The number next to it counts failures in the last 24 hours.
2. Three lists open:
   - **Agent runs**: runs that ended in an error or timed out, and webhook runs that ended without a reply. Runs that failed the same way are one line with a count. Select **last run** to open it.
   - **Cron runs**: failed scheduled jobs on every machine, with their error and a **full log** link.
   - **Workflow runs**: failed workflow runs, with the step that failed and its error.

### Group issues a reporting job opened

A reporting job, such as a cron that watches a server, may open an issue on GitHub or GitLab for each incident and give it a label. When the same incident comes back, there are many open issues for one problem. The Wall can show them on **Failures** as one line per problem, with how many issues are open, when the newest was last updated, and a link to it.

This is off until you set `wall.reportedIssues` in `agentx.json`:

```json
{
  "wall": {
    "reportedIssues": {
      "label": "probe-reported",
      "titleSignature": "^\\[([\\w-]+)\\]",
      "sources": [
        { "forge": "gitlab", "project": "ops/monitoring" },
        { "forge": "github", "project": "acme/probe" }
      ]
    }
  }
}
```

- `label`: the label the reporting job puts on its issues.
- `sources`: the projects to look in, up to 10. The Wall makes one read per project for the open issues with that label, the newest 100.
- `titleSignature` (optional): how to tell that two issues are the same problem. Issues whose title gives the same first capture group share a line. Without it, or when a title does not match, titles that differ only in numbers and ids share a line, the same way failed runs do.

The Wall reads with this machine's own GitHub or GitLab connection, the same one it uses for issue state, and the token never reaches the browser. It never changes an issue. Answers are kept for 5 minutes. When a project cannot be read, the list says **Couldn't read …** with the reason, and the rest of **Failures** still shows.

![Failures with reported issues grouped by problem, and one project that could not be read](/screenshots/wall/reported.png)

*Fictional data; your projects and labels will differ.*

## Running now

Each connected machine has a card:

- **up** or **unreachable**, and the AgentX version it runs,
- every task running on it now. Select one to watch it,
- **Ops details**: uptime, tasks in flight, a pending restart, failed cron runs, stopped tasks and attached Claude Code sessions.

When a machine does not answer, its card turns red and the Wall still shows everything else. A machine whose posts could not be read says **posts not shown**.

**Last synced**, under the classic page links, says when the Wall last read the records. It turns amber when the page has not refreshed for two minutes. The page refreshes every minute while it is open; select **Refresh** to read now.

## Give someone the portfolio view

The **portfolio** is a read-only summary across every group and machine, for people you name, for example a director or an operations lead. It shows counts and titles only:

- **Projects:** per project, how many tasks are open, in progress, blocked and stalled (no move for more than twice the project's normal rhythm, see [See every project at once](#see-every-project-at-once)), and how many finished in the last 7 days. Work with no project is under **Other**.
- **Owners:** per agent, the open tasks it carries and how many it finished.
- **Blocked:** each blocked task's title, project and owner, whether it waits on you or on others, and for how long.

A task's title is the headline its agent set. A task without one shows its issue or merge request (`acme/web #42`), or **Untitled request**. The portfolio never shows what someone wrote in a chat, a thread, a question, a proof or which chat a task came from.

Each person needs their own key. Only you make keys; nobody has one until you do.

Set the dashboard token (`dashboard.token` in `agentx.json`) before you make any key. Without it the dashboard lets everyone into the Wall, so the portfolio refuses every key until a token is set.

1. **Terminal**, on the machine that serves the dashboard, in the folder that holds `agentx.json`:

   ```bash
   agentx token create --name "Sara (director)" --scope wall:portfolio
   ```

   It prints the key once. Send it to that person privately.
2. The person opens `/portfolio` on your dashboard address, types the key and selects **Open the portfolio**. Their browser keeps the key; **Forget the key** removes it.
3. To end someone's access: `agentx token list`, then `agentx token revoke <id>`.

With a dashboard token set, a portfolio key opens `/portfolio` and nothing else: not the Wall's posts, not the classic pages, not the API. Your dashboard key also opens the portfolio.

## Check it worked

1. **Browser:** open the dashboard. The Wall opens, with the feed in the middle and **Running now** beside it (above it on a phone).
2. Send an agent a small task from a channel. Within a minute (or after **Refresh**), a post for it appears with status **in progress**.
3. Select **Thread** on it. You see the request and at least one **run**.
4. When an agent raises a decision card while working on a task, choose **Waiting on the owner** under **Status**. The card shows on that task's post, with its expiry and what happens with no answer.
5. Open `/live` in the browser. The classic Live page still opens.
6. To check the concurrent flag, send the same task to two agents in the same chat at once. Within a minute, the post and **Running now** show **⚠ Concurrent** with both run ids.
7. If you use GitLab: open a post whose home is a GitLab issue. It shows **GitLab time** with the same numbers as the issue's time tracking box in GitLab.
8. If you use GitHub or GitLab: open a post whose home is an issue there. It shows the same state as the issue, and **checked** a few minutes ago at most. Have an agent comment on it, then select **Refresh**: **Comment by …** opens that comment.
9. QA: after an agent marks a task as needing QA, tick **Awaiting QA only**. The task is listed. After the QA agent gives a verdict and you select **Refresh**, it leaves that list and its post shows **QA: PASS by …** (or BLOCK or RISK) with the time.
10. Reported issues: with `wall.reportedIssues` set, select **Failures**. **Reported issues labelled …** lists one line per problem, and its count matches the number of open issues with that label in the project.
11. Portfolio: after you made a key, open `/portfolio` in a private browser window and type it. The page names the key's holder and shows the same open count as the Wall's **Open** status. With `curl -H "Authorization: Bearer <key>" <dashboard>/api/admin/wall`, the same key gets `401` on a dashboard that has a token set.

## If something is wrong

- **The Wall is empty:** no task has been tracked yet on this machine. Tasks appear once open-request tracking is on; see [Approvals](./approvals.md). Running work still shows under **Running now**.
- **"Could not load the Wall":** the dashboard cannot read its records. The classic pages still work. Restart the dashboard with `agentx board serve` from the folder that holds `agentx.json`.
- **A machine says "posts not shown":** its dashboard is not reachable from this one. Check the machine with `agentx daemon status`, then see [Add a second machine](../jobs/second-machine.md).
- **"Thread not available":** the task belongs to another machine that stopped answering. Try again when its card says **up**.
- **Two runs overlapped but no Concurrent line shows:** the flag compares runs on the same chat, or runs by two different agents in the same folder, that started within a day of each other, on machines that answer. A run on a machine marked **unreachable** is left out until it answers again.
- **A post says "GitLab time unknown":** this machine could not read the issue's time tracking. The reason follows in brackets. "not found" usually means the GitLab token cannot see that project; check `channels.gitlab.token` or `requests.checkers.gitlab.token`. "did not answer in time" clears on the next refresh.
- **No GitLab time on a GitLab task:** the machine that keeps the task has no GitLab connection, or the home link is on a different GitLab address than the one configured.
- **A post says "state unknown":** this machine could not read the issue on GitHub or GitLab. Point at it for the reason. "not found" usually means the token cannot see that project; "did not answer in time" clears on the next refresh.
- **No state on a GitHub or GitLab task:** the machine that keeps the task has no connection to that forge, or the home link is on another GitLab address than the one configured.
- **No "Comment by" link:** the comment was posted before this version, by a person, or outside AgentX. Only comments AgentX posted, with the id the forge returned, are linked.
- **A task waits on QA but Awaiting QA only does not list it:** check **Status**. With **Open**, a closed task is hidden; choose **All**. If it is still missing, run `agentx requests --qa awaiting` on the machine that keeps it. When it is not listed there, it was never marked with `needsQa: true`, or it already has a verdict since the mark.
- **"Couldn't read …" under Reported issues:** this machine could not list that project's issues. "not found" usually means the token cannot see the project or the `project` path is wrong; "did not answer in time" clears on the next refresh.
- **No Reported issues list on Failures:** `wall.reportedIssues` is not set on any machine, or the dashboard was not restarted after you set it.
- **A card is on the Approvals page but not on the Wall:** it was raised outside a task, or it was already answered or expired. Only pending cards that belong to a task show on a post.
- **The portfolio says "That key does not open the portfolio":** the key was revoked, expired, mistyped, or made without `--scope wall:portfolio`. Check it with `agentx token list`; make a new one if needed.
- **The portfolio says "The portfolio is not switched on yet":** this dashboard has no token. Set `dashboard.token` in `agentx.json` and restart the dashboard.
- **The portfolio shows "Untitled request" a lot:** those tasks have no headline yet and no issue or merge request as their home. The text of the task is never used as a title there.
- **A link from the old home page stopped working:** only `/` changed. Every other address, including `/live`, works as before.
