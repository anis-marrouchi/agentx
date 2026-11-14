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

Parent and children are the job's tree. Start at your own request and follow it down to see which agent has each part now, and which part is stalled.

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

The reply has `jobs` (each with its `status` line), `total` and `counts` (jobs per state). `GET /jobs/<id>` gives one job with its `runs`, its `parent` and its `children`. Both only read.

## Check it worked

1. **Browser:** send an agent a small task that it must hand to another agent.
2. On the Hub, select **Jobs** in the nav. The **Open** list has a row for the hand-off, with the door **Agent hand-off** and a status line that starts with `working`.
3. Select the row. Its details list a run, and its status is **running**.
4. When the work ends, select **Done**. The job is there, and its status line starts with `done`.
5. **Terminal:** run `curl -s "http://127.0.0.1:18800/jobs?state=all"`. The same job is in `jobs`, with the same `status`.

## If something is wrong

- **Jobs is not in the nav:** this machine runs an older AgentX. Update it, then reload the page.
- **The list is empty but agents are working:** the jobs may be on another machine. Check for a **Not read** line above the list; it names each machine that did not answer. A machine with an older AgentX has no jobs to show; update AgentX on it.
- **A job stays `working` with no recent tool call:** open it and look at its runs. A run that is still **running** may be on a long step. If no run is running, the daemon marks the job stalled at its next check.
- **A job is stalled:** open it to see its last run and its tree. Ask the agent that owes it to pick it up, or, when it is your own request, select **See it in Requests** and decide on it there.
- **The page says "Could not read the jobs":** the machine answered with an error or refused the dashboard's key. Select **Refresh** on the Hub. If it stays, see [It's not answering](../help/its-not-answering.md).
- **You were looking for your recurring jobs:** they are under **Schedules** in the nav, under **Automation**.
