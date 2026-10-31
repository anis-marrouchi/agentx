# Hub — every task as a post

The Hub is the dashboard's home page, in a space of its own, as the wiki is: its own look, close to X, with no dashboard top bar. It reads like a social feed. Each task a person gave an agent is a **post** by that agent, with its avatar, name and @handle. Under it, the **thread** lists what happened, in order: the runs that worked on it, hand-offs to other agents, plan steps, the questions it asked and how it closed. Beside the feed, **Happening now** gives one line per connected machine with what it runs at this moment, and **Agents** lists who has posts this week. At the top of the side column, **Chat** asks an agent about what you see (see [Chat on the Hub](./chat.md#chat-on-the-hub)).

The Hub shows the records AgentX already keeps: tasks, plans and run history. Opening a post sends nothing to anyone and changes nothing. You can give an agent a task from the box at the top of the feed (see [Post a task](#post-a-task)), and from an open post you can comment, have its agent call you, start a Space, or close or hand off the request (see [Act on a post](#act-on-a-post)). What waits on you is answered on **Needs you** (see [See what waits on you](#see-what-waits-on-you)).

![The Hub in the isolated demo: Running now per machine, filters, and posts](/screenshots/wall/wall.png)

*Scripted demo data; your team's names and machines will differ.*

## Open the Hub

1. **Browser:** open the dashboard. The Hub is the first page you see. Its address is `/hub`. From a classic dashboard page, select **Hub** to come back.
2. The nav on the left starts with **Hub** (open posts) and **Needs you** (posts waiting on you). The rest is in four groups, each under a small grey heading:
   - **Work:** **Live**, **Running now**, **Projects** and **Activity**.
   - **Automation:** **Jobs**, **Workflows**, **Reviews** and **Failures**.
   - **Fleet:** **Agents**, **People**, **Org** and **Cost**.
   - **Owner:** **Settings**, for the owner only (see [Change settings](#change-settings)).

   Under them, **Dashboard** opens the classic pages at **Operations**. Each other item opens its own page, and the number next to it counts what is there: open posts, posts waiting on you, live sessions, tasks running now, projects with open work, recurring jobs, workflows, classifications waiting for review, failures in the last 24 hours, people listed, the people and agents in the org chart, what this machine spent this month, and agents. The page you are on is in bold.
3. The right of each page's title shows which build the daemon runs: its version, its commit (the exact state of the source code it was built from) and since when it runs. **Restart pending** is added when the code on disk is newer than the running daemon; hover over the line to read why, and select it to open the Hub's [Live](./live.md#restart-a-machine-when-it-is-idle) page, where **Restart when idle** is on each machine's card. The line refreshes every minute. If the dashboard cannot ask the daemon, the last answer stays, marked **as of** its time. See [See which version is running](index.md#see-which-version-is-running).

   ![The Hub's title row: Hub, the Feed and List switch, and on the right the version, commit, since when, and Restart pending](/screenshots/wall/build-line.png)

4. The **Quiet by design** box on the right says the Hub never pings you. Select **Dashboard pages** in it to list the classic pages that still hold something the Hub does not have yet: **Operations**, **Monitor**, **Org**, **Activity** and **Workflows**. [Live](#live-sessions), [People](./people.md), [Cost](#see-what-the-fleet-costs), [Workflows](#see-your-workflows), [Settings](#change-settings) and the workflow editor are Hub pages, and old links to their classic pages open them here. The classic Workflows page stays for **Follow-ups** and the full history of each run.
5. **Light / dark**, at the bottom of the nav, switches the Hub's colours. The Hub keeps its own choice; until you pick one, it follows your system.
6. **Phone:** the feed comes first, and the nav is a bar at the bottom: **Hub**, **Needs you**, **Running now**, **Projects** and **More**. **More** opens a sheet from the bottom with every other page, in the same groups as on a computer, then **Settings**, **Dashboard** and **Light / dark**. Pick a page, tap outside the sheet, or press Escape to close it. The round **+** opens the Creator. A small number on an icon is its count; a count of zero is not shown. The build line sits under each page's title. Running now, Agents and the classic page links sit under the feed. On a tablet, the classic page links and Running now come before the feed.

   ![The Hub on a phone with More open: Work, Automation and Fleet, then Settings, Dashboard and Light / dark](/screenshots/wall/more-phone.png)


   ![The Hub on a phone in dark mode, with the bottom bar and the round + button](/screenshots/wall/phone-dark.png)

![Mockup take B (left, post text blurred) next to the Hub as built](/screenshots/wall/compare-desktop.png)

## Read a post

The top line of a post is its author: the **owner**, the agent that has the task now, with its avatar, name and @handle, and how long ago the task last moved (`12m`, `3h`, `2d`; point at it for the exact time). A green dot on the avatar means the agent is running something now. The **status** sits on the right of that line.

Under the author line comes the **result**: what the agent delivered or answered. Formatting the agent wrote in Markdown (a text format where `**bold**` shows as **bold** and lines starting with `-` show as a list) is shown as formatting: bold, lists, code, tables and links. Links only open web and mail addresses. It is the task's last run that ended with a reply, with **Answered** and a link to that run. A task closed with no reply shows the proof or reason it was closed with, under **Closed with**. Under the result, select **Request** to open the request it answers: who asked, in which chat, the task id and when. A task with no result yet shows its request as the title, marked **No result yet**. The Hub never takes a result from another task or another chat.

![A post leading with its result, the request one tap under it](/screenshots/wall/result-first.png)

![The same post with its request open](/screenshots/wall/result-request.png)

A post shows:

- its **status** (in progress, waiting on owner, waiting on another agent, needs attention, done, declined or dropped), its result and the request it answers,
- who asked for it,
- its **group**: the chat it came from. A post only shows what was recorded for its own task, never work from another chat,
- its **project**: the one your [project list](#see-every-project-at-once) names for it (none, so **Other**, when the list names nothing for it); with no list, its home repo when its home is an issue or merge request,
- its **goal**, when the agent named one: the larger aim the task serves (see [Follow one goal](#follow-one-goal)),
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

The Hub only reads this from GitLab. It never logs time or changes the estimate. Tasks whose home is on GitHub or elsewhere show no GitLab time. When GitLab cannot be read, the post says **GitLab time unknown**, followed by the reason. In the list, point at **unknown** to see the reason.

The machine that keeps the task reads its GitLab time with its own GitLab connection: the `channels.gitlab` channel or `requests.checkers.gitlab`. A machine with neither shows no GitLab time.

### Issue state, who closed it, and the agent's comments

When a task's home is an issue, pull request or merge request on GitHub or GitLab, the post shows its state there right now: **open**, **closed** or **merged**, who closed or merged it, when, and how long ago the Hub checked. When a person closed the issue while the task is still open on the Hub, the post says so in amber: **GitHub says closed by …, but this post is still open. Do not pick it up.**

The post also shows the issue's **milestone** and who it is **assigned to** there. The other mismatch is marked too: when the issue is still open on the forge but the task is closed on the Hub, the post says **GitHub says open, but this post is done. Close it there or reopen it here.**

![Three posts with their milestone and assignees: one that agrees with GitHub, one done here but open on GitHub, one open here but closed on GitLab](/screenshots/wall/forge-live.png)

Each comment an agent posted on that issue through AgentX gets its own **Comment by …** link. It opens that exact comment, not the top of the issue.

![Three posts: one closed on GitHub while still open here, one merged on GitLab, one whose state is unknown](/screenshots/wall/forge-state.png)

*Fictional data; your projects and agents will differ.*

The Hub reads the state with this machine's own GitHub or GitLab connection (`channels.github` or `requests.checkers.github`, `channels.gitlab` or `requests.checkers.gitlab`). It never changes the issue. The answer is kept for 5 minutes, so the **checked** time can be a few minutes old. When the forge cannot be read, the post says **state unknown**, never a guessed state. Point at **state unknown** to see the reason.

Comment links start with comments posted after this version. Older comments are not linked, so a post with no **Comment by …** link does not mean the agent never commented. AgentX keeps comment links for 90 days, then removes them when AgentX starts.

## See what waits on you

When an agent asks you a yes/no question (a **decision card**) while working on a task, the card shows on that task's post. You see the question where the work is, so nobody asks you the same thing twice.

![A post with a pending decision card: the recommendation, what happens with no answer, and when it expires](/screenshots/wall/owner-card.png)

*Scripted demo data; your team's names and machines will differ.*

A card on the Hub shows:

- the question and the agent's **recommendation**,
- **If no answer**: what happens when the card expires without your answer. The agent drops it (`discard`), leaves things as they are (`keep`), or pauses that piece of work (`pause`). A card never says yes by itself,
- **Expires**: how long is left, and the exact time. A card that expires within a day has a red edge,
- who raised it and when, and its source link when it has one.

Only the owner answers on the Hub: the dashboard asks for its key. To answer:

1. **Browser:** select **Needs you** in the nav. It lists what waits on you, with the same count as the phone app's Desk and the daily digest. **Waiting**, **Put off** and **Answered** are the tabs, and the chips narrow the list to one kind: Decisions, Schedules, Memory, Wiki, Drafts, Requests and Reviews.
2. On a card with choices, the one the agent advised is already picked. Pick another if you want. The draft and what Yes and No do are folded under the card.
3. Select **Yes**, **No** or **Later** (**Keep** or **Drop** for a memory fact). A line opens that says exactly what is sent; select **Confirm**. The card leaves the list, and its post updates without a reload.
4. A card raised while working on a task is also on that task's post, with the same buttons and confirm.

Each card says what answering it unblocks: the post it was raised on and the runs paused on it. Anyone without the dashboard key sees the same cards read only, under **Needs the owner**. The full steps, with screenshots, are in [Approvals › Answer on the Hub](./approvals.md#answer-on-the-hub). The old Approvals page's address, `/approvals`, opens **Needs you**, so old links and bookmarks still work.

To see the waiting tasks in the feed instead:

1. Under **Status**, choose **Waiting on the owner**.
2. The feed and the list show every task that asked you a question or has a pending card. In the list, **Waits on** says **owner** and when the card expires.

## Open a post on its own

1. **Browser:** select a post anywhere outside its links and buttons, or select its time (`21m`) next to the agent's name. With the keyboard, move to the post with Tab and press Enter.
2. The post opens on its own page as a task. From the top:
    - the request, as its title;
    - where it stands: **Asked**, **Working**, **Waits** (only while it waits on someone) and **Done**, each with when or how long. The current step has a blue bar over it, or an amber one while it waits. A task no agent has picked up yet stands at **Asked**. **Waits** names who it waits on: you, the agent that blocks it, the agent that owns the plan's current step, or **another agent** when the Hub does not know which. Under it, one amber line says why it waits;
    - its **Plan**, when it has one: each step, the agent that owns it, its state, what proves it done, and its proof;
    - its **Result**;
    - the facts: who asked, in which chat, the project, the goal, the times, and the run time against the estimate;
    - its links, the actions and its **Thread**.
3. To go back to the feed, select **←** next to **Post**, press Escape, or use the browser's Back button. The feed opens where you left it, with the same filters.

![A post on its own page, its result in Markdown and its thread under it](/screenshots/wall/post.png)

![An opened task with a plan: where it stands, then each step with its agent and state](/screenshots/wall/task.png)

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

### Give an agent a task on the Creator page

The Creator is a longer form of the box at the top of the feed.

1. **Browser:** select **New post** under the nav (the round **+** on a phone).
2. Under **Who does it**, select an agent. Each card shows its machines, its open posts, and **over capacity** when it carries more than your [capacity threshold](#capacity-per-owner).
3. Write the **Request**. Add **Done when** (the proof it should close with, for example a merged PR), a **Project** and an **Estimate** in minutes if you want them.
4. Read **What happens**, then select **Post to** *agent*. The note beside the button says it was posted.

The post is the request with one line each for Done when, Project and Estimate, as the agent reads it. The Creator is the only Hub page that sends something; every other page only reads.

![The Creator: an agent picked, the request filled in and what happens next, in the isolated demo](/screenshots/wall/creator.png)

## Act on a post

Open a post on its own. Under its details there are three actions:

- **Comment**: type in the box and select **Comment**. The comment reaches the agent that has the task now, as a message on any of your channels would: the task goes back to it with your words, and it picks it up within a minute. Your comment shows in the post's **Thread** as a **comment** line by **owner**, and the agent's answer follows it there. Any post takes a comment: on a post that is done, declined or dropped, the label says so, and the comment opens the post again, in progress, for its agent. It needs requests turned on on that machine.
- **@mentions**: put `@` and another agent's id or name in a comment, for example `@reviewer please check the wording`. A name of several words works too, such as `@Night Shift`. That agent gets a post of its own that quotes your comment and names the post, on the machine it runs on. The note under the buttons lists who was brought in. The thread marks each mention with **→ @name**.
- **● Join live**: shown when the post's agent is working on something now. It opens that live task.

![A comment on a done post with an @mention, in the isolated demo](/screenshots/wall/comment.png)
- **Call** *agent*: the agent calls you on AgentX Voice about this post. Your voice widget rings; when you answer, the agent greets you and says where the work stands. This works even if the agent is not in `calls.allow` and even during Focus, since you asked. The agent still has one call at a time and `calls.maxPerHour`.
- **Start a Space**: pick a second agent and select **Start a Space**. The two agents talk about the post out loud on this computer's speakers, in talk mode, and the conversation shows under the buttons as it goes. Type in **Say something into the Space** and select **Say** to join in; select **End** to stop it. A Space always runs on the computer you are browsing from, even when the post is kept on another machine.

A comment and a call go to the machine that keeps the post. All of these need the dashboard token, like every other dashboard action.

### Close or hand off a request

Every open post is a request you gave an agent. As the owner, you can close it or give it to another agent from the post, whether or not it waits on you. Anyone without the dashboard key does not see these buttons, and the dashboard refuses the call.

1. **Browser:** open the post on its own.
2. **Browser:** to leave a note, a link to the evidence or a reason, type it in the comment box first. It is sent with what you pick next.
3. **Browser:** under the comment box, pick one:
   - **Hand to…**: choose an agent on the same machine. It has the request from now on and is told within a minute. The agent marked **(has it: try again)** gets it back to try again.
   - **Done**: closes the request as done. When the request had a check that closes it, the note says why you closed it by hand.
   - **Drop**: drops the request.
4. **Browser:** a line opens that says exactly what happens, for example **Close "Relaunch the demo shop" as done.** Select **Confirm**, or **Back** to change your mind.
5. The note under the buttons says what happened, and the post updates.

![An open post with Hand to, Done and Drop under the comment box, and the line that asks to confirm Done](/screenshots/wall/post-close.png)

*Scripted demo data; your team's names and machines will differ.*

These are the same calls as **Needs you** makes for a request that waits on you, and the same as `agentx requests done` and `agentx requests drop` in a terminal.

## Open a post's thread in the feed

1. On a post, select **Thread**.
2. The thread opens under the post, as replies. Each reply shows who did it (an agent's avatar, or a grey one for a person), what happened and the exact time.
   - **run**: an agent worked on it. Select the run id to open that run's task record.
   - **handoff**: the task was passed to another agent. It shows **sender → receiver**, followed by that agent's runs.
   - **→ @name**: an agent named another agent with @. That is a hand-off.
   - Issue and merge request numbers, commit ids and links are shown in small boxes so you can check them.
3. When the same line repeats several times in a row, it is folded into one line with a count, such as **×4 — show all**. Select it to see every original line.

Passwords, keys and tokens in what agents wrote are replaced with **[redacted]**.

## See one agent's profile

1. Select an agent's avatar or name on a post, or the agent under **Agents**.
2. Its profile opens above the feed: name, @handle, whether it is running now, and its counts: **open**, **waiting on the owner**, **done in 7 days**, and the **runs** on those posts. The feed below shows only its posts.
   - When the agent is in the [org chart](./org.md), its role shows under the @handle, with **reports to** and its boss, and how many agents report to it. The boss can be an agent (select it to open their profile) or a person, such as **reports to The Owner**; a person's name is plain text.
   - The agent's other relations show on the same line: **dotted line to** a second manager for one topic or project, and **acts for** the person the agent works on behalf of.
     ![An agent's profile: its role, reports to an agent, dotted line to a person and acts for a person](/screenshots/wall/org-relations.png)

     ![The same profile on a phone in dark mode, the relations wrapping onto a second line](/screenshots/wall/org-relations-phone.png)

     *Fictional data; your org will differ.*
   - **Org chart** opens the Hub's [Org page](#see-the-org-chart). The Hub only shows the org: setting up members and relations, pausing and resuming an agent stay on the org chart page at `/org`.
3. Under the counts, one line shows what the agent has spent this month against its monthly budget (its cap), for example **Spent $12.50 of $100.00 this month**. The month runs on UTC time, the time zone AgentX uses for budgets.
   - **near cap**: the agent has used 80% of its budget, or the share set with `warnRatio`.
   - **paused: cap reached**: the agent has used all of its budget and does no work until the next month or until you raise the budget. **paused: fleet cap reached** means the budget for all agents together is used up.
   - **no cap**: the agent has no budget; the line still shows what it spent.
   - **not priced**: runs on a model with no price, such as a local model. The budget does not count them, as on the Cost page.
4. Select **Cost** at the end of that line to open the Hub's Cost page, where the owner can raise or remove the budget (see [Set a monthly budget from the Cost page](#set-a-monthly-budget-from-the-cost-page)).
5. Select **Agent page** to open the classic page for that agent.
6. Under the profile, **Posts** shows its posts (the default) and **Activity** shows its runs: see [See what the agents ran](#see-what-the-agents-ran).
7. Select **All posts**, or the same agent again, to go back to every post.

![An agent's profile above its own posts, with its spend this month near its cap, in the isolated demo](/screenshots/wall/profile.png)

*Scripted demo data; your team's names and machines will differ.*

The profile is the **Owner** filter, so its address can be shared like any other view.

The spend line uses the same figures as **Monthly budgets** on the Cost page, from the machine that serves the dashboard you opened. For an agent that runs on another machine, the line says its spend is kept on that machine instead of showing $0; open the dashboard on that machine to see it.

## See every agent

1. **Browser:** in the nav, select **Agents**.
2. The page lists every agent the connected machines report, including agents with no post this week. Agents running something come first, then those with the most open posts.
3. Each agent shows its name and @handle, **running** with a count when it works on something now, the machine it is on, its tier, model and skill count, when it was last active, its role, who it reports to, its **dotted line to** and **acts for** relations when it is in the org chart, and its counts: **open**, **waiting on the owner**, **done in 7 days**, **runs** and any **errors**.
4. Select **Last summary** to read what it last reported.
5. Select its name, its avatar or **posts** to see its profile over its own posts. Select **Activity** for its runs, or **Settings** to change it (see [Change settings](#change-settings)). An agent on another machine shows **Agent page** instead, which opens its classic page.
6. Select **Call** to have the agent call you on AgentX Voice, as from a post. When it is working now, **● Join live** opens what it is doing. Its profile has the same two buttons.
7. Select **Open the org chart** at the top of the page to open the org chart page at `/org`, where the owner changes who reports to whom.

![The Agents page in the isolated demo](/screenshots/wall/agents.png)

*Scripted demo data; your team's names and machines will differ.*

When a machine does not answer, the page names it at the top: agents that run only there are missing until it answers again.

Avatars show an agent's or a person's profile picture when one is set on the machine that serves this dashboard, and the coloured circle with initials otherwise. An agent's profile has **Upload picture**, **Replace picture** and **Remove picture** for the agents this machine runs. See [Give agents and people a picture](../jobs/profile-pictures.md).
## Change settings

**Settings** on the Hub is where you, the owner, change your agents. It is the only Hub page that changes settings; every other Hub page only reads them. The owner is whoever opens the dashboard on the machine that serves it, or signs in with the dashboard token (see [Sign in from another device](../jobs/reverse-proxy.md#sign-in-from-another-device)). Anyone else gets no **Settings** entry; opening its address, or an old `/admin` link, shows **Settings are for the owner**, and the settings API refuses them. Without a dashboard token there is no sign-in, so that page tells them to use the machine that serves the dashboard.

![Settings for a viewer who is not the owner, on a dashboard with no sign-in](/screenshots/wall/settings-not-owner.png)

It saves to `agentx.json`, the AgentX settings file on the machine that serves the dashboard, and replaces the classic Settings page: `/admin` opens it. Every classic tab is here, with the approval and request settings the old Approvals page had. Only **Guests** and **People** open pages of their own. [Settings](./settings.md) walks through each section.

1. **Browser:** in the nav, select **Settings**, under **Owner**. On a phone, select **More**, then **Settings**.
2. The sections are listed on the left in three groups: **Fleet** (Agents, Channels, Schedules, Webhooks, Mesh, Boards, Actions, Inbox, Requests, and Business when it is on), **Access** (Guests, People, Tokens) and **Machines** (Health, Screen capture, Advanced). The one you picked is on the right; **Agents** opens first.
3. An amber number on a section counts what needs you there: on **Agents**, agents waiting for your approval or missing a credential; on **Mesh**, machines that do not answer; on **Health**, those machines plus the ones waiting for a restart. Without one, **Agents** shows how many agents this machine has.

   ![Settings on the Hub: the grouped sections on the left and one card per agent, in the isolated demo](/screenshots/wall/settings.png)

   *Scripted demo data; your team's names and machines will differ.*
4. On a phone, the list of sections fills the screen, with **Health** on top of it and a line under each section on what it holds. Tap a section to open it, and **← All settings** to go back.

   ![Settings on a phone: the grouped list of sections, each with an arrow](/screenshots/wall/settings-phone.png)

   ![Settings on a phone: the Agents section with one agent card and its on/off switch](/screenshots/wall/settings-phone-agents.png)

Each agent card shows the agent's name, @handle, its role in the org chart when it has one, its AI engine and model, and an **On** / **Off** switch. **Waits for approval** instead of the switch means the agent waits for you in **Needs you**: select it to answer there.

### Turn an agent off or on

1. **Browser:** in **Settings** › **Agents**, select the agent's switch, on its card or at the top of its page.
2. **Off** means the agent starts no new run until you turn it back on. A run already going on finishes. This is the same pause as on the [Org](./org.md) page.

### Change an agent

1. **Browser:** in **Settings** › **Agents**, select the agent's card. Its page has its picture (**Upload picture**, **Replace picture**, **Remove picture**) and its switch on top, then the tabs of the classic agent page: **Overview**, **Personality**, **Skills**, **Channels** and **Handovers**.
2. On **Overview**, change what you need: display name, wake words (the words that call it, such as `@support`), AI engine, model, conversations at once, longest task, tool permissions, whether it answers on the public API, whether the wiki absorb includes it, and its instructions.
3. A field you changed turns blue and says what it was. A bar at the bottom says how many changes are not saved and whether they need a restart. **Discard** puts every field back.

   ![One agent on Settings: its picture and switch on top, the tabs, then the Overview form, in the isolated demo](/screenshots/wall/settings-agent.png)

4. Select **Save…**. A box lists each change with its old and new value. When you change the model or the engine, it also says which of the agent's recurring jobs change with it (a job that names its own model keeps it) and what the agent has spent this month against its cap. Select **Save changes**, or **Back** to keep editing.

   ![The Save box: wake words and conversations at once, each with its old value struck through and its new value, then "No restart needed." with Back and Save changes](/screenshots/wall/settings-confirm.png)

5. The bar says **Saved**, or why it was not saved. When a save fails, the form keeps what you typed.

   ![The bar after a save: "Saved. It applies from the agent's next run."](/screenshots/wall/settings-saved.png)

   *Scripted demo data; your team's names and machines will differ.*

Most changes apply from the agent's next run, with no restart. A new engine, model or permission mode applies only after a daemon restart; the bar says so before you save, and the **Saved** line names the command. **Terminal**, on that machine:

```bash
agentx daemon restart --when-idle
```

The other tabs:

- **Personality**: its instruction files. Select one, change it and select **Save**. **Load a file** puts a file from your computer in the editor; nothing is written until you select **Save**.
- **Skills**: its skills, edited the same way. **Add a skill** makes a new one. **Delete** asks you first.
- **Channels**: the outside services it has credentials for (its integrations). You give the name of an environment variable that holds the secret, never the secret itself. **Remove** asks you first. Which chats and bots reach it is still on the classic agent page.
- **Handovers**: the chats passed to another agent. A handover sends every message from one chat to another agent until you release it. See [Hand a chat to another agent](#hand-a-chat-to-another-agent).

**Overview** also has **Test drive** (send it a message and read its answer on the page; it is a real run, so it can cost money) and **Delete**, which removes the agent from `agentx.json` after asking you. Its workspace folder stays on disk, and the daemon stops it after a restart.

### Add an agent

1. **Browser:** in **Settings** › **Agents**, open **Add an agent**.
2. Type an id (lowercase), a name and at least one trigger word. Pick the AI engine; the model and instructions are optional.
3. Select **Add agent**. The line under it says **Added**, or why not.
4. **Terminal:** run `agentx daemon restart --when-idle`. The new agent starts working after the restart.

**Wiki page curator**, under **Add an agent**, picks which agent answers the chat bubble on wiki pages, as in classic Settings.

### Hand a chat to another agent

1. **Browser:** in **Settings** › **Agents**, select the agent that has the chat now, then the **Handovers** tab.
2. **Routed away from** lists the chats this agent has passed on; **Routed to** lists the chats other agents passed to it. Each line says the channel, the chat id, the other agent, until when, and whether the note was read.
3. To pass a chat on, open **Hand a chat to another agent**.
4. Pick the channel (Telegram or WhatsApp) and type the chat id: the person or group, as the channel numbers it.
5. Pick the agent that takes it in **Hand to**. It lists the other agents on this machine.
6. Optional: type a note for that agent. It reads it once, with the next message from the chat.
7. Optional: type a date in **Until**. Leave it empty to keep the handover until you release it.
8. Select **Hand over**. The line under **Handovers** says **Handed …**, or why not.

   ![The Handovers tab: the chats routed away from and to the agent, then Hand a chat to another agent, in the isolated demo](/screenshots/wall/settings-handovers.png)

To end a handover, select **Release** on its line, then **Release** again to confirm. The chat's next message goes where `agentx.json` sends it.

### Check the machines' health

1. **Browser:** in **Settings**, select **Health**, under **Machines**. On a phone, Health is on top of the list of sections.
2. Four numbers sit on top: **agents online** (on machines that answer, out of all agents), **channels on** (out of the chat apps set up in `agentx.json`), **need you**, and **active tokens** (keys for apps and scripts that are neither revoked nor expired).
3. Below them, one line per machine: green when it answers, with its version; red when it does not, with since when; **Restart pending** when it waits for one.
4. Last, what to fix: each machine that does not answer and each one waiting for a restart, with a link to [Live](#live-sessions), where you can restart it. **Nothing to fix.** means every machine answers.

   ![Health on the Hub: four numbers, one line per machine and what to fix, in the isolated demo](/screenshots/wall/settings-health.png)

   *Scripted demo data; your team's names and machines will differ.*

Health only reads. It refreshes with the Hub, without losing what you are typing in another section.

### Connect a chat app

1. **Browser:** in **Settings**, select **Channels**, under **Fleet**. Pick one along the top: **Telegram**, **WhatsApp**, **Email**, **Slack**, **Discord**, **GitLab**, **GitHub** or **Calls**. Each says **on**, **off** or **not set up**.
2. Put the secret (a bot token or a password) in the `.env` file next to `agentx.json` first. The forms take only the *name* of that variable, such as `TG_SUPPORT_BOT_TOKEN`, and never show a secret.
3. **Telegram:** under **Add a Telegram account**, type a name, pick the agent that answers, and type the token's variable name, then **Add account**. **Edit** changes an account in place; **Delete** asks you first.
4. **Email:** under **Add a mailbox**, type the address, the IMAP and SMTP servers, the password's variable name and who may write. Replies wait in **Needs you** unless you tick **Send replies at once**.
5. **Slack**, **Discord**, **GitLab:** fill the form and select **Connect** (or **Save** once connected). A switch turns each one on or off.
6. **GitLab** and **GitHub** also have **Request status**: when it is on, AgentX keeps one comment per request up to date on the issue.
7. **GitHub** lists its webhooks; add one on **Webhooks** with source GitHub. **Calls** lists active and recent calls, and only reads.

The line under the tabs says what was saved, or why not.

### Pair WhatsApp and watch chats

**WhatsApp** in **Settings** › **Channels** has what the classic page has for WhatsApp, in three parts. Routes, phone numbers and allow-lists stay under `channels.whatsapp` in **Advanced**.

1. **Pairing:** with `channels.whatsapp.enabled` on and the daemon running, the tab shows **connected**, or **waiting for scan** with a code. **Phone:** open WhatsApp › **Settings** › **Linked devices** › **Link a device**, and scan it. The code changes about every 20 seconds; the tab reads the state every 3 seconds while it is open. See [Answer customers on WhatsApp](../jobs/answer-whatsapp.md).
2. **Chats:** select **Show chats and contacts** to list the first 100 of each that WhatsApp shows the daemon. **Sweep now** writes them into an agent's wiki, as `agentx whatsapp ingest-all` does. **Dry run** is ticked at first: it counts what would be written and writes nothing.
3. **Watched chats:** the switch turns WhatsApp triage on or off. The tab shows the address wacli sends to and whether its secret is set in `.env` (its variable's name, never the value). Under **Add a watch rule**, type a name, pick the agent, list the chats, then select **Add watch rule**. **Turn off** pauses a rule; **Delete** asks you first. See [Watch a WhatsApp chat](../jobs/watch-whatsapp.md).

![Settings › Channels › WhatsApp on the Hub: waiting for scan with the code, the chats and contacts, and one watch rule](/screenshots/wall/settings-whatsapp.png)

*Example data on a test setup; your chats will differ.*

### Choose how the inbox reaches you

**Inbox**, under **Fleet**, is the classic **Notifications routing**: where AgentX tells you that a task finished, failed or runs long. It saves the same settings as `agentx notifications`. See [Get notified](../jobs/notifications.md).

1. **Browser:** in **Settings**, select **Inbox**. The first line says where notifications go now, or that they go to the daemon log only.
2. Under **Where it goes**, pick the **Channel** and type the **Chat id**. **Clear the destination** removes it.
3. Under **When**, tick the events, and set how long a task runs before a long-task ping (`0`: none).
4. Under **On this machine**, choose the banner and sound `agentx notify` uses on the machine that serves the dashboard.
5. Under **Phone push (ntfy)**, the topic and token are passwords: put each in `.env`, then type only the variable's name, such as `NTFY_TOPIC`. The page says whether each is set and never shows it. Restart the daemon after a phone push change.
6. Select **Save**. The line at the top says it was saved, or why not.

![Settings › Inbox on the Hub: where it goes, when, this machine's banner and sound, and phone push](/screenshots/wall/settings-inbox.png)

### Add or remove a schedule

A schedule has an agent do something on a timer, such as a report every Monday.

1. **Browser:** in **Settings**, select **Schedules**, under **Fleet**. Each schedule shows its name, when it runs (a cron expression, in the machine's time zone), its agent, the start of what it asks and its value line.
2. Under **Add a schedule**, type a **Name**, pick the **Agent**, and fill **When**: type a cron expression, or select a preset such as **Weekdays at 9:00**. The line under it says when that is and the next three runs; a wrong expression says why.
3. Type **What to do**, then select **Add schedule**. The line at the top says it was added, or why not.
4. To remove one, select **Delete** on it, then confirm.

### Point wiki notes at a schedule

**Wiki notes inbox**, at the bottom of **Settings** › **Schedules**, is the classic Schedules tab's block of the same name, as `agentx wiki notes config`. Agents leave short notes for the agent that runs your wiki schedule.

1. **Browser:** in **Settings** › **Schedules**, tick **Wiki notes on** and type the **Inbox agent**.
2. Tick the schedules on this machine that read the inbox, and optionally the agent whose absorb pass answers the notes.
3. Select **Save**. **Show recent notes** lists the last 20 and what was done with each.

### Add a webhook

A webhook is an address another service, such as GitHub or Stripe, calls when something happens there. It goes to the agent you pick. The fields are the same as on the classic page: see [Webhooks](./settings.md#webhooks).

1. **Terminal:** add the shared secret to the `.env` file next to `agentx.json`, for example `EXAMPLE_WEBHOOK_SECRET=<a long random value>`.
2. **Browser:** in **Settings**, select **Webhooks**, under **Fleet**.
3. Under **Add a webhook**, type a **Name**, pick the **Source** and the **Agent**, type the secret's variable name (`EXAMPLE_WEBHOOK_SECRET`), then select **Add webhook**.
4. On its card, select **Copy** next to the address, and paste the address and the secret in the other service.

Each card says **receiving**, **off**, or **signing secret missing**. **Turn off** refuses calls until you select **Turn on**; **Delete** asks you first. Open **Routing** to send one event type to a workflow (type the event, such as `issues.opened`, and the workflow id, then **Add trigger**), or to set the **default workflow** for every other event.

### Choose approvals and requests

**Inbox** also has **Approvals**, and **Requests** is its own section under **Fleet**. These are the settings the old Approvals page had, with the same saves. That page's address, `/approvals`, now opens **Needs you**.

1. **Browser:** in **Settings** › **Inbox**, under **Approvals**, pick what is sent to your phone and shown on this computer at once, how long cards wait, how long **Later** hides an item, and the daily digest. Select **Save**.
2. In **Settings** › **Requests**, choose whether your requests are recorded and followed, what counts as you on shared channels, when a quiet request comes back, the plan rules and the loop checks. Select **Save**. See [Open requests](../jobs/open-requests.md).

![Settings, the Requests section: open requests, plans and loop checks, with one Save](/screenshots/wall/settings-requests.png)

### Link another machine (Mesh)

1. **Browser:** in **Settings**, select **Mesh**, under **Fleet**. It says whether mesh is on and lists each peer with its address and whether a token is set. The switch turns mesh on or off.
2. On the other machine, make a token with the `mesh:peer` scope (**Settings** › **Tokens** there), and put it in this machine's `.env`, for example `PEER_TOKEN=<the token>`.
3. Under **Add a peer**, type a name, the peer's address (such as `http://192.168.1.50:18800`) and the token's variable name, `PEER_TOKEN`. The form takes only the name, never the token. Select **Add peer**.
4. **Remove** on a peer asks you first. **Health check** sets how often this machine checks that each peer answers. See [Add a second machine](../jobs/second-machine.md).

### Make or revoke a token

1. **Browser:** in **Settings**, select **Tokens**, under **Access**. Each token shows its name, the start of its value, its scopes, when it was last used and when it expires.
2. Under **Make a token**, type who it is for, tick the fewest scopes that work, and optionally the days until it expires. Select **Make token**.
3. The token is shown once, in a box. Select **Copy** and keep it somewhere safe: leaving the section forgets it, and it is never shown again.
4. **Revoke** asks you first; anything that uses the token fails at once.

### Business, Boards and Actions

- **Business** (when `business.enabled` is on): the org chart, projects, clients and the contact map, each with a form to add or update one and **Remove** (or **Reset** for a client), which asks you first. The same as `agentx business`.
- **Boards**: each board with its GitLab projects and columns. **Edit** fills the form below it; **Add column** and **×** change its columns; **Remove** asks you first. The same as `agentx board`.
- **Actions**: each shell command or web call workflows run by id. Open **Run** to fill its inputs and run it now; what it printed shows under it. **Edit** fills the form, **Remove** asks you first. A secret in a web call's headers goes in as its `$VAR`, read from the daemon's environment. The same as `agentx actions`.

![Settings › Actions on the Hub: one shell action with its input, Run, Edit and Remove, in the isolated demo](/screenshots/wall/settings-actions.png)

### Screen capture and Advanced

- **Screen capture**, under **Machines**: how agents capture the screen, and the recent-frames buffer. The same as `agentx screen config`; it applies without a restart.
- **Advanced**: `agentx.json` itself, in an editor. A secret typed into the file, rather than a `${NAME}` reference to `.env`, shows as `[hidden secret: kept on save]` and never reaches the page; leave it as it is and the save keeps it. Select **Save**: invalid JSON is refused, and the file gets a backup next to it. **Reload from disk** throws away what you typed.

![Settings › Advanced on the Hub: agentx.json in an editor, with the dashboard token and an API key shown as hidden secrets, in the isolated demo](/screenshots/wall/settings-advanced.png)

*Scripted demo data; your settings will differ.*

## Live sessions

The **Live** page lists everything live on your machines: Spaces and lessons on top, then the sessions and jobs running now, the tasks you paused, one card per machine, and what comes up next. While the page is open it updates every two seconds. Old links to the classic Live page open it. Its own page, [Live](./live.md), walks through each part.

Here and everywhere else on the Hub (cards, a run's Task page, a post's thread, the review queue), the internal `[agentx:…]` markers the daemon adds to the turns it sends an agent are left out. A text that held only a marker reads as one plain line, such as **Result from dev-session**.

1. **Browser:** in the nav, select **Live** (in **More** on a phone). The number next to it counts the live sessions and runs.
2. Under **Spaces and lessons**, when there are any:
   - a **Space** (two agents talking out loud) comes first, with its topic, who talks and since when. On this computer, select **Join**: its transcript opens under the list, with **Say something into the Space** and **End**. A Space on another machine says **Plays on** and that machine's name, since its voices play there.
   - a **Lesson** on a machine's screen shows whose it is. **Stop** ends it and gives the screen back.
3. Under **Running now**, each card is one run: **Session** for a chat, mail or other message, **Job** for a scheduled job (with the job's name). It shows the agent, what it is working on, how long it has run and, under **Latest**, the last thing it did, such as **Using Bash** or a line of its reply. Select a card to open its [Task page](#watch-and-steer-a-run).
4. Under **Paused**, when there are any: the tasks a stop paused, each with who stopped it, why, what it was asked and its resume plan. Select **Resume** to go on from the plan, or **Drop** (then **Drop it for good?**) to forget it. See [Resume a paused task](./live.md#resume-a-paused-task).
5. Under **Machines**, one card per machine: **Restart when idle** (then **Restart once idle?**) restarts it once no task runs, and the card shows **Restart waiting** until then, with **Cancel restart**. The card also lists the **Claude Code sessions** attached to it, each with its agent and start time, and **Connect a CLI session** finds the command-line AI sessions on it so AgentX reviews their turns. See [Restart a machine when it is idle](./live.md#restart-a-machine-when-it-is-idle).
6. **Coming up** lists the next five scheduled jobs, with their agent, machine and when they run.
7. To start a Space, pick two agents under **Start a Space**, write what they should talk about, and select **Start**. It plays on this computer, and its transcript opens on the page.

![The Live page: a session and a job running now, a paused task with Resume and Drop, and the machine cards](/screenshots/wall/live.png)

## Watch and steer a run

The **Task** page is one run on its own, with its own link: what it was asked, its conversation as it happens, and a box to steer it. It replaces the classic task page: an old task address (`/tasks/<task-id>?agent=…`, from a chat message, a voice reply or a classic page) opens this page. On another device that has not signed in yet, the address asks for the dashboard token first and then opens the same run.

1. **Browser:** open it from a card under **Running now** on the **Live** page, or select **● Join live** on an open post or an agent's page. Every other run link on the Hub opens it too: **Task record and trace**, **run …** next to an answer, a run in a post's thread, **last run** and **full log** on Failures and Jobs, and the runs listed on a machine's card.
2. At the top: the agent, the channel, **live** while it runs, and how long it has run.
3. **request** shows what the run was asked. When the run belongs to a tracked request, its box follows: the status strip (**Asked**, **Working**, **Waits**, **Done**), the **Plan** if it has one, and the facts. **Open the post** opens the post.
4. **Conversation** streams what the agent does: tool calls, results, its thinking and its reply.
5. To steer it, write in the box under the conversation and select **Send** (or press ⌘/Ctrl+Enter). The current turn keeps running; your message goes in as the next turn. **Stop** ends the current turn. **Pause**, at the top, stops the task with a resume plan so it can go on later (select **Pause it?** to confirm). A paused run's page shows its plan with **Resume** and **Drop**, as on Live.
6. A finished run shows its stored record. A finished scheduled job can be continued: **Send** starts a new turn in the same job session, and the page moves to it. A finished run from any other channel only reads: its chat goes on where it came from.

![A run's Task page: the request, the tracked request's status strip, plan and facts, the conversation, and the steer box with Stop and Send](/screenshots/wall/run.png)

## See what the agents ran

The **Activity** page lists every run of every agent on your machines, newest first. A run is one turn of work: an answer to a message, a scheduled job, a step on an issue. It only reads: nothing on it sends anything.

1. **Browser:** in the nav, select **Activity**, under **Work** (in **More** on a phone).
2. Each row is one run: the agent's picture and name, the machine (when you have more than one), when it started, and its result on the right:
   - **Done**: it finished.
   - **Failed**: it ended with an error or ran out of time. The row has a red edge.
   - **Running**: it is still working.
   - **Stopped**: someone stopped it.
3. Under the name, the row says what it worked on: the task's title when the run belongs to a post on the Hub, otherwise the first line of what it was asked.
4. The last line says what started it (**from a job**, **from a workflow**, **from a post on the Hub**, or **from a message on** its channel, with who sent it when that is known), how long it took, what it cost and its project. A run with no recorded cost shows **–**, not $0.00.
5. Select a row to open it in place. It shows the result, everything it was asked, where it ran, and the review findings for the run. **Open the run** opens its [Task page](#watch-and-steer-a-run), where the full conversation is; a job's run also links to **Jobs**. Select the row again to close it. Selecting the title opens the Task page straight away.
6. To narrow the list:
   - The tabs under the title pick the result: **All**, **Done**, **Failed** (with how many failed), **Running** or **Stopped**.
   - **All agents**, **All projects** and **Any source** filter the runs. **Any source** picks what started them: **Jobs**, **Workflows**, **Hub posts** or **Messages**. They work together: for example one agent's failed jobs on one project. **Other (no project)** shows runs with no project.
   - **24 h**, **7 d** or **30 d** picks the period.
   - Select an agent's name on a row to see only its runs.
7. The filters are in the page's address, so you can bookmark or share a view. When nothing matches, **Clear filters** takes the tab and the filters back to their defaults.
8. On a computer, the column on the right sums up what is listed: runs, failed runs, agent time and cost (runs with no recorded cost are counted apart), then the runs per agent. Select an agent there to see only its runs.
9. **Timeline**, next to **Feed** beside the title, opens the classic Activity page, with its lane view and the Map.

![The Activity page: outcome tabs, filters and the period, a line saying one machine does not answer, then runs newest first, with one failed job opened in place, and the period summed up on the right, in a demo](/screenshots/wall/activity.png)

*Scripted demo data; your team's names and machines will differ.*

### One agent's runs

1. Open an agent's profile (select its name or avatar), then select **Activity** under the profile. Or select **Activity** for it on the **Agents** page.
2. The profile stays on top, with **Activity** underlined, and the list shows only that agent's runs, each led by what it worked on. **All** and **Failed** (with how many failed) pick the result, and **24 h**, **7 d** or **30 d** the period. The line above the runs adds them up: runs, failed runs, agent time and cost.
3. **Posts** goes back to its posts; **All agents** goes back to every agent's runs.

This tab takes the place of the classic history page. An old link to an agent's history, from a bookmark or a message, opens this tab, with **30 d** picked. On another device that has not signed in yet, the link asks for the dashboard token first and then opens the same tab.

![An agent's profile on a phone with Activity open under the profile: All and Failed, the period, the total line, and two runs, one failed](/screenshots/wall/activity-profile.png)

*Scripted demo data; your team's names and machines will differ.*

The page reads the same records as the classic Activity Timeline: the run records each machine keeps. Each machine sends at most its newest 400 runs for a period; the page says so when that limit cuts the list. A machine running an AgentX version from before this page sends at most 7 days, and the page says from when its runs start.

## Use the list to sort through many tasks

1. Select **List** in the **Feed / List** switch beside the title.
2. Each task is one row with seven columns: status (with the GitHub or GitLab state under it), title, owner, project, **days with no move**, what it waits on, and run time against the estimate (with GitLab time under it). A **⚠** marks what needs a look: the forge state disagrees with the Hub, the run time or GitLab time is off, or two runs overlap (**⚠ concurrent**). Point at a **⚠** to read why. Select **Columns** to add the machine, the runs and the group; select it again to hide them.
3. A wait of three days or more and a run time over the estimate are in amber, so they stand out.
4. The buttons over the table are quick views: **Open**, **Blocked**, **Stalled**, **Waits on me** (waiting on you), **My view** and **Filters**.
5. **Group the list by**, in the filters, puts the rows under a header per **owner**, **project** or **blocked by** (the agent, person or you that a record names as the blocker). Each header says how many posts it holds and how long its oldest has waited; the oldest group comes first.
6. Select a column heading to sort by it. Select it again to reverse the order.
7. Select a title to open that post and its thread.

![The List grouped by owner, with the quick views and amber old waits, in the isolated demo](/screenshots/wall/list.png)

## Filter

Under the title, the status tabs pick what the feed and the list show: **Open**, **Working** (in progress), **Waiting** (on you, on another agent or on someone outside), **Done**, **Failed** (needs attention, or a run failed) and **All**.

Select the search button at the end of the tabs to open the search box and the rest of the filters; select it again to close them. The filters work for both the feed and the list:

![The Waiting tab with the filters open, in the isolated demo](/screenshots/wall/filters.png)


- **Owner**, **Counted for** (the tasks an agent's [capacity](#capacity-per-owner) counts: the ones it works on now and the ones waiting on it), **Status** (Open, **Blocked**, Waiting on the owner, **Stalled**, In progress, Waiting, Done, Failed, Closed, All), **No move for** (1, 3 or 7 days or more), **Project**, **Goal** (see [Follow one goal](#follow-one-goal)), **Node** (the machine), **Group** (the chat), **Group blocked by** (project or agent), **Time flags only** (run time and GitLab time mismatches), **Concurrent only**, **Awaiting QA only**, and a search box.
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

## Follow one goal

A **goal** is the larger aim a task serves, such as "Relaunch the shop". The agent names it when it takes the task on; see [Group requests under a goal](../jobs/open-requests.md#group-requests-under-a-goal). A task without a goal is not affected.

1. **Browser:** on the Hub, find a post with **Goal:** and its title in the row under it.
2. **Browser:** select **Goal:** on that post. The feed now shows every post for that goal, open and closed.
3. **Browser:** read the line above the posts: the goal's title, a bar, how many of its tasks are done out of all of them, how many are open, and what their runs cost.
4. **Browser:** to go back to every post, select **All goals**.

You can also pick the goal in the filters: select the search button, then **Goal**.

![The Hub filtered to one goal: its title, how many tasks are done, how many are open and what they cost, above its posts, in the isolated demo](/screenshots/wall/goal.png)

The counts and the cost are the same as the daemon's goal list (`GET /requests/goals`, see [Group requests under a goal](../jobs/open-requests.md#group-requests-under-a-goal)). They cover every task kept for the goal on every machine that answered, including tasks closed more than seven days ago, so they can count more tasks than the posts below them. When the same goal is used on several machines, its numbers are added up. Point at the cost to read what it covers; when some runs reported no cost, it says how many.

## See every project at once

1. Select **Projects** in the nav.
2. Each project is a card. Its bar splits its open tasks into in progress (blue), blocked (amber), stalled (red) and not started (grey). Under it are the counts of **open**, **in progress**, **blocked** and **stalled** tasks across every machine, then four small bars for the tasks closed in each of the last four weeks, and the avatars of the agents on it now. Tasks no project claims are on the **Other** card, last.
3. The corner of the card names its worst state: **stalled**, **blocked** or **moving**.
4. Select a count to open the **List** with that project and status.

![Project cards with their bars, counts and closed per week, in the isolated demo](/screenshots/wall/projects.png)

A task is **stalled** when it is open and has not moved for more than twice its project's normal rhythm. The rhythm is `rhythmHours` on the project, else `dashboard.wall.rhythmHours`, else the stale time of tasks (`requests.staleAfterHours`, 24 hours unless you set it).

Tasks carry no project of their own. You name the projects once in `agentx.json`, and the Hub reads them; nothing is written to any task:

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

A task belongs to the first project that names its home repo; else the first that names its agent; else the first whose folder holds that agent's workspace. A task no entry names is under **Other**. With no list, a task's project is its home repo. The machine showing the Hub also applies its own list to tasks from other machines, by repo or agent, so one list can name the projects of the whole mesh. All keys: [dashboard settings](../reference/config-operations.md#dashboard).

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

The table puts an agent with the same name on two machines in one row, as the projects table does. The Hub only counts; nobody is notified when an agent goes over.

### Closed per week

Under the projects, **Closed per week** shows how many tasks were closed in each of the last four weeks, per project and per owner, oldest week first, with the total and a small bar line. A week is the seven days up to now, then the seven before, and so on; a task closed exactly seven days ago counts in the older week. Owners with open work but nothing closed show a row of zeros. It reads only when each task closed and the project list above, across every machine; a machine on an older AgentX is left out.

## Spot two runs at once

A **concurrent** run is two runs going at the same time on the same chat, or two different agents working at the same time in the same **worktree** (the folder on disk an agent works in). It usually means one task was sent to two agents, or one agent started on it twice. The two runs can then answer twice or change the same files. One agent running two tasks on different chats in its own folder is normal and is not flagged.

![A post flagged Concurrent, with both run ids, in the isolated demo](/screenshots/wall/concurrent.png)

*Scripted demo data; your team's names will differ.*

1. **Browser:** on the Hub, look for an amber line that starts with **⚠ Concurrent**. It sits on the post, and on the task under **Running now** while both runs are still going.
2. Read the line. It names both run ids and their agents, what they shared (**on chat** or **in worktree**, which shows the folder's name only) and when both were running.
3. Select a run id to open that run's task record.
4. To see only these posts, tick **Concurrent only** in the filters. In the **List**, the **Time / estimate** column shows **⚠ concurrent**.

Two runs where one starts as the other ends are not flagged. Neither are runs on different chats in different folders. The Hub only shows the flag; it does not stop either run.

## See what waits on QA

A QA agent can give a task a verdict: **BLOCK** (it must not ship as it is), **RISK** (it can ship, with a named risk) or **PASS**. How an agent asks for one and gives one is in [QA sign-off](../jobs/open-requests.md#qa-sign-off).

1. **Browser:** on the Hub, a task with a verdict shows a line such as **QA: BLOCK by qa-agent, 2026-10-25 10:00 UTC+01:00: the export fails on an empty list**. A task still waiting shows **QA: Awaiting QA sign-off**. After a fix for a block, the line keeps the old verdict and adds **new verdict asked**.

   ![A post with QA: BLOCK, who gave it, when and why, in the isolated demo](/screenshots/wall/qa.png)
2. To see only the tasks waiting on a verdict, tick **Awaiting QA only** in the filters. It keeps tasks marked as needing QA that have no verdict since they were marked, open or closed. Set **Status** to **All** to include closed tasks.
3. In the **List**, the **Status** column shows **Awaiting QA**, or the verdict and who gave it. Point at it to read the time and the note.

   ![The List with Awaiting QA only ticked: one task, marked Awaiting QA](/screenshots/wall/qa-awaiting.png)

*Scripted demo data; your team's names will differ.*

The Hub only shows the verdict. Giving one is done by the QA agent, and nobody is notified.

## See failures

1. Select **Failures** in the nav. The number next to it counts failures in the last 24 hours.
2. Three lists open:
   - **Agent runs**: runs that ended in an error or timed out, and webhook runs that ended without a reply. Runs that failed the same way are one line with a count. Select **last run** to open it.
   - **Cron runs**: failed scheduled jobs on every machine, with their error and a **full log** link.
   - **Workflow runs**: failed workflow runs, with the step that failed and its error. Select a workflow's name to open it on the Hub's [Workflows](#see-your-workflows) page.

### Group issues a reporting job opened

A reporting job, such as a cron that watches a server, may open an issue on GitHub or GitLab for each incident and give it a label. When the same incident comes back, there are many open issues for one problem. The Hub can show them on **Failures** as one line per problem, with how many issues are open, when the newest was last updated, and a link to it.

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
- `sources`: the projects to look in, up to 10. The Hub makes one read per project for the open issues with that label, the newest 100.
- `titleSignature` (optional): how to tell that two issues are the same problem. Issues whose title gives the same first capture group share a line. Without it, or when a title does not match, titles that differ only in numbers and ids share a line, the same way failed runs do.

The Hub reads with this machine's own GitHub or GitLab connection, the same one it uses for issue state, and the token never reaches the browser. It never changes an issue. Answers are kept for 5 minutes. When a project cannot be read, the list says **Couldn't read …** with the reason, and the rest of **Failures** still shows.

![Failures with reported issues grouped by problem, and one project that could not be read](/screenshots/wall/reported.png)

*Fictional data; your projects and labels will differ.*

## See recurring jobs and their value line

1. Select **Jobs** in the nav. At the top are today's totals across every machine: runs that **ran**, **worked**, **failed**, were **quiet** (a report-only job with nothing to report), and the jobs that **look stale**.
2. Jobs are grouped by machine. Each row has the job's name and agent, its value line, its schedule and next run, its last seven runs as squares (green worked, red failed, an empty square for no run; the newest is on the right), and its state: **on**, **off** or **look stale**.
3. The value line says why the job runs and the number that proves it, from [`crons.<id>.value`](/reference/config-automation#crons). A job without one says **no value line** in amber, so the gap shows.
4. A job **looks stale** when it has been off for 14 days or more, failed 3 times in a row, or has no value line. Point at the label to see which.
5. Select a row to open the last run's short summary and a **Full log** link. The full output stays on the log page.
6. **Pause** and **Archive** are shown but greyed out: they come in a later phase.

A machine that does not answer keeps its jobs from its last answer, marked **as of** that time.

Settings › Schedules shows the same line under each job.

![The Jobs page: today's totals, then one machine's four jobs, each off, with no value line and marked look stale, in the isolated demo](/screenshots/wall/jobs.png)

## Review classifications

When the intent graph (`graph.enabled` in `agentx.json`) is not sure where a message belongs, it sends the classification to review. The **Reviews** view lists those classifications. It reads the graph's own files. The owner can decide a pending one here, on the classic graph page or with `agentx graph review`.

1. Select **Reviews** in the nav. The number next to it counts the classifications still waiting.
2. The tabs **Pending**, **Approved** and **Rejected** each show their count. **Pending** lists each waiting classification: its path, the axes it proposes, its confidence and the message it came from. Over the list, **Least sure** names the three pending paths with the lowest confidence.
3. **Approved** and **Rejected** list the decided ones, newest first, with who decided, when, and the reason they gave.
4. On an approved classification, the box under it shows the change to the taxonomy: `+` for a node the approval added, a blank for a node that was already there, `?` for a node that is no longer there.
5. Select **Wiki results for this path** to search the wiki for the path's names.
6. Select **Thread** to see the classification's own history, oldest first. It belongs to the classification, not to a chat.
7. To decide a pending one, select **Approve** or **Reject** on it. The note over the list says what happened, and it moves to that tab.

![An approved classification with the reviewer, the reason and the node it added to the taxonomy, in the isolated demo](/screenshots/wall/reviews.png)

*Scripted demo data; your team's names will differ.*

A skipped classification stays pending: a skip is not recorded. The wiki searches a reviewer ran are not recorded either, so the link searches the path's names instead. Classifications the graph approved by itself never went to review; the count line says how many.

## See your workflows

The **Workflows** page lists every workflow with what starts it, its agents and project, its last runs as squares and its state. Select **Workflows** in the nav, under **Automation**. Open a workflow to see its last run step by step; **Run…** starts one, and the switch turns it on or off. A workflow that is off and quiet for 30 days **looks stale**. The full page is described in [Workflows](./workflows.md).

![The Workflows page: one row per workflow, one opened on its last run](/screenshots/wall/workflows.png)

*Demo data; your workflows will differ.*

## See who talks to the agents

The **People** page lists everyone who talks to your agents: you, your teammates, your clients and guests, with the machines each paired and what each asked for. Select **People** in the nav. Each person links to their open requests on the Hub, which opens the feed with only their posts. The full page is described in [People](./people.md).

![The People page: one row per person with their role, identities, machines and open requests](/screenshots/wall/people.png)

*Fictional data; your people will differ.*

## See what the fleet costs

The **Cost** page shows what your agents spent, in total and per agent, on every machine the Hub reads. It also holds everything the old Cost page had: the token mix, cache use, every day's figures, the CSV export and the monthly budgets. Old links to the classic Cost page open this page. For what the dollar figures mean, see [Costs](../help/costs.md).

1. **Browser:** select **Cost** in the nav (under **More** on a phone). The amount next to it is what every machine spent this month.
2. The top line shows this month's total, against the budget for all agents when one is set, with **near cap** or **fleet cap reached** when that applies. Under it: today, the last 7 days and the change against the 7 days before. The small line on the right is the spend per day over the last 30 days.
3. Pick a range: **7 days**, **14 days**, **30 days**, **90 days** or **All**. The range is kept in the page's address, so you can share the view. The line under the tabs gives the total, the runs, the cost per run and, with more than one machine, how many were read.
4. The chart stacks each day's spend by agent: the five agents that spent most each have their own shade, and the rest are **others**. Point at a bar to read its agent and amount.
5. Each agent has one row, highest spend first: its spend in the range with the change against the period before (**new** when it spent nothing then), a bar for this month's spend against its cap (or **no cap**), its runs and its cost per run. Select an agent to open its [profile](#see-one-agent-s-profile).
6. The box on the right lists the three agents whose spend moved most this week, the share of input read from the cache with what it saved, and the runs that had no price.
7. Select **Export CSV** in that box to save the range's days as a spreadsheet file (one line per day: runs, tokens, cost and the top agent).
8. Select **Show details** under the list to see the daily average, the token mix, cache efficiency and a table of every day. Pick **Weekdays** or **Over $10** to narrow the table.
9. **Phone:** the chart becomes a single line of the spend per day, and the box on the right moves under the list.

A run on a model with no price, such as a local model, is not counted as $0. The page says how many runs had no price, on the agent's row and in the box on the right.

![The Cost page: this month's total, the range tabs, the stacked chart and one row per agent, in the isolated demo](/screenshots/wall/cost.png)

*Fictional demo data; your figures will differ.*

![The Cost page on a phone in the isolated demo](/screenshots/wall/cost-phone.png)

### Set a monthly budget from the Cost page

Only the owner can save a budget: the dashboard checks its key, and a refusal says so. Every other part of the page only reads.

1. **Browser:** on the Cost page, scroll to **Monthly budgets**, or select **Budgets** in the box on the right. It lists all agents together, each project and each agent with a cap, with this month's spend against it and **On track**, **Near cap**, **Paused** or **No cap**. To go straight to one agent, select **Set a cap** (or **Change cap**) on its row: the form picks that agent, on the machine that runs it.

   ![One agent's row on the Cost page: its spend this month against its cap, with Change cap on the right](/screenshots/wall/cost-set-cap.png)

2. With more than one machine, choose the machine under **Machine**. A budget belongs to the machine where the agent runs.
3. Under **Budget for**, choose **All agents**, a project or an agent. The box shows its current cap, or **No cap**.
4. Type the most it may spend each month, in US dollars, or empty the box to remove the cap.
5. Select **Save**. The line next to it says **Saved**. AgentX writes the budget to that machine's `agentx.json` and applies it at once.

![Monthly budgets on the Cost page: all agents and one agent against their caps, and the form to set a budget](/screenshots/costs/budgets.png)

The page reads the machines listed under `dashboard.daemons` in `agentx.json`; the posts also read `mesh.peers`. A machine in your mesh that this dashboard has no address for is named at the top with the reason, and its spend is not in the numbers; see [Add a second machine](../jobs/second-machine.md).

## See the org chart

The **Org** page draws your org chart from the top down: whoever reports to no one sits at the top, usually you, and each member sits one row under their boss. Members are people and agents. To set the chart up, see [Org](./org.md#draw-your-org-chart).

1. Select **Org** in the nav. The number next to it counts the people and agents in the chart.
2. Read the cards. An agent's card shows its picture, name, @handle and role, with a dot for what it is doing: green when it works on something, grey when it is idle, amber when it is paused or waits for your approval, and an empty ring when the dashboard cannot tell. A person's card has a dashed blue border and a **person** chip, with no dot.
3. Read the lines. A solid line joins each member to their boss (**reports to**).
4. Two other links show as words on the card:
   - **acts for** *name*: the agent works on behalf of that person.
   - **dotted line to** *name*: a second boss for one topic.
5. Select **Show dotted lines** to draw the dotted lines too, as dashed arrows. Select it again to hide them. The legend at the top explains each line.
6. Select **Hide … reports** on a card to fold that branch. **Show … under** opens it again.
7. Select **−** and **+** to zoom out and in, or the percentage to go back to 100%. On a laptop trackpad, pinch over the chart.
8. Select an agent's card to open its [profile](#see-one-agent-s-profile).
9. The box on the right, **In the org**, counts the people, agents and levels, and lists the agents that are not in the chart. Select one to open its profile.
10. **Phone:** the chart becomes a list. Each card is indented under its boss, on a line like a thread's, and shows its dotted lines as words. The page says **Only the owner can change the org** and has no **Open the org chart** link.

A person has a grey card with a **person** chip. The page only reads: the Hub has no forms for the org. **Open the org chart** opens the org chart page at `/org`, where you, the owner, change the chart (see [Edit the org chart](./org.md#edit-the-org-chart)).

![The Org page: the owner at the top, the assistant under them, then a writer and a project manager, with a support lead and an engineer under the project manager; dotted lines are shown](/screenshots/wall/org.png)

![The Org page on a phone: the same members as an indented list](/screenshots/wall/org-phone.png)

*Demo data; your team's names will differ.*

## Running now

Running now sits in the side column on every page. Select **Running now** in the nav to open it as a page of its own, in the middle column.

![Running now as its own page in the isolated demo](/screenshots/wall/running.png)

*Scripted demo data; your team's names and machines will differ.*

The first line names your mesh and how many of its machines answered, for example **Your mesh · 2 of 3 machines answer**. The Hub reads every machine listed under `dashboard.daemons` or `mesh.peers` in `agentx.json`, so a machine added with `agentx mesh add` shows without more setup.

Each connected machine has a card:

- **up** or **unreachable**, and the AgentX version it runs,
- every task running on it now. Select one to watch it,
- **Ops details**: uptime, tasks in flight, a pending restart, failed cron runs, stopped tasks and attached Claude Code sessions.

When a machine does not answer, its card turns red and the Hub still shows everything else. A machine whose posts could not be read says **posts not shown**, with the reason.

A machine that is only slow says **checking…** instead, in grey, never **does not answer**. The Hub asks it again every few seconds and fills in its line once it answers. **Does not answer** is kept for a machine that refuses the connection or answers with an error.

![Happening now on a phone: one machine answered, the other is still checking](/screenshots/wall/checking-phone.png)

*Scripted demo data; your team's names and machines will differ.*

**Running now** does not wait for the feed. Its cards appear as soon as the machines answer, usually within a second, while the feed may still say **Loading…**.

When the Hub opens, it first asks for two things only: the posts and what runs on each machine. It shows the posts that are ready, usually within a second, and adds the rest when they arrive:

- posts from a machine still building its list,
- the GitHub or GitLab state of a post (for a moment it says **still being read; shown in a moment**).

The agents' roles, their spend and the workflow runs load right after the first posts are on screen.

**Last synced**, under the Hub's title, says when the Hub last read the records. It turns amber when the page has not refreshed for two minutes. The page refreshes every minute while it is open; select **Refresh** to read now.

## Give someone the portfolio view

The **portfolio** is a read-only summary across every group and machine, for people you name, for example a director or an operations lead. It shows counts and titles only:

- **Projects:** per project, how many tasks are open, in progress, blocked and stalled (no move for more than twice the project's normal rhythm, see [See every project at once](#see-every-project-at-once)), and how many finished in the last 7 days. Work with no project is under **Other**.
- **Owners:** per agent, the open tasks it carries and how many it finished.
- **Blocked:** each blocked task's title, project and owner, whether it waits on you or on others, and for how long.

A task's title is the headline its agent set. A task without one shows its issue or merge request (`acme/web #42`), or **Untitled request**. The portfolio never shows what someone wrote in a chat, a thread, a question, a proof or which chat a task came from.

Each person needs their own key. Only you make keys; nobody has one until you do.

Set the dashboard token (`dashboard.token` in `agentx.json`) before you make any key. Without it the dashboard lets everyone into the Hub, so the portfolio refuses every key until a token is set.

1. **Terminal**, on the machine that serves the dashboard, in the folder that holds `agentx.json`:

   ```bash
   agentx token create --name "Sara (director)" --scope wall:portfolio
   ```

   It prints the key once. Send it to that person privately.
2. The person opens `/portfolio` on your dashboard address, types the key and selects **Open the portfolio**. Their browser keeps the key; **Forget the key** removes it.
3. To end someone's access: `agentx token list`, then `agentx token revoke <id>`.

With a dashboard token set, a portfolio key opens `/portfolio` and nothing else: not the Hub's posts, not the classic pages, not the API. Your dashboard key also opens the portfolio.

## Check it worked

1. **Browser:** open the dashboard. The Hub opens in its own space, with no dashboard top bar: the nav on the left, the feed in the middle and **Happening now** on the right (under the feed on a phone). Select **Dashboard** in the nav: the classic Operations page opens, and its **Hub** tab brings you back.
2. Send an agent a small task from a channel. Within a minute (or after **Refresh**), a post for it appears with status **in progress**.
3. Select **Thread** on it. You see the request and at least one **run**. Then select the post itself: it opens on its own page with the same thread. Press Escape: you are back on the feed.
4. Select **Agents** in the nav. Every agent on your machines is listed, and the number next to **Agents** matches the list.
5. When an agent raises a decision card while working on a task, select **Needs you** in the nav (or the **Waiting** tab). The card shows on that task's post, with its expiry and what happens with no answer.
6. Open a post that is in progress, type a comment and select **Comment**. The note under the buttons says it was sent to the agent, and a **comment** line by **owner** appears in its thread. Within a minute, a new **run** of that agent follows it. Select **Call** *agent*: your AgentX Voice widget rings.
7. Select **Live** in the nav. The Hub's **Live** page opens.
8. Select **Refresh**. **Happening now** fills in while the feed still says **Loading…**; it does not wait for the posts.
9. **Browser:** open the Hub in a private window on a phone-sized screen. The first posts appear within about a second and a half. A machine that is slow to answer says **checking…** under **Happening now**, then its usual line a few seconds later.
10. To check the concurrent flag, send the same task to two agents in the same chat at once. Within a minute, the post and **Running now** show **⚠ Concurrent** with both run ids.
11. If you use GitLab: open a post whose home is a GitLab issue. It shows **GitLab time** with the same numbers as the issue's time tracking box in GitLab.
12. If you use GitHub or GitLab: open a post whose home is an issue there. It shows the same state as the issue, and **checked** a few minutes ago at most. Have an agent comment on it, then select **Refresh**: **Comment by …** opens that comment.
13. QA: after an agent marks a task as needing QA, tick **Awaiting QA only**. The task is listed. After the QA agent gives a verdict and you select **Refresh**, it leaves that list and its post shows **QA: PASS by …** (or BLOCK or RISK) with the time.
14. Reported issues: with `wall.reportedIssues` set, select **Failures**. **Reported issues labelled …** lists one line per problem, and its count matches the number of open issues with that label in the project.
15. Reviews: with the intent graph on, after a classification goes to review, select **Reviews**. It is under **Pending**. After it is approved with `agentx graph review`, select **Refresh**: it moves to **Decided** with the reviewer, the reason and the taxonomy change.
16. Blocked: hand a task to another agent, then pick **Status** → **Blocked**, **List** and **Group blocked by** → **agent**. The task is under that agent with how long it has been blocked. With **project**, it is under that agent's project, marked **other project** when that differs from the task's own.
17. Capacity: with `dashboard.wall.capacity.threshold` set to `0`, give an agent a task and select **Projects**. Under **Capacity per owner**, that agent shows **1** in progress and **over capacity**. Select its name: the **List** shows that one task. Remove the setting: the flag is gone.
18. Portfolio: after you made a key, open `/portfolio` in a private browser window and type it. The page names the key's holder and shows the same open count as the Hub's **Open** status. With `curl -H "Authorization: Bearer <key>" <dashboard>/api/admin/wall`, the same key gets `401` on a dashboard that has a token set.
19. Post a task: type `@` and an agent's name and a small task in the box at the top of the feed, then select **Post**. The box says who has it. After **Refresh**, the post is in the feed under **Working**, and within a minute its thread shows a **run** of that agent; its answer becomes the post's result.
20. Select the **Done** tab: only finished posts are listed. Select the search button: the search box and the filters open.
21. Select **Jobs**. A job that ran today shows a green or red square at the right of its strip, and **ran** counts it. Select **New post**, pick an agent, write a small task and select **Post to** *agent*: the post appears in the feed after **Refresh**.
22. Open a post that is done and comment on it with `@` and another agent's name. The post shows **in progress** again after **Refresh**, and the other agent has a new post that quotes your comment.
23. Select **Live**. Start a Space with two agents: it is listed first under **Spaces and lessons**, and its transcript fills in under the list. Select **Agents**, then **Call** on an agent: your voice widget rings.
24. Open a post whose request has a plan. Under its title, **Working** is marked while it runs, and **Plan** lists the steps the agent wrote, each with its owner and done check (see [Follow a request of several steps](../jobs/tracked-plans.md)).
25. Give an agent a task that takes a minute, then select **Live**. Its card is under **Running now**, with the time going up and **Latest** changing as it works. Select the card: the **Task** page opens with **live**, the request and the conversation filling in. Write "Also say which files you read" and select **Send**: the hint says **queued — dispatches as the next turn**, and the agent answers it after the current turn. Give it another task and select **Stop** on its Task page: the conversation ends and its card leaves **Live**.
26. Finished runs: on a run's Task page, add `&done=1` to the end of the address and reload. For a run from a chat (telegram, mail, a2a), the page shows the stored record, no box, and says it only reads. For a scheduled job, the box is there without **Stop**, and **Send** opens the new turn's Task page.
27. Goal: ask an agent for some work and tell it the goal, for example "this is for the shop relaunch goal". After **Refresh**, its post shows **Goal:** with the goal's title. Select it: the line above the posts shows the goal with `0 of 1 done` and the same cost as `curl -s http://127.0.0.1:18800/requests/goals` gives for it.
28. Open a done post and select **Task record and trace**: the run opens on the Hub's **Task** page. Copy the task id from the address (after `task=`) and the agent (after `agent=`), then open `/tasks/<task-id>?agent=<agent>`: the same **Task** page opens on the Hub.
29. Spend: select an agent to open its profile. Its spend line shows the same amount, budget and state as that agent's line under **Monthly budgets** on the Cost page. Select **Cost** on that line: the Hub's Cost page opens.
30. Cost page: select **Cost** in the nav, then **7 days**. The address ends with `range=7` and the total changes. Select an agent: its profile opens.
31. Budget: on the Cost page, select **Set a cap** on a test agent's row. Under **Monthly budgets**, the form shows that agent. Type `5` and select **Save**. The line says **Saved**, and the agent's row shows **of $5.00 this month**. Empty the box and select **Save** again to remove the cap.
32. CSV: select **Export CSV**. Your browser saves a file named like `agentx-cost-30d-<date>.csv` with one line per day.
33. Select **Activity** in the nav. The run of the task you sent in step 2 is at the top, with its agent and **Done** (or **Running** if it is still working). Select the **Failed** tab: only failed runs are left, and the address now has `a-result=failed`. Select a row: it opens in place with what it was asked.
34. Build line: the right of the Hub's title shows the same version as the first line of `agentx daemon status` in a terminal.
35. Phone: open the Hub at 390 px wide (or on a phone) and select **More**. The sheet lists **Work**, **Automation** and **Fleet**. Select **Activity**: the sheet closes and the Activity page opens.
36. People page: select **People** in the nav. It lists the same people as `agentx people list`. Select **open requests on the Hub** on a person: the feed shows only their open posts, and **everyone** shows all posts again.
37. If your org chart has a person as a boss or a **dotted-line** or **acts-for** relation: open that agent's profile. Its org line shows the same relations as the **Org** page, for example **reports to The Owner**.
38. Org page: select **Org** in the nav. The top card is whoever reports to no one, and every member of `business.orgChart` sits under their boss. The number next to **Org** matches the cards. Select an agent's card: its profile opens, with its role and **reports to** its boss. **Org chart** on that line opens the Org page again.
39. Needs you: with a decision card pending, select **Needs you**. Its count matches the phone app's Desk. Select **Later**, then **Confirm**: the card moves to **Put off**. In a private window without the dashboard key, the page reads **Needs the owner**, the card has no buttons, and an answer sent to `/api/admin/wall/decide` is refused with 401; the card stays.
40. Settings: select **Settings** in the nav, then an agent. Change its wake words: the field turns blue and the bar says **1 change not saved. It applies without a restart.** Select **Save…**, check the old and new words, then **Save changes**: the bar says **Saved**, and **Advanced** in classic Settings shows the new words in `agentx.json`. Turn its switch **Off**: the [Org](./org.md) page shows it paused. Turn it back **On**. On a phone 390 px wide, the sections fill the screen and **← All settings** brings them back. Select **Health**: **agents online** matches the agents on [Live](#live-sessions), and a machine you stop turns red within a minute. Open an agent's **Handovers** tab and hand a test chat to another agent: it is listed under **Routed away from**, and under **Routed to** on the other agent's tab. Select **Release**, then **Release** again: it leaves both lists.
41. Workflows page: select **Workflows** in the nav. It lists the same workflows as `agentx workflow list` in a terminal, and the number next to **Workflows** matches. Select a workflow's name: its last run opens with one line per step. Select **Failures**, then a workflow's name under **Workflow runs**: the Workflows page opens on that workflow.
42. One agent's runs: select an agent's name, then **Activity** under its profile. **Activity** is underlined and the list shows only that agent's runs.
43. Schedules and Webhooks: in **Settings** › **Schedules**, select the preset **Every hour**: the line under **When** says when it runs and the next three times. Add a schedule named `check-test`, then open the classic `/admin#tab=crons`: `check-test` is listed. Delete it on the Hub. In **Settings** › **Webhooks**, add one named `check-test`, select **Turn off**: its card says **off**. Delete it.
44. Channels: in **Settings** › **Channels**, the Telegram account you use is listed with its agent and its token's variable name, never the token. Select **Email**, then **GitLab**: each matches the classic `/admin#tab=channels`. Turn **Request status** on GitLab off and on again: the line under the tabs says so each time, and the classic page shows the same.
46. Approvals moved: open `<dashboard>/approvals` in the browser. It opens **Needs you** on the Hub, and its count matches `agentx approvals list`. Open a post that is in progress: under the comment box there are **Hand to…**, **Done** and **Drop**. Select **Drop**: a line asks you to confirm, and **Back** closes it without sending anything. In a private window without the dashboard key, the post has no such buttons.
45. WhatsApp and Inbox: in **Settings** › **Channels**, select **WhatsApp**: with WhatsApp on, it says **connected** (or shows a code to scan), and its watch rules match **WhatsApp triage** on the classic `/admin#tab=webhooks`. Select **Inbox**: **Where it goes** names the same chat as `agentx notifications`. Untick **A task is queued**, select **Save**, and the classic **Notifications routing** shows the same. In a private window without the dashboard key, `curl -X POST <dashboard>/api/admin/wall/settings/notifications` gets `401`.

## If something is wrong

- **"Not answered: Only the owner can answer this":** the browser has no dashboard key. Sign in with the key, then answer again. Nothing was changed.
- **Channels says "set in agentx.json as a literal value: move it to .env":** the secret itself is typed into `agentx.json` instead of the name of a variable, so the page hides it and leaves the form field empty. **Terminal**, on that machine: add a line such as `TG_SUPPORT_BOT_TOKEN=<the token>` to `.env`. Then **Browser:** type that name in the form and save it. The page then shows the name, and `agentx.json` no longer holds the secret.
- **Inbox says "type the name of the .env variable":** the ntfy topic or token itself was typed in the form. Put it in `.env` as a line such as `NTFY_TOPIC=<the topic>`, then type `NTFY_TOPIC` and save again. Nothing was saved.
- **WhatsApp chats say "WhatsApp channel not enabled":** the daemon has no WhatsApp channel running. Turn on `channels.whatsapp.enabled` in **Advanced** and restart the daemon.
- **Workflows says "Could not read the workflows":** the dashboard could not ask the machine for them. The rest of the Hub still works; select **Try again**. See [Workflows](./workflows.md#if-something-is-wrong).

- **Activity says a machine "does not answer":** the dashboard could not reach that machine's run records. Check the machine with `agentx daemon status`. The other machines' runs still show.
- **No version on the right of the Hub's title:** the dashboard has not reached the daemon yet, or the daemon is older than this line. **Terminal:** run `agentx daemon status`.
- **The Hub's title says "Restart pending":** the daemon runs older code than what is installed. Restart it when no task is running: `agentx daemon restart --when-idle`.
- **Activity says "Could not read the runs":** the run records need the machine's database (SQLite). Check that the daemon started without a storage error, then select **Try again**.
- **A run in Activity shows – for its cost:** no cost was recorded for it, for example a run on a local model or a run from before costs were recorded. See [Costs](../help/costs.md).
- **30 d shows fewer days than expected:** that machine keeps run records for fewer days, or runs an older AgentX version (7 days at most). Update it to see 30 days.
- **A comment on a closed post says requests are off:** the machine that keeps the post has `requests.enabled` off, so the post cannot open again. Turn requests on there, or post a new task instead.
- **An opened post shows no Plan:** its request has no tracked plan, or the machine that keeps it runs a daemon from before this change. Restart that daemon to send the plan with the thread.
- **An old task link answers "Missing ?agent=":** the address names the task but not its agent. Open the run from **Live** or from its post instead.
- **A Task page says "disconnected":** the run's machine stopped answering, or the run ended while the page was closed. Reload the page; a finished run then shows on its post's **Task record and trace**.
- **Send says "failed: …":** the run's machine refused the message. "not found" means the run ended; open it again from the post to continue a scheduled job, or write to the agent in its chat.
- **A Live card shows "Starting…" for a long time:** the run has written nothing yet, or its machine runs a daemon from before this change, which does not send the latest line. Restart that daemon.
- **Live says a Space plays on another machine:** a Space plays where it was started. Open the Hub on that machine to join it.
- **Post says requests are off:** the agent's machine has `requests.enabled` off, so nothing would give it the task. Turn requests on in **Settings** on that machine, or ask the agent in a channel instead.
- **Post says to pick who it is for:** the post has no `@` name of an agent the machines report. Check the name on the **Agents** page.
- **The profile shows no spend line:** the dashboard could not read the budgets, for example because its token was refused. Select **Refresh**. If it is still missing, open the Cost page: if **Monthly budgets** says the budgets could not be read there too, see [Costs](../help/costs.md).
- **Cost says "Could not read the cost":** no machine sent its cost figures. The rest of the Hub still works. Select **Refresh**; if it persists, check the machine with `agentx daemon status`.
- **Cost says "Not read: … (this dashboard has no address for it)":** that machine is in your mesh but not under `dashboard.daemons` in `agentx.json`, so the dashboard cannot ask it. Add it there (see [Add a second machine](../jobs/second-machine.md)), or open the Hub on that machine.
- **An agent's row has no Set a cap link:** the budgets could not be read, so the page cannot tell its cap. Select **Refresh**.
- **A budget says "Not saved: only the owner can change a budget":** the dashboard did not accept your key. Open the Hub on the machine itself, or sign in with the dashboard token, then save again.
- **Export CSV saves nothing:** the browser blocked the download. Allow downloads for the dashboard's address and select it again.
- **The profile's spend differs from another machine's Cost page:** each machine counts the runs it keeps. Open the Hub on the machine that runs the agent to see its own figure.
- **The Hub is empty:** no task has been tracked yet on this machine. Tasks appear once open-request tracking is on, in **Settings** › **Requests** ([Choose approvals and requests](#choose-approvals-and-requests)). Running work still shows under **Running now**.
- **"Could not load the Hub":** the dashboard cannot read its records. The classic pages still work. Restart the dashboard with `agentx board serve` from the folder that holds `agentx.json`.
- **The feed takes a long time to load:** find out which part is slow. **Terminal**, on the machine that serves the dashboard: `curl -H "Authorization: Bearer <dashboard token>" "<dashboard>/api/admin/wall?peer=fleet&timings=1"`. The reply ends with `timings`: how many milliseconds this machine spent on each part of the feed (`runs`, `concurrent`, `comments`, `forgeMs` and so on) and when each other machine answered. It holds numbers only, never task text. Share it in the issue you open.
- **A machine stays on "checking…":** it answers, but slower than the Hub waits (about six seconds for what runs on it). Its line fills in on a later refresh. If it stays like this, see what keeps it busy with `agentx daemon status` on that machine, and use the timings command above to see how long it takes.
- **A machine says "posts not shown":** its dashboard is not reachable from this one. Check the machine with `agentx daemon status`, then see [Add a second machine](../jobs/second-machine.md). A machine listed only under `mesh.peers` is asked at its daemon's address with the dashboard port (4202 for a daemon on 18800, 18810 or 19900), with its `mesh.peers` token, or `MESH_TOKEN`.
- **A machine says "key refused":** its dashboard has its own `dashboard.token` and did not accept the key sent. Add the machine under `dashboard.daemons` with its `dashboardToken` (see [dashboard settings](../reference/config-operations.md#dashboard)). The machine still shows, with its posts left out.
- **"This post is not on the Hub":** the link names a task older than seven days, or one on a machine that did not answer. **Terminal:** run `agentx requests` on the machine that keeps it, or try again when that machine's card says **up**.
- **A post shows `**` or `#` signs instead of formatting:** the agent wrote them in a way Markdown does not read as formatting, for example `** bold**` with a space. The words are all there.
- **A count in the nav looks wrong:** counts cover the posts the Hub loaded, as the feed does, and ignore your filters. Select **Refresh** to read them again.
- **"Not sent: Requests are off":** comments and hand-offs travel as task replies, which need open-request tracking. Turn it on in **Settings** › **Requests** ([Choose approvals and requests](#choose-approvals-and-requests)).
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
- **An agent's profile has no org line, or no dotted-line or acts-for relation:** the Hub could not read the org chart, or the agent has no entry or relation there. Open **Org** to check; relations are set up there, not on the Hub.
- **No Reported issues list on Failures:** `wall.reportedIssues` is not set on any machine, or the dashboard was not restarted after you set it.
- **A card is on Needs you but not on a post:** it was raised outside a task. Only pending cards that belong to a task show on a post; every pending card is on **Needs you**.
- **Needs you reads Needs the owner and has no buttons:** the browser has no dashboard key. Sign in with the key; the buttons come back.
- **Answering unblocks names no run:** runs show there only when they were paused on that card by a workflow's owner-decision step, on a machine that answered within five seconds.
- **The portfolio says "That key does not open the portfolio":** the key was revoked, expired, mistyped, or made without `--scope wall:portfolio`. Check it with `agentx token list`; make a new one if needed.
- **The portfolio says "The portfolio is not switched on yet":** this dashboard has no token. Set `dashboard.token` in `agentx.json` and restart the dashboard.
- **The portfolio shows "Untitled request" a lot:** those tasks have no headline yet and no issue or merge request as their home. The text of the task is never used as a title there.
- **Reviews says the intent graph is off:** `graph.enabled` is false in `agentx.json`, so nothing is classified here. Classifications made before it was switched off still show.
- **A decision shows "No reason recorded" or "the graph page (no reviewer recorded)":** it was decided on the classic graph page, which keeps neither. Decisions made with `agentx graph review` or the review tool keep both.
- **No Goal filter, or no goal on a post:** no task names a goal yet. The agent names it when it accepts the task; see [Group requests under a goal](../jobs/open-requests.md#group-requests-under-a-goal).
- **"No progress or cost for this goal":** the machine that keeps the goal's tasks did not answer, or runs a daemon from before this change. Its posts still show. Restart that daemon, then select **Refresh**.
- **A goal counts more tasks than the posts shown:** the Hub lists closed posts of the last seven days only, while the goal counts every task kept for it. Pick the **All** tab to see every post the Hub has.
- **The Org page says "No org chart yet":** no agent has a role in `business.orgChart`. Select **Open the org chart**, then **Edit org** on that page, or see [Draw your org chart](./org.md#draw-your-org-chart).
- **"Could not load the org chart":** the dashboard could not read `agentx.json`. The rest of the Hub still works. Select **Refresh**; if it stays, run `agentx doctor` on the machine that serves the dashboard.
- **The Org page says "Something in the org chart does not hold":** a relation names someone unknown, loops back, or gives a member two bosses. The message names it. Fix it in `agentx.json`; see [Org relations](../reference/config-operations.md).
- **A person is missing from the Org page:** a person gets a card only when a **reports to** or **dotted line** names them. A person an agent only acts for shows on that agent's card as **acts for** *name*.
- **The org chart is cut off on the right:** it is wider than the screen. Scroll it sideways, or select **−** to zoom out.
- **A link from the old home page stopped working:** only `/` changed. Every other address works as before, and an old link to a classic page the Hub replaced opens the matching Hub page.
- **No Settings in the nav, or "Settings are for the owner":** the dashboard does not see you as the owner. Open it on the machine that serves it, or sign in with the dashboard token, then reload. If the page says **This dashboard has no sign-in**, no dashboard token is set: open the dashboard on the machine that serves it, or set `dashboard.token` there first (see [Sign in from another device](../jobs/reverse-proxy.md#sign-in-from-another-device)).
- **Settings says "Only the owner can change settings":** your sign-in ended or the dashboard token changed. Sign in again at `/login`.
- **"Not saved: …" in Settings:** the value was refused, for example an agent id with capitals or no wake word. The form keeps what you typed. Fix it as the message says and select **Save…** again; nothing was written.
- **Save… does nothing:** no field differs from what is saved. A field you changed is blue; if none is, there is nothing to save.
- **A saved change does not show in the agent's work:** a new engine, model or permission mode, and a new or deleted agent, need `agentx daemon restart --when-idle`. Other changes apply from its next run; a run going on finishes as it started.
- **Health shows a dash instead of a number:** that number could not be read just now, for example the token list. Reload the page; the other numbers still hold.
- **"Not handed over: …" in Handovers:** the chat id or the agent is missing, or the date is not one AgentX reads. Fix it and select **Hand over** again.
- **A Settings section says "not on the Hub yet":** that section is still on its classic page. Its button opens it there.
