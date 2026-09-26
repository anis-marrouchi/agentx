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

## Event trigger filters

A `trigger.hook` node subscribes to an `on:*` event, such as `on:gitlab-mr` or `on:github-pr`. Its `config.filter` narrows which events start a run. Events that don't match are dropped before any agent is woken.

| Filter | Events | Fires only when |
|---|---|---|
| `topic` | `on:n8n` | The topic in `/webhook/n8n/<topic>` is listed |
| `action` | GitLab issue and MR events | The action, such as `open`, is listed |
| `mentions` | `on:gitlab-note` | The comment @-mentions a listed username |
| `noteableType` | `on:gitlab-note` | The comment is on a listed type: `merge_request` or `issue` |
| `assigneesAdded`, `reviewersAdded`, `labelsAdded` | GitLab issue and MR events | The update added a listed assignee, reviewer, or label |
| `skipSelfAuthored` | Events with an author | The author is not one of this workflow's own agents (off by default) |
| `ignoreAuthors` | Events with an author | The author is not in the list. Leading `@` and letter case are ignored |
| `maxFiresPerTarget` | Issue, MR, PR, and note events | This workflow has fired fewer than `count` times for the same issue, MR, or PR within `windowMinutes` (default 60) |

**Loop guard.** With `skipSelfAuthored: true`, a workflow skips events written by the bot identity of any agent it runs, so a routine's own comment or label change cannot restart it. It is off by default, because label-driven lifecycle workflows react to their own agent's transitions on purpose. To find that identity, AgentX checks the GitLab adapter's username-to-agent map, the signature on AgentX comments, and each agent's `gitlabUsernames` or `githubUsernames` in `agentMappings`. If the identity can't be resolved, the daemon logs this once and only `ignoreAuthors` applies. On GitLab issue and MR events the identity comes only from the username map. When all agents share one GitLab token, they post as one user, which maps to a single agent, so a workflow run by a different agent won't see those events as self-authored. Comments avoid this because AgentX reads the signature on each comment.

This check can't catch two routines that trigger each other, such as a generator and a critic. Neither one sees its own identity. Use `maxFiresPerTarget` for that case:

```json
{ "event": "on:gitlab-note",
  "filter": { "noteableType": ["merge_request"], "ignoreAuthors": ["ci-bot"],
              "maxFiresPerTarget": { "count": 3, "windowMinutes": 60 } } }
```

A note and an update on the same MR count toward the same limit. Every loop-guard skip still claims the event, unless the trigger sets `passthrough`. That way the adapter's fallback (the project's default agent, or the legacy @-mention path) doesn't wake the agent instead. Every skip is logged as `[workflows] <id> skipping <event> (<reason>)`. The counters are held in memory, so a daemon restart resets them.

The editor's assistant can propose a workflow from a request. **Apply to canvas replaces the current graph.** Review the agent, input, destination, and error path before saving. The complete implementation is in `src/workflows/types.ts` and `src/workflows/nodes/`.

<!-- No screenshot needed: this is the machine-readable counterpart to the illustrated automation guide. -->
