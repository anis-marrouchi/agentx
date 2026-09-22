# Workflow schema

A V2 workflow is a directed graph stored as JSON or YAML under `.agentx/workflows/`. The editor's canvas displays the same definition. Use `agentx workflow validate <file>` before importing a hand-written file.

| Term | Meaning |
|---|---|
| Workflow | The named automation definition |
| Node | One unit of work, such as a trigger, an agent call, or an output action |
| Edge | A connection from one node ID to another; a branch can choose a named output port |
| Run | One execution of a workflow |
| Pause / resume | Stops and later continues a run where supported |

## Required structure

| Field | Meaning |
|---|---|
| `id` | Stable lowercase ID using letters, digits, hyphens or underscores |
| `version` | `2` |
| `title` | Human-readable title |
| `nodes` | Nonempty array of `{ id, type, config }` objects |
| `edges` | Connections such as `{ "from": "start", "to": "report" }` |
| `state` | Dispatch control: `active`, `disabled`, or `quarantined` |
| `status` | Review metadata: `draft`, `review`, `active`, or `deprecated` |

**`state` controls execution.** A workflow marked `status: "draft"` can still run if its `state` is active. Use `state: "disabled"` for a proposal that must not fire yet. A quarantined workflow is held because of a detected conflict; investigate that conflict before reactivating it.

## A small example

Download [demo-report.json](/examples/demo-report.json). It contains three nodes: `trigger.manual`, `agent`, and `end`. The agent node uses `config.agentId: "cx"` and a fixed report prompt. Replace `cx` with your registered agent before using it outside the demo.

```sh
agentx workflow validate demo-report.json
agentx workflow add demo-report.json
```

The example is deliberately disabled. After reviewing it, set `state` to `active`, import the updated file, and test it:

```sh
agentx workflow run demo-report --watch
agentx workflow runs demo-report
```

The daemon must have `workflows.enabled: true`. These commands use `http://127.0.0.1:18800` by default; pass `--daemon <url>` when working against another endpoint where that option is available.

## Inputs and error handling

Node configuration can reference earlier outputs with templates such as <code v-pre>{{trigger.payload.text}}</code>. A manual run can supply JSON using `--input '{"text":"Prepare a summary"}'`. Each node may declare `retry: { maxAttempts, backoffMs }`; retrying an external write can repeat its side effect, so use it only when the action can safely be repeated.

An `agent` node needs a registered `agentId`. An `action.send` node needs a live channel and destination. `branch` uses named ports to choose an edge; `checkpoint` pauses for review. Node configuration is validated by the corresponding handler, so passing the top-level file validator alone does not prove that credentials or destinations work.

The editor's assistant can propose a workflow from a request. **Apply to canvas replaces the current graph.** Review the agent, input, destination, and error path before saving. The complete implementation is in `src/workflows/types.ts` and `src/workflows/nodes/`.

<!-- No screenshot needed: this is the machine-readable counterpart to the illustrated automation guide. -->
