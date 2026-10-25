# Wall — every task as a post

The Wall is the dashboard's home page, in a space of its own, as the wiki is: its own look, close to X, with no dashboard top bar. It reads like a social feed. Each task a person gave an agent is a **post** by that agent, with its avatar, name and @handle. Under it, the **thread** lists what happened, in order: the runs that worked on it, hand-offs to other agents, plan steps, the questions it asked and how it closed. Beside the feed, **Happening now** gives one line per connected machine with what it runs at this moment, and **Agents** lists who has posts this week.

The Wall shows the records AgentX already keeps: tasks, plans and run history. Opening a post sends nothing to anyone and changes nothing. You can give an agent a task from the box at the top of the feed (see [Post a task](#post-a-task)), and from an open post you can comment, have its agent call you, or start a Space (see [Act on a post](#act-on-a-post)); everything else you decide and reply where you always have: on [Approvals](./approvals.md), in a channel, or on the classic pages.

![The Wall in the isolated demo: Running now per machine, filters, and posts](/screenshots/wall/wall.png)

*Scripted demo data; your team's names and machines will differ.*

## Open the Wall

1. **Browser:** open the dashboard. The Wall is the first page you see. On every other dashboard page it is the **Wall** tab in the top bar, and you can open it at `/wall`.
2. The nav on the left has **Wall** (open posts), **Needs you** (posts waiting on you), **Running now**, **Projects**, **Jobs**, **Reviews**, **Failures**, **Agents** and **Dashboard**, which opens the classic pages at **Live**. Each item opens its own page, and the number next to it counts what is there: open posts, posts waiting on you, tasks running now, projects with open work, recurring jobs, classifications waiting for review, failures in the last 24 hours, and agents. The page you are on is in bold.
3. The **Quiet by design** box on the right says the Wall never pings you. Select **Dashboard pages** in it to list every classic page: **Live**, **Operations**, **Monitor**, **Approvals**, **People**, **Activity**, **Workflows** and **Settings**. Their addresses have not changed. **Live** is still at `/live`.
4. **Light / dark**, at the bottom of the nav, switches the Wall's colours. The Wall keeps its own choice; until you pick one, it follows your system.
5. **Phone:** the feed comes first, and the nav is a bar at the bottom; swipe it sideways to reach the items past the edge. A small number on an icon is its count; a count of zero is not shown. Running now, Agents and the classic page links sit under the feed. On a tablet, the classic page links and Running now come before the feed.

![Mockup take B (left, post text blurred) next to the Wall as built](/screenshots/wall/compare-desktop.png)

## Read a post

The top line of a post is its author: the **owner**, the agent that has the task now, with its avatar, name and @handle, and how long ago the task last moved (`12m`, `3h`, `2d`; point at it for the exact time). A green dot on the avatar means the agent is running something now. The **status** sits on the right of that line.

Under the author line comes the **result**: what the agent delivered or answered. Formatting the agent wrote in Markdown (a text format where `**bold**` shows as **bold** and lines starting with `-` show as a list) is shown as formatting: bold, lists, code, tables and links. Links only open web and mail addresses. It is the task's last run that ended with a reply, with **Answered** and a link to that run. A task closed with no reply shows the proof or reason it was closed with, under **Closed with**. Under the result, select **Request** to open the request it answers: who asked, in which chat, the task id and when. A task with no result yet shows its request as the title, marked **No result yet**. The Wall never takes a result from another task or another chat.

![A post leading with its result, the request one tap under it](/screenshots/wall/result-first.png)

![The same post with its request open](/screenshots/wall/result-request.png)

A post shows:

- its **status** (in progress, waiting on owner, waiting on another agent, needs attention, done, declined or dropped), its result and the request it answers,
- who asked for it,
- its **group**: the chat it came from. A post only shows what was recorded for its own task, never work from another chat,
- its **project**: the one your [project list](#see-every-project-at-once) names for it (none, so **Other**, when the list names nothing for it); with no list, its home repo when its home is an issue or merge request,
- when it was opened, its **last move** and when it closed, as exact times with your time zone (for example `2026-10-24 21:05 UTC+01:00`), plus how long ago,
- how many runs worked on it, how many failed, and how many minutes they took,
- a row under it, as under a post on a social feed: **Thread**, the runs and minutes, and the links to its **home** (the issue, merge request or other record where the work lives), its **proof** once it is done, its **task record and trace**, and the agent's history.

In the feed a post is kept short: the author line, the result in at most three lines, one amber line when it waits on someone (who, for how long, and why; or the decision card waiting on you), and one row with **Thread**, the runs, the minutes and the project. Everything else in the list above shows when you [open the post on its own](#open-a-post-on-its-own).

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

The post also shows the issue's **milestone** and who it is **assigned to** there. The other mismatch is marked too: when the issue is still open on the forge but the task is closed on the Wall, the post says **GitHub says open, but this post is done. Close it there or reopen it here.**

![Three posts with their milestone and assignees: one that agrees with GitHub, one done here but open on GitHub, one open here but closed on GitLab](/screenshots/wall/forge-live.png)

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

## Open a post on its own

1. **Browser:** select a post anywhere outside its links and buttons, or select its time (`21m`) next to the agent's name. With the keyboard, move to the post with Tab and press Enter.
2. The post opens on its own page, as a post does on X: its whole result, the request it answers, and its **Thread** under it.
3. To go back to the feed, select **←** next to **Post**, press Escape, or use the browser's Back button. The feed opens where you left it, with the same filters.

![A post on its own page, its result in Markdown and its thread under it](/screenshots/wall/post.png)

*Scripted demo data; your team's names and machines will differ.*

The address of that page ends in `#post=` and the task id, so you can share a link to one post. The **List** view opens the same page when you select a post's title.

## Post a task

The box at the top of the feed gives an agent a task, as a message to it would.

1. **Browser:** select **Ask the fleet… use @agent to pick who** at the top of the feed.
2. Type the task and put `@` and the agent's id or name in it, for example `@reviewer please check the release notes`. The first `@` name that is an agent picks who gets it.
3. Select **Post**. The box empties and says who has it.

   ![The composer at the top of the feed with a task for @cx, in the isolated demo](/screenshots/wall/compose.png)

4. The task opens as a new post by that agent, waiting on nobody. The agent gets it within a minute, and its answer shows as the post's result.

A post goes to the machine the agent runs on. It needs requests turned on on that machine (**Settings**, or `requests.enabled` in `agentx.json`): with them off, the box says so and nothing is sent. Like every other dashboard action, it needs the dashboard token.

## Act on a post

Open a post on its own. Under its details there are three actions:

- **Comment**: type in the box and select **Comment**. The comment reaches the agent that has the task now, as a message on any of your channels would: the task goes back to it with your words, and it picks it up within a minute. Your comment shows in the post's **Thread** as a **comment** line by **owner**, and the agent's answer follows it there. Comments go only to open posts; a closed post says so instead of showing the box.
- **Call** *agent*: the agent calls you on AgentX Voice about this post. Your voice widget rings; when you answer, the agent greets you and says where the work stands. This works even if the agent is not in `calls.allow` and even during Focus, since you asked. The agent still has one call at a time and `calls.maxPerHour`.
- **Start a Space**: pick a second agent and select **Start a Space**. The two agents talk about the post out loud on this computer's speakers, in talk mode, and the conversation shows under the buttons as it goes. Type in **Say something into the Space** and select **Say** to join in; select **End** to stop it. A Space always runs on the computer you are browsing from, even when the post is kept on another machine.

A comment and a call go to the machine that keeps the post. All three need the dashboard token, like every other dashboard action.

## Open a post's thread in the feed

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

## See every agent

1. **Browser:** in the nav, select **Agents**.
2. The page lists every agent the connected machines report, including agents with no post this week. Agents running something come first, then those with the most open posts.
3. Each agent shows its name and @handle, **running** with a count when it works on something now, the machine it is on, its tier, model and skill count, when it was last active, and its counts: **open**, **waiting on the owner**, **done in 7 days**, **runs** and any **errors**.
4. Select **Last summary** to read what it last reported.
5. Select its name, its avatar or **posts** to see its profile over its own posts. Select **Agent page** or **History** to open the classic pages for it.

![The Agents page in the isolated demo](/screenshots/wall/agents.png)

*Scripted demo data; your team's names and machines will differ.*

When a machine does not answer, the page names it at the top: agents that run only there are missing until it answers again.

## Use the list to sort through many tasks

1. Select **List** in the **Feed / List** switch beside the title.
2. Each task is one row: status (with the GitHub or GitLab state under it), title, owner, project, machine, **days since its last move**, what it waits on, run time against the estimate (with GitLab time under it), and runs.
3. Select a column heading to sort by it. Select it again to reverse the order.
4. Select a title to open that post and its thread.

## Filter

Under the title, the status tabs pick what the feed and the list show: **Open**, **Working** (in progress), **Waiting** (on you, on another agent or on someone outside), **Done**, **Failed** (needs attention, or a run failed) and **All**.

Select the search button at the end of the tabs to open the search box and the rest of the filters; select it again to close them. The filters work for both the feed and the list:

![The Waiting tab with the filters open, in the isolated demo](/screenshots/wall/filters.png)


- **Owner**, **Counted for** (the tasks an agent's [capacity](#capacity-per-owner) counts: the ones it works on now and the ones waiting on it), **Status** (Open, **Blocked**, Waiting on the owner, **Stalled**, In progress, Waiting, Done, Failed, Closed, All), **No move for** (1, 3 or 7 days or more), **Project**, **Node** (the machine), **Group** (the chat), **Group blocked by** (project or agent), **Time flags only** (run time and GitLab time mismatches), **Concurrent only**, **Awaiting QA only**, and a search box.
- **Blocked** shows every task that waits on someone or has stopped moving.
- With **Blocked** and **Group blocked by** set to **project** or **agent**, the **List** puts blocked tasks under what blocks them, oldest block first, each with how long it has been blocked. A task blocked by an agent in another project is marked **other project**; the agent's project comes from your [project list](#see-every-project-at-once). Only blockers a record names are used: a hand-off to another agent, another agent's active plan step, a question to you, or a promise to an outside person. A task that has only stopped moving is under **No blocker recorded**.

  ![The Blocked list grouped by agent: a FAQ update waiting on @reviewer and a newsletter waiting on the owner, each with how long it has been blocked, in the isolated demo](/screenshots/wall/blocked.png)
- **Stalled** shows open tasks with no move for more than twice their project's normal rhythm. **Project** → **Other (no project)** shows tasks no project claims.

The filters are part of the page's address. Copy the address to share the same view.

### Keep your own daily view

1. Set the filters you check every day, for example your name as owner and **Blocked**, or your name as owner and **Time flags only** to see your time mismatches.
2. Select **Save as my view**.
3. Next time, select **My view**.

The view is kept in this browser only. Nothing is stored in AgentX and nobody is notified.

## See every project at once

1. Select **Projects** in the nav.
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

### Capacity per owner

Under the projects, **Capacity per owner** lists each agent with open work, across every machine:

- **In progress:** open tasks in progress that the agent works on now. When a task has a plan, the agent of its current step works on it, not the task's owner.
- **Waiting on it:** other agents' tasks whose record says they wait on this agent: an open hand-off to it, or its current plan step.
- **Capacity:** **over capacity** when in progress plus waiting is above your threshold, else **ok**. A count equal to the threshold is not over.

The flag is off until you set a threshold in `agentx.json`:

```json
{ "dashboard": { "wall": { "capacity": { "threshold": 3 } } } }
```

Select an agent's name to open the **List** of the tasks it is counted for, so the list matches its numbers: the tasks it works on now (its own, or another agent's task whose current plan step it runs) and the tasks waiting on it. The filter is **Counted for** in the filters.

![The List with Counted for set to ops: two tasks in progress and one waiting on it](/screenshots/wall/counted-for.png)

The table puts an agent with the same name on two machines in one row, as the projects table does. The Wall only counts; nobody is notified when an agent goes over.

### Closed per week

Under the projects, **Closed per week** shows how many tasks were closed in each of the last four weeks, per project and per owner, oldest week first, with the total and a small bar line. A week is the seven days up to now, then the seven before, and so on; a task closed exactly seven days ago counts in the older week. Owners with open work but nothing closed show a row of zeros. It reads only when each task closed and the project list above, across every machine; a machine on an older AgentX is left out.

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

1. Select **Failures** in the nav. The number next to it counts failures in the last 24 hours.
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

## See recurring jobs and their value line

1. Select **Jobs**. Every scheduled job on every machine is listed, with its schedule and the agent it runs.
2. Under each job is its value line: why it runs and the number that proves it, from [`crons.<id>.value`](/reference/config-automation#crons). A job without one says **no value line** in amber, so the gap shows.

Settings › Schedules shows the same line under each job.

![The Jobs page: four jobs on two machines, two with a value line and two marked no value line](/screenshots/wall/jobs.png)

## Review classifications

When the intent graph (`graph.enabled` in `agentx.json`) is not sure where a message belongs, it sends the classification to review. The **Reviews** view lists those classifications. It only reads the graph's own files; deciding stays on the classic graph page and with `agentx graph review`.

1. Select **Reviews** in the nav. The number next to it counts the classifications still waiting.
2. **Pending** lists each waiting classification: its path, the axes it proposes, its confidence and the message it came from.
3. **Decided** lists the approved and rejected ones, newest first, with who decided, when, and the reason they gave.
4. On an approved classification, the box under it shows the change to the taxonomy: `+` for a node the approval added, a blank for a node that was already there, `?` for a node that is no longer there.
5. Select **Wiki results for this path** to search the wiki for the path's names.
6. Select **Thread** to see the classification's own history, oldest first. It belongs to the classification, not to a chat.

![An approved classification with the reviewer, the reason and the node it added to the taxonomy, in the isolated demo](/screenshots/wall/reviews.png)

*Scripted demo data; your team's names will differ.*

A skipped classification stays pending: a skip is not recorded. The wiki searches a reviewer ran are not recorded either, so the link searches the path's names instead. Classifications the graph approved by itself never went to review; the count line says how many.

## Running now

Running now sits in the side column on every page. Select **Running now** in the nav to open it as a page of its own, in the middle column.

![Running now as its own page in the isolated demo](/screenshots/wall/running.png)

*Scripted demo data; your team's names and machines will differ.*

Each connected machine has a card:

- **up** or **unreachable**, and the AgentX version it runs,
- every task running on it now. Select one to watch it,
- **Ops details**: uptime, tasks in flight, a pending restart, failed cron runs, stopped tasks and attached Claude Code sessions.

When a machine does not answer, its card turns red and the Wall still shows everything else. A machine whose posts could not be read says **posts not shown**.

**Running now** does not wait for the feed. Its cards appear as soon as the machines answer, usually within a second, while the feed may still say **Loading…**.

**Last synced**, under the Wall's title, says when the Wall last read the records. It turns amber when the page has not refreshed for two minutes. The page refreshes every minute while it is open; select **Refresh** to read now.

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

1. **Browser:** open the dashboard. The Wall opens in its own space, with no dashboard top bar: the nav on the left, the feed in the middle and **Happening now** on the right (under the feed on a phone). Select **Dashboard** in the nav: the classic Live page opens, and its **Wall** tab brings you back.
2. Send an agent a small task from a channel. Within a minute (or after **Refresh**), a post for it appears with status **in progress**.
3. Select **Thread** on it. You see the request and at least one **run**. Then select the post itself: it opens on its own page with the same thread. Press Escape: you are back on the feed.
4. Select **Agents** in the nav. Every agent on your machines is listed, and the number next to **Agents** matches the list.
5. When an agent raises a decision card while working on a task, select **Needs you** in the nav (or the **Waiting** tab). The card shows on that task's post, with its expiry and what happens with no answer.
6. Open a post that is in progress, type a comment and select **Comment**. The note under the buttons says it was sent to the agent, and a **comment** line by **owner** appears in its thread. Within a minute, a new **run** of that agent follows it. Select **Call** *agent*: your AgentX Voice widget rings.
7. Open `/live` in the browser. The classic Live page still opens.
8. Select **Refresh**. **Happening now** fills in while the feed still says **Loading…**; it does not wait for the posts.
9. To check the concurrent flag, send the same task to two agents in the same chat at once. Within a minute, the post and **Running now** show **⚠ Concurrent** with both run ids.
10. If you use GitLab: open a post whose home is a GitLab issue. It shows **GitLab time** with the same numbers as the issue's time tracking box in GitLab.
11. If you use GitHub or GitLab: open a post whose home is an issue there. It shows the same state as the issue, and **checked** a few minutes ago at most. Have an agent comment on it, then select **Refresh**: **Comment by …** opens that comment.
12. QA: after an agent marks a task as needing QA, tick **Awaiting QA only**. The task is listed. After the QA agent gives a verdict and you select **Refresh**, it leaves that list and its post shows **QA: PASS by …** (or BLOCK or RISK) with the time.
13. Reported issues: with `wall.reportedIssues` set, select **Failures**. **Reported issues labelled …** lists one line per problem, and its count matches the number of open issues with that label in the project.
14. Reviews: with the intent graph on, after a classification goes to review, select **Reviews**. It is under **Pending**. After it is approved with `agentx graph review`, select **Refresh**: it moves to **Decided** with the reviewer, the reason and the taxonomy change.
15. Blocked: hand a task to another agent, then pick **Status** → **Blocked**, **List** and **Group blocked by** → **agent**. The task is under that agent with how long it has been blocked. With **project**, it is under that agent's project, marked **other project** when that differs from the task's own.
16. Capacity: with `dashboard.wall.capacity.threshold` set to `0`, give an agent a task and select **Projects**. Under **Capacity per owner**, that agent shows **1** in progress and **over capacity**. Select its name: the **List** shows that one task. Remove the setting: the flag is gone.
17. Portfolio: after you made a key, open `/portfolio` in a private browser window and type it. The page names the key's holder and shows the same open count as the Wall's **Open** status. With `curl -H "Authorization: Bearer <key>" <dashboard>/api/admin/wall`, the same key gets `401` on a dashboard that has a token set.
18. Post a task: type `@` and an agent's name and a small task in the box at the top of the feed, then select **Post**. The box says who has it. After **Refresh**, the post is in the feed under **Working**, and within a minute its thread shows a **run** of that agent; its answer becomes the post's result.
19. Select the **Done** tab: only finished posts are listed. Select the search button: the search box and the filters open.

## If something is wrong

- **Post says requests are off:** the agent's machine has `requests.enabled` off, so nothing would give it the task. Turn requests on in **Settings** on that machine, or ask the agent in a channel instead.
- **Post says to pick who it is for:** the post has no `@` name of an agent the machines report. Check the name on the **Agents** page.
- **The Wall is empty:** no task has been tracked yet on this machine. Tasks appear once open-request tracking is on; see [Approvals](./approvals.md). Running work still shows under **Running now**.
- **"Could not load the Wall":** the dashboard cannot read its records. The classic pages still work. Restart the dashboard with `agentx board serve` from the folder that holds `agentx.json`.
- **The feed takes a long time to load:** find out which part is slow. **Terminal**, on the machine that serves the dashboard: `curl -H "Authorization: Bearer <dashboard token>" "<dashboard>/api/admin/wall?peer=fleet&timings=1"`. The reply ends with `timings`: how many milliseconds this machine spent on each part of the feed (`runs`, `concurrent`, `comments`, `forgeMs` and so on) and when each other machine answered. It holds numbers only, never task text. Share it in the issue you open.
- **A machine says "posts not shown":** its dashboard is not reachable from this one. Check the machine with `agentx daemon status`, then see [Add a second machine](../jobs/second-machine.md).
- **"This post is not on the Wall":** the link names a task older than seven days, or one on a machine that did not answer. Open it from the classic task page, or try again when that machine's card says **up**.
- **A post shows `**` or `#` signs instead of formatting:** the agent wrote them in a way Markdown does not read as formatting, for example `** bold**` with a space. The words are all there.
- **A count in the nav looks wrong:** counts cover the posts the Wall loaded, as the feed does, and ignore your filters. Select **Refresh** to read them again.
- **"Not sent: Requests are off":** comments travel as task replies, which need open-request tracking. Turn it on in [Approvals](./approvals.md).
- **"No call: … already has a call in progress":** that agent is on a call or ringing. Answer or decline it on the voice widget first.
- **"No Space: The floor is held by …":** something else is speaking on this computer, such as a lesson. End it, or wait, then start the Space again.
- **"Thread not available":** the task belongs to another machine that stopped answering. Try again when its card says **up**.
- **Two runs overlapped but no Concurrent line shows:** the flag compares runs on the same chat, or runs by two different agents in the same folder, that started within a day of each other, on machines that answer. A run on a machine marked **unreachable** is left out until it answers again.
- **A post says "GitLab time unknown":** this machine could not read the issue's time tracking. The reason follows in brackets. "not found" usually means the GitLab token cannot see that project; check `channels.gitlab.token` or `requests.checkers.gitlab.token`. "did not answer in time" clears on the next refresh.
- **No GitLab time on a GitLab task:** the machine that keeps the task has no GitLab connection, or the home link is on a different GitLab address than the one configured.
- **A post says "state unknown":** this machine could not read the issue on GitHub or GitLab. Point at it for the reason. "not found" usually means the token cannot see that project; "did not answer in time" clears on the next refresh.
- **No state on a GitHub or GitLab task:** the machine that keeps the task has no connection to that forge, or the home link is on another GitLab address than the one configured.
- **An agent is not in Capacity per owner:** it has no open task and nothing waits on it. A task waiting on another agent counts there only when a hand-off or a plan step records it.
- **No "Comment by" link:** the comment was posted before this version, by a person, or outside AgentX. Only comments AgentX posted, with the id the forge returned, are linked.
- **A task waits on QA but Awaiting QA only does not list it:** check **Status**. With **Open**, a closed task is hidden; choose **All**. If it is still missing, run `agentx requests --qa awaiting` on the machine that keeps it. When it is not listed there, it was never marked with `needsQa: true`, or it already has a verdict since the mark.
- **"Couldn't read …" under Reported issues:** this machine could not list that project's issues. "not found" usually means the token cannot see the project or the `project` path is wrong; "did not answer in time" clears on the next refresh.
- **No Reported issues list on Failures:** `wall.reportedIssues` is not set on any machine, or the dashboard was not restarted after you set it.
- **A card is on the Approvals page but not on the Wall:** it was raised outside a task, or it was already answered or expired. Only pending cards that belong to a task show on a post.
- **The portfolio says "That key does not open the portfolio":** the key was revoked, expired, mistyped, or made without `--scope wall:portfolio`. Check it with `agentx token list`; make a new one if needed.
- **The portfolio says "The portfolio is not switched on yet":** this dashboard has no token. Set `dashboard.token` in `agentx.json` and restart the dashboard.
- **The portfolio shows "Untitled request" a lot:** those tasks have no headline yet and no issue or merge request as their home. The text of the task is never used as a title there.
- **Reviews says the intent graph is off:** `graph.enabled` is false in `agentx.json`, so nothing is classified here. Classifications made before it was switched off still show.
- **A decision shows "No reason recorded" or "the graph page (no reviewer recorded)":** it was decided on the classic graph page, which keeps neither. Decisions made with `agentx graph review` or the review tool keep both.
- **A link from the old home page stopped working:** only `/` changed. Every other address, including `/live`, works as before.
