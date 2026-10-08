# Dashboard map

The eight top-level tabs are **Live**, **Operations**, **Monitor**, **Approvals**, **People**, **Activity**, **Workflows**, and **Settings**. Each tab answers a different question. The dashboard also has deeper pages, reached from those tabs or by typing the address. Add each path to your dashboard's address, for example `http://127.0.0.1:4202/live`.

## Tabs

| Need | Tab | Path |
|---|---|---|
| See current agent work | **Live** | `/live` |
| See machines, peer work and schedules | **Operations** | `/mesh` |
| See what needs a person | **Monitor** | `/monitor` |
| Answer what agents ask you | **Approvals** | `/approvals` |
| See who is connected, their machines and what they asked for | **People** | `/people` |
| Investigate past work | **Activity** | `/activity` |
| Edit a workflow | **Workflows** | `/workflows` (editor: `/workflows/editor`) |
| Configure agents, channels, schedules, webhooks and tokens | **Settings** | `/admin` |

## Other pages

| Need | Path |
|---|---|
| Run setup again, or add another agent | `/setup` |
| Edit one agent's instructions and skills | `/admin/agents/<agent-id>` |
| Watch or reopen one task | `/tasks/<task-id>` |
| Trace an inbound message, errors, and daemon health | `/admin/health` (the old `/admin/observability` redirects here) |
| See token spend | `/admin/cost` |
| Browse the shared wiki by pillar and type ([Wiki](../dashboard/wiki.md)) | `/admin/wiki/` |
| Browse each agent's own wiki pages | `/admin/wiki/agents` |
| Set the wiki notes inbox and see recent notes ([Wiki notes](../jobs/wiki-notes.md)) | `/admin`, **Schedules** tab, **Wiki notes inbox** |
| See work grouped by project | `/admin/projects` |
| Review the intent ledger (the record of incoming work and which agent it was sent to) | `/admin/ledger` |
| Review the intent graph | `/admin/graph` (also `/graph`) |
| Kanban boards, when configured | `/boards` |
| Procedures learned from activity | `/procedures` |
| Running agent processes | `/processes` |
| Words used on screen | `/glossary` |
| Places for the phone's place reminders | `/places` |

The browser call page, `/call`, is served by the daemon (default `http://127.0.0.1:18800/call`), not the dashboard.

The route list is a navigation aid, not a list of separate products. A view may be empty until its source integration has produced data.

## Check it worked

1. **Browser:** open `/live` on your dashboard. The top bar shows the eight tabs.
2. Open `/admin/health`. It loads, or redirects there from `/admin/observability`.

## If something is wrong

- **A page doesn't load at all:** the dashboard is a separate service from the daemon. **Terminal:** check it is running, then run `agentx daemon status` for the daemon.
- **A page is empty:** the feature behind it may not be set up yet, such as boards or the wiki.
- **A page looks out of date after an update:** restart the dashboard service as well as the daemon.
