# Wall v2 designs, round 2 (#1451)

Design proposals for review. Nothing here is built. Per #1451 (epic #1449), a page gets built only after Anis accepts its design.

Every screen is in this note as an image (under `img/wall-v2-round-2/`), so it opens on GitHub for anyone with access to the repo. Comment here or on #1451. The same screens are also on a canvas (https://claude.ai/artifact/JUeGggfTkuKnqZd5rKGMbn), but this note does not need it: the canvas is not shared, so most people cannot open it.

All data on the screens is made up: agents (Forge, Quill, Scout, Atlas, Relay, Pulse, Harbor), people (Dana, Lee, Kim, Ari, "Client A contact"), machines (studio, mini, cloud-1) and amounts. The look is the Wall space as it ships: its tokens in `src/daemon/ui/pages/wall-space.ts`, system font, white or black page, blue accent.

## The screens

Each page has a desktop screen (1280 px) and a phone screen (390 px), in light. Cost on the phone is drawn in dark. Pages that write show the owner's view with the confirm step open on desktop. The phone shows what anyone else sees (read only), except Settings, which only the owner gets.

| # | Page | Build issue | Desktop | Phone |
|---|---|---|---|---|
| 0 | Nav and build line | #1444 | The Wall feed with the new nav and the build line, hover text open<br>[<img src="img/wall-v2-round-2/00-nav-and-build-line.png" width="240" alt="Wall feed with the new nav and build line">](img/wall-v2-round-2/00-nav-and-build-line.png) | More open, build line, restart pending<br>[<img src="img/wall-v2-round-2/00-nav-phone-more-open.png" width="110" alt="Phone with More open">](img/wall-v2-round-2/00-nav-phone-more-open.png) |
| 1 | Decisions and inbox | #1440 | Owner answering a card in place, confirm open<br>[<img src="img/wall-v2-round-2/01-decisions.png" width="240" alt="Decisions, owner answering a card">](img/wall-v2-round-2/01-decisions.png) | Anyone else, read only<br>[<img src="img/wall-v2-round-2/01-decisions-phone.png" width="110" alt="Decisions on a phone, read only">](img/wall-v2-round-2/01-decisions-phone.png) |
| 2 | Settings | #1428 | Owner editing one agent, confirm open<br>[<img src="img/wall-v2-round-2/02-settings.png" width="240" alt="Settings, editing one agent">](img/wall-v2-round-2/02-settings.png) | Health and the section list; Guests with End confirm<br>[<img src="img/wall-v2-round-2/02-settings-phone-health.png" width="110" alt="Settings on a phone, Health">](img/wall-v2-round-2/02-settings-phone-health.png) [<img src="img/wall-v2-round-2/02-settings-phone-guests.png" width="110" alt="Settings on a phone, Guests">](img/wall-v2-round-2/02-settings-phone-guests.png) |
| 3 | Activity | #1429 | Runs across the fleet, one run open<br>[<img src="img/wall-v2-round-2/03-activity.png" width="240" alt="Activity, one run open">](img/wall-v2-round-2/03-activity.png) | One agent's history (profile tab)<br>[<img src="img/wall-v2-round-2/03-activity-phone.png" width="110" alt="One agent history on a phone">](img/wall-v2-round-2/03-activity-phone.png) |
| 4 | Cost | #1423 | Per project, period switch, budget line<br>[<img src="img/wall-v2-round-2/04-cost.png" width="240" alt="Cost per project">](img/wall-v2-round-2/04-cost.png) | Per agent, dark<br>[<img src="img/wall-v2-round-2/04-cost-phone-dark.png" width="110" alt="Cost on a phone, dark">](img/wall-v2-round-2/04-cost-phone-dark.png) |
| 5 | Org | #1419, #1420, #1421 | Chart with the owner's setup panel, a move being confirmed<br>[<img src="img/wall-v2-round-2/05-org.png" width="240" alt="Org chart with the setup panel">](img/wall-v2-round-2/05-org.png) | Indented list, read only<br>[<img src="img/wall-v2-round-2/05-org-phone.png" width="110" alt="Org on a phone, read only">](img/wall-v2-round-2/05-org-phone.png) |
| 6 | People | #1441, #1425 | The list and Dana's page<br>[<img src="img/wall-v2-round-2/06-people.png" width="240" alt="People list and a person page">](img/wall-v2-round-2/06-people.png) | Dana's page<br>[<img src="img/wall-v2-round-2/06-people-phone.png" width="110" alt="A person page on a phone">](img/wall-v2-round-2/06-people-phone.png) |
| 7 | Workflows | #1445 | A failed run open, Start confirm open<br>[<img src="img/wall-v2-round-2/07-workflows.png" width="240" alt="Workflows, a failed run open">](img/wall-v2-round-2/07-workflows.png) | Read only<br>[<img src="img/wall-v2-round-2/07-workflows-phone.png" width="110" alt="Workflows on a phone, read only">](img/wall-v2-round-2/07-workflows-phone.png) |
| – | Live | #1439 | Restart when idle (confirm open), restart waiting, Resume, attached sessions<br>[<img src="img/wall-v2-round-2/08-live.png" width="240" alt="Live, Machines tab">](img/wall-v2-round-2/08-live.png) | Restart waiting, Drop confirm<br>[<img src="img/wall-v2-round-2/08-live-phone.png" width="110" alt="Live on a phone">](img/wall-v2-round-2/08-live-phone.png) |
| – | States | all | Empty, loading and error for each page, and for the build line<br>[<img src="img/wall-v2-round-2/09-states.png" width="240" alt="Empty, loading and error states">](img/wall-v2-round-2/09-states.png) | |

