---
title: "Workflows"
---

# Workflows

Workflows are the **execution backend** of agentx automation. The user-facing front door is [procedures](./procedures.md) — plain-language SOPs mined from real activity, reviewed by you, and injected as guidance when a matching task arrives. A procedure that has proven stable and needs deterministic, trigger-driven automation gets re-expressed as a workflow: a directed dataflow graph the daemon executes node by node, no LLM improvisation in the control flow.

A workflow is a DAG of typed nodes connected by edges. A run walks the graph from the trigger, folding each node's output bundle into a shared context keyed by node id. Prompts and action params template against that context via <code v-pre>{{&lt;nodeId&gt;.&lt;path&gt;}}</code>.

Definitions live in `.agentx/workflows/` (YAML or JSON, one workflow per file). Runs are append-only JSONL under `.agentx/workflows/_runs/`.

## A validating example

The repository ships `examples/workflows/whatsapp-client-support.yaml` as the canonical worked example. A trimmed version:

```yaml
id: support-triage
version: 2
title: WhatsApp support triage

nodes:
  - id: trigger
    type: trigger.channel
    config:
      source: whatsapp-message
      filter: { chat: "*" }

  - id: classify
    type: agent
    config:
      agentId: intent-classifier
      prompt: |
        A client wrote:
        {{trigger.text}}
        Reply with exactly one line:
        RESULT: new-request
        RESULT: other
      resultParser: noqta-result-token
      timeoutMinutes: 2

  - id: route
    type: branch
    config:
      cases:
        - when: { kind: equals, params: { path: classify.result, value: new-request } }
          to: new
      default: fallback

  - id: create_issue
    type: action.createIssue
    config:
      channel: gitlab
      project: noqta/web
      title: "WhatsApp: new request from {{trigger.sender.name}}"
      description: "{{trigger.text}}"

  - id: fallback
    type: action.send
    config:
      channel: whatsapp
      chatId: "{{trigger.chatId}}"
      text: Got your message — a human will reply shortly.

  - id: done
    type: end
    config: { status: completed }

# Linear prefix via the flow: shorthand; the branch fan-out needs explicit edges.
flow: [trigger, classify]
edges:
  - { from: classify, to: route }
  - { from: route, fromPort: new, to: create_issue }
  - { from: route, fromPort: fallback, to: fallback }
  - { from: create_issue, to: done }
  - { from: fallback, to: done }
```

Check it with `agentx workflow validate <file>` — this runs the YAML parser, the Zod schema, and the DAG linter (exactly one trigger, edges reference real nodes, no unreachable nodes, branch ports declared, no un-pausable cycles, a reachable `end`/pause node).

## Schema

Defined by `workflowSchema` in `src/workflows/types.ts`. Top-level fields:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | lower-kebab (`/^[a-z0-9][a-z0-9_-]*$/`) |
| `version` | yes | literal `2` (v1 state machines are not loadable) |
| `title` | yes | human name |
| `description` | no | free text |
| `status` | no (`active`) | **review metadata only** — `draft` / `review` / `active` / `deprecated`. Never gates dispatch. |
| `state` | no (`active`) | **the only dispatch gate** — `active` / `disabled` / `quarantined` |
| `project` | no | hard scope in `<org>/<repo>` form. Events carrying a different `project` never fire this workflow. Unset = global. |
| `priority` | no (`0`) | when multiple workflows match one event, highest priority wins; ties broken by id |
| `fanOut` | no (`false`) | if any match sets it, **every** matching workflow runs (each with its own run) instead of only the top-priority one |
| `nodes` | yes | at least one node (see below) |
| `edges` | no (`[]`) | `{ from, fromPort?, to, toPort?, label? }` |
| `envAllow` | no (`[]`) | env-var names templates may read via <code v-pre>{{env.*}}</code> |
| `retention` | no | `{ maxRuns: 500, maxDays: 90 }` |
| `maxChildDepth` | no (`5`) | sub-process nesting cap |
| `mesh.allowRemote` | no (`false`) | opt in to cross-mesh trigger fan-out; `mesh.peers` optionally allowlists sender peers |
| `tags` | no (`[]`) | UI grouping |

Absorb provenance fields (`generatedFrom`, `sourceTaskIds`, `confidence`, `intentPath`, …) are optional and written by the draft pipeline, not by hand.

### `status` vs `state`

These are two independent axes and the distinction matters:

