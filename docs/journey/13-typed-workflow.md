# 13. Authoring a typed workflow

By the end of this chapter you'll have written, validated, and watched a YAML workflow that classifies an inbound message, extracts typed fields, and pushes them into a SaaS backend — all while every step's inputs/outputs flow through `/traces`.

## What you'll build

A lead-capture workflow:

```
trigger.channel       (telegram message arrives)
   │
   ▼
agent.classify        (categorize: sales / support / newsletter / other)
   │
   ▼
branch                (route on the classified category)
   ├─ sales ──▶ extract.structured ──▶ action.run hubspot ──▶ reply
   └─ default ──▶ generic ack
```

Branching, structured-output extraction, retries, action invocation, and trace-friendly node ids in one file. ~5 minutes if you have an agent and a registered HubSpot action; up to 15 from a blank install.

## Prerequisites

- A running agentx daemon (`agentx daemon start`)
- One agent capable of following classification instructions — Sonnet or higher works reliably (`agentx agent add` if you don't have one)
- Optional but recommended: a HubSpot integration via [Actions registry](/reference/actions) — the workflow degrades gracefully without it (the action node will fail, the run completes with a typed error you can branch on)

## Step 1 — Scaffold

```bash
agentx workflow init lead-capture --template branching --agent classifier
```

You'll see something like:

```
  ✓ scaffolded /…/.agentx/workflows/lead-capture.yaml
    template: branching

  Next:
    1. edit /…/.agentx/workflows/lead-capture.yaml
    2. agentx workflow validate /…/.agentx/workflows/lead-capture.yaml
    3. agentx workflow run lead-capture --watch
```

`agentx workflow templates` lists the other shipped templates if you want to see them — `linear`, `extract`, `human-in-the-loop`, and `retry` each demonstrate a different node-shape combination.

## Step 2 — Author

Open `lead-capture.yaml`. The scaffold is heavily commented; the only fields you'll typically edit are:

- the `trigger.channel.config.filter.chatId` (or remove `filter:` to listen on every message)
- each `agent` node's `prompt` template
- the `branch` cases (the case names become the outgoing edge `fromPort` values — match them in `edges:`)

For the full lead-capture flow, the example in the repo is the canonical reference: copy from `examples/workflows/lead-capture.yaml` if you want the extraction + HubSpot push wired in.

## Step 3 — Validate

```bash
agentx workflow validate
```

The validator runs Zod schema checks (every node config) plus the linter (every edge resolves to a real node, every reachable end node terminates the run, no cycles without a pause-capable node). Errors come back with a path you can copy-paste into your editor's go-to-line.

## Step 4 — Run + watch

```bash
agentx workflow run lead-capture --watch
```

`--watch` tails `/traces?workflowRunId=<id>` every 500ms and prints each step as it completes:

```
  ok    classify         420t  3812ms
  ok    route                   3ms
  ok    extract          892t  2104ms
  ok    push_to_hubspot         412ms
  ok    reply_sales              28ms
  ok    done                      2ms

  run finished: completed
  full traces: http://127.0.0.1:18800/traces?workflowRunId=<runId>
```

If a step fails (model erred, action returned a typed `errorKind`, schema mismatch on extraction), the row is red and the error message follows on the next line. The run continues if a node has `retry:` configured; otherwise it terminates with `status: failed` and the trace is preserved for inspection.

## Step 5 — Inspect

```bash
agentx workflow trace <runId>
```

prints the same data as a stand-alone table — useful when you've SSH'd into the daemon host and don't want to scroll back through the watch output, or when a CI job needs a copy-pasteable post-mortem.

For deeper inspection — system prompts, tool calls, raw model output — open `http://127.0.0.1:18800/traces/<taskId>` for one node, or use the dashboard's run viewer at `/workflows`.

## Iterate without committing

`agentx workflow run <file>` accepts a path directly — registers it under an `_adhoc-…` id, hot-reloads the daemon, and runs in one shot:

```bash
agentx workflow run ./drafts/experiment-3.yaml --watch
```

The ad-hoc copy lives at `.agentx/workflows/_adhoc-<id>-<ts>.yaml` so it's visible to `workflow runs` and the dashboard until you delete it. Good for benchmark sweeps and quick what-ifs.

## What's templatable in YAML

Most of agentx's typed building blocks are reachable from a workflow YAML:

| Concept | Node type | Built on |
|---|---|---|
| Channel events | `trigger.channel` | gitlab / telegram / whatsapp / discord / slack adapters |
| Manual run / cron | `trigger.manual` / `trigger.cron` | dispatcher |
| Agent invocation | `agent` | the registry |
| Built-in typed actions | `action.builtin` | `http.fetch`, `extract.structured`, `mesh.delegate`, `rag.lexical`, ... |
| Registered actions | `action.run` | the [Actions registry](/reference/actions) |
| Conditional routing | `branch`, `rule` | engine evaluator |
| Structured extraction | `action.builtin` w/ `extract.structured` | model + Zod-validated JSON schema |
| Human approval | `userTask` | actor / role + form fields |
| Sub-workflows | `subProcess` | dispatcher |
| Cross-run signals | `signal.emit` / `signal.wait` | signal bus |
| Time-based pauses | `timer.boundary` | timer service |
| Per-node retries | `retry: { maxAttempts, backoffMs }` | dispatcher |
| Mesh delegation | `action.builtin` w/ `mesh.delegate` (defaults `freshSession: true`) | a2a |

For the field-level schema, see [Workflows reference](/reference/workflows).

## Next

- [Operating playbook — boards & SDLC](/architecture/workflows-yaml) for end-to-end agentic loops
- [Actions registry](/reference/actions) — wire CRM / email / billing into the workflows you author here
- [Production hardening](/journey/11-production-hardening) — schedule, monitor, and roll back workflow deploys