Two parts are drawn once and reused on every screen: **Nav** (desktop) and **PBar** (phone bar).

## 0. Nav and the build line (#1444)

![Desktop: the Wall feed with the new nav and the build line, hover text open](img/wall-v2-round-2/00-nav-and-build-line.png)

<img src="img/wall-v2-round-2/00-nav-phone-more-open.png" width="390" alt="Phone: More open, build line, restart pending">

**Nav.** Seven new destinations do not fit as one flat list (it would be 16 items). The proposal groups them under small labels, keeps the item height a little lower (42 px instead of 50 px), and keeps the counts:

- (top) **Wall**, **Needs you**
- **Work:** Live, Running now, Projects, **Activity**
- **Automation:** Jobs, **Workflows**, Reviews, Failures
- **Fleet:** Agents, **People**, **Org**, Cost
- **Owner:** **Settings** (gear), shown to the owner only, as #1428 asks
- Dashboard, until the classic pages are gone
- **New post**, then the light/dark box

Decisions does not get its own item: **Needs you** becomes the Decisions and inbox page (screen 1). On the phone, the bar stays Wall, Needs you, Running now, Projects, More. **More** opens a sheet with the same three groups, plus Settings, Dashboard and Light / dark.

**Build line.** The Wall has no top bar, so the version goes on the right of the title row of every page: `v0.182.0 · 4f2c9a1 · since Oct 27, 08:14`. On a phone it is one small line under the title. It is the same data and the same one-minute refresh as the classic top bar (`/api/node/build`).

- **Restart pending** is an amber chip after it, under the classic rule (the code on disk is newer than the running daemon).
- Hovering or focusing it shows the classic hover text: "The code on disk is newer than the running daemon. Restart the daemon to load it. Node: studio". It adds one link: **Restart when idle on Live**.
- While the line has not loaded, nothing is drawn and the title row keeps its height. If the build call fails, the last answer stays, with "as of 09:40".

## 1. Decisions and inbox (#1440)

![Desktop: the owner answering a card in place, confirm open](img/wall-v2-round-2/01-decisions.png)

<img src="img/wall-v2-round-2/01-decisions-phone.png" width="390" alt="Phone: anyone else, read only">

- **Needs you** opens this page. Tabs: **Waiting**, **Put off** (Later) and **Answered** (the history). The count under the title matches the Desk and the digest.
- Chips by kind: Decisions, Schedules, Memory, Wiki, Drafts, Requests and Reviews. Classifier reviews (`/admin/graph`) show here too, so the Wall total equals `/approvals`.
- **Answer in place.** Each card has its buttons on the card: Yes / No / Later, the choices when there are some (the advice is marked), and **Reply instead**. Memory facts get Keep / Drop. Requests get a reply box, Hand to…, Done and Drop.
- **What it unblocks** is one line on the card: the post, how long it has waited, and the runs held behind it.
- **Confirm.** Pressing an answer opens a one-line confirm under the buttons, which says exactly what is sent ("Send Quill: Yes, send Tuesday at 09:00") and that it is recorded. **Confirm** sends it through the same API as `/approvals`, then the card leaves the list and the post updates without a reload.
- Details, the full draft and "what Yes and No do" stay folded.
- The side column: what waits on you (posts, held runs, the oldest wait), **Answered today** with a link to the full history, and how the inbox reaches you (with a link to Settings).
- **Anyone else** sees the same cards with no buttons, under "Only the owner can answer these" (the phone screen). The title reads "Needs the owner".

## 2. Settings (#1428)

![Desktop: the owner editing one agent, confirm open](img/wall-v2-round-2/02-settings.png)

