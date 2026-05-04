# Typed Workflow DSL — first-class authoring path

**Plan reference:** improvement plan #10 (handoff doc, May 2026 benchmark).

**Goal:** make the workflow surface a first-class authoring path alongside agents — a YAML author can validate, run, and observe a typed step-graph in under a minute, end-to-end.

## Where we are

The engine already has every building block the handoff acceptance criteria asks for:

| Acceptance criterion | Existing surface |
|---|---|
| YAML authoring | `src/workflows/yaml.ts` — `parseYamlWorkflow` + `flow:` sugar for linear sequences |
| Conditional branching | `branch` and `rule` node types |
| Structured-output extraction | `extract.structured` built-in invoked via `action.builtin` node |
| Retries | per-node `retry: { maxAttempts, backoffMs }` on every node (Zod-validated) |
| Step-by-step traces | `recordTraceStart` / `recordTraceEnd` in dispatcher → `GET /traces[/:taskId]` |

The handoff still calls this "the biggest single item left." It is — but as **ergonomics**, not engine work. Today an operator has to:

1. Hand-write `.agentx/workflows/<id>.json` *or* learn the YAML schema by reading types.ts
2. Restart the daemon (or wait for `fs.watch` to re-index) before they can validate
3. Trigger a run via `POST /workflows/:id/run` (CLI `run <id>` only works on **stored** ids — no ad-hoc file)
4. Pull traces via raw HTTP — no CLI helper

Every step is a small papercut. None of them block expert users; together they keep workflows from feeling first-class.

## What "first-class" looks like

Concrete success: an operator types **four commands** end-to-end and the workflow runs with visible traces:

```bash
agentx workflow init lead-capture        # scaffolds .agentx/workflows/lead-capture.yaml
$EDITOR .agentx/workflows/lead-capture.yaml   # author
agentx workflow validate                  # already exists, unchanged
agentx workflow run lead-capture --watch  # runs + tails traces
```

That's the bar. Everything below either already exists, or fills a gap on the path from blank file → first run.

## Plan

### Stage 1 — Authoring scaffolds (CLI)

#### 1a. `agentx workflow init <id> [--template <name>] [--yaml]`

Scaffolds `.agentx/workflows/<id>.yaml` (or `.json`) from a template, validates it, and adds it to the store.

**Templates ship in the bundle** (`src/workflows/templates/<name>.yaml`):

- `linear` (default) — a `trigger.manual` → `agent` → `end` chain. Smallest workflow that actually runs.
- `branching` — adds a `branch` node off the agent's structured output (e.g. classifier → routes).
- `extract` — uses `action.builtin` with `extract.structured` to pull JSON fields from an upstream message, then routes on them.
- `human-in-the-loop` — `userTask` form → `signal.wait` → `agent` follow-up.
- `retry` — an `agent` node with a `retry: { maxAttempts: 3, backoffMs: 1000 }` policy and a fallback `branch` on the failure path.

Each template is a working YAML file with comments explaining each section.

#### 1b. `agentx workflow add <file>`

Copies a YAML/JSON file into `.agentx/workflows/<id>.<ext>`, runs the existing `validate + lint` pipe, and (if the daemon is up) fires `POST /reload` so the new workflow is live without a restart.

Why this and not just-copy-the-file: the reload trigger + the validate are the foot-guns operators hit today. Bundling them eliminates the silent "I edited the file but the daemon hasn't picked it up" failure mode.

#### 1c. `agentx workflow run <id-or-file> [--watch]`

Today: `run <id>` only fires by stored id. Extension:

- If the argument resolves to a real file (`.yaml` / `.json`), parse + validate + register-then-run as a one-shot. The synthesized id is `_adhoc-<filename>-<timestamp>` so it doesn't shadow stored workflows.
- `--watch` streams the run's trace rows (the existing `GET /traces?workflowRunId=<id>` filter, polled every 500ms) and prints each step as it completes — node id, status, tokens, error if any.

#### 1d. `agentx workflow trace <runId-or-taskId>`