- **`state` is the one and only dispatch gate.** `state: disabled` (operator kill switch) and `state: quarantined` (set by the conflict detector when the workflow would race another dispatch path) mean: no trigger registration, no new runs. In-flight runs continue. A workflow with `status: draft` but `state: active` **will** fire.
- **`status` is review metadata.** "Has a human looked at this?" Generated drafts are saved `status: draft` + `state: disabled` so they validate but never fire until promoted.

If you're asking "will this run?", read `state`. If you're asking "is this reviewed?", read `status`.

### Nodes

```yaml
- id: classify            # identifier-safe: /^[a-zA-Z_][a-zA-Z0-9_-]*$/
  type: agent             # one of nodeTypeSchema (below)
  config: { ... }         # free-form; each handler validates its own shape at execution time
  retry: { maxAttempts: 3, backoffMs: 2000 }   # optional; default no retry
  position: { x: 320, y: 160 }                 # optional; editor layout only
```

`retry` re-runs a node on hard errors (`{error}` or a throw) up to `maxAttempts` with exponential backoff. Pauses (`userTask`, `signal.wait`, timers) are never retried.

### The `flow:` shorthand (YAML only)

`flow: [a, b, c]` desugars into linear edges `a→b→c` at parse time, then the key is stripped before Zod validation. Rules (enforced in `src/workflows/yaml.ts`):

- `flow:` may not include nodes of type `branch`, `gateway.parallel`, `rule`, `signal.wait`, `userTask`, `subProcess`, `timer.boundary`, or `checkpoint` — those need explicit edges.
- Every id in `flow:` must reference a node in the same file.
- `flow:` and `edges:` may coexist; the result is the union, deduped on `(from, fromPort, to)`, explicit edges winning.
- Multi-document YAML (`---`) is rejected — one workflow per file.

## Triggers — three wiring paths

Every workflow has exactly one `trigger.*` node, but the three trigger types are matched by **different machinery**. This is a common source of confusion:

| Trigger type | How it's matched | Config fields |
|---|---|---|
| `trigger.channel` | Channel events flow through `dispatcher.matchByTrigger()`: `config.source` must equal the event source, then `config.filter` and the top-level `project` scope are applied, then priority/fanOut selects among matches | `source` (`whatsapp-message`, `telegram-message`, `slack-message`, `discord-message`, `gitlab-issue`, `gitlab-mr`, `gitlab-note`, `gitlab-pipeline`), `filter: { project, repo, chat, labels }` (`"*"` = any) |
| `trigger.hook` | A **per-workflow subscriber** on the named `on:*` hook, registered at daemon boot. Fires the workflow directly — `matchByTrigger`, `priority`, and `fanOut` do not apply. Top-level `project` scope and `config.filter` still gate it. | `event` (must start with `on:`), `passthrough`, `filter: { action, mentions, noteableType, assigneesAdded, reviewersAdded, labelsAdded }` |
| `trigger.cron` | A per-workflow timer loop (`getNextCronDate` + chained `setTimeout`). Fires unconditionally on schedule with a synthetic event. | `spec` (cron expression, required), `timezone` (default `UTC`) |

`trigger.manual` (fired by `agentx workflow run <id>` or the dashboard Run button) and `trigger.form` (human submits a form to start a run) round out the enum.

The `state` gate holds on all paths: `matchByTrigger` skips non-active workflows, and the trigger registrar refuses to register cron timers or hook subscribers for them.

### `trigger.hook` details

Filters move "ONLY ACT when …" guards from the agent prompt up to the dispatch gate, so agents aren't woken (and billed) just to exit cleanly:

```yaml
id: mr-review-pickup
version: 2
title: Review MRs when a reviewer is assigned
project: noqta/web

nodes:
  - id: trigger
    type: trigger.hook
    config:
      event: on:gitlab-mr
      filter:
        action: [update]              # gitlab action gate (open / reopen / update / ...)
        reviewersAdded: [review-bot]  # fire only when this username was newly added
  - id: review
    type: agent
    config:
      agentId: reviewer
      prompt: "Review MR !{{trigger.iid}} in {{trigger.project}}."
  - id: done
    type: end
    config: { status: completed }

flow: [trigger, review, done]
```

Filter semantics (all case-insensitive, leading `@` stripped where relevant):

- `action` — restrict `on:gitlab-issue` / `on:gitlab-mr` to specific actions, e.g. `[open, reopen]`.
- `mentions` — restrict `on:gitlab-note` to comments @-mentioning one of these usernames.
- `noteableType` — restrict `on:gitlab-note` to `merge_request` or `issue`. Without it, an MR-focused workflow also claims issue comments and swallows them.
- `assigneesAdded` / `reviewersAdded` — fire only when one of these usernames was newly added (adapter computes the diff).
- `labelsAdded` — fire only when one of these labels was newly added.