<img src="img/wall-v2-round-2/02-settings-phone-health.png" width="390" alt="Phone: Health and the section list"> <img src="img/wall-v2-round-2/02-settings-phone-guests.png" width="390" alt="Phone: Guests, ending a grant">

- Owner only. Others get no nav item. Opening the address anyway shows "Settings are for the owner" (see Questions).
- Two columns inside the page: the section list, then the chosen section. The sections are grouped: **Fleet** (Agents, Channels, Schedules, Webhooks, Mesh, Boards, Actions, Inbox), **Access** (Guests, People, Tokens) and **Machines** (Health, Advanced). A section that needs attention has an amber count.
- **One agent's settings** keeps the classic tabs (Overview, Personality, Skills, Channels, Handovers), with the picture from #1425 (change or remove) and the on/off switch on top.
- **The edit state.** A changed field turns blue and says what it was. A bar at the bottom says "2 changes not saved" and whether they need a restart, with **Discard** and **Save…**.
- **Confirm.** **Save…** opens a dialog with the before and after of each change. It also says what else moves: an agent's recurring jobs follow its model, as CLAUDE.md requires, and spend may change against the agent's cap. Then **Save changes**. After that the page shows "Saved", or the error with the form kept as it was.
- **Health** (phone) is a section of its own. It holds the classic health strip (agents online, channels connected, needs attention, active tokens), one line per machine (answer time, restart pending, or "not answering since…"), and what to fix, with a link.
- **Guests** (phone): one card per grant, with Pause and End. End opens a sheet that says what happens, with **End access** in red and **Keep it**. A grant waiting for approval gets Approve / Decline.
- On a phone the section list is its own screen, and you tap into a section.

## 3. Activity (#1429)

![Desktop: runs across the fleet, one run open](img/wall-v2-round-2/03-activity.png)

<img src="img/wall-v2-round-2/03-activity-phone.png" width="390" alt="Phone: one agent's history">

- A feed of runs, newest first. Each row has the agent, machine and time, what it worked on, the outcome, **what started it** (a message on the Wall, a job, a request by a person, a workflow), how long it took, its cost and its project. A run with no cost shows "–".
- Tabs by outcome (All, Done, Failed, Waiting, Stopped). Filters: agent, project and source, and a period switch of 24 h / 7 d / 30 d. All of them are kept in the URL.
- **Opening a run** expands it in place. It shows the result (or the error), what was asked, the steps, where it ran, the review findings, and links: **Open the run** (the Wall Task page), **The job**, **Full log**. The full output stays on the log page, so the list holds only short summaries.
- **Feed / Timeline** switch beside the title. Timeline is the classic lane view; the Map stays on classic `/activity`, linked from the side column.
- **One agent's history** is an **Activity** tab on the agent's Wall profile (phone screen): a short summary (runs, failed, agent time, cost), then the same rows filtered to that agent.
- A machine that does not answer keeps its runs, under an amber line "shown as of 09:12".

## 4. Cost (#1423, already built)

![Desktop: per project, period switch, budget line](img/wall-v2-round-2/04-cost.png)

<img src="img/wall-v2-round-2/04-cost-phone-dark.png" width="390" alt="Phone: per agent, dark theme">

