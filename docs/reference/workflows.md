---
title: "Workflows"
---

# Workflows

AgentX workflows model **business activities as directed dataflow graphs**. A workflow is a set of nodes connected by edges; a run executes the graph by walking from a trigger, accumulating each node's output into a shared context, and pausing whenever a party (human, agent, external system, or child workflow) needs to act.

The same engine powers two ends of the spectrum:

- **Bot automations** — "incoming Telegram message → classify → reply" — short, stateless, request/response.
- **Business processes** — "applicant submits form → AI pre-screens → reviewer scores (human) → external disbursement webhook → child closure workflow → email" — long-lived, state-based, composable.

There's no separate engine for the two shapes. Authors pick the node types that match their problem.

## A simple workflow, end-to-end

Before the catalog: here's the smallest useful flow, in plain English.

1. **Trigger fires** when a Telegram message contains the word "expense".
2. **Agent extracts** the amount + category from the message.
3. **If amount > $500**, route to a `userTask` form for the CFO; **else**, post directly to a Slack approvals channel.

In YAML (each line annotated):

```yaml
id: expense-routing
nodes:
  - id: in                          # the trigger node
    type: trigger.channel           # listen for channel messages
    config:
      channel: telegram             # only Telegram
      match:
        textContains: "expense"     # only messages with the word "expense"

  - id: classify                    # ask an agent to read the message
    type: agent
    config:
      agentId: finance-bot          # which agent runs
      prompt: |
        Extract amount (USD) and category from:
        {{in.text}}                 # the user's text from the trigger
      outputJson: true              # parse the reply as JSON

  - id: route                       # branch on the parsed amount
    type: branch
    config:
      on: "{{classify.json.amount}}"
      cases:
        - { gt: 500, port: cfo }    # >$500 → CFO branch
        - { else: true, port: slack }

  - id: cfo
    type: userTask                  # pause until a human submits
    config:
      assignTo: actor:cfo
      form: { fields: [approve, reject] }

  - id: slack
    type: action.send               # one-shot send, no wait
    config:
      channel: slack
      chatId: "#approvals"
      text: "Auto-approved: {{classify.json.amount}}"
```

That's it — five nodes, one branch, one human checkpoint. Below is the catalog of every node type you can use in a workflow. Each entry shows: what it does, the template fields it reads from the run state, and what it writes back. You probably won't need most of them on day one — start with `trigger`, `agent`, and `userTask`.

## Mental model

A workflow **reflects a complete activity from start to end**. Each node is a step; each edge is a state transition. Transitions fire because a party *did something*, not because time passed — timers exist (SLAs, intermediate waits) but aren't the primary driver.

Four party kinds advance a run:

| Party | Node that waits for it | How it advances state |
|---|---|---|
| Human | `userTask` | Submits a form in chat or web inbox |
| Agent (LLM) | `agent` | Returns a `RESULT:` token |
| External system | `signal.wait`, `checkpoint`, `trigger.hook` | Posts a webhook or emits a signal |
| Child workflow | `subProcess` | Reaches its own `end` node |

## Node catalog

### Triggers

| Node | Purpose | Output bundle |
|---|---|---|
| `trigger.channel` | Entry point for a channel adapter message (WhatsApp, Telegram, Slack, Discord, GitLab) | `{ event, text, chatId, channel, fromJid, sender, group?, media? }` |
| `trigger.cron` | Scheduled fire | `{ firedAt }` |
| `trigger.hook` | Arbitrary hook event subscription | payload-specific |
| `trigger.manual` | CLI-initiated runs (`agentx workflow run <id>`) | payload-specific |
| `trigger.form` | Human fills a form to start a new run | `{ submittedBy, values }` |

### Compute

| Node | Purpose | Output |
|---|---|---|
| `agent` | Invoke a registered agent with a templated prompt | `{ reply, result, json?, taskId, durationMs }` |
| `transform` | Pick or reshape values from upstream context | arbitrary |

### Control flow

| Node | Purpose | Output |
|---|---|---|
| `branch` | N-way switch on `equals`/`contains`/`matches`/`exists` | passes through; selects outgoing port |
| `gateway.parallel` | `mode: fanOut` splits to N branches; `mode: join` waits for every incoming edge | merged context |
| `rule` | DMN-style decision table — first matching row wins | `{ ...row.output, matchedPort }` |
| `checkpoint` | Pause for an arbitrary resume event | `{ event }` on resume |
| `end` | Terminates the run with a status | — |

### Actions

Built-in verbs (one method per channel adapter): `action.send`, `action.createIssue`, `action.setLabel`, `action.readLabel`, `action.react`, `action.editMessage`, `action.logTime`, `action.callHTTP`.

`action.run` invokes a registered action from the [action registry](./actions). Config takes an `actionId` plus a templated `inputs` map; output mirrors the registry's `ActionRunResult` so downstream nodes can branch.

```json
{
  "id": "notify_lead",
  "type": "action.run",
  "config": {
    "actionId": "slack-notify",
    "inputs": { "text": "New lead from {{trigger.source}}: {{trigger.email}}" }
  }
}
```

Outputs: <code v-pre>{{ &lt;nodeId&gt;.ok / .status / .output / .errors / .durationMs }}</code>. Use `action.callHTTP` for one-off calls inside a single workflow, `action.run` when the same call shows up in three or more places (or in a CLI/cron) and deserves to be promoted to the registry.

### BPM

