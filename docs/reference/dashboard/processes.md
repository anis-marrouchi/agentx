# Processes

Path: `/processes`

Live view over workflow runs with composition-tree rendering and SLA indicators computed from `userTask`'s `dueAt`. Reads `/api/workflows/runs`, `/api/workflows/tasks`, and `/api/workflows` (for definition titles).

Where [Workflows](./workflows) is "what definitions exist and how have runs gone historically", **Processes is "what is running right now"**.

## What you'll see

- **Run cards**, one per active run, ordered by recency.
- Each card renders the **composition tree** — main run plus every sub-process spawned via `subProcess` nodes — with current state highlighted.
- **SLA strip** along the top: pending user tasks colored by `dueAt` bucket (overdue red, due-soon amber, fresh green).
- **Tab toggle** for completed vs in-flight.

## What you can do

- **Inspect a run** — click into the workflow definition (jumps to [/workflows](./workflows) with the run pre-selected) for the full timeline.
- **Pause / resume / cancel** an in-flight run from the card menu (matches `agentx workflow pause/resume/cancel`).
- **Open the user task** that's blocking a run — opens [/inbox](./inbox) with the task pre-selected.

## Common tasks

| You want to… | Do this |
|---|---|
| Find which runs are blocked on a userTask | Toggle to **In-flight**; runs with a yellow/red SLA strip have an open user task |
| See the most recent agent decisions across all runs | This page only shows in-flight; for a feed, use [/live](./live) |
| Cancel a runaway run | Card menu → Cancel. Preferred over killing the daemon — preserves the timeline |

## Troubleshooting

- **Empty page.** No active runs. Trigger one via [/workflows](./workflows) or wait for an inbound webhook to fire.
- **SLA dot is red but no task is open.** The `dueAt` calculation includes the workflow's home-node clock skew. Check the daemon's system time; the dashboard renders timestamps in the browser's local timezone but the SLA bucket comes from the server.
- **Sub-process tree shows orphans.** A `subProcess` node spawned a child whose home-node is a peer the dashboard can't reach. Add the peer to `dashboard.daemons[]` or check the peer chip on [/live](./live).

## Implementation pointers

- Page module: `src/daemon/ui/pages/processes.ts`
- API: `GET /api/workflows/runs`, `GET /api/workflows/tasks`, `GET /api/workflows`
- Composition: parent runs link to children via the run's `parentRunId` field set by the `subProcess` node executor
