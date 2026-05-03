# Boards (Kanban)

Path: `/boards`

Column-based view over configured `boards[]`. Default columns are GitLab-style: Open / To Do / Doing / On Hold / Review / Closed, driving the `Status::*` scoped-label taxonomy.

For the column model, label conventions, and reconciler behaviour, see [Boards & Kanban](/reference/boards) — that page is the canonical reference. This page covers the dashboard surface specifically.

## What you'll see

- **Subheader**: board picker (one entry per `boards[]`), search box, label/milestone/assignee filter chips.
- **Columns**: rendered from `boards[<id>].columns[]`. Each card is one issue; assignee avatars overlap on the right; primary-tool label badge top-left.
- **Issue modal**: click any card. Shows description (markdown), labels, comments, and an inline "agent activity" drawer pulling from the daemon's task history filtered by issue id.
- **Create-issue button**: opens a slide-over form that POSTs to GitLab. The `dashboard.draftAgent` (if configured) drafts a description from the title.

## What you can do

- **Drag-drop** between columns. The transition computes label add/remove pairs from `transitionDiff()` (`src/boards/config.ts`); scoped-label columns are mutually exclusive by prefix, so adding `Status::Doing` strips `Status::To Do` automatically. Closed-column lands close the issue; dragging out reopens.
- **Edit inline** — title, labels, milestone, assignees — without opening the modal.
- **Filter by primary tool**: every board has an optional `primaryToolLabel` ANDed into every query and rendered as a baseline chip.
- **Stale-Doing badge**: cards in `Doing` past the reconciler's threshold get a clock badge. Configure via `boards[].reconciliation` (see [config schema](../config-schema#boards)).

## Common tasks

| You want to… | Do this |
|---|---|
| Add a board for a new GitLab project | `agentx board add <id> --name "..." --projects "group/repo"` |
| Change the columns | Edit `boards[<id>].columns[]` in `agentx.json`. Restart the dashboard or save via `agentx config set` to hot-reload |
| See which agent owns a card | The assignee avatar resolves via `channels.gitlab.agentMappings[].gitlabUsernames`. Hover for the agent id |
| Bulk-import issues into the local backlog | Use `agentx backlog import` and switch `business.workSource.type=backlog`. Mutations on imported items sync upstream automatically |

## Troubleshooting

- **Empty board.** No issues in the open window. Either bump `boards[].timeRangeDays` or pick a project with active issues. The query is GitLab `issues?state=opened&updated_after=...`.
- **Card refuses to drop.** The dashboard token is missing or read-only. Either set `dashboard.token` to a `dashboard:admin` token, or — for local-only setups — leave `dashboard.token` unset.
- **Drag works but GitLab doesn't reflect.** Look in dev tools for a 401/403 from the GitLab API; the agent token used (or the global `channels.gitlab.token`) lacks `api` scope. Fix the PAT scopes and restart the daemon.

## Implementation pointers

- Page module: `src/daemon/ui/pages/boards.ts`
- Column logic: `src/boards/config.ts` (`deriveStage`, `transitionDiff`)
- API: `GET /api/boards/:id/items`, `POST /api/boards/:id/items/:itemId/transition`
