# Inbox

Path: `/inbox?actor=<actor-id>` (omit `actor` for the global view)

Per-actor list of open `userTask` workflow nodes. Renders the embedded form inline so reviewers can submit without leaving the dashboard.

## What you'll see

A two-pane layout:

- **Left**: list of open user tasks scoped to the `actor` query param (or all open tasks). Each row shows: workflow id, run id, task title, due-at indicator (color-coded by SLA), assignedAt timestamp.
- **Right**: the selected task with the form rendered from its schema. Supported field kinds (Phase 1): `text`, `long-text`, `number`, `boolean`, `select`, `multi-select`, `date`. Submit posts to `POST /api/workflows/tasks/:id/submit`.

## What you can do

- Browse open user tasks, filter by workflow id / SLA bucket.
- Submit a task — the workflow run advances to whatever transition the task's `submitTransition` points at.
- Reassign (if the role assignment strategy allows) — the dropdown shows the resolved actor list for the role.
- Add a comment without submitting — comments are recorded as transitions in the workflow run timeline.

## Common tasks

| You want to… | Do this |
|---|---|
| See the tasks for "alice" specifically | Visit `/inbox?actor=alice` |
| Forward an inbox link to a non-technical reviewer | Many channels render a one-click button to `/inbox?actor=...` automatically — Telegram/WhatsApp/Slack do this for `userTask` notifications |
| Triage SLA breaches | Sort by SLA bucket; the [Processes page](./processes) gives a workflow-tree view of the same data |

## Troubleshooting

- **"No actor specified."** Pass `?actor=<id>` or use [`/admin` → Actors](./admin) to register actors first.
- **Form fields render but submit fails.** The validation schema rejects something — the response body names the field. Common: an `email` field in a `text` schema (Phase 1 doesn't validate email format, but downstream agents may); a `number` field with a string default.
- **Tasks don't appear after submit.** They have moved to **completed**. Look in the [Processes](./processes) timeline for the transition.

## Implementation pointers

- Page module: `src/daemon/ui/pages/inbox.ts`
- API: `GET /api/workflows/tasks?actor=<id>`, `POST /api/workflows/tasks/:id/submit`
- Forms: `src/workflows/forms.ts` defines the schema; the renderer is HTML-form-only (no client framework)
