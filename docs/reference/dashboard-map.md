# Dashboard map

The eight top-level tabs are **Live**, **Operations**, **Monitor**, **Approvals**, **People**, **Activity**, **Workflows**, and **Settings**. Each tab answers a different question. The dashboard also has deeper pages, reached from those tabs or by typing the address. Add each path to your dashboard's address, for example `http://127.0.0.1:4202/mesh`.

## Tabs

| Need | Tab | Path |
|---|---|---|
| See current agent work, resume paused tasks, restart a machine | **Live** (on the Wall) | `/wall#page=live` (`/live` opens it) |
| See machines, peer work and schedules | **Operations** | `/mesh` |
| See what needs a person | **Monitor** | `/monitor` |
| Answer what agents ask you | **Approvals** | `/approvals` |
| See who is connected, their machines and what they asked for: the Wall's [People](../dashboard/people.md) page | **People** | `/wall#page=people` (the old `/people` opens it too) |
| Investigate past work | **Activity** | `/activity` |
| See workflows and their runs, start one, turn one on or off: the Wall's [Workflows](../dashboard/workflows.md) page | **Workflows** (on the Wall) | `/wall#page=workflows` |
| Edit a workflow on the canvas: the Wall's [workflow editor](../dashboard/workflows.md#edit-a-workflow) | **Workflows** (on the Wall) | `/wall#page=editor&e-wf=<id>` (the old `/workflows/editor?id=<id>` opens it too) |
| Follow-ups, every run of a workflow | **Workflows** | `/workflows` |
| Configure agents, channels, schedules, webhooks and tokens | **Settings** | `/admin` |

## Other pages

| Need | Path |
|---|---|
| Run setup again, or add another agent | `/setup` |
| Edit one agent's instructions and skills | `/admin/agents/<agent-id>` |
| Watch or reopen one task | `/tasks/<task-id>?agent=<agent-id>` opens the run on the Wall's **Task** page ([Watch and steer a run](../dashboard/wall.md#watch-and-steer-a-run)) |
| Trace an inbound message, errors, and daemon health | `/admin/health` (the old `/admin/observability` redirects here) |
| See token spend and set monthly budgets ([Wall › Cost](../dashboard/wall.md#see-what-the-fleet-costs)) | `/wall`, **Cost** (`/admin/cost` opens it) |
| Browse the shared wiki by pillar and type ([Wiki](../dashboard/wiki.md)) | `/admin/wiki/` |
| Browse each agent's own wiki pages | `/admin/wiki/agents` |
| Set the wiki notes inbox, the schedules and absorb pass that read it, and see recent notes ([Wiki notes](../jobs/wiki-notes.md)) | `/admin`, **Schedules** tab, **Wiki notes inbox** |
| Turn the wiki's page curator chat off, or choose its agent ([Wiki](../dashboard/wiki.md#ask-an-agent-to-curate-a-page)) | `/admin`, **Agents** tab, **Wiki page curator** |
| See work grouped by project | `/admin/projects` |
| Review the intent ledger (the record of incoming work and which agent it was sent to) | `/admin/ledger` |
| Review the intent graph | `/admin/graph` (also `/graph`) |

## Retired pages

These pages were removed because nobody opened them. Their old addresses still work and open the closest view on the Wall (the main page, `/wall`).

| Old page | Old path | Opens now |
|---|---|---|
| Kanban boards | `/boards` | Wall, **Projects** |
| Words used on screen | `/glossary` | Wall. The words are explained in the [glossary](./glossary.md). |
| Procedures (actions, templates and skills) | `/procedures` | Wall, **Agents** |
| Workflow runs | `/processes` | Wall, **Jobs** |
| Places for the phone's place reminders | `/places` | Wall. Add places in the [phone app](../dashboard/mobile-places.md). |

The browser call page, `/call`, is served by the daemon (default `http://127.0.0.1:18800/call`), not the dashboard.

The route list is a navigation aid, not a list of separate products. A view may be empty until its source integration has produced data.

## Check it worked

1. **Browser:** open `/mesh` on your dashboard. The top bar shows the eight tabs. Select **Live**: the Wall's Live page opens.
2. Open `/admin/health`. It loads, or redirects there from `/admin/observability`.
3. Open `/boards`. The Wall opens on **Projects**.

## If something is wrong

- **A page doesn't load at all:** the dashboard is a separate service from the daemon. **Terminal:** check it is running, then run `agentx daemon status` for the daemon.
- **A page is empty:** the feature behind it may not be set up yet, such as boards or the wiki.
- **An old address opens the Wall instead of a page:** that page was retired; see [Retired pages](#retired-pages).
- **A page looks out of date after an update:** restart the dashboard service as well as the daemon.
