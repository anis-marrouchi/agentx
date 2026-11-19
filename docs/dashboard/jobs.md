# Jobs — every piece of assigned work, and what it is doing now

Work reaches an agent in several ways: you ask, another agent hands it over, someone mentions the agent on an issue, a schedule fires, a workflow reaches a step. **Jobs** lists all of it in one place. Each piece of work is one **job**, and each job has one status line that says what is happening to it now.

**Jobs** is a page of the [Hub](./hub.md), the dashboard's home. It only reads. Nothing on it changes a job.

![The Jobs page in a demo: the state chips with their counts, the Door filter, and seven open jobs, each with its status line, one blocked in amber and one stalled in red](/screenshots/wall/job-ledger.png)

The page that lists your recurring jobs and their value line is now called **Schedules** (it was called Jobs before). See [See recurring jobs and their value line](./hub.md#see-recurring-jobs-and-their-value-line).

## What a job is

A job is one record for one piece of assigned work. It names who asked, which agent owes the work, and where the work lives (its issue or merge request, when it has one). The record stays until the work is done or dropped, across as many runs as it takes.

The **door** is how the work came in:

| Door | The work started when |
|---|---|
| Owner | You asked an agent in a chat. This is also one of your [open requests](../jobs/open-requests.md). |
| Agent hand-off | One agent gave work to another. |
| Issue mention | Someone mentioned the agent on an issue or a merge request. |
| Cron | A schedule fired. |
| Workflow | A workflow reached a step that an agent runs. |
| API | A script or another program started the work through the daemon. |

## Open the page

1. **Browser:** open the dashboard. On the Hub, select **Jobs** in the nav, under **Work**. On a phone, select **More**, then **Jobs**.
2. The page opens on the **Open** jobs, most recently active first. Its address is `/hub#page=jobledger`.
3. The number beside **Jobs** in the nav is how many jobs are stalled or blocked. It shows after the page has been opened once.

The page reads every machine the Hub reads. With more than one machine, each row names its machine. A machine that does not answer is named above the list. The list is read again every minute while the page is open.

## Read a row

Each row has:

- **The job's name:** its headline, or the start of what was asked.
- **The status line:** the main thing on the row. See [What the status line means](#what-the-status-line-means).
- **Who asked and who owes it:** for example `pm → @coder`.
- **The door.**
- **The home:** a link to the issue or merge request, when the job has one.
- **Updated:** how long ago the job last moved.
- **Your request:** a tag on a job that you asked for yourself. **See it in Requests** opens **Needs you** on its **Requests** chip, where you can answer or close it.

## What the status line means

The daemon writes the status line from facts it has: the run that is live now and its last tool call, the wake that is set, the name and due time of whoever the job waits on, or the absence of all three. It is never what the agent says about itself.

| State | Chip | A status line looks like | It means |
|---|---|---|---|
| Working | **Working** | `working, last tool call 40 s ago` | A run is on the job now. |
| Continue | **Sleeping** | `sleeping until 18:00 for the build` | The last run ended with work left. The daemon starts the next run at that time. |
| Waiting | **Waiting** | `waiting on devops until 19:00` | The job waits on someone named, until a due time. |
| Blocked | **Blocked** | `blocked: no access to the server` | The job cannot go on. The line says why. Shown in amber. |
| Stalled | **Stalled** | `stalled, run ended 3 h ago with no state` | No run is on it, no wake is set and it waits on nobody. The daemon found this itself. Shown in red. |
| Done | **Done** | `done: merged in the release` | Finished, with its proof. |
| Dropped | under **All** | `dropped` | Declined or dropped. |

A line that starts with `nobody on it` is an open job that nothing holds right now. The daemon marks it stalled at its next check. It is shown in red too.

Every open job is meant to have one of three things: a live run, a set wake, or a named person or agent it waits on with a due time. A job with none of them is stalled, and that is what the page is for: to make such a job visible instead of quiet.

## The Queue block

When `requests.dueTimes.mode` is `"shadow"` or `"on"`, a **Queue** block sits above the list. It shows how AgentX works out due times from the open work: one line per agent, the busiest first. A line reads, for example, `@writer · 3 jobs, 2 h of work · next ends in 40 min · clear in 2 h · correction ×1.5`:

- **jobs** and **of work:** the agent's open jobs that wait for its time, and their minutes, with its correction factor applied.
- **next ends:** when the first of them would end.
- **clear:** when the last of them would end.
- **correction:** how long the agent's work really took against its estimates. It is not shown when it is 1.

![The Jobs page in a demo with due times in shadow mode: the Queue block above the list, one line per agent with its jobs, minutes of work, when the next ends and when it is clear](/screenshots/wall/job-ledger-queue.png)

The block only reads. See [Due times the daemon gives](../jobs/open-requests.md#due-times-the-daemon-gives-the-queue) for how the times are worked out and how to turn it on.

## How long a job is kept

Jobs leave the list by themselves after the number of days set in **Keep closed requests for (days)** (`requests.retentionDays`, 90 by default; see [open requests](../jobs/open-requests.md)).

- A finished job leaves that many days after it finished.
- A working, blocked or stalled job leaves that many days after it last moved. This clears the jobs of a schedule that keeps failing, and jobs whose run was cut by a restart.
- A sleeping or waiting job is kept: its wake or its due time decides what happens to it.
- Your own requests follow the rules of [open requests](../jobs/open-requests.md): an open request is never removed.

## Filter by state or door

1. Select a chip to list one state: **Open** (every state that is not finished), **Working**, **Sleeping**, **Waiting**, **Blocked**, **Stalled**, **Done** or **All**. Each chip shows how many jobs it holds.
2. Choose a door under **Door** to keep only the jobs that came in that way.
3. The address keeps both, so you can share or bookmark a filtered list.

The list shows the 100 most recently active jobs that match. A line under the list says so when there are more.

## Open a job and follow its tree

1. Select a row. It opens in place.
2. The details show the full text of what was asked, and every run of the job: its status, when it started, how long it took and what it cost.
3. **Part of** names the job this one came from, when an agent handed it out while working on another job. Select it to open that job.
4. **Handed out from this job** lists the jobs this one started. Select one to open it.
5. Select the row again to close it.

![A job opened in place: what was asked, the two jobs handed out from it with their status lines, and its three runs with status, start, duration and cost](/screenshots/wall/job-ledger-open.png)

**A job handed to another machine.** When an agent hands work to an agent on another machine, the job is kept on both: here it waits on that machine, there the agent works on it. The two rows have the same id. Opened here, the job shows **On** and the machine's name, with the job's status line as that machine gives it now and the jobs it **handed out there**. Select one to open it on that machine. In the list, the row here quotes the other machine's line, for example `waiting on devops@clawd (there: working, last tool call 40 s ago)`; the daemon reads it again every minute, 30 jobs at a time. With more than 30 open jobs on other machines, each is read in turn, so a line can be a few minutes old. If the Hub does not read that machine, or that machine keeps no jobs or runs an older AgentX, the details say the job was not read and the row keeps its own line.

![A job handed to another machine, opened on this one: under "On clawd", its status line there, working, and the two jobs handed out there, one working and one stalled in red; the row above quotes that line after "waiting on devops@clawd"](/screenshots/wall/job-ledger-mesh.png)

Parent and children are the job's tree. Start at your own request and follow it down to see which agent has each part now, and which part is stalled.

## How a job keeps going

Work often takes more than one run. The daemon, not the agent, keeps a job going between runs.

- **Continue:** a run that ends with work left says when to go on and what is left. At that time the daemon starts the next run, in the same chat, and gives it the job's note. The job shows `sleeping until …` in between.
- **A cap on every job:** the daemon wakes one job at most 20 times, and stops once its runs have cost 10 US dollars. The reply an agent writes on its own when background work ends counts toward that cost too. A job at its cap is marked stalled, and its line says which cap. Change the caps with `requests.jobs.wake.maxWakes` and `requests.jobs.wake.maxCostUsd`.
- **A wake that cannot start:** when the agent is busy, the woken run waits for a free slot; it is never put in the chat's message queue, so its reply is not posted in a chat where nobody asked for it. If no run could start at all, the daemon tries again 5 minutes later. If the run started and then failed (a model error), the daemon does not try again: the job shows `blocked` with the reason. A run stopped at its time limit is the exception: its job is woken again, within its caps.
- **Background work:** when a run ends but left a script or a build running, the job waits on it (`waiting on its background work until …`) instead of closing. When that work ends, the daemon wakes the job that waits on it and gives it the work's closing reply; another job in the same chat is left as it is. Before, that reply was dropped. The agent's process is kept for up to 3 hours while such work is open (`processPool.maxBackgroundSeconds`); before, it was stopped after 45 minutes.
- **The check each minute:** an open job must have a live run, a set wake, or someone named it waits on with a due time. The daemon checks this every minute. A job with none of the three for 10 minutes (`requests.jobs.wake.graceMinutes`) is marked stalled, with the reason on its status line.
- **A stalled job is told:** at the same check, the daemon tells the agent that asked for the work, once, with a `[Job stalled]` line that gives the job, the reason and what was asked. The line is a notice: the agent reads it at the start of its next run, and no run is started for it. A schedule has nobody who asked, so its own agent is told. The agent that owes the job is told when the one who asked is not an agent on this machine (a person's request, a comment on an issue, an agent on another machine). Notices are kept in memory: one not yet read when the daemon restarts is lost, and the job still shows as stalled on this page.
- **A job handed to another machine:** the check above leaves it to that machine. When that machine still has no record of the job 6 hours after it last moved here, the hand-off never started there or was lost. The job is marked stalled with that reason, and the one who asked is told. Every open job on another machine is checked this way, however many there are and however old. This applies only when that machine keeps jobs and says it has no such job. A machine that keeps no jobs (`requests.jobs.enabled` is off there), or that runs an older AgentX that cannot say which, may have done the work: the job here is left as it is.
- **A job that ended on the other machine:** while the hand-off is still out, its answer ends the job here. Once the answer is back, the job here follows what that machine says. Before, such a job stayed `waiting` here for good.
  - **Done there:** the job here is done, and its proof is that machine's line, for example `on build-box: done: <link>`.
  - **Dropped there:** the job here is dropped too.
  - **Stalled there:** the job here is marked stalled with that machine's line as the reason, for example `on build-box: stalled, nobody on it`, and the one who asked here is told once. The daemon keeps reading it: when it is done there later, it is done here; when an agent there takes it up again, it is `waiting` here again.
  - **Blocked there:** the job here keeps `waiting` and quotes why, for example `waiting on devops@build-box (there: blocked: no access to the server)`. The one who asked here is told once, with a `[Job blocked]` line. If it moves on there and is blocked again later, they are told again.
- **A schedule's job that says `continue`:** the daemon does not wake it. The schedule's next firing goes on with the same job, so it is not marked stalled while its schedule is on. It is marked stalled when the schedule was turned off or removed.

Your own requests keep their own checks (quiet time, resend, pick-up). The check each minute holds one of them only after a run has stated a job state on it.

When the daemon wakes one of your requests (a due time came, a resend, a pick-up), the wake is used up as soon as its run starts. The request then shows its own state again (`working` while it is in progress), and a new due time the agent gives arms a new wake. A request that a run had already given a job state shows `working` instead; a new due time arms a wake on it too. Only a state a run gave since (waiting, blocked) keeps a new due time from arming one. A request left showing `continue` with no wake set, from an older AgentX, is handed back to its own checks at the next minute check.

Three older paths now go through the job's wake:

- **Resend once:** a request that a usage limit or a restart stopped is sent back once by waking its job, with the reason as its note. If the wake does not take it, the pick-up turn sends it, as before.
- **Time limit:** a run stopped at its agent's time limit wakes its job, with a note listing the tool calls it had made. The run no longer gets a continuation of its own. See [work that runs past its time limit](/jobs/restart-safely#work-that-runs-past-its-time-limit).
- **Pick-up:** when you reply to a request, hand it to an agent, or ask for it to be picked up again, the requests check wakes its job, with your words as the note. A `blocked` or `stalled` state a run put on the request is lifted by your pick-up: your word decides. The daemon's own resend does not lift it. If the wake does not take it (jobs turned off, the job at its cap, or your words too long for a note), the pick-up turn goes as before.

All of them count toward the job's caps. Task watchers are removed: a job that is not finished is followed by its own wake and the stalled check. An old `agentx.json` that still has their section loads; the section is ignored. Their table in the database (`task_watchers`) is deleted at start when it is empty; one that still holds rows is left as it is.

Hand-offs (work one agent hands to another) are kept in their own table, `handoffs`, in the same database as the jobs (`.agentx/db.sqlite`). It is not a list of jobs: it is how a hand-off that was still out when the daemon restarted is reported as lost, and how an answer a restart kept from reaching the agent that asked is passed on once more. A hand-off's job is the job row `job-<hand-off id>`; the two are joined by that id. Ended hand-offs are deleted after `requests.retentionDays`, like finished jobs. One whose answer is still waiting to be passed on is kept until it is.

The old delegation log (`.agentx/a2a/delegations.jsonl`) is still written for this release, but no longer read. At every start, AgentX adds what is in it to the table, so going back to an older AgentX and forward again loses nothing. A later release stops writing it.

On a machine where the database cannot open, hand-offs are kept in memory only. The daemon log says so at start with a line beginning `[delegation] WARNING: no database`, you get one notice "Hand-offs kept in memory only", and `GET /health` shows `"handoffs": "memory-only"` (`"database"` otherwise). A restart then forgets every hand-off still out, and nobody is told it was lost.

Jobs are kept while `requests.enabled` is on. To keep jobs on a node where requests are off, set `requests.jobs.enabled` to `true`: every run that is not your own turn gets its job, and your own requests leave no record there. Set it to `false` to keep no jobs at all.

To turn the wake and the check off, set `requests.jobs.wake.enabled` to `false` in `agentx.json`. An agent's process with background work open is then stopped after 45 minutes again, not 3 hours. The settings are listed under [`requests`](../reference/config-automation.md#requests).

## Read the jobs from a script

`GET /jobs` on the daemon (loopback, or a mesh token) gives the same list as JSON. Agents and scripts use it. Without filters it gives the open jobs, most recently active first, at most 100. Filters, all optional:

| Filter | Keeps |
|---|---|
| `state=` | `open` (the default), `all`, or one or more of `working`, `continue`, `waiting`, `blocked`, `stalled`, `done`, `dropped`, separated by commas |
| `door=` | `owner`, `a2a` (agent hand-off), `mention`, `cron`, `workflow` or `api` |
| `agent=` | Jobs this agent owes |
| `requester=` | Jobs this requester asked for |
| `parent=` | The children of this job |
| `roots=1` | Jobs with no parent |
| `limit=`, `offset=` | A page of the list. `limit` is 1 to 500. |

The reply has `jobs` (each with its `status` line), `total` and `counts` (jobs per state). `GET /jobs/<id>` gives one job with its `runs`, its `parent` and its `children`. Add `?tree=1` and a job handed to another machine also comes with `remote`: that machine's own `job`, `runs` and `children`, or an `error` saying why it could not be read. Both only read.

When the daemon has no job with that id, `GET /jobs/<id>` answers `404` with `ledger`: `"on"` means this machine keeps jobs and has no such job; `"off"` means this machine keeps no jobs, so it cannot say whether the work happened.

## Check it worked

1. **Browser:** send an agent a small task that it must hand to another agent.
2. On the Hub, select **Jobs** in the nav. The **Open** list has a row for the hand-off, with the door **Agent hand-off** and a status line that starts with `working`.
3. Select the row. Its details list a run, and its status is **running**.
4. When the work ends, select **Done**. The job is there, and its status line starts with `done`.
5. **Terminal:** run `curl -s "http://127.0.0.1:18800/jobs?state=all"`. The same job is in `jobs`, with the same `status`.
6. **Browser:** with `requests.dueTimes.mode` set to `"shadow"`, select **Refresh** on the Jobs page. The **Queue** block lists each agent that has open work.

## If something is wrong

- **Jobs is not in the nav:** this machine runs an older AgentX. Update it, then reload the page.
- **The list is empty but agents are working:** the jobs may be on another machine. Check for a **Not read** line above the list; it names each machine that did not answer. A machine with an older AgentX has no jobs to show; update AgentX on it.
- **A job stays `working` with no recent tool call:** open it and look at its runs. A run that is still **running** may be on a long step. If no run is running, the daemon marks the job stalled at its next check.
- **A job is stalled:** open it to see its last run and its tree. Ask the agent that owes it to pick it up, or, when it is your own request, select **See it in Requests** and decide on it there.
- **One of your requests shows `continue` but no time to wake:** this machine runs an AgentX older than the fix; the next minute check after the update hands it back to its request's checks. If it stays, check that `requests.jobs.wake.enabled` is not `false`.
- **A job handed to another machine stays `waiting` for days:** that machine may keep no jobs, or run an older AgentX. Open the job: it shows **Not read from** and that machine's name. The daemon does not mark such a job stalled, because it cannot tell whether the work happened. Update AgentX on that machine, or set `requests.jobs.enabled` to `true` there.
- **The page says "Could not read the jobs":** the machine answered with an error or refused the dashboard's key. Select **Refresh** on the Hub. If it stays, see [It's not answering](../help/its-not-answering.md).
- **No Queue block above the list:** `requests.dueTimes.mode` is `"off"` on that machine, or no agent there has open work.
- **You were looking for your recurring jobs:** they are under **Schedules** in the nav, under **Automation**.
