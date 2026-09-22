# Workflow absorb and task replay

## Done

- Workflow DSL exists in JSON and YAML.
- Workflow engine supports triggers, agent nodes, transforms, branches, rules, actions, user tasks, subprocesses, signals, timers, checkpoints, end nodes, retries, and `maxChildDepth`.
- Workflow CLI supports authoring, validation, running, tracing, pausing, resuming, and canceling runs.
- Task traces are stored in SQLite with task, step, workflow, token, duration, and error fields.
- Workflow definitions now support generated-workflow metadata: `status`, `tags`, `entity`, `intentPath`, `generatedFrom`, `sourceTaskIds`, `confidence`, `workflowVersion`, `ownerAgent`, `lastMatchedAt`, and `matchCount`.
- Workflow drafts are stored under `.agentx/workflows/_drafts/` and are never registered as live triggers.
- New CLI surfaces:
  - `agentx workflow draft-from-task <taskId>`
  - `agentx workflow absorb`
  - `agentx workflow drafts`
  - `agentx workflow promote <draftId>`
  - `agentx workflow reject <draftId>`
  - `agentx workflow replay-task <taskId>`
- A conservative workflow matcher seam exists behind `workflows.matching.enabled`; v1 logs suggestions and falls back to normal agent execution.

## Pending

- Add a workflow index once active workflows exceed roughly 100 definitions.
- Persist replay comparison metrics: original vs replay duration, usage, model, status, and output summary.
- Add richer clustering signals: intent graph path, action sequence similarity, file/action targets, and outcome category.

## Shipped recently

- LLM-assisted workflow architect (`src/workflows/architect.ts`) — when `--model <id>` is passed to `agentx workflow draft-from-task` or `agentx workflow absorb`, the trace + step list is sent through the Anthropic API with a forced `emit_workflow` tool_use. The model decomposes the procedure into `action.run`, `transform`, `branch`, etc. nodes; the result is validated against `workflowSchema` (with one retry on schema failure); deterministic single-node fallback runs on any LLM error. Requires `ANTHROPIC_API_KEY` set in the daemon's environment.
- Dashboard edit-then-replay loop — drafts are editable in the workflow detail panel; "Save" persists to disk, "Save & Replay" fires an ad-hoc replay against the first source trace's input.
- `workflows.matching.mode: "auto"` fires matched workflows directly via `dispatcher.dispatchWorkflow`; high-confidence matches return an empty `AgentResponse` with `metadata.handledByWorkflow` so the agent doesn't double-reply.

## Recommended cron

Operators wire scheduled workflow mining via `crons` in `agentx.json`. The cron only
generates drafts — promotion stays explicit:

```yaml
crons:
  workflow-absorb-nightly:
    enabled: false
    schedule: "0 2 * * *"
    agent: workflow-architect
    timeout: 900
    prompt: >
      Run agentx workflow absorb --since 24h --min-cluster-size 3 --max 10 --commit.
      Report generated drafts, skipped clusters, and validation failures.
```

Flip `enabled: true` once an agent is configured for the role and the operator has
reviewed the first hand-run drafts.

## Decisions

- Workflow DSL is the canonical representation for reusable task execution.
- YAML is preferred for generated drafts because it is easier to review.
- JSON remains supported and editor-compatible.
- Generated workflows default to `status: draft` and `state: disabled`.
- Scheduled mining produces drafts only; no generated workflow is activated automatically.
- Workflow absorb mirrors the wiki absorb philosophy, but it uses workflow draft storage rather than wiki article storage.
- v1 matching is conservative and non-blocking; normal agent execution remains the fallback.

## Acceptance Criteria

- Existing YAML and JSON workflows remain valid.
- Draft workflows validate but never auto-trigger.
- `agentx workflow absorb --dry-run` writes nothing and exits cleanly on empty trace sets.
- `agentx workflow draft-from-task <taskId> --commit` writes a valid draft with task provenance.
- `agentx workflow promote <draftId>` validates and activates the workflow explicitly.
- `agentx workflow reject <draftId>` archives the draft without deleting evidence.
- `agentx workflow replay-task <taskId>` can run an ad-hoc workflow from a task trace without promoting it.
- Workflow matching can be disabled globally and never blocks normal task execution in v1.
