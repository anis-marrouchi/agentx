# Three-tier model: System, Process, Procedure

AgentX is organised into three operational tiers. The dashboard nav, the
docs, and the runtime are all anchored to this separation so that "where
does X live?" and "who owns X?" always have the same answer.

This is the runbook framing applied to a multi-agent system. A runbook
answers five questions about a piece of work: **when** it fires,
**what** comes in, **how** it runs, **what** comes out, **who** owns it.
Each of those five maps cleanly onto one of the three tiers.

## Tier 1 — System

The always-on infrastructure. Long-lived, mostly declarative.

| Concept | File / Source | Dashboard surface |
|---|---|---|
| Agents (config, registry, persistent processes) | `src/agents/registry.ts`, `agentx.json:agents` | Live, Settings, /admin/processes |
| Channels (telegram, gitlab, github, whatsapp, webrtc, …) | `src/channels/*` | Settings |
| Mesh (peers, A2A) | `src/a2a/*` | Settings, peer selector in topbar |
| Hooks (event subscribers) | `src/hooks/*` | Health |
| Verified References (canonical facts: hosts, projects) | `agentx.json:references`, `src/agents/references/` | Settings |
| Memory (per-agent persistent facts) | `src/agents/memory-store.ts` | Settings |
| Activity ledger | `src/intent/ledger.ts` | /admin/ledger |
| Costs / token tracking | `src/daemon/token-tracker.ts` | /admin/cost |

Touch this tier when you are changing **what exists**, not what we do
with it.

## Tier 2 — Process

Named, reusable, parameterised SOPs. This is where intent turns into
work — the place a runbook actually lives. Workflows are the central
artefact.

| Concept | File / Source | Dashboard surface |
|---|---|---|
| Workflow definitions | `.agentx/workflows/*.yaml` | /workflows |
| Workflow drafts (review queue) | `.agentx/workflows/_drafts/*.yaml` | /workflows (left rail Drafts) |
| Workflow runs (history, replay, traces) | `src/workflows/run-store.ts`, SQLite `task_traces` | /workflows run drawer |
| Triggers (manual / cron / hook / channel) | `src/workflows/triggers.ts` | per-workflow detail |
| Matching (intent → workflow routing) | `src/workflows/matcher.ts`, `agentx.json:workflows.matching` | per-task log line |
| User-task inbox (BPM) | `src/workflows/task-store.ts` | /inbox |
| Boards / kanban (per-channel work pool) | `src/business/work-pool.ts`, `src/boards/*` | / (Boards) |

Each workflow on /workflows is a runbook:

- **WHEN** — `trigger.*` node + matching criteria + last-fired badge
- **WHAT comes in** — `trigger.config.inputSchema` (typed)
- **HOW** — the DAG (nodes + edges)
- **WHAT comes out** — `end.config.output` (structured)
- **WHO** — `ownerAgent` + tags + `sourceTaskIds`

Touch this tier when you are changing **how the system handles a
recurring kind of work**.

## Tier 3 — Procedure

Reusable concrete steps a process composes. The verb library that
workflows reach for instead of inlining shell. Procedures live one
level beneath workflows — workflows reference them, not the other
way around.

| Concept | File / Source | Dashboard surface |
|---|---|---|
| Built-in typed actions (http.fetch, file.*, mesh.delegate, extract.structured, rag.lexical, …) | `src/actions/builtin/*` | /procedures |
| Workflow templates (init scaffolds) | `src/workflows/templates/*.yaml` | /procedures |
| Agent skills (per-agent toolkit, auto-injected on relevance) | `src/agent/skills/*` | per-agent settings |
| RAG indexes | `src/rag/lexical-index.ts` | per-agent settings |

Touch this tier when you are adding a **new building block** that
multiple workflows can reuse.

## Composition rule

Higher tiers depend on lower tiers, never the reverse:

```
Procedure (verbs)        →  used by
Process (workflows)      →  runs on
System (agents/channels) →  observable as runs on the dashboard
```

A procedure must not embed knowledge of which workflow calls it. A
workflow must not hardcode infrastructure details (hosts, project
paths, branches) — those come from `inputSchema` parameters resolved
from the System tier (chatId, references, channel context).

## How the dashboard reflects this

Topbar groups the tabs by tier:

```
System    │ Live · Health · Activity Graph · Ledger · Cost · Settings
Processes │ Workflows · Boards · Inbox
Procedures│ Procedures · Wiki · Glossary
```

Each tier is also one HTTP namespace: `/admin/*` for system,
`/workflows` and `/inbox` for process, `/procedures` for the verb
library.

## When a new feature lands, ask which tier owns it

- "Add an OAuth refresher that runs every hour" → System (it's a hook),
  surfaced as a Cron entry under Settings.
- "Capture the SSH-pull-and-rebuild-cache pattern as a step we can
  reuse" → Procedure (`action.builtin` or a sub-workflow template),
  surfaced under /procedures.
- "When a GitLab issue is labelled 'bug', triage it and assign" →
  Process (workflow), surfaced under /workflows.

Cross-tier wiring (e.g. a workflow that calls a procedure, which calls
an agent on a peer node) happens at the trigger and at typed action
boundaries. Inside the workflow you only ever see the abstraction one
tier down — never two.
