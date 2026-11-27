# Hub — every task as a post

The Hub is the dashboard's home page, in a space of its own, as the wiki is: its own layout, close to X, with no dashboard top bar. Its colours and type are the same as every other dashboard page and the phone app. It reads like a social feed. Each task a person gave an agent is a **post** by that agent, with its avatar, name and @handle. Under it, the **thread** lists what happened, in order: the runs that worked on it, hand-offs to other agents, plan steps, the questions it asked and how it closed. On the left, every agent is listed once, by what it is doing: **Working**, **Needs you** and **Done today**. Select a working agent to watch its run live, and **⌘K** searches agents and pages. The page takes the rest of the width; there is no side column with Chat and Agents any more. The chat button at the top right of each page asks an agent about what you see (see [Chat on the Hub](./chat.md#chat-on-the-hub)).

The Hub shows the records AgentX already keeps: tasks, plans and run history. Opening a post sends nothing to anyone and changes nothing. You can give an agent a task from the box at the top of the feed (see [Post a task](#post-a-task)), and from an open post you can comment, have its agent call you, start a Space, or close or hand off the request (see [Act on a post](#act-on-a-post)). What waits on you is answered on **Waiting on you** (see [See what waits on you](#see-what-waits-on-you)).

![The Hub in the isolated demo: Running now per machine, filters, and posts](/screenshots/wall/wall.png)

*Scripted demo data; your team's names and machines will differ.*

## Open the Hub

1. **Browser:** open the dashboard. The Hub opens to **Chat** at `/hub`. Select an agent in the row of agent names at the top of the chat to open its conversation, as in the phone app. Slide the row sideways when there are more agents than fit. Close Chat to see the feed. On a phone, use **Back to the page**. A link to a post or another Hub page opens that page directly.
2. The side menu on the left opens with **Search agents and pages** and the list of agents (see [See every agent at a glance](#see-every-agent-at-a-glance)). Each agent is listed once. What waits on you shows once: as the agent list's **Needs you** group, and as **Waiting on you**'s count. For every run of every machine, with the ops details, press **⌘K** and pick **Running now**.

   Under the agents, **Workspace**: **Waiting on you** (what waits on you, to answer there, with its count) and **Jobs**. For the owner, **Settings** is pinned at the very bottom. **Upgrading:** Workflows, Mobile app and some ⌘K pages are hidden after this upgrade; [Settings › Layout](./settings.md#layout) › **Full** brings them back. With the full layout, or their switches on there, **Workflows** and **Mobile app** (how to put the Hub on your phone, see [Put the app on your phone](#put-the-app-on-your-phone)) show there too.

   Every other page is one search away: press **⌘K** (**Ctrl K**) and type its name. The switcher lists them under the agents and requests: **Hub** (open posts), **Waiting on you**, **New post** (the [Creator](#give-an-agent-a-task-on-the-creator-page)), **Jobs**, **Live**, **Projects**, **Activity**, **Running now**, **Schedules**, **Workflows**, **Reviews**, **Events**, **Failures**, **Agents**, **People**, **Org**, **Operations**, **Cost**, **Dashboard** (the classic pages at **Operations**) and the classic **Monitor**, **Org**, **Activity** and **Workflows** pages. The owner also gets **Settings**.
3. On a computer the version shows once, at the right end of the bottom bar; point at it to read its commit (the exact state of the source code it was built from) and since when the daemon runs. On a phone, which has no bottom bar, the version, commit and start time sit under each page's title. **Restart pending** shows at the right of each page's title when the code on disk is newer than the running daemon; hover over the line to read why, and select it to open the Hub's [Live](./live.md#restart-a-machine-when-it-is-idle) page, where **Restart when idle** is on each machine's card. The line refreshes every minute; if an ask fails, it asks again after 5, 10, 20 and 40 seconds. The dashboard keeps the daemon's last answer, so when the daemon is slow to answer, that answer still shows, marked **as of** its time; on a computer, point at the version in the bottom bar to read the same **as of**. See [See which version is running](index.md#see-which-version-is-running).

   ![The Hub's title row: Hub, the Feed and List switch, and on the right the version, commit, since when, and Restart pending](/screenshots/wall/build-line.png)

4. The Hub never pings you on its own. The classic pages that still hold something the Hub does not have yet, **Monitor**, **Org**, **Activity** and **Workflows**, are in the **⌘K** switcher as **Dashboard ·** *page*. [Live](#live-sessions), [People](./people.md), [Cost](#see-what-the-fleet-costs), [Workflows](#see-your-workflows), [Settings](#change-settings) and the workflow editor are Hub pages, and old links to their classic pages open them here. The classic Workflows page stays for **Follow-ups** and the full history of each run.
5. **Theme**, in the bottom status bar (see [Read the bottom status bar](#read-the-bottom-status-bar)), switches between light and dark. On a phone, which has no status bar, **Light / dark** is at the bottom of the menu, under **Settings**. The choice is shared with the other dashboard pages and the phone app on the same browser; until you pick one, it follows your system. A choice made on the Hub before this change is kept.

   **Keyboard and motion:** press Tab to move through the page; whatever has the focus gets a soft blue ring. With reduced motion turned on in your system, nothing slides or fades and spinners stand still; the words next to them still say what is running.
6. **Phone (640 pixels wide or less):** Chat opens first. Use **Back to the page** to reach the feed. There is no bottom bar: the top bar has the menu button on the left, the page title, then search and chat on the right. Tap the menu button to open the same side menu as on a computer, sliding in from the left over the page. Tap **X**, tap the dimmed page beside it, or press Escape to close it; picking an agent or a page closes it too. Every other page is in search, as on a computer. The build line sits under each page's title.

   ![The side menu open on a phone: search, the agents by state, Workspace, then Settings and Light / dark](/screenshots/hub-sidemenu/phone-sheet.png)

   ![The same menu in dark mode](/screenshots/hub-sidemenu/phone-sheet-dark.png)

7. **Tablet or narrow window (641 to 1180 pixels wide):** the side menu becomes a narrow column of icons. It still lists every agent, as its initials with a small state icon (the same icons as in the full menu), in the same order, then **Waiting on you**, **Jobs** and **Settings**. Point at an icon to read its name, its state and its line. The button at the top of the column opens the full menu over the page.

   ![The icon column at 1180 pixels: search, the agents with their state icons, then Waiting on you and Jobs](/screenshots/hub-sidemenu/rail.png)

![Mockup take B (left, post text blurred) next to the Hub as built](/screenshots/wall/compare-desktop.png)

## Try the simple shell (new version of the Hub)

The Hub is being rebuilt page by page (the setting `dashboard.hub.react`, on by default, see [Configuration › Operations](../reference/config-operations.md)). With it on and the simple layout (the default, see [Settings › Layout](./settings.md#layout)), `/hub` opens on the **simple shell**: three columns, for the owner.

![The simple shell on a computer: the side menu, the chat with the agent in view, and the Files tab on the right](/screenshots/hub-shell/simple.png)

*Demo data; your agents will differ.*

1. **Browser:** open `/hub`. A fresh install opens here with no setting. If `dashboard.hub.react` is `false`, open `/hub?react=1` (once). The shell's own address is `/hub#page=home`.
2. **Left, the side menu:** **Search** at the top narrows the menu and the agent list as you type; **Enter** opens the first match. **⌘K** (**Ctrl K**) still opens the Hub's jump box on a computer. Then **Tasks** (see [Tasks: List or Kanban](#tasks-list-or-kanban) below), **Automations** (see [Automations](#automations) below), **Agents** (select one to chat with it), **Projects** (see [Projects in the shell](#projects-in-the-shell) below) and **Waiting on you** (see [Waiting on you in the shell](#waiting-on-you-in-the-shell) below). **Settings** is at the bottom.
3. **Centre, the chat:** the agent in view's newest conversation. The box at the bottom is the same card as in the old Hub chat: **To** and the agent's name on top, then your message, then **+** to attach files (or paste or drop them, five at most), the model, the mic, and the blue arrow to send. Press **Enter** or the arrow to send; **Shift Enter** starts a new line. For a Claude Code agent the model is a menu: the agent's own model, or **Opus**, **Sonnet** or **Haiku** for this message; a Codex CLI agent's menu lists the Codex models (such as `gpt-6.2-sol`); other agents show their own model. The mic records a voice message and sends it when you stop; the pencil next to it (**Check before sending**) puts the words in the box for you to send instead. The answer to a voice message is said aloud. The machine shows under the box. The answer shows word by word under **Working…** as the agent writes it, formatted as on the Task page: bold, lists, tables and code. When the run ends, the saved answer takes its place.

   **Check it worked:** ask an agent for a long answer, for example "List ten things you can do, with a short line each". Words appear within a few seconds, before the run ends, and **bold** words show bold, with no asterisks.

   **If something is wrong:** if the whole answer lands at once at the end, the browser could not open the run's live output (a machine that does not answer, or a proxy that holds streams back); the answer still shows when the run ends. Reload the page and try again, and check that the machine shows as reachable in the side menu.
4. **Right, the tabs:** the files of the chat in view, in three tabs.
   - **Run artifacts** (always first): what the agent's current run writes, edits or sends. While the run works, each new file shows as soon as the agent touches it, under **Running**. **Files it only read** opens the files it read. **Other runs in this chat** lists the chat's earlier runs by what you asked; pick one to see its files, and **Current run** brings you back. Select a file to see what the run changed in it.
   - **Project**: the files of the Git repository (GitHub or GitLab) the agent works in, found from the files its runs touch. The tab is hidden when the agent works in no repository.
   - **Workspace**: the agent's workspace, one folder at a time.

   Project and Workspace are read only. Files and folders whose name starts with a dot (`.git`, `.github`, `.claude`, ...), `node_modules` and files that usually hold secrets are never listed.

   **Check it worked:** ask an agent to write a short file, for example "Write a file notes/hello.md with one line". While it works, **hello.md** appears under **Run artifacts** with **wrote**. Pick an earlier run under **Other runs in this chat**: the list changes to that run's files.

   **If something is wrong:** if **Run artifacts** stays on **Nothing yet** until the run ends, the browser could not open the run's live output; the files still show when the run ends (press the reload button at the top right of the tabs). If **Project** is missing, the agent's runs touched no file inside a Git repository and its workspace is not one.
5. **Items you switch on** in [Settings › Layout](./settings.md#layout), such as **Workflows**, **Wiki**, **Mobile app**, **Activity**, **Org**, **Sessions** and **Usage**, show under **More** in the side menu. Switch one on, go back to `/hub#page=home`, and it is there, with no restart and no reload. The full layout shows them all:

   ![The simple shell with the full layout: More lists Mobile app, Workflows, Wiki, Activity, Org, Sessions and Usage](/screenshots/hub-shell/full.png)

   **Your own menu:** once you save a change in **Settings › Menu**, the side menu shows that menu instead, in your order, with your names, group headers, saved views and links (links open in a new tab). **Search agents and pages** and the agent list stay at the top. A page you take out of the menu is not gone: type its name in the search and it shows under **Other pages**. The Hub feed is **Tasks** there, and **Schedules** is **Automations**. The menu is the owner's: anyone else who opens the Hub sees the default list, without your links. Until you first save, nothing changes.

6. **Phone:** the chat takes the screen. The menu button at the top left opens the side menu; the panel button at the top right opens the files tabs.

   ![The simple shell on a phone](/screenshots/hub-shell/simple-phone.png)
   ![The side menu open on a phone](/screenshots/hub-shell/simple-phone-menu.png)

**Tasks**, **Automations**, **Projects** and **Waiting on you** open in the shell's centre. Every other menu item opens today's Hub page for it. The logo, **AgentX**, brings you back to the shell.

### Tasks: List or Kanban

**Tasks** lists two things together. Its address is `/hub#page=home&pane=tasks`.

- **Issues and pull requests:** the open issues and open pull (merge) requests of your GitHub repositories and GitLab projects. The repositories are the ones in your settings: `channels.github.routes` (each `repo`), `channels.gitlab.routes` (each `project`) and your GitLab boards. GitHub is read with the `gh` login of the user that runs AgentX, GitLab with the GitLab channel's token. No new sign-in. Each one opens on GitHub or GitLab, in a new tab. Jira is not listed yet.
- **Requests:** the requests you gave your agents, open ones and the ones closed in the last 7 days, from every connected machine (the posts of the old Hub's feed). A request whose home is one of those issues or pull requests stands for it, so it shows once.

An icon says which is which: a dot in a circle for an issue, the pull request icon for a pull request, the robot for a request. The issues and pull requests are read again at most once a minute.

![Tasks as a list, grouped by state: To do, In progress, In review, Waiting on others, Needs attention, Closed](/screenshots/hub-tasks/list.png)

*Demo data; your tasks will differ.*

1. **Browser:** in the simple shell, select **Tasks** in the side menu.
2. **List or Kanban:** the switch at the bottom of the side menu (on a phone, at the top of Tasks) changes the view. This browser remembers your choice.
3. **Project:** the box at the top of Tasks shows one project's tasks only; **All projects** shows them all again. The project is in the address (`&project=<name>`), so Back and a shared link keep it.

   ![Tasks for one project, picked in the box at the top](/screenshots/hub-automations/tasks-project.png)

4. **The columns:**
   - **To do:** an open issue nobody is assigned to.
   - **In progress:** a request being worked on, an issue someone is assigned to, a draft pull request, or one sent back with changes asked.
   - **In review:** a request that waits for your answer or approval, and an open pull request waiting for its review.
   - **Waiting on others**, **Needs attention:** the request states of the same name.
   - **Closed:** requests done, declined or dropped in the last 7 days.

   A GitLab board label decides first: `Status::Doing` is In progress, `Status::Review` In review, `Status::On Hold` Waiting on others. Each task shows who has it (for an issue with nobody assigned, who opened it), its project (with the issue or pull request number) and how long ago it last moved.

   ![Tasks as a Kanban, one column per state](/screenshots/hub-tasks/kanban.png)

5. **Open a task:** select it. An issue or pull request opens on its forge. For a request, its timeline opens in the centre: what was asked, its runs, hand-offs and comments. **Full record** opens the old Hub's page for it, with its actions (comment, hand over, close). The arrow at the top goes back to the list.

   ![An opened task with its timeline](/screenshots/hub-tasks/open.png)

6. **Phone:** the list and the board fill the screen; the board scrolls sideways. The List and Kanban buttons are icons only, next to the project box.

   ![Tasks as a list on a phone](/screenshots/hub-tasks/list-phone.png)
   ![Tasks as a Kanban on a phone](/screenshots/hub-tasks/kanban-phone.png)
   ![Tasks for one project on a phone](/screenshots/hub-automations/tasks-project-phone.png)

Tasks only shows: moving a card does not change a task's state. Close or hand over a task from its **Full record**.

### Check Tasks worked

- Ask an agent something that leaves work open (for example a task it hands to another agent). Within 30 seconds it is under **In progress** in Tasks.
- Open an issue on one of your GitHub repositories. Within about a minute it is under **To do**, with the issue icon.
- Pick **Kanban**, reload the page: Tasks opens as a Kanban again.

### If Tasks is wrong

- **Could not read the tasks:** nothing could be read yet: the dashboard could not reach the daemon, or your sign-in ended. Select **Try again**; check the daemon runs (**Terminal:** `agentx daemon status`).
- **Could not refresh** above the tasks: the last read failed. The tasks shown are the ones read before; they are read again within 30 seconds, or select **Try again**.
- **Not read: owner/repo (why)** above the tasks: that repository or project could not be read. For GitHub, check `gh auth status` as the user that runs AgentX, and that the login can see the repository. For GitLab, check the GitLab channel's token can read the project. The last issues read for it stay shown. Issues and pull requests are read apart: a repository with Issues turned off still shows its pull requests, and is not named here.
- **No issues or pull requests:** the repository is not in `channels.github.routes`, `channels.gitlab.routes` or a GitLab board (a `*` route is not listed), or it has none open.
- **No tasks:** no open issue or pull request, and nothing asked that left work behind. A question an agent answers at once is not a task.
- **A task is missing:** a machine that does not answer is left out until it answers. The old Hub's feed (`/hub#status=open`) shows the same tasks.
- **Task not found** after opening a link: it was closed more than 7 days ago, or its machine is not answering.
- **No tasks in a project:** none of that project's tasks moved in the last 7 days. Select **All projects**. A task with no project shows under **All projects** only.

### Automations

**Automations** lists what runs on its own on every connected machine: the scheduled jobs, and the workflows a schedule or an event starts. It reads what the old Hub's **Schedules** page reads. Its address is `/hub#page=home&pane=automations`.

![Automations: per machine, each job and workflow with its next run, its last result and its last seven runs](/screenshots/hub-automations/automations.png)

*Demo data; your schedules will differ.*

1. **Browser:** in the simple shell, select **Automations** in the side menu.
2. **The figures** at the top: how many are on, how many are failing (last run failed, or several failures in a row), how many look stale.
3. **Each machine** has its own table. A row shows the name and its agent, what it is for (or the first line of its last failure, in red), **Next run** (`off` for one that is off, `on event` for a workflow an event starts), **Last result** and **Last 7**: one square per run, oldest first, green for worked, red for failed or timed out, grey for an empty slot.
4. **The badge** at the end, first match wins: **Off** (or **Quarantined**) for one that is off, whatever else it shows; **Last run failed**; **Failing** (failed several times in a row); **Looks stale** (overdue: no run since its schedule should have fired, or dormant: ran the week before, silent the last one); **Not run yet** for a new job with no run so far; else **On**. The reason is under the name, and under **Notes** when you open the row.
5. **Select a row** to open it: its schedule and time zone (or the event that starts it), whether it is a job or a workflow, its project, and what its last run said.

   ![A job opened: its schedule, kind and last run](/screenshots/hub-automations/automations-open.png)

6. **Phone:** the name and the badge only; open a row for the rest, its last seven runs included.

   ![Automations on a phone](/screenshots/hub-automations/automations-phone.png)

Automations only shows. To add, change or turn off a schedule, use [Settings › Schedules](#add-or-remove-a-schedule). Sensors, host jobs and the day's totals stay on the old **Schedules** page; the link is at the bottom of Automations.

### Check Automations worked

- Every schedule in Settings › Schedules is in Automations, under its machine.
- After a job runs, its **Last result** and its last square change within 30 seconds.

### If Automations is wrong

- **Could not read the automations:** the dashboard could not reach the daemon, or your sign-in ended. Select **Try again**; check the daemon runs (**Terminal:** `agentx daemon status`).
- **Nothing runs on its own yet:** no machine has a schedule, and no workflow starts on a schedule or an event.
- **A machine says "does not answer":** it is off or out of reach. Its automations show again when it answers. **checking…** means it is slow; the page asks again every 2 seconds.
- **No Last 7 squares:** the machine runs an older AgentX that does not report its runs this way. Update it.

### Waiting on you in the shell

**Waiting on you** lists what waits on you: decisions and approvals your agents asked for, and requests whose agent asked you a question. It is the same list, with the same count, as **Waiting on you** in the old Hub, the phone app's Desk and the daily digest. The one waiting longest is at the top. Its address is `/hub#page=home&pane=waiting`.

![Waiting on you: each item with its kind, its question, who asked and how long ago](/screenshots/hub-automations/waiting.png)

*Demo data; your items will differ.*

1. **Browser:** in the simple shell, select **Waiting on you** in the side menu.
2. **Each row** shows the kind (Decision, Request, Schedule, Memory and so on), the title, the question, the agent and how long ago it asked. **Answer today** marks one that expires within a day: after that its default applies without you.
3. **Select an item** to open it: the question, the choices, what is known, what the agent suggests, what **Yes** and **No** do, and when to answer by.

   ![An opened decision: the question, what Yes and No do, and when to answer by](/screenshots/hub-automations/waiting-open.png)

4. **Answer** opens **Waiting on you** in the old Hub, where you give Yes, No, a choice or Later. For a request, **Open the task** opens it in Tasks.
5. **Phone:** the list and the opened item fill the screen.

   ![Waiting on you on a phone](/screenshots/hub-automations/waiting-phone.png)
   ![An opened item with choices on a phone](/screenshots/hub-automations/waiting-open-phone.png)

What you put off with **Later** is not listed; the line under the list counts it and links to it in the old Hub's Waiting on you.

### Check Waiting on you worked

- The number next to **Waiting on you** matches the **Waiting on you** count in the old Hub and the phone app's Desk.
- Answer an item in the old Hub's Waiting on you, then come back: within 15 seconds it is gone from the list.

### If Waiting on you is wrong

- **Could not read what waits on you:** the dashboard could not reach the daemon, or your sign-in ended. Select **Try again**.
- **A yellow line above the list:** one source could not be read (for example the requests). The list may be short until it can; the line says which.
- **No longer waiting** after opening a link: it was answered, put off, or it expired.

### Projects in the shell

**Projects** lists your projects, each with its open, in progress, blocked and stalled tasks across every machine, and its worst state: **Stalled**, **Blocked**, **Moving** or **No open work**. Tasks no project claims are under **Other**, last. Its address is `/hub#page=home&pane=projects`. It reads the same [project list](#see-every-project-at-once) as the old Hub's Projects page.

1. **Browser:** in the simple shell, select **Projects** in the side menu.
2. **Select a project** to open **Tasks** with that project picked.
3. **Add a project** (owner only): select **Add project**. Give its **Name**, then its **Repos** (`group/project` on GitLab or GitHub, comma separated), its **Agents**, or both. Select **Add project**. It is added to `dashboard.wall.projects` in `agentx.json` and the daemon reloads its settings.
4. **Phone:** the list fills the screen and shows each project's open count next to its name.

With no project yet, the page says how a project is made and shows **Add project**.

### Check Projects worked

1. Add a project with a repo that has open issues or requests: within 30 seconds it is listed with its open count, and `agentx.json` has it under `dashboard.wall.projects`.
2. Select it: **Tasks** opens with the project in the box at the top.

### If Projects is wrong

- **Could not read the projects:** the dashboard could not reach the daemon, or your sign-in ended. Select **Try again**.
- **No Add project button:** you are not signed in as the owner.
- **"A project named … already exists":** pick another name, or change that project in `agentx.json`.
- **"… is not a repo":** write the repo as `group/project`, as in its address on GitLab or GitHub.
- **The new project shows 0 open:** no open task names its repo or agents yet. A task belongs to the first project that names its home repo, else its agent.

### Check the simple shell worked

- `/hub` as the owner opens on three columns, and the address ends in `#page=home`.
- In Settings › Layout, turn **Workflows page** on, then open `/hub#page=home`: **Workflows** is under **More**.
- Select an agent in the side menu: the box at the bottom reads **To** and the agent's name, with **+**, the model, the mic and a blue arrow.

### If the simple shell is wrong

- **`/hub` opens the old Hub:** the layout is **Full** (pick **Simple** in Settings › Layout), you are not the owner (the shell is the owner's), or `dashboard.hub.react` is `false`. `/hub#page=home` opens the shell in any layout.
- **The shell looks broken:** open `/hub?legacy=1` for the old version, or add `"home"` to `dashboard.hub.legacyPages`.
- **No agents in the menu:** the dashboard could not reach the daemon. Check that it runs (**Terminal:** `agentx daemon status`).
- **No mic in the box:** the browser gives no microphone to the page (it needs `https` or `localhost`) or has no recorder. Typing and files still work.
- **A file shows "Not attached":** the machine that runs the agent refused or did not answer the upload; the reason is in brackets. Try again, or send the message without it.

## See every agent at a glance

The side menu lists every agent of every connected machine once, by what it is doing. One click opens a working agent's live run, or any other agent's chat. It changes by itself every 2 seconds, in place: nothing jumps, and a menu you opened stays open.

![The full side menu at 1440 pixels: search, the agents under Needs you and Working, the folded groups, Workspace and Settings](/screenshots/hub-sidemenu/side-menu.png)

1. **Browser:** open the Hub. On a screen wider than 1180 pixels the full menu shows; on a narrower one it is the icon column or, on a phone, the menu button (see [Open the Hub](#open-the-hub)).
2. There are no filter chips: the groups are the filter.
3. The agents are grouped, what needs you first:
   - **Needs you**: nothing running, and it asked you something, or its last run today failed. The row shows its oldest question, or **Run failed:** and the reason, with a red failed icon. It starts open, with its count on the heading, and shows its first 3 agents and **Show all (N)**.
   - **Working**: a run is going. The row shows the title of its newest run next to a turning spinner. With reduced motion turned on in your system, the spinner stands still. A voice call's turn starts with **Voice ·**. Each agent is listed once. When it has more than one run going, its other runs are listed under its row, newest first, each with where it came from (**Voice**, **Agent to agent**, **GitLab** and so on) and its title: the first 3, then how many more. Select one to open that run live. Only agents of machines that answer count as working. While a machine is slow or answers with an error, its agents stay in the list but never under **Working**. When agents work on more than one machine, **Working** groups them under each machine's name with its count, as **At work now** does. The same count is used everywhere else: the **agents running** count in the status bar, **Running now** in the side menu and **running now** on the Live page. **Working** shows its first 3 agents and **Show all (N)**; select it to see every one, and **Show fewer** to go back.
   - **Done today**: its last run ended today. The row shows the first line of its last answer. It starts folded.
   - **Not working today**, folded at the end: every other agent.

   Every group folds: select its heading (the arrow, the name and the count) to open or close it. The arrow points right when the group is folded and turns down when it is open; with reduced motion turned on in your system, it does not turn smoothly. The folding sections on the Hub's other pages use the same arrow. The first time, **Needs you** and **Working** are open and the others are folded. The Hub remembers in this browser which groups you opened or closed and whether a group shows all its agents, also after a reload. **Reset layout** in Settings › Layout puts them back.
4. Each row has two lines. The first: the agent's initials in a grey square, its name, its counts and how long ago it last moved (point at it for the full date and time). The second: a state icon and its line, and an amber number when it has questions for you. The state icons are the same on every page: a turning spinner for **Working**, an amber circle with **!** for **Needs you**, a red circle with **×** for **Failed**, a green tick for **Done** and an empty grey circle for **Not working today**. The counts sit next to the name: a pulse line with how many of its own runs are going now (a worker a run started counts on its own agent's row) and a clock with how many runs it started today, since your midnight, the ones still going included. A count of 0 is left out. Point at the counts to read them in words. Finished runs today are counted by the hour, so a run that ended up to an hour before midnight can still count. The agent whose chat is open has a grey background. On a phone the counts are left out so the name has room.

   A **Needs you** row says its numbers in words instead: **3 for you** on the right (how many questions it has for you), and a third line, **asked 40m**, for how long its oldest question has waited. Its run counts and its last move are left out there. Its second line is its oldest question.
5. Point at a row (on a phone they always show) for **Stop** on a working agent and **⋯** for the row's menu, for example **Open chat**, **Open live run** and **Copy agent ID**.
6. The whole side menu scrolls as one, so the last agent is always in reach; **Search agents and pages** stays at the top and **Settings** stays at the bottom.
7. Select a row to open it:
   - A **Working** row opens the run it is on, live: what it was asked, its steps as they come, **Send** and **Stop**. This works for a run from any channel (Telegram, a request, a scheduled job, another agent), not only one you started in the Hub chat.
   - A **Needs you** row opens that agent's questions for you (see [Answer an agent's questions](#answer-an-agents-questions)).
   - Any other row opens that agent's chat, with its latest conversation. If the run ended a moment before you selected the row, its chat opens too.

### Answer an agent's questions

When an agent waits on you, selecting its row in **Needs you** opens its questions above its chat, so you see what it asks, not an older conversation about something else.

![Coder's three questions: the oldest open, with what is known, what Yes and No do, and Yes, No and Later](/screenshots/hub-needs/open.png)

*Demo data; your questions will differ.*

1. **Browser:** in the side menu, select an agent under **Needs you**.
2. The line at the top says how many questions it has for you, oldest first. The oldest is open: the question, what is known, what it suggests, what **Yes** and **No** do, and when to answer by. The others are listed under it, each with how long ago it was asked; select one to open it.
3. **Yes** or **No** (or pick a choice, then **Answer**) shows a line that says what will be sent. Select **Confirm** to send it, or **Back**. The question leaves the list, the next one opens, and the count on the agent's row goes down at once. After the last one, the row leaves **Needs you**.

   ![After answering the first: two left, the pricing question open with its three choices, and 2 for you on the row](/screenshots/hub-needs/after.png)

4. **Later** folds the question and opens the next one. It stays in the list.
5. A request that waits on your reply has **Open the task to reply**, which opens it in Tasks.
6. **Whole chat** shows the agent's conversation under the questions; **Hide the chat** folds it again. The box at the bottom writes to the agent's chat, as always.
7. **Phone:** the questions fill the screen above the box.

   ![An agent's questions on a phone](/screenshots/hub-needs/phone.png)

In the old Hub, the row opens the agent's chat with its first question named in the address (`ask=`), and **Working on** names the request of that question, as one link, with no list to pick from. A question that is on no request (a draft, for example) leaves **Working on** out. At the end of the chat, the agent's questions are listed, the one the row opened last, next to the writing box. A Desk card has its buttons there; a request has **Reply in Waiting on you** and **See the request**; anything else has **Answer in Waiting on you**.

**Check it worked:** select a **Needs you** row whose question is a request. The address still ends in `ask=request…`, **Working on** names that request, and its question is the last one above the writing box. The row's **3 for you** stays whole while the row is selected, at 1280 pixels and wider.

### See where the work runs: Machines

The agent list shows *who* is working. **Machines**, under it, shows *where*: each machine and the runs going on it now.

1. **Browser:** on a screen at least 1181 pixels wide, select **Machines** under the agent list. It starts folded, with the number of agents working on its heading. The Hub remembers whether you left it open.
2. **Your mesh** comes first, with how many of its machines answer (for example **3/4**) and how many agents are working. Under it, every machine is listed, even when nothing runs on it.
3. Under each machine, one row for each run going now: its title, the agent, the model and how long ago it last moved. A run started by a schedule says **Job:** before its name. The hand-offs and workflows a run started are listed under it. A hand-off whose run is going is one line that points to it, for example **→ Tester on Workshop**: the run itself is listed under its own machine. Select a row to open that run live.
4. A machine that is slow keeps its last rows and its number, with **as of** and the time, and still counts in **3/4**. A slow machine with no answer yet says **checking…**. A machine that does not answer says **not checked**, and its runs are not shown.
5. An agent is shown on one machine only, and the machines' numbers add up to **Working** in the agent list.

Idle agents and the work that finished are not in **Machines**: they are in the agent list (**Done today**, **Not working today**) and on Activity.

### Search agents and pages

1. Press **⌘K** (**Ctrl K** on Windows and Linux), or select **Search agents and pages** at the top of the side menu (on a phone, the search button in the top bar). The box opens in the middle of the page, above everything on it, the side menu and the chat button included, with no animation.

   ![The search box: agents with their state icons and shortcuts, then requests, and the keys at the bottom](/screenshots/hub-sidemenu/search.png)

2. Type part of a name, words of a request or a page name. Agents come first: those whose name starts with the words, then those whose name or line has them. Up to five open requests follow, then the pages, each with its icon. With nothing typed, the agents that need you are first.
3. Use **↑** and **↓**, then **Enter**, or select a row. A working agent opens its live run, any other agent its chat, with its history; a request opens its post. **Esc** closes it.
4. **⌘1** to **⌘9** (or **Alt 1** to **Alt 9**) open the agents in the switcher's order, also with it closed. **Ctrl Tab** goes back to the last agent you had open; in a browser tab, the browser keeps that key, so use it in the AgentX app window.

**If something is wrong:** the box shows only after you press **⌘K** or select **Search agents and pages**. If an empty box covers the page as soon as it opens, and nothing under it can be selected, the dashboard runs a version before 0.286.0, where the closed box still took every click. Upgrade AgentX, then reload the page.

**Check it worked:** start a task for an agent. Within a few seconds it moves to **Working** with a turning spinner, and **Working**'s count goes up by one. Select its row: its run opens in the middle and its output streams in as it works. While it works, call it by voice: within a few seconds its row reads **Voice ·** and what you said, and its earlier run moves to a line under the row. Select either to open that run. Ask an agent to ask you something: it moves to **Needs you** with a blue **1**.

**If something is wrong:** if the list says **Could not reach the machines just now**, the dashboard cannot read the live view; open **Running now**, which says which machine fails. An agent on a machine that does not answer is left out until it answers; a note at the top of the list names the machine, with a link to **Running now**. On a narrow window the list is the icon column: point at an icon for its name, or select the button at the top of the column for the full menu.

## Read states, counts and empty lists

Every Hub page and the phone app show the same few things in the same way, so you read them once:

- **State:** a small dot and a word at the end of a row. Blue **Running**, green **Done**, amber **Waiting**, red **Failed**. Grey means idle, off or not started. Workflow steps, workers, machines, agent cards and the phone's Desk and Fleet use it.
- **Count:** a small grey number beside a heading or tab, amber when it is waiting on you. A count of 0 is not shown.
- **Loading:** a turning eight-ray mark with what is loading, or grey bars shaped like the rows that are coming.
- **Empty list:** a short title, one line, and the button that gets you going, such as **Open Jobs**, **New workflow**, **Set up an agent** or **Reload**.

The look is adapted from the free [affectUI](https://github.com/flohoeller/affectui) items (MIT) and uses the AgentX colours in light and dark.

The icons in the new version of the Hub come from the free [Lucide](https://lucide.dev) set (ISC licence). The classic Hub page is moving to the same icons, so one thing has one icon on both.

### Check the look worked

Open **Workflows** and open a run: each step is one line with its state word at the end. Open **Live** with nothing running: you see **No session or job is running** and **Open Jobs**.

### If the look is wrong

- **A page still shows its old spinner or a "Loading…" line:** the Hub page is cached by the browser. Reload it.
- **Dots have no colour in dark mode:** the page was opened before the daemon was upgraded. Reload it.

## Put the app on your phone

Select **Mobile app** at the bottom of the nav (with the simple layout, turn **Mobile app page** on in [Settings › Layout](./settings.md#layout) first, or open `/hub#page=mobile`). In the simple shell it opens in the centre, at `/hub#page=home&pane=mobile`, under **More**. The page says what the phone app does and how to install it in five steps: Tailscale on both devices, two `tailscale serve` commands, `agentx app pair --name "My phone"`, scan the QR code, add it to the home screen. Each command has a **Copy** button. Beside the steps (above them in a narrow window), a phone leans slowly and shows the phone app's Chat, Desk, Fleet and Alerts in turn; with reduced motion on, it stays still on Chat. The full guide is [Phone app](./mobile-app.md).

![The Hub's Mobile app page with setup steps in a demo instance](/screenshots/wall/mobile-page.png)

## Read the bottom status bar

On a desktop screen, the thin bar at the bottom shows, each with its icon: whether the Hub is **Connected** to the daemon (**Connecting…**, **Reconnecting…** or **Offline** otherwise), the machines it reads, how many agents are running, an item for each engine your agents use now (**Claude**, **Codex**, and **API**, **Orchestrator** or **OpenCode** for agents billed per token), and on the right **Accounts** (see [Switch the Claude Code or Codex account](#switch-the-claude-code-or-codex-account-for-new-runs)), **CLI**, **Theme** (light or dark) and the AgentX version. The version appears once the daemon has reported it, usually at once and at most a few seconds after the page opens. On a phone, the navigation bar occupies the bottom edge, so this status bar is hidden. Up to 1180 pixels wide the bar stays on one line: Theme is its icon, the engines keep their logo and bars without their names, the agents count reads **3 running**, **CLI** shortens with **…**, and **Accounts** is just its name (point at it for the full text).

### See plan usage and the agents from the status bar

An engine gets an item while at least one agent runs on it. A plan (**Claude**, **Codex**) also keeps its item while this machine has a reading of it, even with no agent on it. A plan engine's item shows a small bar, the percent used and when the window resets (for example **wk 26% resets Wed 05:00**) for the five-hour window (**5h**) and the week (**wk**) of the account new runs use. Up to 1180 pixels wide the reset time is left out; it is still in the drop-down. Claude's numbers come from the daemon's own reading, the same one as `/usage/plan`; Codex's come from the limits Codex wrote after its last run on this machine. An engine billed per token (**API**, **Orchestrator**, **OpenCode**) has no plan limit: its item shows what its agents' runs on this machine cost today (since 00:00 UTC), the same numbers as the **Cost** page. The bar refreshes them once a minute, and not while the Hub's tab is hidden. When the daemon is busy and does not answer in time, the bar keeps its last answer for up to 15 minutes, and a read that brings nothing is tried again after 10 seconds (three times), so a restart does not leave the bar empty for a minute.

1. Point at an engine in the bottom bar (or select it, on a touch screen or with the keyboard). A drop-down opens with one bar per limit window, its reset time, when it was read, and the agents that use the engine. When you added more accounts for that engine under **Accounts**, the drop-down has a section for each account with its own bars; the one new runs use comes first, marked **In use**. For an engine billed per token, the drop-down says **No plan limit**, gives **Spent today** and each agent's share, and links to **Cost**.
2. Select **Add account** at the bottom of a Claude or Codex drop-down to add another account for that engine (owner only). It opens the **Accounts** form at that engine's row.
3. Point at **agents running**. A drop-down lists every agent with its state (**Working**, **Needs you**, **Done today**, **Idle** or **Paused**), its engine's logo and its quick actions: **Chat**, **Open run** (while it runs a task), **Pause** or **Resume** new work (owner only) and **Stop run**, which asks first.
4. Press **Escape**, or select anywhere else, to close a drop-down.

**Check it worked:** the engine item shows its bars, and its drop-down says when it was read, for example **Read 2 min ago** or **As of the last Codex run on this machine, 1 h ago**. When the account in use is near a limit (70% or more) the item turns amber, and red at 90% or when a run reported the limit reached.

**If something is wrong:** a window with no number, or one that has reset since it was read, is left out until a new reading arrives; the bar never guesses. When a run reported only that a limit was reached or is near, the drop-down says **Limit reached** or **Near the limit** with the reset time, and the item shows a red or amber dot instead of a bar. No Codex bars: no Codex run has finished on this machine yet, or Codex is signed in with an API key, which has no plan limit. No Claude bars: the drop-down says why. **Plan usage not read: the Claude login on this machine has run out** means open `claude` in a terminal and run `/login`. **Plan usage not read yet: Claude's usage service asked to wait** clears by itself, usually within an hour. The daemon reads the Claude Code sign-in that runs out last, so an old sign-in left in the Mac's keychain no longer hides a fresh one. An added account that says **Signed out** needs its own sign-in: `CLAUDE_CONFIG_DIR=<its folder> claude`, then `/login`. Another account's Claude reading is taken at most every 5 minutes, so its bars can take that long to appear. An engine billed per token shows only its name when its agents run on another machine (their spend is kept there) or only on a model with no price, such as a local model.

### Switch the CLI an agent runs on

For the owner only. **CLI** names the agent whose chat is open and the engine it runs on, for example **Claude Code · CX**, with that engine's own logo in front.

1. Select **CLI** in the bottom bar.
2. Pick the agent under **Agent**, if it is not the one in view.
3. Under **Engine**, pick **Claude Code**, **Codex CLI**, **OpenCode**, **Anthropic API (SDK)** or **Orchestrator**, each shown with its own logo, then select **Switch**.

**Check it worked:** the note says **Saved.** *agent***'s next run uses** *engine***.** No restart is needed: the agent's next run uses that engine. A run already going keeps its own, and a busy agent switches when its last run ends. A saved model the new engine cannot run (for example a Claude model after a switch to Codex CLI or OpenCode) is cleared, so the agent uses that engine's default model; set another one in the agent's **Edit**.

**If something is wrong:** **Not switched:** and a reason means nothing was saved; the same change in **Settings**, on the agent's card, shows the full error. No **CLI** button: you are not signed in as the owner, or no machine answered the live view yet.

![The Hub's bottom status bar in a neutral demo](/screenshots/wall/status-bar.png)

## See fleet operations

Select **Operations**, under **Fleet**. The Hub shows the fleet's Operations views in its own page, with the Hub's nav still on the left: **Today's automations**, **Routines** with their flags, the **Mesh feed**, **Activity provenance**, **Nodes**, and **Agents and skills**. The tabs at the top also open **Activity** and **Lifetime** for a history window. Select any row for its details.

The page loads when you first open it, not with the Hub, because Operations checks the fleet every few seconds while it shows. **Open Operations on its own page**, under it, opens the full classic page at `/mesh`. **Light / dark** changes both.

## Switch the Claude Code or Codex account for new runs

If you have more than one Claude Code or Codex account, keep each in its own config folder and choose which one new runs use. Only the owner sees this.

1. **Terminal:** sign in once per folder with the CLI itself. For Claude Code: `CLAUDE_CONFIG_DIR=~/.claude-work claude`, then `/login`. For Codex: `CODEX_HOME=~/.codex-work codex login`. AgentX never reads, copies or stores the token; it stays where the CLI put it.
2. **Browser:** in the Hub's bottom bar, select **Accounts**. Each provider lists **default** (the CLI's own folder, `~/.claude` or `~/.codex`) and the profiles you added.
3. To add a profile, type a name (for example `work`) and its folder, then select **Add**. A folder that does not exist yet says **folder not there yet**: sign in first (step 1).
4. Select a profile's button. The bar says **Accounts · Claude Code: work · Codex: default**, and every Claude Code or Codex process AgentX starts from then on uses that folder. Usage holds are kept per account, so a hold the old account left does not hold runs on the new one.
5. **Remove** deletes a profile from the list, not its folder. If it was in use, new runs go back to **default**.

What stays as it was:
- A run already going, and a chat whose Claude Code session is still open, keep the account they started with. The switch applies from their next new process.
- An agent whose workspace `.env` sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME` keeps its own folder, in one-off runs and in open chats alike.
- The usage numbers in the bar still read the daemon's own Claude Code reading, not the picked profile's.
- Gemini is not listed yet.

The list is kept in `~/.agentx/cli-accounts.json` (names and folders only, readable by your user alone).

### Check the account switch worked

Pick a profile, then start a new task for a Claude Code agent and ask it to run `echo $CLAUDE_CONFIG_DIR`. It prints the profile's folder.

### If the account switch goes wrong

- **The new run asks to sign in, or uses the wrong plan:** that folder has no sign-in yet. Run step 1 for it.
- **No Accounts button:** you are not signed in as the owner, or you are on a phone (the bar is hidden there).
- **An agent ignores the switch:** its workspace `.env` sets the folder itself; remove that line to follow the switch.

## Chat with an agent

1. Select an agent in the Hub to open their chat in the middle pane.
2. Type a message, attach a file, or record a voice message with the microphone. Select the microphone again to stop: the message is sent at once and the chat shows the transcription. To check the words first, turn on the pencil button next to the microphone (**Check before sending**); the words then wait in the box for you to send. The play button (**Hear my message**) plays your last recording back. When you send a voice message, AgentX reads the answer aloud. The box at the bottom says who the message goes to (**To** and the agent's name). Select **+** to attach files, the microphone to record, and the blue arrow (or Enter) to send.
3. To run one message on another model, pick it in the box next to **+**. Agents on the claude-code engine offer Opus, Sonnet and Haiku; agents on the codex-cli engine offer the models Codex CLI lists (such as `gpt-6.2-sol` or `gpt-5.6-luna`); **(own)** is the agent's own model. Other agents run on their own model, and the box shows its name. The choice is kept for that agent in this browser. A model that differs from the conversation's starts a fresh session on it.
4. The reply appears as it is written. Messages and replies show formatting such as bold text and code blocks. Open **Worked for …** to see tool steps and available results. Select **Open the run** during a reply to follow that run on its own page.
5. Switch agents and return to the first agent to see the earlier conversation.
6. When the agent works on an open request, the line under the agents names it: **Working on** and its headline. Select **Changes** to see its pull or merge request, or **Plan** to see its steps, in the [panel on the right](#see-changes-plans-and-files-beside-the-page). When the agent works on more than one, pick one from the list; each entry shows the request's project (its repository when it has no project) and how long ago it last moved. The line is not shown when the agent works on nothing open.

## See changes, plans and files beside the page

The Hub has no fixed column on the right. A panel opens there only when you ask for something to see beside the page, and the page takes the whole width again when you close it.

1. **Browser:** open it in one of these ways:
   - In a chat, select **Changes** or **Plan** on the **Working on** line.
   - On an open post, select **Diff**.
   - In **Changes**, select **File** next to a file's name. The whole file opens as it is on the pull or merge request's last commit, with the lines it adds or changes in green. A removed or binary file has no **File** button.
   - At the top of a chat, or of a run's [Task page](#watch-and-steer-a-run), select **Files**. See [See a run's files](#see-a-runs-files) below.
2. Each thing you open is a tab at the top of the panel. Select a tab to see it again, or its **×** to close it. Select the request's name at the top of a tab to open the request.
3. Close the last tab to give the width back to the page.

On a narrow window the panel slides over the page from the right. On a phone it covers the page, above the bottom bar.

The panel reads the same pull or merge requests, with the same tokens, as the **Diff** view, and line comments in **Changes** work as described in [Comment on the lines of a pull or merge request](#comment-on-the-lines-of-a-pull-or-merge-request). A file longer than 3,000 lines shows its first 3,000.

The top of the chat shows the agent's letter, the computer it runs on and its engine with the engine's own logo, and one state word: **Working** while it answers, **Waiting on you** when it has a question for you, or **Done**. While it works, **Stop** ends the run. **↗ Request** opens the request the agent is on.

1. Select **Plan** to see the steps of the agent's open requests and who has each step. Above the steps, a line shows when the request started, when it last moved, its project (its repository when it has no project, or **no project** when it has neither) and links to its home and **History**. Each step shows how long ago it last moved; a step with no known time shows none.
2. Select **Proofs** to see the steps that are done, each with its proof link.
3. Select **Chat** to go back to the conversation.

When the agent asks you something, the question shows at the end of the chat as a card. Select **Accept** (or one of the answers it offers), **Ask for changes** to write what to change, or **Later** to put it off. The answer is the same as on the Desk: an answered question leaves the Desk too.

### Resize, collapse and expand the side menu and the panel

On a window wider than 1,180 px you can size both side columns, and the Hub remembers what you set in this browser, also after a reload.

1. **Browser:** drag the edge between the side menu and the page, or between the page and the right panel. The menu goes from 200 to 420 px wide. The panel goes from 320 px up to 70% of the window. The page in the middle always keeps at least 480 px: when the window is too narrow for the widths you set, the panel and then the menu are made narrower, and they get their widths back when the window is wide enough again.
2. To collapse the side menu to a column of icons, select the button at its top right. Select it again to expand the menu to its last width.
3. To collapse the right panel, double-click its edge. Its tabs stay open; select the panel button at the top right of the page to bring it back. Opening something new in the panel also brings it back.
4. From the keyboard, select an edge with Tab, then use ← and → to resize it and Enter to collapse or expand it. On a Mac, **⌘B** collapses or expands the side menu and **⌘J** the right panel while it has tabs. Windows and Linux have no shortcut for this, because Ctrl+B and Ctrl+J belong to the browser.

Narrower windows keep the icon menu and the sliding panel, as above.

### Go back to the previous page

Select **‹** at the top left of the page to go back to the page you were on before, and **›** to go forward again. They follow your browser's history in this tab. A post opened from a link, with nothing before it, goes back to the feed. On a phone these buttons are hidden and the post's own **←** goes back to the feed.

### Fold sections and long lists

Long pages start short, and you choose what to open. The Hub remembers your choices in this browser, also after a reload.

1. **Browser:** a heading with **›** and a count folds. Select it to open or close what is under it:
   - **Agents**: one section per machine, with its number of agents.
   - **Settings**: the groups of the menu (Fleet, Access, Machines, Hub), with their number of sections.
   - **Search**: after the search box, the filters are folded under **Filters**. The number next to it says how many filters are in use.
   - **Jobs** and **Desk**: the filter chips fold under **State** (Jobs) or **Kind** (Desk). The heading keeps the chip you picked and its number, for example **State: Open 5**.
   - **Chat**: the row of agents folds under **Agents**, with the number of agents. While it is folded, the **To** list picks the agent.
2. A long list shows its first 3 items and **Show all (N)** under them: the Desk's cards and each machine's agents. Select **Show all (N)** to see every item, and **Show fewer** to go back.
3. **Back** (**‹** or your browser's Back) returns to the page you were on at the place you had scrolled to.

### Reset the layout

1. **Browser:** open **Settings** › **Layout** and select **Reset layout**.
2. The page reloads with the side menu and the right panel at their first widths and expanded, and every section and list folded as the first time. Only this browser is changed.

### Check the folds worked

Fold a section, for example **Fleet** in Settings, and reload the page: it stays folded. Select **Reset layout**: after the reload it is open again.

### If the folds are wrong

A section that will not stay folded means the browser keeps nothing for the page (a private window, or site data blocked); the Hub then starts each page as the first time. Allow site data for the Hub, or use a normal window.

### See a run's files

**Files** shows what a run, or every run of a chat, did to files, and the agent's workspace (the folder it works in). Its tab is always the first one in the panel.

1. **Browser:** at the top of a chat or of a run's Task page, select **Files**. Select it again to close the tab.
2. The first list holds the files the runs changed (**wrote**, **edited**), then the ones they only **read**, the files the agent sent with its answer, and the files you attached. When the run is on a pull or merge request, **PR** opens its **Changes**.
3. Select a changed file: it opens in its own tab with what the run removed in red and added in green. A file the run only read shows its path. Select **Open it as it is now** to see the file in the workspace today.
4. Under **Workspace**, select a folder to open it, and the names in the path above the list to go back up. Select a file: it opens in its own tab with its line numbers.
5. Select **Reload** to read the runs again, for example after a run ends.

The workspace only reads: nothing here changes a file. Only you (the dashboard's owner) can open it. It shows text files of up to 256 KB. It never shows `.git`, `node_modules`, or files that usually hold secrets, such as `.env`, keys and token files. It never follows a link that leads out of the workspace.

## Read a post

The top line of a post is its author: the **owner**, the agent that has the task now, with its avatar, name and @handle, and how long ago the task last moved (`12m`, `3h`, `2d`; point at it for the exact time). A green dot on the avatar means the agent is running something now. The **status** sits on the right of that line.

Under the author line comes the **result**: what the agent delivered or answered. Formatting the agent wrote in Markdown (a text format where `**bold**` shows as **bold** and lines starting with `-` show as a list) is shown as formatting: bold, lists, code, tables and links. Links only open web and mail addresses. It is the task's last run that ended with a reply, with **Answered** and a link to that run. A task closed with no reply shows the proof or reason it was closed with, under **Closed with**. Under the result, select **Request** to open the request it answers: who asked, in which chat, the task id and when. A task with no result yet shows its request as the title, marked **No result yet**. The Hub never takes a result from another task or another chat.

![A post leading with its result, the request one tap under it](/screenshots/wall/result-first.png)

One task shows as one post. When an agent opened the same request more than once (the same agent, the same title, all still open), the feed shows the one that moved last, with **N more posts like this** under its text. Select an id there to open that copy. Closed copies are not folded: they stay in **Done** and **All** as they are.

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

In the feed a post is kept short: the author line with its state on the right, the title, what the agent said in at most two lines, and one row with **Thread**, the runs, the minutes and the project. A post that waits on someone says who, for how long and why in one line. A decision card waiting on you shows as a small card with **Deny** and **Approve**. A task whose last run failed shows the reason and the run id in a red line, with **Retry** (it asks the agent to try again). Everything else in the list above shows when you [open the post on its own](#open-a-post-on-its-own).

The feed puts the posts in groups, in this order: **Needs you** (waiting on you, and failed runs), **Working**, **Waiting**, **Not started**, then **Cancelled** and **Done**, which start folded. Each group shows 3 posts, then **Show all**. Every post has one state, with one icon and one word, the same in the feed, the list and the tabs: **Waiting on you**, **Failed**, **Working** (its icon turns), **Waiting**, **Not started**, **Cancelled** or **Done**.

Point at a post, or move to it with Tab, to see two more buttons at the end of its row: the link button copies the post's address, and **...** opens what else you can do with it: **Hand off to another agent**, **Run on another machine**, **Call me about it**, **Start a Space** and **Close as done**. While a run works on the post, **Stop** is always there.

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

1. **Browser:** select **Waiting on you** in the nav. It lists what waits on you, with the same count as the phone app's Desk and the daily digest. **Waiting**, **Put off** and **Answered** are the tabs, and the chips narrow the list to one kind: Decisions, Schedules, Memory, Wiki, Drafts, Requests and Reviews.
2. On a card with choices, the one the agent advised is already picked. Pick another if you want. The draft and what Yes and No do are folded under the card.
3. Select **Yes**, **No** or **Later** (**Keep** or **Drop** for a memory fact). A line opens that says exactly what is sent; select **Confirm**. The card leaves the list, and its post updates without a reload.
4. A card raised while working on a task is also on that task's post, with the same buttons and confirm.

Each card says what answering it unblocks: the post it was raised on and the runs paused on it. Anyone without the dashboard key sees the same cards read only, under **Needs the owner**. The full steps, with screenshots, are in [Approvals › Answer on the Hub](./approvals.md#answer-on-the-hub). The old Approvals page's address, `/approvals`, opens **Waiting on you**, so old links and bookmarks still work.

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

### Open the new Task page

The Hub is getting one **Task page** per request, in the new look. It shows the same request as the page above, and makes the same calls when you act on it. For now only the owner can open it, by its own address; the old post page keeps its address until the Task page takes its place.

1. **Browser:** copy the task id from the end of a post's address (the part after `#post=`, for example `req-1234`).
2. **Browser:** open `/hub#page=task-preview&id=` followed by that id, for example `/hub#page=task-preview&id=req-1234`.
3. The page shows, from the top:
    - **Task**, the agent that has it, and its state on the right (**Working**, **Waiting on you**, **Done** and so on), then the request as the title and what was asked under it;
    - where it stands: **Asked**, **Working**, **Waits** (only while it waits) and **Done**, as on the old page, with one amber line that says why it waits;
    - **Plan**, with "1 of 3" for how many steps are done: each step with its state, the agent that owns it, what proves it done, and **Proof** when there is one;
    - **Result**: the agent's answer, formatted (bold, lists, code);
    - **Live run** while an agent works on it, and **Past runs**: see [Watch and steer a run](#watch-and-steer-a-run);
    - **Facts**: who asked, the chat, the project, the goal, the times, the run time against the estimate, the machine and the request id;
    - **Links**: its issue or pull request, its proof, and the comments agents posted there;
    - **Thread**: every step of its history, then the comment box.
4. **Browser:** select a section's title (**Plan**, **Facts**, **Thread** and so on) to fold it or open it again.
5. **Browser:** to act on it, use the comment box at the bottom. It does what the old page's box does (see [Act on a post](#act-on-a-post)): **Comment** with the arrow or **Enter**, `@` another agent to bring it in, **Call** the agent, **Hand to…**, **Done** and **Drop**. Hand to, Done and Drop open a line that says what will happen; select **Confirm**, or **Back**. **Start a Space** stays on the old page for now.
6. **Browser:** to go back, select the arrow at the top left, press **Escape**, or use the browser's Back button.

![The new Task page: state, where it stands, the plan with each step's agent and state, the result and the facts](/screenshots/hub-task/task.png)

![The comment box under the thread, with the line that asks to confirm Done](/screenshots/hub-task/task-confirm.png)

![The Task page on a phone](/screenshots/hub-task/task-phone.png)

*Scripted demo data; your team's names and machines will differ.*

#### Check the Task page worked

Open the same request on the old page (`#post=` and its id) and on the Task page. Both show the same title, state, plan steps and thread. Write a comment on the Task page: it shows in its **Thread** within a few seconds, and on the old page too.

#### If the Task page is wrong

- **No task in this address**: the address has no `id=`. Add the request id after `id=`.
- **Could not load the task**: the machine that keeps the request did not answer. Select **Retry**; check that the machine shows as reachable.
- **No request for this run**: the address names a run that nobody tracks as a request; open the run on the run page instead.
- The page opens the old Hub: you are not signed in as the owner, or `dashboard.hub.legacyPages` lists `task-preview` (see [Configuration › Operations](../reference/config-operations.md)).
- The action buttons are missing: only the owner sees **Call**, **Hand to…**, **Done** and **Drop**; Hand to, Done and Drop show only while the request is open.

### Watch and steer a run

The Task page shows the request's runs in place, so you do not need the run page to follow one.

1. **Browser:** open the request's Task page (see [Open the new Task page](#open-the-new-task-page)).
2. While an agent works on it, **Live run** shows the run as a conversation: what was asked on the right, then each step the agent takes (folded to one line; select it to see its input and result), its thinking, and its reply as it is written. **Working** turns at the top right of the section, with the agent's name and when the run started. The run scrolls on its own while you are at its end; scroll up to read and it stays where you are.
3. **Browser:** to steer it, type in the box under the run and press **Enter** (or select the arrow). Your words go in as the run's next turn. The line under the box says what happened: queued as the next turn, sent as a new run of the same chat (that run then shows here), or why it was not sent.
4. **Browser:** to stop it, select the square **Stop** button next to the arrow. The turn ends now; the line under the box says **Stop asked** or why it did not stop.
5. When the run ends, it stays in place with its state (**Done**, **Failed**, **Cancelled**), and the steer box goes away. To ask more, use the comment box at the bottom of the page.
6. **Browser:** **Past runs** lists the request's other runs, newest first: the agent, its state, how long it took, its reply on one line and when it ran. The first three show; select **Show all** for the rest. Select a run to open it in place, read-only: what was asked, each step and the reply. Select it again to fold it. The page's address then ends in `&run=` and the run's id, so a link opens the page with that run open.

#### Check the run panel worked

Give the agent of an open request a task in its chat, then open the request's Task page. **Live run** shows the steps as they come, within a second or two of the run page. Type `Also list what you changed` in the box and press **Enter**: the line under the box says **Queued**, and the run's next turn answers it. When it ends, reload the page: the run is in **Past runs**, and selecting it shows the same steps.

#### If the run panel is wrong

- **No Live run while the agent works**: the run is not linked to this request yet (it shows in **Thread** once it is). Wait for the next refresh (about 15 seconds) or reload the page.
- **Waiting for the first words…** stays: the machine that runs it did not answer the stream. Check that the machine shows as reachable; the page opens the stream again by itself after a drop.
- **Could not read this run** under a past run: the machine that keeps it did not answer, or it no longer keeps the run. Select **Retry**.
- **Failed: cut off** on a past run: the run was still going when its machine restarted, so it has no end.
- **Not sent** or **Not stopped**: the line says why (the run already ended, or the machine is unreachable).

## Post a task

The box at the top of the feed gives an agent a task, as a message to it would.

1. **Browser:** select **Give an agent a task. Type @ to pick who.** at the top of the feed.
2. Type the task. To pick who gets it, put `@` and the agent's id or name in it, for example `@reviewer please check the release notes`, or pick the agent under the box (**Any agent** until you pick one). The first `@` name that is an agent wins over the picker.
3. Press **Enter**, or select the send button (the arrow). **Shift Enter** starts a new line instead. The box empties and says who has it.

   ![The box at the top of the feed, with the agent picker and the send button, in the isolated demo](/screenshots/wall/compose.png)

4. The task opens as a new post by that agent, waiting on nobody. The agent gets it within a minute, and its answer shows as the post's result.

A post goes to the machine the agent runs on. It needs requests turned on on that machine (**Settings**, or `requests.enabled` in `agentx.json`): with them off, the box says so and nothing is sent. Like every other dashboard action, it needs the dashboard token.

### Give an agent a task on the Creator page

The Creator is a longer form of the box at the top of the feed.

1. **Browser:** press **⌘K** (**Ctrl K**) and pick **New post** (on a phone, **More**, then **New post**).
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

These are the same calls as **Waiting on you** makes for a request that waits on you, and the same as `agentx requests done` and `agentx requests drop` in a terminal.

### Comment on the lines of a pull or merge request

When a post's home is a GitHub or GitLab issue, pull request or merge request, its action row has a **Diff** button. Posts with no forge home do not have one.

For a post on an issue, the Hub finds the pull or merge requests of its work: the ones of the same repository or project linked in the request itself (its home, proof, words, notes and the agent's last answer; a link to another repository is left out), the GitHub pull requests of the same repository that mention the issue, and the GitLab merge requests related to the issue. Open ones come first, and the list is kept for about a minute. If none is found, the view says **No pull or merge request names this issue yet**.

1. **Browser:** open the post on its own and select **Diff**. The changes of the first open pull or merge request open in the [panel on the right](#see-changes-plans-and-files-beside-the-page) as its **Changes** tab, one file at a time, with the head commit they were read at. When there are several, select one at the top to see its changes; send or remove your drafts first. Select a file's name to fold or unfold it. Each line shows its old and new line numbers, with added lines in green and removed lines in red. A binary file is listed but not shown.
2. **Browser:** select a line. A box opens under it. Type your comment and select **Add**. The comment stays under its line as a draft, and the footer counts your drafts. Select **Edit** or **Remove** on a draft to change it.
3. **Browser:** add as many comments as you need, on as many lines and files, then select **Send N comments to agent**.
4. The agent that has the post gets them all in one message: the pull or merge request it is about and the commit you read, then each comment in the order you added it, with its file, line, side (**old** or **new**) and the code on that line. It is asked to address them on the branch, push, and reply when done. The message goes the same way as a **Comment**, so it shows in the post's **Thread**, and on a closed post it opens the post again.

The footer says when the comments were sent, or why not. Drafts stay in your browser tab until the send succeeds. After a reload, the view opens the pull or merge request your drafts were written on, and the send names the commit you read them at. If that pull or merge request can no longer be read, the view offers to remove the drafts. If someone pushed to the pull or merge request after you loaded the diff, the message tells the agent so, and the footer warns you to reload the diff.

A post kept on another computer of your mesh is read and commented on at that computer, the same way as a **Comment**.

A very long diff shows its first 3,000 lines, with a note that the rest is on GitHub or GitLab. You can send up to 50 comments at once, each up to 2,000 characters, and up to 16,000 characters in all. The diff is read with the same GitHub token (`requests.checkers.github.token`, or the GitHub channel's token) and GitLab connection the Hub uses to show a post's issue state. Only the owner can send comments, like every other action on a post.

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

### Set up agents from the Agents page

Each agent on the **Agents** page has a status next to its @handle: **Working** (it runs something now), **Needs you** (a card or a post waits on you, or it waits for your approval), **Idle**, **Paused**, or **Not started** (saved, but no machine runs it yet). Anyone who opens the Hub sees the statuses. You, the owner, also get the buttons below; they use the same settings as **Settings** › **Agents**.

1. **Browser:** in the nav, select **Agents**, then **New agent**.
2. Type a name. The agent id comes from the name unless you type one. Role, workspace, AI engine, model, wake words and instructions are optional: the role puts the agent on the org chart, and the workspace is a folder (`~/` is your home folder; empty means `agents/<id>`). A folder that already exists is used as it is; nothing is written in it. Instructions take up to 4000 characters, here and in **Edit**; put longer ones in the agent's `CLAUDE.md`.
3. Optional: under **Channels**, type the name of the environment variable that holds a Telegram, Discord or Slack token (the name, never the token). Tick **Answers on the public API** to open it there.
   - A machine has one Slack bot and one Discord bot. The form says which agent each answers as now. If it answers as another agent, tick **Move the Slack bot** (or **Move the Discord bot**) to make it answer as the new agent instead; that agent then stops answering there. Without the tick, nothing is saved.
4. Select **Create agent**. The line at the top says **Created**. If a part is refused, the form stays open with what you typed and says what was saved and what was not. Fix that field and select **Create agent** again: the parts already saved are not sent twice.
5. Select **Restart when idle**. The daemon restarts once no task runs, and the agent starts.
6. Under the new agent, **Test drive** is open: type a message and select **Send**. Its answer shows under it. It is a real run, so it can cost money.

![The Agents page as the owner: a status per agent, New agent, and Edit, Pause, Test drive and Remove on an agent this machine runs](/screenshots/wall/agents-manager.png)

![The New agent form: name, id, role, workspace, AI engine, model, wake words, instructions and channels](/screenshots/wall/agents-new.png)

*Scripted demo data; your team's names and machines will differ.*

On an agent this machine runs:

- **Edit** opens the same form with what is saved. **Save** changes only what you changed. Channels, skills and files are under **Settings**.
- **Pause** stops it from starting new runs until you select **Resume**. An agent waiting for your approval shows **Approve in Waiting on you** instead.
- **Remove** asks first, then takes the agent out of `agentx.json` and out of the org chart (with its lines and departments), and unbinds the Telegram, Slack and Discord bots that answered as it. You can then create an agent with the same id and a role. An agent that manages a project is not removed: give the project another manager first. Its workspace folder stays on disk. Select **Restart when idle** to stop it.

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

Each agent card shows the agent's name, @handle, its role in the org chart when it has one, its AI engine and model, and an **On** / **Off** switch. **Waits for approval** instead of the switch means the agent waits for you in **Waiting on you**: select it to answer there.

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

Most changes apply from the agent's next run, with no restart, a new engine too. A new model or permission mode applies only after a daemon restart; the bar says so before you save, and the **Saved** line names the command. **Terminal**, on that machine:

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
2. To start from a template, select one at the top: **Support desk**, **Code reviewer**, **Daily reporter** or **Researcher**. It fills the id, name, trigger words, engine and instructions. **After you add it** then lists the first thing to ask the agent, the skills worth adding, and what to connect, with a link to each Settings section. **Blank** clears the form. A template only fills the form, so nothing is saved yet.
3. Type or change the id (lowercase), the name and at least one trigger word. Pick the AI engine; the model and instructions are optional.
4. Select **Add agent**. The line under it says **Added**, or why not.
5. **Terminal:** run `agentx daemon restart --when-idle`. The new agent starts working after the restart.

#### Add an agent under someone in the org chart

1. **Browser:** in the org chart editor (on `/org`, select **Edit org**), find the member the new agent will report to and select **Add agent here**.
2. The Hub opens **Settings** › **Agents** with **Add an agent under** that member. The form says **Reports to** with their name, and has a **Role** field.
3. Fill in the form as above, and type a role, for example `Engineer`. Select **Add agent**.
4. **Terminal:** run `agentx daemon restart --when-idle`, as for any new agent.

The agent, its role and its reports-to line are saved together. **Check it worked:** the line under the form says **Added**, then **reporting to** and the member's name, for example "Added @tester, reporting to Helper.", and `/org` shows the new card under that member. **If something is wrong:** if the line is refused (for example, the member left the org chart), the form says why, and nothing is saved, not even the agent. To add the agent outside the org chart, select **Add it outside the org chart instead**.

![Settings › Agents with Add an agent under Planner: Reports to Planner, and a Role field, in the isolated demo](/screenshots/settings/add-agent-here.png)

*Scripted demo data; your team's names will differ.*

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
4. **Email:** under **Add a mailbox**, type the address, the IMAP and SMTP servers, the password's variable name and who may write. Replies wait in **Waiting on you** unless you tick **Send replies at once**.
5. **Slack**, **Discord**, **GitLab:** fill the form and select **Connect** (or **Save** once connected). A switch turns each one on or off.
6. **GitHub** lists its webhooks; add one on **Webhooks** with source GitHub. **Calls** lists active and recent calls, and only reads.

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

**Inbox** also has **Approvals**, and **Requests** is its own section under **Fleet**. These are the settings the old Approvals page had, with the same saves. That page's address, `/approvals`, now opens **Waiting on you**.

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
2. At the top: the agent, the channel, **live** while it runs, and its clock: **Working · 2m 14s**, counting every second while it runs, then the time it took once it ends.
3. **A run in a chat is one turn of it.** When the run's chat has other turns (a follow-up, or the turns after it), the top says where it sits, such as **Follow-up · turn 3 of 5 in this chat**. **Earlier in this chat** shows the turns before it in order. Each one is folded to a line with its number and what was asked; select the line to open it and see the agent's reply and **View log**, which opens that turn's own page. A turn you open stays open while the page updates. The newest turn of the chat stays open. The first request always shows. When the chat has more than 10 earlier turns, select **Load earlier turns** to read the older ones. **Later in this chat** follows the conversation when turns came after it. The selected run is marked **turn 3 · selected** and keeps its own conversation, actions and live stream below. Only the same agent's runs in the same chat show, from its saved runs on that machine (kept 30 days).
4. **request** shows what the run was asked. When the run belongs to a tracked request, its box follows: the status strip (**Asked**, **Working**, **Waits**, **Done**), the **Plan** if it has one, and the facts. **Open the post** opens the post.
5. **Conversation** streams what the agent does while it works, whatever started the run (the Hub, Telegram, an agent, GitLab or a schedule). Claude Code replies can appear a few words at a time while the run is active. This holds for every Claude Code agent, including one that is not a persistent process: its runs stream their steps too, whatever started them. The reply shows as formatted text with highlighted code and tables. A spinner shows while the conversation waits for its first output. Each tool step shows its state on one line, such as **Read** `net/retry.ts` with **Running** while it works and **Completed** when a result arrives. Select a step to see its input and result. An open step stays open while the run goes on, and after the page reconnects to a run that was cut off, each step shows once. An edit opens as a diff, with removed lines in red, added lines in green and the counts (+3 −2) on its line. **Thought** folds the agent's thinking to one line. While a reply streams, the pane stays at the bottom. Scroll up to read and it stops following; a round **↓** button (**Jump to latest**) shows at the bottom of the pane. Select it to go back to the newest text and follow the stream again. On a phone the whole page scrolls instead of the pane, and it opens at its top, so the header, the **request** and the plan show first. When the conversation runs below the screen, **↓** shows just above the bottom edge of the screen: select it, or scroll to the end, to follow the stream. Scrolling the page up stops following again. Each message and step shows the time it happened, such as **14:05**; point at it to see the full date.
6. To steer it, use the box under the conversation. It is the same box as in the Hub chat: type, select **+** to attach files, or record a voice message with the microphone, then select the blue arrow (or press Enter; Shift+Enter starts a new line). The current turn keeps running; your message and its files go in as the next turn, and the agent can open the files. The box has no model picker: the run keeps the model it started on. Next to the arrow, while the run goes on: **Pause** stops the task at the next point it can and has the agent write a resume plan, so it can go on later; **Stop** ends the current turn now, with no plan. While the agent writes its plan the box says **Writing its plan…**, then shows **Resume**, which goes on from the plan in the same chat. The plan and **Drop** show under the top of the page, as on Live.
7. A finished run shows its stored record. A finished scheduled job can be continued: **Send** starts a new turn in the same job session, and the page moves to it. A finished run from any other channel only reads: its chat goes on where it came from.

![A run's Task page: the request, the tracked request's status strip, plan and facts, the conversation, and the steer box](/screenshots/wall/run.png)

![A demo conversation waiting for output and the count of what waits on you](/screenshots/wall/run-waiting.png)

![Demo tool steps on a narrow screen, showing an edit diff and the Completed, Failed and Running states](/screenshots/wall/run-tool-states.png)

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
5. Select a row to open it in place. It shows the result, everything it was asked, where it ran, and the review findings for the run. **Open the run** opens its [Task page](#watch-and-steer-a-run), where the full conversation is; a job's run also links to **Schedules**. Select the row again to close it. Selecting the title opens the Task page straight away.
6. To narrow the list:
   - The tabs under the title pick the result: **All**, **Done**, **Failed** (with how many failed), **Running** or **Stopped**.
   - **All agents**, **All projects** and **Any source** filter the runs. **Any source** picks what started them: **Jobs**, **Workflows**, **Hub posts** or **Messages**. They work together: for example one agent's failed jobs on one project. **Other (no project)** shows runs with no project.
   - **24 h**, **7 d** or **30 d** picks the period.
   - Select an agent's name on a row to see only its runs.
7. The filters are in the page's address, so you can bookmark or share a view. When nothing matches, **Clear filters** takes the tab and the filters back to their defaults.
8. The line over the list sums up what is listed: runs, failed runs, agent time and cost (runs with no recorded cost are counted apart), and links to the Map on the classic page. To see one agent's runs, select its name on a run.
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
2. Each task is one row with seven columns: **Status**, **Task** (with its issue or PR number), **Owner**, **Project**, **Idle** (how long it has not moved: `38 m`, `1 h`, `2 d`), **Waits on**, and **Time** (minutes run against the estimate). A word in amber with a warning sign marks what needs a look: **Closed on GitHub** (or GitLab) while it is still open here, **Open on GitHub** while it is closed here, **2 runs going** when runs overlap, **Awaiting QA**, and **Over** when the run time passed the estimate.
3. A task idle for three days or more is in amber, so it stands out.
4. The list shows 10 rows, then **Show all**. The line under it says how many it shows.
5. Select the **Group and columns** button (the sliders, right of **Filters**) to put the rows under a header per **owner**, **project** or **blocked by** (the agent, person or you that a record names as the blocker), each with its count, and to add the **Node**, **Runs** and **Group** columns. This browser keeps your columns.
6. Select a column heading to sort by it. Select it again to reverse the order.
7. Select a title to open that post and its thread. The end of a row has the same buttons as a post in the feed: **Stop** while it runs, **Retry** after a failed run, and the link and **...** when you point at the row.

![The List with its seven columns, amber flags and old waits, in the isolated demo](/screenshots/wall/list.png)

## Filter

Under the box, the status tabs pick what the feed and the list show: **Open**, **Working** (a run works on it), **Waiting** (on you or on another agent), **Failed** (needs attention, or its last run failed), **Done** and **All**. The number beside each tab counts the tasks it shows with your other filters, so a tab never says more than it lists.

Type in **Search tasks** at the top right to search; press `/` to jump there. On a phone, select the search button first. Select **Filters** to open the rest of the filters; select it again, press Escape or click outside to close them. The number on **Filters** says how many are in use. The filters work for both the feed and the list:

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

You can also pick the goal in the filters: select **Filters**, then **Goal**.

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

1. Select **Schedules** in the nav. At the top are today's totals across every machine: runs that **ran**, **worked**, **failed**, were **quiet** (a report-only job with nothing to report), the jobs that **look stale**, and the jobs whose **last run failed**.
2. Jobs are grouped by machine, in a table with these columns: **Schedule** (the job's name, agent and value line), **Project** (the issue its runs are about, from [`crons.<id>.home`](/reference/config-automation#crons), else its goal), **Next run** (with the cron expression under it), **Last result** (**Worked**, **Failed** or **Timed out**, and when), **Last 7** (its last seven runs as squares: green worked, red failed, an empty square for no run; the newest is on the right), and its state: **on**, **off** or **look stale**.
   A job whose last run failed or timed out has a red edge, and the first line of the error shows under its name, so you see it without opening the row. On a phone, the row keeps the name and the last result.
3. The value line says why the job runs and the number that proves it, from [`crons.<id>.value`](/reference/config-automation#crons). A job without one says **no value line** in amber, so the gap shows.
4. A job **looks stale** when it has been off for 14 days or more, failed 3 times in a row, or has no value line. Point at the label to see which.
5. Select a row to open the last run's short summary and a **Full log** link. The full output stays on the log page.
6. **Pause** and **Archive** are shown but greyed out: they come in a later phase.

A machine that does not answer keeps its jobs from its last answer, marked **as of** that time. A machine that has not answered yet says **This machine does not answer, so its jobs are not shown.**

Settings › Schedules shows the same line under each job.

![The Schedules page: today's totals, then one machine's four jobs, each off, with no value line and marked look stale, in the isolated demo](/screenshots/wall/jobs.png)

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

## See events and who answered them

An **event** is one short record of something that happened, such as `daemon:restart-soon` sent before a restart. A **broadcast** is an event sent to every agent that follows it. An agent can follow an event so that it is **woken**: the event starts a task for it (see [Let agents follow events](../automations/event-subscriptions.md)). The **Events** view shows the events agents and scripts sent, which agents each one woke and how that went, and the events the agents sent back in reply. You no longer need the daemon log for this.

It lists named events (sent with `agentx events emit` or the `agentx_emit` tool) and mesh announcements, from every connected machine. It reads what each machine keeps in memory, so it starts empty after a daemon restarts. Nothing is sent from this view.

1. **Browser:** select **Events** in the nav, under **Automation**. The number next to it counts the events listed.
2. The line at the top counts the events and the wakes, and how the wakes went: **ran**, **waiting**, **timed out or gave up**, **failed** and **skipped**.
3. Each card is one event, newest activity first. Its first line gives the event's name, who sent it, when, its **ref** (where the details are, as the sender gave it) and the first characters of its id. The summary follows when there is one.
4. Under it, **N wakes** sums up the agents it woke. Select it to see one line per agent, with the machine it is on when you have more than one:
   - **ran**: the task ran. **waited 4 min** is added when it had to wait for a free slot (the agent was busy) before it started.
   - **waiting** or **running**: the task has not started yet, or is still going. **waiting** gives how long so far.
   - **held**: a dispatch limit is holding it. The daemon tries again on its own; **try 2** counts the tries.
   - **timed out**: it waited too long for a slot, or its run hit its time limit. **gave up**: it was held too many times.
   - **failed**: the task ended with an error, shown under the line.
   - **skipped**: the agent was not woken. The reason follows: `rate-limit`, `own-root` (the event came from its own work) or `duplicate-root` (it was already woken for it).
   - **run** opens the woken task on the Hub's **Task** page.
5. Events sent in reply are listed under the event that caused them, marked **in reply to** with that event's name and id. Each has its own wakes.

![The Events view: a restart notice, the three agents it woke, one after a wait, and their replies under it, in a scripted demo](/screenshots/wall/events.png)

![The same Events view on a phone, in dark mode](/screenshots/wall/events-phone.png)

*Scripted demo data; your team's names and machines will differ.*

A reply is linked to its event in this order: the event that woke the task that sent the reply; else an event of the same request that woke the sender; else the latest earlier event of the same request sent by someone else. An event sent from outside any task (a script, a person) starts its own thread.

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

1. **Browser:** select **Cost** in the nav (under **More** on a phone). With the simple layout, the default, Cost is not in the menus: turn **Cost page** on in [Settings › Layout](./settings.md#layout), or open `/hub#status=open&view=cost`, which always works. The amount next to it is what every machine spent this month.
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
2. Read the cards. An agent's card shows its picture, name, @handle and role, with a dot for what it is doing: green when it works on something, grey when it is idle, and amber when it is paused or waits for your approval. When the dashboard cannot tell, the card has no dot, and a line above the chart says **The daemon did not answer, so working and idle are not shown.** A person's card has a dashed blue border and a **person** chip, with no dot.
3. Read the lines. A solid line joins each member to their boss (**reports to**).
4. Two other links show as words on the card:
   - **acts for** *name*: the agent works on behalf of that person.
   - **dotted line to** *name*: a second boss for one topic.
5. Select **Show dotted lines** to draw the dotted lines too, as dashed arrows. Select it again to hide them. The legend at the top explains each line.
6. Select **Hide … reports** on a card to fold that branch. **Show … under** opens it again.
7. Select **−** and **+** to zoom out and in, or the percentage to go back to 100%. On a laptop trackpad, pinch over the chart.
8. Select an agent's card to open its [profile](#see-one-agent-s-profile).
9. Under the chart, the page counts the people, agents and levels, and lists the agents that are not in the chart. Select one to open its profile.
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

In the side menu's machine tree, a slow machine keeps the agents of its last answer, with its number and **as of** and the time of that answer (UTC, hours and minutes) next to it. Its rows do not disappear while it is asked again. A slow machine with no answer yet says **checking…**. A machine that has not answered in five minutes says **not checked** and shows no agents. **At work now**, **Working**, the status bar, **Machines** and **Tasks running** on `/mesh` count the machines that are up and the slow ones with their last answer, so the numbers do not drop to 0 and back while runs go on. On `/mesh`, a machine too slow for the history says **Slow to answer, history not merged**, not **UNREACHABLE**.

![Happening now on a phone: one machine answered, the other is still checking](/screenshots/wall/checking-phone.png)

*Scripted demo data; your team's names and machines will differ.*

**Running now** does not wait for the feed. Its cards appear as soon as the machines answer, usually within a second, while the feed may still say **Loading…**.

When the Hub opens, it first asks for two things only: the posts and what runs on each machine. It shows the posts that are ready, usually within a second, and adds the rest when they arrive:

- posts from a machine still building its list,
- the GitHub or GitLab state of a post (for a moment it says **still being read; shown in a moment**).

The agents' roles, their spend and the workflow runs load right after the first posts are on screen.

**Synced** and a time, right of the status tabs, says when the Hub last read the records (point at it for the exact time). When the page has not read them for two minutes, or the last read failed, it says **Not synced since** in amber, and the button beside it says **Retry**. The page refreshes every minute while it is open; select the refresh button to read now.

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

1. **Browser:** open the dashboard. The Hub opens in its own space, with no dashboard top bar: the nav on the left and the page across the rest of the width, with no Chat or Agents column on the right. No label shows twice in the nav, and at 900 pixels high it does not scroll. The bottom status bar has **Theme**, and at 900 pixels wide it still fits on one line. Press **⌘K** and pick **Dashboard**: the classic Operations page opens, and its **Hub** tab brings you back.
2. Send an agent a small task from a channel. Within a minute (or after **Refresh**), a post for it appears with status **in progress**.
3. Select **Thread** on it. You see the request and at least one **run**. Then select the post itself: it opens on its own page with the same thread. Press Escape: you are back on the feed.
4. Press **⌘K** and pick **Agents**. Every agent on your machines is listed, and the number next to **Agents** matches the list. Each agent has a status (**Working**, **Needs you**, **Idle**, **Paused** or **Not started**). As the owner, select **New agent**, type a name and select **Create agent**, then **Restart when idle**. After the restart, **Test drive** the new agent: it answers, and you edited no file.
5. When an agent raises a decision card while working on a task, select **Waiting on you** at the bottom of the nav (or the **Waiting** tab). The card shows on that task's post, with its expiry and what happens with no answer.
6. Open a post that is in progress, type a comment and select **Comment**. The note under the buttons says it was sent to the agent, and a **comment** line by **owner** appears in its thread. Within a minute, a new **run** of that agent follows it. Select **Call** *agent*: your AgentX Voice widget rings.
7. Press **⌘K** and pick **Live**. The Hub's **Live** page opens.
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
19. Post a task: type `@` and an agent's name and a small task in the box at the top of the feed, then press **Enter**. The box says who has it. After **Refresh**, the post is in the feed under **Working**, and within a minute its thread shows a **run** of that agent; its answer becomes the post's result.
20. Select the **Done** tab: only finished posts are listed. Select **Filters**: the filters open.
21. Select **Schedules**. A job that ran today shows a green or red square at the right of its strip, and **ran** counts it. Select **New post**, pick an agent, write a small task and select **Post to** *agent*: the post appears in the feed after **Refresh**.
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
35. Phone: open the Hub at 390 px wide (or on a phone) and select the menu button at the top left. The side menu slides in from the left with the agents, **Workspace**, **Settings** and **Light / dark**. Select **Jobs**: the menu closes and the Jobs page opens. Select the search button, type `act` and pick **Activity**: the Activity page opens.
36. People page: select **People** in the nav. It lists the same people as `agentx people list`. Select **open requests on the Hub** on a person: the feed shows only their open posts, and **everyone** shows all posts again.
37. If your org chart has a person as a boss or a **dotted-line** or **acts-for** relation: open that agent's profile. Its org line shows the same relations as the **Org** page, for example **reports to The Owner**.
38. Org page: select **Org** in the nav. The top card is whoever reports to no one, and every member of `business.orgChart` sits under their boss. The number next to **Org** matches the cards. Select an agent's card: its profile opens, with its role and **reports to** its boss. **Org chart** on that line opens the Org page again.
39. Waiting on you: with a decision card pending, select **Waiting on you**. Its count matches the phone app's Desk. Select **Later**, then **Confirm**: the card moves to **Put off**. In a private window without the dashboard key, the page reads **Needs the owner**, the card has no buttons, and an answer sent to `/api/admin/wall/decide` is refused with 401; the card stays.
40. Settings: select **Settings** in the nav, then an agent. Change its wake words: the field turns blue and the bar says **1 change not saved. It applies without a restart.** Select **Save…**, check the old and new words, then **Save changes**: the bar says **Saved**, and **Advanced** in classic Settings shows the new words in `agentx.json`. Turn its switch **Off**: the [Org](./org.md) page shows it paused. Turn it back **On**. On a phone 390 px wide, the sections fill the screen and **← All settings** brings them back. Select **Health**: **agents online** matches the agents on [Live](#live-sessions), and a machine you stop turns red within a minute. Open an agent's **Handovers** tab and hand a test chat to another agent: it is listed under **Routed away from**, and under **Routed to** on the other agent's tab. Select **Release**, then **Release** again: it leaves both lists.
41. Workflows page: select **Workflows** in the nav. It lists the same workflows as `agentx workflow list` in a terminal, and the number next to **Workflows** matches. Select a workflow's name: its last run opens with one line per step. Select **Failures**, then a workflow's name under **Workflow runs**: the Workflows page opens on that workflow.
42. One agent's runs: select an agent's name, then **Activity** under its profile. **Activity** is underlined and the list shows only that agent's runs.
43. Schedules and Webhooks: in **Settings** › **Schedules**, select the preset **Every hour**: the line under **When** says when it runs and the next three times. Add a schedule named `check-test`, then open the classic `/admin#tab=crons`: `check-test` is listed. Delete it on the Hub. In **Settings** › **Webhooks**, add one named `check-test`, select **Turn off**: its card says **off**. Delete it.
44. Channels: in **Settings** › **Channels**, the Telegram account you use is listed with its agent and its token's variable name, never the token. Select **Email**, then **GitLab**: each matches the classic `/admin#tab=channels`.
46. Approvals moved: open `<dashboard>/approvals` in the browser. It opens **Waiting on you** on the Hub, and its count matches `agentx approvals list`. Open a post that is in progress: under the comment box there are **Hand to…**, **Done** and **Drop**. Select **Drop**: a line asks you to confirm, and **Back** closes it without sending anything. In a private window without the dashboard key, the post has no such buttons.
45. WhatsApp and Inbox: in **Settings** › **Channels**, select **WhatsApp**: with WhatsApp on, it says **connected** (or shows a code to scan), and its watch rules match **WhatsApp triage** on the classic `/admin#tab=webhooks`. Select **Inbox**: **Where it goes** names the same chat as `agentx notifications`. Untick **A task is queued**, select **Save**, and the classic **Notifications routing** shows the same. In a private window without the dashboard key, `curl -X POST <dashboard>/api/admin/wall/settings/notifications` gets `401`.
47. Events: give an agent a subscription such as `{ "kinds": ["test:ping"], "delivery": "wake", "prompt": "Reply with agentx events emit test:pong" }`. **Terminal:** run `agentx events emit test:ping --summary "hello"`. **Browser:** select **Events**, then **Refresh** after a minute. The `test:ping` card says **1 wake: 1 ran**, and `test:pong` is under it, marked **in reply to test:ping**.
48. Right panel: open the chat of an agent that works on an open request on a GitHub or GitLab issue. The **Working on** line names it. Select **Changes**: the panel opens on the right with its diff, and the chat narrows. Select **File** next to a file: a second tab shows the whole file with its new lines in green. Close both tabs: the chat takes the whole width again.
49. Files: ask an agent in a chat to "write a file named hello.txt with one line". When it is done, select **Files** at the top of the chat. The **Files** tab opens first in the panel, with `hello.txt` marked **wrote**. Select it: its line shows in green. Under **Workspace**, `hello.txt` is listed; select it, and the file opens with its line number.

## If something is wrong

- **"Not answered: Only the owner can answer this":** the browser has no dashboard key. Sign in with the key, then answer again. Nothing was changed.
- **Channels says "set in agentx.json as a literal value: move it to .env":** the secret itself is typed into `agentx.json` instead of the name of a variable, so the page hides it and leaves the form field empty. **Terminal**, on that machine: add a line such as `TG_SUPPORT_BOT_TOKEN=<the token>` to `.env`. Then **Browser:** type that name in the form and save it. The page then shows the name, and `agentx.json` no longer holds the secret.
- **Inbox says "type the name of the .env variable":** the ntfy topic or token itself was typed in the form. Put it in `.env` as a line such as `NTFY_TOPIC=<the topic>`, then type `NTFY_TOPIC` and save again. Nothing was saved.
- **WhatsApp chats say "WhatsApp channel not enabled":** the daemon has no WhatsApp channel running. Turn on `channels.whatsapp.enabled` in **Advanced** and restart the daemon.
- **Files says "Files not available":** the run's machine did not answer, or it runs an AgentX older than this dashboard and keeps a run's record only when the run ends. Select **Reload** later.
- **Files says "Still running: the files so far":** the run is still going. The list is what it touched up to now; select **Reload** for more.
- **Workspace says "not available" or a file says "Not shown":** the reason follows. "this file is not shown" is a secret-like name or `.git`; "the file is too big" is over 256 KB; "not a text file" is a picture or another binary file; "the path leads out of the workspace" is a link to a folder outside it. "unauthorized" means the browser is not signed in as the owner, or the machine refused this dashboard's token: add it under `dashboard.daemons` with a token it accepts.
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
- **A card is on Waiting on you but not on a post:** it was raised outside a task. Only pending cards that belong to a task show on a post; every pending card is on **Waiting on you**.
- **Waiting on you reads Needs the owner and has no buttons:** the browser has no dashboard key. Sign in with the key; the buttons come back.
- **Answering unblocks names no run:** runs show there only when they were paused on that card by a workflow's owner-decision step, on a machine that answered within five seconds.
- **The portfolio says "That key does not open the portfolio":** the key was revoked, expired, mistyped, or made without `--scope wall:portfolio`. Check it with `agentx token list`; make a new one if needed.
- **The portfolio says "The portfolio is not switched on yet":** this dashboard has no token. Set `dashboard.token` in `agentx.json` and restart the dashboard.
- **The portfolio shows "Untitled request" a lot:** those tasks have no headline yet and no issue or merge request as their home. The text of the task is never used as a title there.
- **Events says "No named event or announcement since the daemons last started":** events are kept in memory only. Send one with `agentx events emit <name>` and select **Refresh**.
- **An event shows "No subscriber was woken":** no agent has a `wake` subscription that matches it, or the subscription names other machines in `nodes`. Pull and digest subscriptions do not show here. See [Let agents follow events](../automations/event-subscriptions.md#set-up-a-subscription).
- **Events says a machine "key refused" or "no events feed (older AgentX)":** that machine's events and wakes are missing; the rest still shows. Add its `dashboardToken` under `dashboard.daemons`, or update AgentX on it.
- **A reply is listed as its own card:** it was sent from outside the woken task (a script, or a task on another request), so nothing links it to the event. Send it from the woken task with `agentx events emit` or the `agentx_emit` tool.
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