When a hook-triggered workflow fires, it **claims** the event: the channel adapter suppresses its legacy @-mention / default-route dispatch so one event doesn't spawn the same agent twice. Set `passthrough: true` on the trigger config for observability-only workflows that should leave the legacy reply path intact.

### `trigger.cron`

```yaml
id: nightly-digest
version: 2
title: Nightly digest
nodes:
  - id: trigger
    type: trigger.cron
    config: { spec: "0 7 * * *", timezone: Africa/Tunis }
  - id: digest
    type: agent
    config:
      agentId: coo-agent
      prompt: "Summarize yesterday's activity in five bullets."
  - id: send
    type: action.send
    config: { channel: telegram, chatId: "123456", text: "{{digest.reply}}" }
  - id: done
    type: end
    config: { status: completed }
flow: [trigger, digest, send, done]
```

Each fire gets a distinct entity ref, so overlapping runs coexist. The trigger's output payload is `{ now, spec, workflowId }`.

## Core nodes

| Node | Purpose | Output bundle |
|---|---|---|
| `agent` | Invoke a registered agent with a templated `prompt`. `resultParser: noqta-result-token` (default) parses a `RESULT:` line; `resultParser: json` extracts a JSON block. `timeoutMinutes` optional. | `{ reply, result, json?, taskId, durationMs }` |
| `transform` | Pick or reshape values from upstream context | arbitrary |
| `branch` | First matching case selects an outgoing port (see below) | `{ port }` |
| `action.*` | Side-effect sinks — one verb per channel-adapter method | verb-specific |
| `end` | Terminates the run; `config: { status: completed }` | — |

Built-in action verbs: `action.send`, `action.createIssue`, `action.setLabel`, `action.readLabel`, `action.react`, `action.editMessage`, `action.logTime`, `action.callHTTP`. Plus:

- `action.run` — invoke a reusable entry from the [action registry](./actions) by `actionId` with a templated `inputs` map. Prefer it over `action.callHTTP` when the same call shows up in several workflows.
- `action.builtin` — call a daemon-shipped typed action (`http.fetch`, `mesh.delegate`, `extract.structured`, …); output is the validated builtin response.

```json
{
  "id": "notify_lead",
  "type": "action.run",
  "config": {
    "actionId": "slack-notify",
    "inputs": { "text": "New lead: {{trigger.text}}" }
  }
}
```

## Branch conditions

A `branch` node's config is a list of cases, each pairing a condition with a port name, plus a default port:

```yaml
- id: route
  type: branch
  config:
    cases:
      - when: { kind: equals,   params: { path: classify.result, value: approved } }
        to: approve
      - when: { kind: contains, params: { path: trigger.text, value: urgent } }
        to: rush
      - when: { kind: matches,  params: { path: trigger.text, regex: "^deploy " } }
        to: deploy
      - when: { kind: exists,   params: { path: trigger.media.path } }
        to: media
    default: fallback
```

The four condition kinds implemented in `evaluateBranch` (`src/workflows/engine.ts`):

| Kind | Params | True when |
|---|---|---|
| `equals` | `path`, `value` | context value at `path` `===` `value` |
| `contains` | `path`, `value` | string includes `value`, or array has an element `===` `value` |
| `matches` | `path`, `regex` | string value matches the regex |
| `exists` | `path` | value is not `undefined` / `null` / `""` |

`path` is a dotted lookup into the run context (`<nodeId>.<field>...`). The first matching case wins; otherwise `default`. Every outgoing edge from a branch must set `fromPort` to a declared case `to` or the `default` — the linter rejects undeclared ports. There is no expression language and no numeric comparison (`gt`/`lt`) in v1; put numeric decisions in an `agent` or `transform` node and branch on its output.

## Templates

<div v-pre>

Node configs and prompts interpolate `{{path}}` against the run context (see `src/workflows/template.ts`):

- `{{<nodeId>.<field>}}` — an upstream node's output bundle, e.g. `{{classify.result}}`, `{{create_issue.issue.webUrl}}`. The trigger's payload lives under the trigger node's **id** — `{{trigger.text}}` works because the node is named `trigger`.
- `{{env.NAME}}` — env var, **only** if `NAME` is listed in the workflow's `envAllow`; anything else renders as `""`.

Unknown paths render as `""` (never as literal `{{…}}`), objects are JSON-stringified. No expressions, no filters — dotted paths only.

