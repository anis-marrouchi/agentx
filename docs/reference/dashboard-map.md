# Dashboard map

The dashboard opens on the [Hub](../dashboard/hub.md). Every view below is a page of the Hub, picked in its nav on the left (on a phone: the bar at the bottom, and **More** for the rest). Add each path to your dashboard's address, for example `http://127.0.0.1:4202/hub#page=live`.

## Hub pages

| Need | Nav item | Path |
|---|---|---|
| Every task as a post, with its thread | **Hub** | `/hub` |
| What waits on you: decisions, drafts, requests ([Needs you](../dashboard/hub.md#see-what-waits-on-you)) | **Needs you** | `/hub#status=open&view=decide` |
| Live sessions, paused tasks, each machine, restart when idle ([Live](../dashboard/live.md)) | **Live** | `/hub#page=live` |
| What each machine runs at this moment ([Running now](../dashboard/hub.md#running-now)) | **Running now** | `/hub#page=running` |
| Every project with its open work ([Projects](../dashboard/hub.md#see-every-project-at-once)) | **Projects** | `/hub#status=open&view=projects` |
| What the agents ran, newest first ([Activity](../dashboard/activity.md)) | **Activity** | `/hub#page=activity` |
| Recurring jobs and their value line ([Jobs](../dashboard/hub.md#see-recurring-jobs-and-their-value-line)) | **Jobs** | `/hub#status=open&view=jobs` |
| Workflows and their runs; start one, turn one on or off ([Workflows](../dashboard/workflows.md)) | **Workflows** | `/hub#page=workflows` |
| Edit a workflow on the canvas ([workflow editor](../dashboard/workflows.md#edit-a-workflow)) | **Workflows**, then **Open in the editor** | `/hub#page=editor&e-wf=<id>` |
| Classifications waiting for review ([Reviews](../dashboard/hub.md#review-classifications)) | **Reviews** | `/hub#status=open&view=reviews` |
| Failed runs and reported issues ([Failures](../dashboard/hub.md#see-failures)) | **Failures** | `/hub#status=open&view=failures` |
| Every agent, and one agent's profile ([Agents](../dashboard/hub.md#see-every-agent)) | **Agents** | `/hub#page=agents` |
| Who talks to the agents ([People](../dashboard/people.md)) | **People** | `/hub#page=people` |
| The org chart, to read ([Org](../dashboard/org.md)) | **Org** | `/hub#page=org` |
| Token spend and monthly budgets ([Cost](../dashboard/hub.md#see-what-the-fleet-costs)) | **Cost** | `/hub#status=open&view=cost` |
| Settings, for the owner ([Change settings](../dashboard/hub.md#change-settings)) | **Settings** | `/hub#page=settings` |
| Watch or steer one task ([Watch and steer a run](../dashboard/hub.md#watch-and-steer-a-run)) | a post, then its run | `/tasks/<task-id>?agent=<agent-id>` opens it |

## Old addresses that open the Hub

These classic pages are gone. Their addresses still work and open the matching Hub page, so old bookmarks and links in old messages keep working.

| Old address | Opens |
|---|---|
| `/wall` | **Hub** (`/hub`) |
| `/live` | **Live** |
| `/people` | **People** |
| `/admin/cost` | **Cost** |
| `/approvals` | **Needs you** |
| `/agents/<agent-id>/history` | the agent's profile, with its **Activity** open |
| `/workflows/editor?id=<id>` | the workflow editor |

## Pages the Hub does not replace yet

These pages are still served, because the Hub does not do everything they do yet. Each one goes when the Hub matches it.

| Page | Path | What only it has |
|---|---|---|
| [Settings](../dashboard/settings.md) | `/admin`, `/admin/agents/<agent-id>` | The settings the Hub's Settings page does not have yet, such as the wiki notes inbox ([Wiki notes](../jobs/wiki-notes.md)) and the wiki page curator ([Wiki](../dashboard/wiki.md#ask-an-agent-to-curate-a-page)) |
| Health | `/admin/health` (the old `/admin/observability` redirects here) | Route traces, errors and daemon health. Errors, Routing, Rotations and Doctor are also in the Hub's **Settings** › **Diagnostics** |
| Guests | `/guests` | Letting another organisation into part of your mesh ([guest mesh](../jobs/guest-mesh.md)) |
| [Monitor](../dashboard/monitor.md) | `/monitor` | Task reviews, and connecting a CLI session by hand |
| [Operations](../dashboard/operations.md) | `/mesh` | A run's full lifetime, Routines with their stale flags, run analytics |
| [Activity timeline](../dashboard/activity.md) | `/activity` | The timeline lanes and the Map |
| [Workflows](../dashboard/workflows.md) | `/workflows` | Follow-ups, and every run of a workflow |
| Intent graph | `/admin/graph` (also `/graph`) | Editing the taxonomy. Pending classifications are decided on the Hub's **Reviews** |
| Projects | `/admin/projects` | Creating and editing projects |
| Intent ledger | `/admin/ledger` | The record of incoming work and which agent it was sent to |

Tool pages stay on purpose, outside the Hub: `/setup` (run setup again or add an agent), the org chart editor at `/org` ([Edit the org chart](../dashboard/org.md#edit-the-org-chart)), `/login` (sign in from another device) and the wiki at `/admin/wiki/` ([Wiki](../dashboard/wiki.md); each agent's own pages at `/admin/wiki/agents`).

## Retired pages

These pages were removed because nobody opened them. Their old addresses still work and open the closest view on the Hub (the main page, `/hub`).

| Old page | Old path | Opens now |
|---|---|---|
| Kanban boards | `/boards` | Hub, **Projects** |
| Words used on screen | `/glossary` | Hub. The words are explained in the [glossary](./glossary.md). |
| Procedures (actions, templates and skills) | `/procedures` | Hub, **Agents** |
| Workflow runs | `/processes` | Hub, **Jobs** |
| Places for the phone's place reminders | `/places` | Hub. Add places in the [phone app](../dashboard/mobile-places.md). |

The browser call page, `/call`, is served by the daemon (default `http://127.0.0.1:18800/call`), not the dashboard.

The route list is a navigation aid, not a list of separate products. A view may be empty until its source integration has produced data.

## Check it worked

1. **Browser:** open `/hub` on your dashboard. The Hub opens with its nav on the left. Select **Live**: the Live page opens.
2. **Browser:** open `/live`. The same Live page opens.
3. **Browser:** open `/boards`. The Hub opens on **Projects**.

## If something is wrong

- **A page doesn't load at all:** the dashboard is a separate service from the daemon. **Terminal:** check it is running, then run `agentx daemon status` for the daemon.
- **A page is empty:** the feature behind it may not be set up yet, such as boards or the wiki.
- **An old address opens the Hub instead of a page:** that page moved to the Hub or was retired; see [Old addresses that open the Hub](#old-addresses-that-open-the-hub) and [Retired pages](#retired-pages).
- **A page looks out of date after an update:** restart the dashboard service as well as the daemon.
