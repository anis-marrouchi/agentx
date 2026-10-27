# Spike: is the Wall ready to be the default dashboard? (#1430)

Evaluation only. Nothing was built. Date: 2026-10-27, AgentX 0.181.1.

**Short answer:** the Wall is already a good default home page. But the
classic pages cannot be retired yet. **Verdict: ready after 6 fixes.** The
biggest gap is approvals: the Wall shows only the decision cards that belong to
a task, and it has no way to answer them.

## How this was measured

- The code: `src/daemon/ui/pages/wall*.ts`, the classic pages in
  `src/daemon/ui/pages/`, and the routes in `src/daemon/board-dashboard.ts`.
- The isolated three-node demo (`pnpm docs:demo` + `pnpm docs:seed`), driven
  with Playwright. I checked 11 Wall views at 1366 px (light theme) and at
  390 px (dark theme). I recorded console errors, failed requests, horizontal
  overflow, the time until the Wall finished painting, and the HTTP status of
  every internal link. Then I stopped one node and checked the views again.
- **I could not reach the live daemon from this session.** So the timings and
  screenshots below come from the demo, not the live fleet. Two commands
  finish the job on the live fleet (see [Still to measure on the live
  fleet](#still-to-measure-on-the-live-fleet)).

## 1. Coverage

**full**: the Wall does the same job. **partial**: the Wall shows it but
cannot do the writes. **missing**: the Wall has no equivalent. **not needed**:
it is not a daily dashboard page (a tool, a wizard, or a separate space).

| Classic page | Route | Wall equivalent | Coverage | What the Wall lacks | Issue |
|---|---|---|---|---|---|
| Task | `/tasks/:id` | Task page (`#task=`): request, live conversation, Send, Stop, follow-up on a finished job | **full** | none | |
| Live | `/live` | **Live** + **Running now** + Task page | **partial** | Pause, resume or drop a stopped task (`/api/signals/*`). Restart a node or cancel a restart (`/api/node/restart`). Stop voice. | new: A |
| Operations | `/mesh` | **Running now** (nodes, ops details), **Jobs** (today's outcomes, value line, staleness), **Failures** | **partial** | Workflow routines and whether they are overdue, lifetime analytics, drill-down drawers | #1429 (Activity) |
| Approvals | `/approvals` | **Needs you**: only cards that belong to a task, read-only, plus a link out | **partial** | Cards raised outside a task: in the demo, **1 of 6** pending items shows on the Wall. Yes/No/Later, pop-out, settings. Request hand-off and close (only *comment* exists). | new: B |
| Monitor | `/monitor` | A count of attached sessions under **Ops details** | **missing** | Open actions of CLI sessions, retry, clear, register a session | new: B |
| Activity | `/activity` | One post's **Thread**; **Failures** | **missing** | A fleet-wide run log and the map view | #1429 |
| Agent history | `/agents/:id/history` | Agent profile (the posts it owns from the last 7 days) | **partial** | Runs without a request: cron runs, chats. Anything older than 7 days. | #1429 |
| Cost | `/admin/cost` | Spend line on the agent profile; cost on a goal | **partial** | Fleet total, time range, CSV, setting a budget | #1423 |
| Settings | `/admin` (10 tabs) | none: **Dashboard pages** links out | **missing** | Agents, channels, schedules, webhooks, mesh, business, boards, actions, tokens, raw config | #1428 |
| Agent settings | `/admin/agents/:id` | **Agent page** link from the profile | **missing** | Model, skills, MCP servers, handovers, identity files, model key, delete | #1428 |
| Org | `/org` | Read-only role and manager on the profile (#1398) | **partial** | The chart itself, pausing and resuming an agent, editing who reports to whom | #1419, #1420, #1421, #1425 |
| Projects | `/admin/projects` | **Projects** (health cards, capacity, closed per week) | **partial** | Creating, editing or deleting projects, and linking workflows, contacts and clauses. Two project models exist: `dashboard.wall.projects` and business projects. | new: E |
| Workflows | `/workflows` | Failed runs under **Failures** | **partial** | The list, Run now, pause, resume or cancel a run, required-workflow settings | new: E |
| Workflow editor | `/workflows/editor` | none | **not needed** | It is an editing tool. Keep it as a deep link. | |
| Reviews / graph | `/admin/graph` | **Reviews** (pending, approved, rejected, read-only) | **partial** | Approve, reject, taxonomy, schema | new: F |
| People | `/people` | none | **missing** | Who paired which device; ending a device session | #1418 (people in the org) covers part |
| Boards | `/boards` | **Projects** shows the same work another way | **missing** | Kanban, drag, AI draft. Retire it or keep it as a classic page based on usage, not on porting. | new: E |
| Observability | `/admin/health` | Agent errors under **Failures** | **missing** | Live logs, doctor, 24-hour and 7-day charts | #1428 (as a Settings tab) |
| Guests | `/guests` | none | **missing** | Pause, resume or end a guest | new: E |
| Places | `/places` | none (the phone app has Places) | **not needed** | It belongs with the phone app | |
| Procedures, Processes, Glossary | `/procedures`, `/processes`, `/glossary` | none | **not needed** | Reference pages with no writes. Retire them or keep them based on usage. | new: E |
| Ledger | `/admin/ledger` | none | **not needed** | An engineering tool | |
| Wiki | `/admin/wiki` | Its own space, with links from Reviews | **not needed** | none | |
| Setup | `/setup` | `/` sends a machine with no agents there | **not needed** | none | |
| Portfolio, member, app, client | `/portfolio`, `/member`, `/app` | Their own spaces | **not needed** | none | |

Score for the 18 daily pages (everything not marked *not needed*): **1 full,
9 partial, 8 missing.**

## 2. Daily use: when must the owner leave the Wall?

| Step in a normal day | On the Wall? | Where the owner has to go |
|---|---|---|
| Check what needs them | **No** | **Needs you** counts only cards that belong to a task (1 of 6 in the demo). The rest, such as a new schedule request, a deploy left stopped, or a LinkedIn post to approve, are only on `/approvals`. Open actions of CLI sessions are only on `/monitor`. |
| Approve or decline | **No** | Every card has a link out to `/approvals`. The Wall has no buttons on a card. |
| Follow running work | **Yes** | Live, Running now and the Task page (watch, Send, Stop). The owner leaves only to resume or drop a stopped task, or to restart a node: `/live`. |
| See cost | **Partly** | The agent profile shows one agent's spend this month. For the fleet total, a time range, or to raise a budget: `/admin/cost`. |
| Change a setting | **No** | Everything is on `/admin` and `/admin/agents/:id`. Pausing an agent is on `/org`. A recurring job cannot be paused from the Wall: **Pause** and **Archive** on Jobs are greyed out, and Settings › Schedules can only add or delete a job. Turning a job off is possible only in the raw config editor (Settings › Advanced). |
| Look back at what ran | **Partly** | A post's thread covers work tied to a request. For cron runs, chats and anything older than 7 days: `/activity` or `/agents/:id/history`. |
| Give an agent a task | **Yes** | Composer, Creator, comment with an @mention, Call, Space |

Also, the Wall's own **Dashboard** nav item opens `/live`. Once the classic
pages go, it needs a new target or must be removed.

## 3. Quality (isolated demo)

| Check | Result |
|---|---|
| Console errors and failed requests | **None** in 22 page loads (11 views × 2 widths), and none with one node stopped. |
| Broken links | **None.** All 18 internal links found on the Wall returned 200. |
| Time until painted | 70–240 ms per view. `/api/admin/wall?peer=fleet` answers in 4–6 ms with 8.5 KB (`timings=1`: 3 ms in total). Demo data is tiny, so this says nothing about the live fleet. |
| Phone layout at 390 px | The page never scrolls sideways, and the bottom bar and the round **+** work. **One defect:** the status tabs scroll inside their strip, so **All** is cut off and the search/filter button sits at x=445, off-screen. Nothing shows it is there (see `phone-feed.png`, `phone-list.png`). On the feed, 25 links and buttons are smaller than 24 px in one dimension, mostly inline run-id links. |
| Dark and light | Both render. The Wall keeps its own theme choice. |
| Unreachable node | Good. **Running now** marks the node red, **unreachable, last data …**, and the other nodes still show (`down-running.png`). |
| Empty states | Present and worded: Live (*No session or job is running…*), Jobs per node (*No recurring jobs.*), Failures (*No failed cron runs.*). |
| Counts that disagree | **Needs you 1** against 6 pending items on Approvals. A Wall that is the only dashboard must not under-count what waits on the owner. |

Screenshots (demo data) are in [`wall-default-readiness/`](wall-default-readiness/):
`desktop-needs.png`, `desktop-jobs.png`, `desktop-live.png`, `phone-feed.png`,
`phone-list.png`, `down-running.png`.

## 4. Verdict: ready after 6 fixes

The Wall stays the default; it already is, and it holds up. Retire the classic
pages **one by one**: each one goes only after its port ships **and** it passes the
[surface-reduction bar](surface-reduction.md), meaning no use in 30 days on
both nodes. The long-tail pages (Boards, Guests, Procedures, Processes,
Glossary, Ledger, workflow editor) can stay behind **Dashboard pages**. They
do not block the decision.

Blockers, ranked by how often the owner hits them:

1. **Approvals on the Wall.** Show every pending card and answer it from
   **Needs you**. Proposed new issue **B**.
2. **Settings.** #1428. Include the agent settings page (`/admin/agents/:id`)
   and, as a tab, the logs and doctor from `/admin/health`.
3. **Cost.** #1423.
4. **Activity.** #1429. Include the per-agent history and runs that have no
   request.
5. **Stopped tasks and node restart on the Wall.** Proposed new issue **A**.
6. **Search and filters off-screen on phones.** Proposed new issue **D**.
   It is small, but on a phone the filters cannot be found.

Not blocking, but needed before the matching classic page goes: Org editing
(#1419, #1420, #1421, #1425), pausing and archiving jobs (**C**), and
deciding on Reviews (**F**).

## Proposed new issues (not filed)

- **A. Feat: Wall – resume or drop stopped tasks and restart a node from Running now.** Bring the `/live` controls (`/api/signals/{stop,resume,drop}`, `/api/node/restart` and cancel) to the node cards and the Task page.
- **B. Feat: Wall – answer every decision card from Needs you.** List the cards raised outside a task and the open actions of CLI sessions, add Yes, No and Later on each card, and make the **Needs you** count match Approvals.
- **C. Feat: Wall – pause and archive recurring jobs on Jobs.** Turn on the greyed buttons (phase 2 in CLAUDE.md). Today a job can be turned off only in the raw config editor.
- **D. Fix: Wall – status tabs hide All and the filter button at 390 px.** Wrap the tabs or pin the search button so it stays visible on a phone.
- **E. Task: Wall – measure use of each classic page on the live fleet, then retire or port.** Run `agentx usage surfaces --kind page --days 30` on both nodes. Decide the fate of Boards, Guests, Procedures, Processes, Glossary and the Workflows page. Settle the two project models. Choose the new target of the Wall's **Dashboard** link.
- **F. Feat: Wall – approve or reject a classification on Reviews.** Today you approve or reject only on `/admin/graph` or with `agentx graph review`.

## Still to measure on the live fleet

Run these on the machine that serves the dashboard:

1. **Terminal:** `curl -H "Authorization: Bearer <dashboard token>" "<dashboard>/api/admin/wall?peer=fleet&timings=1"`. Note `timings.totalMs` and when each peer answered.
2. **Terminal:** `agentx usage surfaces --kind page --days 30`, on each node. This shows which classic pages anyone still opens.
3. **Browser:** open `/wall` at 390 px and at full width, and take the same screenshots as above.