| Node | Purpose | Output |
|---|---|---|
| `userTask` | Assign a form to an actor or role; pauses until submission | `{ submittedAt, submittedBy, values, action }` |
| `subProcess` | Spawn a child workflow; parent pauses until child reaches `end` | `{ childRunId, status, output }` |
| `signal.emit` | Publish a named event | `{ emittedAt, name, scope, payload }` |
| `signal.wait` | Pause until a matching signal arrives | `{ receivedAt, name, payload }` |
| `timer.boundary` | Pause until a duration elapses (ISO-8601 or minutes) | `{ firedAt, scheduledFor }` |

## Identities

Workflows reference humans via the **Actor** and **Role** primitives, stored under `.agentx/actors/` and `.agentx/roles/`.

```bash
# create an actor with one or more channel handles
agentx actor add alice --name "Alice Ahmed" --telegram 1234567890 --email a@co.test --prefer telegram

# group actors via a role
agentx role create reviewers --name "Grant Reviewers" --strategy first-available
agentx role grant reviewers actor:alice
agentx role grant reviewers actor:bob
```

Assignment strategies: `first-available` (default, first member), `round-robin` (rotates), `all` (fans out), `manager-of` (future). Nested roles are resolved recursively.

A `userTask` node's `assignTo` takes either an actor ref (`actor:alice`) or a role ref (`role:reviewers`). The configured channel renderer (Telegram, WhatsApp, Slack, web inbox) delivers the form to each resolved actor's preferred channel.

## Templates

<div v-pre>

Every node's config and every prompt can interpolate `{{nodeId.path}}` against the run context. Examples:

- `{{trigger.values.amount}}` — value of a field submitted at the trigger form
- `{{classify.result}}` — the agent node's parsed `RESULT:` token
- `{{review.values.score}}` — a submitted user-task form field
- `{{env.GITLAB_TOKEN}}` — env var (must be in the workflow's `envAllow`)

Template rendering respects the allowlist on `workflow.envAllow` for any `{{env.*}}` lookups, so secrets never leak through unreviewed templates.

</div>

## Sub-process composition

A workflow can embed another workflow via `subProcess`:

```json
{
  "id": "closure",
  "type": "subProcess",
  "config": {
    "workflowId": "grant-closure-letter",
    "inputMap": { "trigger": { "grantee": "{{trigger.values.applicantName}}" } },
    "awaitCompletion": true
  }
}
```

Semantics:

- Parent **pauses** at the subProcess node; child runs to its own `end`; parent **resumes** with the child's output.
- Child gets a **fresh context**, seeded only by `inputMap`. Set `inputMap: "*"` for full inheritance (opt-in).
- Nesting is bounded by `workflow.maxChildDepth` (default 5). Exceeding the cap fails the parent run with a clear error.
- Runs carry `parentRunId`, `rootRunId`, and `depth` — the composition tree is traversable and rendered on `/processes`.

## Running it

Workflows live at `.agentx/workflows/<id>.json`. When `workflows.enabled: true` in daemon config, the engine:

1. Watches channel events, cron fires, and hook subscriptions.
2. Matches trigger filters.
3. Routes to the home node (local or mesh-forwarded).
4. Walks the DAG — executing each pending node's handler, folding output into context, pausing at `userTask`/`subProcess`/`signal.wait`/`checkpoint`/`timer.boundary`, and resuming via the appropriate callback (form submit, child end, signal emission, timer fire).

Runs are append-only JSONL at `.agentx/workflows/_runs/<runId>.jsonl`. Tasks live at `.agentx/workflows/_tasks/<taskId>.json` while open, archived under `_tasks/_completed/` on submit. Timers at `.agentx/workflows/_timers/`.

## HTTP surface

- `GET /workflows` — editor and workflow list UI
- `GET /inbox?actor=<id>` — per-actor task list + form renderer
- `GET /processes` — run overview with SLA indicators + composition tree
- `POST /api/workflows/tasks/:id/submit` — submit a user-task form (body: `{ submittedBy, submission: { action, values } }`)
- `GET /t/:taskId/:action?actor=<id>` — one-click approve/reject (emitted as URL buttons in Telegram)
- `POST /api/workflows/signal/:name` — manually emit a signal (debugging, external webhooks)
- `GET /api/workflows/kpis` — actor-level + total KPIs

## CLI

```bash
# inspect definitions
agentx workflow list
agentx workflow show <id>
agentx workflow validate <id>

# run a manual workflow
agentx workflow run <id> --input '{"key":"value"}'

# inspect runs
agentx workflow runs --workflow <id> --limit 20
agentx workflow run show <runId>

# identity management
agentx actor add / list / show / remove
agentx role  create / grant / revoke / list / show
```

## Example: grant application

The repository ships `examples/workflows/grant-application.json` + `examples/workflows/grant-closure-letter.json` as a proof of life exercising all four party kinds and one nested sub-workflow:

```
trigger.form (human)
    ↓
agent (pre-screen eligibility)
    ↓
branch (on agent.result)
    ├─ "eligible" → userTask (human: reviewer score)
    │                   ↓
    │                 branch (on review.action)
    │                   ├─ "primary" → signal.wait (external: finance webhook)
    │                   │                   ↓
    │                   │                 subProcess (child: closure letter workflow)
    │                   │                   ↓
    │                   │                 action.callHTTP (notify applicant)
    │                   └─ "reject"
    ├─ "ineligible" → action.callHTTP (rejection email)
    └─ "needs-clarification" → userTask (human: clarification request)
```

Copy both files into `.agentx/workflows/`, register a Telegram/WhatsApp actor for your reviewer role, and drive the first transition by POSTing a form submission to `/api/workflows/tasks/<taskId>/submit`.