The Wall Cost page is built (#1434). The design shows what to add so that classic `/admin/cost` can go:

- **Per project**, beside Fleet and Per agent: the daily bars stack by project, and a table gives spend, change, share, agents and cost per run. "No project" is its own row.
- **The budget line** drawn on the chart: the daily budget, which is what is left of the month cap spread over the days left. The side column says where the month ends at this pace ("near $206, $6 over the cap").
- The period switch moves into the title row.
- **Export as CSV** and **Change caps in Settings** are links in the side column. Caps are edited in Settings, not here.
- Phone (dark): the month total against the cap, three numbers, then one row per agent with its cap bar.

## 5. Org (#1419, #1420, #1421)

![Desktop: the chart with the owner's setup panel, a move being confirmed](img/wall-v2-round-2/05-org.png)

<img src="img/wall-v2-round-2/05-org-phone.png" width="390" alt="Phone: indented list, read only">

- A top-down chart built from **reports to**. Cards show the picture, name, role and status. People have a grey card and a "person" chip.
- **Dotted line** is a dashed blue line, behind **Show dotted lines**. **Acts for** is a chip on the agent's card ("acts for Dana"), not a line. The legend sits above the chart, with zoom buttons.
- **Setup on the same page (owner).** The owner sees an **Edit the org** panel in the side column. Pick a member (or drag its card), then set Reports to, Dotted line to and Acts for (agents only). Also **Add a person**, **Add an agent**, and **Place** for anyone not in the chart yet.
- **Confirm.** Moving someone shows where they will land on the chart and one line on what changes ("Scout will report to Atlas, not Forge. When Scout is stuck, it asks Atlas first"). Then **Save the move** or **Cancel**.
- **Anyone else** (phone): an indented list with thread lines, collapsible branches, no panel, and "Only the owner can change the org".

## 6. People (#1441, #1425)

![Desktop: the list and Dana's page](img/wall-v2-round-2/06-people.png)

<img src="img/wall-v2-round-2/06-people-phone.png" width="390" alt="Phone: Dana's page">

- The list: picture (initials until #1425 lands), name, role (Owner, Member, Client, Guest), machines, and how many requests each person **owns** and **waits on**. Tabs by role.
- **A person's page:** picture, role, who they report to, channels and which agents they may use. Then:
  - **Owns:** their open requests, with state, agent and age.
  - **Waits on:** both ways, what an agent waits on from them, and what they wait on.
  - **Machines:** state, paired, last use.
  - **Latest turns,** with a link to their runs in Activity.
- **Edit in Settings** for the owner. The page itself is read only, except **End access** on a machine (see Questions).
- Phone: the same page, as tabs (Owns, Waits, Machines, Turns).

## 7. Workflows (#1445)

![Desktop: a failed run open, Start confirm open](img/wall-v2-round-2/07-workflows.png)

<img src="img/wall-v2-round-2/07-workflows-phone.png" width="390" alt="Phone: read only">

- One row per workflow: name, what starts it (in words), its agents and project, the last runs as squares, its state, and an on/off switch (owner).
- Tabs: All, Running, Failed, Off. A filter box and a project filter.
- A workflow that is off and has not run for 30 days is marked **looks stale**, as Jobs does in round 1.
- **Opening a workflow** shows its last run step by step (who did each step, how long it took, where it stopped), with **Run again**, **Open in the editor ↗** and **All 38 runs**. The editor stays a tool page and opens in its own tab.
- **Confirm (owner).** **Run…** opens a dialog with the workflow's inputs as a form (JSON and "run even if one is running" folded), one line on what will happen, then **Start the run**.
- **Anyone else** (phone): the same list with no switches or Run buttons, under "Only the owner can start, turn on or turn off a workflow".
- Failures links here, not to classic `/workflows`.

## Live: resume and restart when idle (#1439)

![Desktop: restart when idle, stopped tasks and attached sessions](img/wall-v2-round-2/08-live.png)

<img src="img/wall-v2-round-2/08-live-phone.png" width="390" alt="Phone: restart waiting, Drop confirm">

Drawn on the Live page, in a **Machines** tab next to Spaces and Next jobs:

- One block per machine: version, uptime, and **Restart when idle**. Pressing it opens a confirm: what runs now, and that new runs wait. After that the chip reads **Restart waiting · 1 running · until 10:05**, with **Cancel restart**.
- A machine that does not answer has the button turned off, and says why.
- **Stopped tasks:** what stopped and when, with **Resume** and **Drop…** (Drop opens a confirm sheet).
- **Attached code sessions:** session, agent, machine, start time, and **Connect a CLI session**.
- Anyone else sees the blocks, tasks and sessions without the buttons.

## Empty, loading and error states

One board covers the empty, loading and error state of every page, and of the build line.

![Empty, loading and error states for every page](img/wall-v2-round-2/09-states.png)

## Questions for Anis

1. **Nav:** grouping under Work / Automation / Fleet / Owner, or a flat list? Should **Running now** fold into **Live** now that Live has a Machines tab?
2. **Needs you = Decisions:** is it fine that Needs you becomes the Decisions page (with Answered as history), instead of a feed filter plus a separate Decide view?
3. **Confirm on every answer:** a one-line confirm on each Yes / No adds one tap. Keep it for all cards, or only for cards that send something outside (emails, posts) and for Drop?
4. **Settings for others:** no item at all (as #1428 says), or a read-only Health section for members?
5. **Cost per project:** run costs do not carry a project today, so this needs a new grouping in the cost endpoint. Build it in #1423's follow-up, or leave Per project out for now?
6. **People and End access:** #1441 says People is read only, but classic `/people` can end a machine's access. Keep **End access** on the person's page (owner only, with a confirm), or move it to Settings › People?
7. **Org setup:** drag and drop on desktop plus the fields, or only the fields (simpler, and works the same on a phone)?
8. **Workflows on the phone:** owner controls (on/off, Run) on the phone too, or desktop only?
9. **Build line on the phone:** one line under every title, or only on Live and Settings to save space?

## Next round

Comments on the canvas or on #1451 become round 3. Once a screen is accepted, its build issue links it, and it is built on the Wall space as it is today: server-rendered HTML, shared tokens and plain browser JavaScript, no build step.