Channel trigger payloads include `text`, `chatId`, `channel`, `accountId`, `fromJid`, `sender.{id,name,username}`, `group.{id,name}`, `replyTo`, `replyToText`, `media.{path,type}`, `event.id`. Hook trigger payloads carry the hook context verbatim (`project`, `iid`, `action`, `mentions`, …).

</div>

## Dispatch mechanics

When `workflows.enabled: true` in daemon config:

1. Channel events, hook fires, and cron ticks reach the dispatcher through their respective paths (table above).
2. Matching honors `state`, `project` scope, trigger filters, then `priority` / `fanOut`.
3. The run is routed to its home node (local or mesh-forwarded; remote-origin events only reach workflows with `mesh.allowRemote`).
4. The walk driver executes pending nodes, folds outputs into context, pauses at `userTask` / `subProcess` / `signal.wait` / `checkpoint` / `timer.boundary`, and resumes via the matching callback (form submit, child end, signal, timer).

Runs are keyed by an entity ref (issue, MR, chat, cron fire) so webhook re-entry finds the active run instead of spawning a duplicate.

## Advanced nodes

BPMN-style primitives for long-lived, human-in-the-loop processes. They exist and are supported, but they are not the front door — most workflows never need them.

| Node | Purpose | Output |
|---|---|---|
| `userTask` | Assign a form to `actor:<id>` or `role:<id>`; pauses until submission (chat or web inbox) | `{ submittedAt, submittedBy, values, action }` |
| `subProcess` | Spawn a child workflow; parent pauses until the child reaches `end`. Child gets a fresh context seeded by `inputMap`; nesting bounded by `maxChildDepth`. | `{ childRunId, status, output }` |
| `signal.emit` / `signal.wait` | Publish / pause-until a named event (workflow or global scope) | `{ emittedAt, … }` / `{ receivedAt, name, payload }` |
| `timer.boundary` | Pause until a duration elapses | `{ firedAt, scheduledFor }` |
| `checkpoint` | Pause for an arbitrary resume event (filter-matched, like a trigger) | `{ event }` on resume |
| `gateway.parallel` | `mode: fanOut` splits to N branches; `mode: join` waits for every incoming edge | merged context |
| `rule` | DMN-style decision table; first matching row selects a port | `{ …row.output, matchedPort }` |
| `trigger.form` | Human fills a form to start a run | `{ submittedBy, values }` |

None of these are usable inside `flow:` — wire them with explicit edges. Human identities come from the Actor/Role primitives (`agentx actor add`, `agentx role create/grant`); a `userTask`'s form is delivered on each resolved actor's preferred channel. `examples/workflows/grant-application.json` exercises all of them end to end.

## CLI

```bash
# author
agentx workflow init <id> [--template linear|branching|extract|human-in-the-loop|retry] [--agent <id>] [--json]
agentx workflow templates
agentx workflow add <file>                # import into .agentx/workflows + hot-reload
agentx workflow list
agentx workflow show <id> [--format yaml]

# validate
agentx workflow validate                  # all workflows in .agentx/workflows
agentx workflow validate <file>           # one YAML/JSON file

# run + observe
agentx workflow run <id-or-file> [--input '{"key":"value"}'] [--watch]
agentx workflow trace <runId-or-taskId>
agentx workflow runs [<id>]

# control
agentx workflow pause  <runId>
agentx workflow resume <runId>
agentx workflow cancel <runId>

# drafts (absorb pipeline)
agentx workflow drafts
agentx workflow promote <draftId>
agentx workflow reject  <draftId>
```

`run` accepts a stored workflow id or a path to a YAML/JSON file — file paths are registered ad-hoc so iteration is fast. `--watch` tails the run's trace until it finishes.

## Absorb (advanced)

`agentx workflow absorb` distills executable DAG drafts directly from successful task traces — clustering similar tasks, then (with `--via <agentId>`) having an LLM architect emit a parameterized workflow. Drafts land in `.agentx/workflows/_drafts/` as `status: draft` + `state: disabled`; promotion is always an explicit human step (`agentx workflow drafts` / `promote` / `reject`).

This is the advanced trace→DAG path. For user-facing pattern mining — turning recurring activity into reviewable plain-language SOPs — start with [`agentx procedure extract`](./procedures.md) instead, and promote a procedure to a workflow only once it has proven stable.

See: [Actions](./actions) for the registry `action.run` invokes; [Three-tier model](../architecture/three-tier) for where workflows sit in the System / Process / Procedure hierarchy.
