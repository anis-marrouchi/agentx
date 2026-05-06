# Workflows

Paths: `/workflows`, `/workflows/editor` (when `workflows.editor` is `edit`)

Observability + runbook view over workflow definitions and runs in `.agentx/workflows/`, draft review + edit + replay for `.agentx/workflows/_drafts/`, plus an opt-in visual editor that opens both active workflows and drafts.

For the workflow model itself (nodes, edges, triggers, templates, absorb pipeline, LLM architect), see [Workflows reference](/reference/workflows). For the verb library workflows compose with, see [Procedures](./procedures). This page covers the dashboard surface.

## What you'll see

### `/workflows` — the runbook view

The detail panel is structured as a **runbook** for whichever workflow is selected — five sections that answer the operational five-W questions:

- **WHEN** — trigger node + filter + a "last fired … (status)" badge
- **WHAT comes in** — `trigger.config.inputSchema` rendered as a typed table: field, type (with enum + default + example), required-or-optional pill, description
- **HOW it runs** — DAG: nodes (id + type badge with agentId / source / action) and edges (with `fromPort` labels for branch outputs)
- **WHAT comes out** — the `end` node's `output` template, rendered as a key/value table so you see what the run resolves to
- **WHO owns it** — `ownerAgent`, tags, generatedFrom (`task-trace` | `workflow-absorb` | `llm-architect`), confidence, source task ids

Plus the existing **Recent runs** panel (with re-run buttons per row) and **Definition (raw JSON)** under a collapsible.

**Workflow card on the left rail** shows trigger source, live-run count, and a color-coded **last-run badge** (`last: completed · 3m ago` / `failed` / `running` / `paused`) so you can scan the catalog at a glance.

**Drafts panel** at the bottom of the left rail lists generated workflow drafts pending review with confidence + validation status.

### `/workflows/editor` — visual authoring

Opens **both** active workflows (`?id=<wf>`) and drafts (`?draft=<id>`):

- **Active workflows**: standard React Flow editor. Save persists to the active store via `PUT /api/workflows/:id`, layout to `PUT /api/workflows/:id/layout`. Run-preview button kicks the workflow.
- **Drafts**: same canvas; brand label gets a `· draft` suffix; breadcrumb shows `/workflows/_drafts/<id>`. Save persists via `PUT /api/workflows/drafts/:id`. The Run-preview button is **replaced by Promote** which calls `/promote` and rewrites the URL to `?id=<id>` after success — promotion in-flow without leaving the canvas.

YAML-authored workflows on disk are still treated as the source of truth — the editor refuses to overwrite a `.yaml` file with `.json`.

## What you can do