Pretty-printer for `GET /traces/:taskId` — table per step with `node | status | model | tokens (in/out/cache) | duration | error`. Same data the dashboard's run viewer shows, but available in a terminal for CI / SSH sessions.

### Stage 2 — Worked example

Ship `examples/workflows/lead-capture.yaml` in the repo, referenced from the docs:

- `trigger.channel` (telegram source, project filter)
- `agent` node (classifier — extracts `intent`)
- `branch` on `intent === "newsletter"` vs `"sales"` vs `default`
- `action.builtin` with `extract.structured` to pull `{ name, email }` from the agent reply
- `action.run` with a registered `hubspot-create-contact` action (per the actions reference page)
- per-node `retry: { maxAttempts: 2 }` on the HTTP-touching nodes
- `end` with `status: completed`

This single file demonstrates branching, extraction, retries, action invocation, and trace-friendly node ids. It doubles as the docs' running example.

### Stage 3 — Documentation refresh

Three doc edits:

1. **New page `docs/journey/13-typed-workflow.md`** — walkthrough that mirrors the four-command flow at the top of this plan, using the lead-capture example.
2. **Update `docs/reference/workflows.md`** — add an "Authoring" section showing the new CLI surface and link to the journey.
3. **Update `docs/index.md`** — promote workflows to a real feature pill ("Typed step-graphs in YAML — branching, extraction, retries, traces"), pointing at the journey.

### Stage 4 — Tests

Unit + integration:

- `test/workflow-init.test.ts` — `agentx workflow init` produces files that round-trip validate clean for every shipped template.
- `test/workflow-run-file.test.ts` — `run` with a YAML file path validates + dispatches; `--watch` polls and prints; ad-hoc runs don't shadow stored workflows.
- `test/workflow-trace-cli.test.ts` — `trace <id>` formats the existing payload correctly and 404s gracefully on a missing id.
- Extend `test/workflows.test.ts` with a YAML round-trip case using all five templates.

## Non-goals (deferred)

- **Loop construct.** Not in handoff acceptance. Workflows can already loop via `subProcess` + signals; a dedicated `loop` node is its own design pass.
- **Visual editor parity for the new templates.** The editor (`src/web/workflow-editor/`) renders any valid workflow already; templates appear as ordinary nodes once added. A "Pick a template" button in the editor's New menu is a separate small UI task — flag in roadmap.
- **`workflow lint --fix`.** Schema errors should still surface; auto-fix is too much rope without a careful design.
- **Sub-process composition tutorials.** Already supported (`subProcess` node); deserves its own journey, not part of this scope.
- **Replay (handoff #11).** Independent feature.

## Effort & ordering

| Stage | Effort | Files |
|---|---|---|
| 1a `init` + templates | M | `src/commands/workflow.ts`, 5 template files under `src/workflows/templates/` |
| 1b `add` | S | `src/commands/workflow.ts` |
| 1c `run <file>` + `--watch` | M | `src/commands/workflow.ts`, small daemon route for ad-hoc registration |
| 1d `trace` | S | `src/commands/workflow.ts` |
| 2 example | S | `examples/workflows/lead-capture.yaml` |
| 3 docs | M | journey 13, workflows.md, index.md |
| 4 tests | M | three new test files |

Total: ~1–1.5 days for an operator-ready first-class workflow surface, end-to-end. The handoff estimate of "≥2 weeks" assumed building the engine from scratch — the engine is already done.

## Acceptance (matches handoff)

A YAML workflow with conditional branching, structured-output extraction, and retries can be authored, validated, and run via `agentx workflow run`. Each step's input/output flows through `/traces`.

Concrete repro:

```bash
agentx workflow init demo --template branching
# edit .agentx/workflows/demo.yaml
agentx workflow validate
agentx workflow run demo --watch
# prints each step as it completes; the final line is a /traces/:id link
agentx workflow trace <runId>
# table view of all steps, tokens, model, duration
```

If those four commands work end-to-end on a fresh install, #10 is done.
