# Workflows

Paths: `/workflows`, `/workflows/editor` (when `workflows.editor` is `edit`)

Observability over workflow definitions and runs in `.agentx/workflows/`, review for generated drafts in `.agentx/workflows/_drafts/`, plus an opt-in visual editor that emits JSON.

For the workflow model itself (states, transitions, triggers, templates), see [Workflows reference](/reference/workflows). This page covers the dashboard surface.

## What you'll see

### `/workflows` — observability
- **Workflow list** (left rail): every file in `.agentx/workflows/` with id, title, trigger source, and node count.
- **Drafts** (left rail): generated workflows pending review, with confidence and validation status.
- **Selected workflow** (centre): node list, edge list, recent runs, and raw definition JSON.
- **Selected draft** (centre): provenance, owner, tags, source task ids, validation issues, raw definition JSON, and review actions.
- **Run timeline** (right): pick a run, see every transition with timestamps, payloads, and any agent/userTask outputs. Errors render with stack/diff.

### `/workflow-editor` — visual authoring
- A **drag-drop graph canvas** where you place nodes (agent, branch, gateway, userTask, signal.wait, subProcess, end) and wire edges. Saves to JSON.
- **YAML-authored workflows are read-only here.** The editor refuses to overwrite a `.yaml` file with `.json`; either edit on disk or delete the YAML first.
- **Live validation strip** at the bottom — same `validateAll()` that `agentx workflow validate` runs, refreshing on every change.

## What you can do

- **Trigger a manual workflow** with the **Run** button (sends `POST /workflows/<id>/run`).
- **Pause / resume / cancel** an in-flight run from the timeline (matches `agentx workflow pause/resume/cancel`).
- **Review generated drafts** with **Validate**, **Promote**, and **Reject**.
- **Author** a workflow visually if `workflows.editor: "edit"` (see [config schema](../config-schema#workflows)).
- **Validate** definitions via the strip — same exit-code as the CLI for CI use.

## Common tasks

| You want to… | Do this |
|---|---|
| See which channel triggered a run | The timeline's first row shows the trigger event payload — `source` field at the top |
| Re-run with the same input | Open the run, click **Re-run with input**, edit the payload, submit |
| Review generated workflow drafts | Open `/workflows`, pick a draft in the left rail, validate it, then promote or reject |
| Author a workflow that has a userTask | Add a `userTask` node, set `assignTo: "actor:alice"` or `"role:reviewers"` — the form is rendered to the actor's preferred channel |
| Switch a workflow from JSON to YAML | `agentx workflow show <id> --format yaml > .agentx/workflows/<id>.yaml`, then delete the JSON |

## Troubleshooting

- **"Editor disabled."** `workflows.editor` is `disabled` or `readonly` (see [config schema](../config-schema#workflows)).
- **Run stuck in `running`.** Open the timeline; the last transition row shows where it stopped. Common: a `userTask` waiting on a form, an `agent` node hitting `maxExecutionMinutes`, or a `signal.wait` waiting on an external event that never arrives.
- **Drafts missing.** Draft review reads `.agentx/workflows/_drafts/`. Generate one with `agentx workflow draft-from-task <taskId> --commit` or `agentx workflow absorb --commit`.
- **Cross-node runs not showing up.** Runs belong to their home node. The dashboard polls every entry in `dashboard.daemons[]` and merges. If a peer's missing, check the peer chip in [`/live`](./live).

## Implementation pointers

- Page modules: `src/daemon/ui/pages/workflows.ts`, `src/daemon/ui/pages/workflow-editor.ts`
- Editor IIFE bundle: `dist/web/workflow-editor.global.js` (built by `tsup.web.config.ts`)
- API: `GET /api/workflows`, `GET /api/workflows/runs`, `GET /api/workflows/drafts`, `POST /api/workflows/drafts/:id/validate|promote|reject`, `POST /workflows/:id/run`, `POST /api/workflows/runs/:id/status`