### Run a workflow on demand
Click **▶ Run** on a workflow's detail panel. An inline form opens with:
- Payload (JSON) textarea (defaults to `{}`)
- **Force** checkbox — auto-checked when the trigger is *not* `trigger.manual` (for `trigger.hook` / `trigger.channel` / `trigger.cron` you'd otherwise race against live event delivery)
- Run now → POSTs to `/workflows/<id>/run`, opens the run drawer streaming live

### Re-run a completed run
Each row in **Recent runs** carries a small **↻** button for terminal runs (completed / failed / canceled). One click:
1. Fetches the original run's full context (slim listing strips it; the detail endpoint keeps it)
2. Looks up `context[<triggerNodeId>]` to recover the original payload
3. Mirrors `force: true` if the original was a synthesized event (entityRef.backend === "channel")
4. POSTs a fresh `/workflows/<id>/run` with the same payload
5. Auto-opens the run drawer on the new runId

Running/paused rows don't get the button — re-runs would race with the in-flight execution.

### Edit + Save & Replay a draft
Pick a draft in the left rail. The detail panel shows:
- **Validation issues** (lint + schema)
- **Source task ids** (provenance)
- **Definition** as an editable JSON textarea
- Action buttons: **Validate** · **Save** · **Save & Replay** · **Promote** · **Reject** · **✎ Edit visually** (opens the React Flow editor at `?draft=<id>`)

**Save** writes the textarea back to `_drafts/<id>.yaml` (server re-serializes JSON → YAML on disk). Lint warnings shown without blocking. **Save & Replay** does the save, then fires the draft as `adhoc-replay-<id>-<ts>` in the active store and opens the run drawer streaming live — you see the draft's behavior end-to-end without promoting it. **Promote** moves the draft into the active store; **Reject** archives to `_drafts/_rejected/`.

### Pause / resume / cancel an in-flight run
From the run drawer, matching `agentx workflow pause/resume/cancel`.

### Auto-run a matched workflow (suggest vs auto)
Configure `workflows.matching.mode` (see [config schema](../config-schema#workflows)). When `mode: "auto"` and a workflow's match score ≥ `autoRunThreshold`, the daemon **auto-fires** the workflow on incoming agent tasks — input fields are resolved from `chatId` parse + schema defaults; missing required fields fall back to normal agent execution with a precise log line. See [Workflows reference — auto-match input resolution](../workflows#auto-match-input-resolution).

## Common tasks

| You want to… | Do this |
|---|---|
| See what inputs a workflow expects | Click the workflow on `/workflows`; the **WHAT comes in** panel renders the inputSchema as a typed table |
| See what outputs a workflow produces | Same panel — **WHAT comes out** shows the `end.config.output` keys + their templated source values |
| Test a draft against a real source trace | Pick the draft, click **Save & Replay** — it fires against the first `sourceTaskId`'s recorded input |
| Trigger a hook-driven workflow manually | Click **▶ Run**; tick the **Force** checkbox so the dispatcher synthesizes the trigger event matching the workflow's declared source |
| Author a workflow that has a userTask | Add a `userTask` node, set `assignTo: "actor:alice"` or `"role:reviewers"`; the form is rendered to the actor's preferred channel |
| Switch a workflow from JSON to YAML | `agentx workflow show <id> --format yaml > .agentx/workflows/<id>.yaml`, then delete the JSON |
| Inspect what filled the auto-run inputs | Daemon log: `auto-run input resolution for <wf>: passthrough=[…] chatId=[…] defaults=[…]` |
| Review what a draft would actually do without running it | Open in the visual editor (`✎ Edit visually`); the DAG visualisation shows every step + edge |

## Troubleshooting

- **"Editor disabled."** `workflows.editor` is `disabled` or `readonly` (see [config schema](../config-schema#workflows)).
- **Run stuck in `running`.** Open the run drawer; the timeline's last row shows where it stopped. Common: a `userTask` waiting on a form, an `agent` node hitting `maxExecutionMinutes`, or a `signal.wait` for an event that never arrived.
- **Drafts missing.** Reads `.agentx/workflows/_drafts/`. Generate via `agentx workflow draft-from-task <taskId> --commit` (single trace) or `agentx workflow absorb --commit` (cluster of similar traces; nightly cron does this automatically).
- **Auto-run skipped on a clear match.** Daemon log line: `inputSchema requires host, path — chatId+defaults filled […]; auto-run skipped`. The workflow needed inputs the chatId parse + defaults couldn't fill — manual run with the missing fields, OR add `default` to the inputSchema property.
- **Workflow card stuck on `last: failed`.** Click the run row, inspect the timeline. The error reason is captured per-step.
- **Cross-node runs not showing up.** Runs belong to their home node. The dashboard polls every entry in `dashboard.daemons[]` and merges; if a peer's missing, check the peer chip in [`/live`](./live).

## Implementation pointers

- Page modules: `src/daemon/ui/pages/workflows.ts`, `src/daemon/ui/pages/workflow-editor.ts`
- Editor IIFE bundle: `dist/web/workflow-editor.global.js` (built by `tsup --config tsup.web.config.ts`; rebuild with `pnpm build:web`)
- Editor draft support: `src/web/workflow-editor/api.ts` (`fetchDraft`, `saveDraft`, `promoteDraft`)
- HTTP API: `GET /api/workflows`, `GET /api/workflows/runs?summary=1` (slim listing — strips per-run `context` blobs to keep first-paint fast), `GET /api/workflows/runs/:id` (full), `GET /api/workflows/drafts`, `PUT /api/workflows/drafts/:id`, `POST /api/workflows/drafts/:id/{validate,promote,reject,replay}`, `POST /workflows/:id/run`, `POST /api/workflows/runs/:id/status`
- Auto-match runtime: `src/agents/registry.ts` (matcher seam) + `src/daemon/index.ts` (`setWorkflowAutoRunner`) + `src/workflows/inputs.ts` (input resolution)
