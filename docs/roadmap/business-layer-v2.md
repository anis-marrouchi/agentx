# Business layer v2 — recurrence, roles-with-tasks, workflows, external sources

> **Status:** draft idea, not scheduled. Captured 2026-04-13 from a conversation about what the business layer should evolve into.
> **Today's gap:** the business layer works (standup → work-tick → wrap, org chart, KPI) but the backlog is a flat, perpetual checklist. No periodicity, no role templates, no state machine, no PM/ERP/CRM integration. Each ask below is one `WorkSource`/schema extension away.

## Motivating scenarios

- Solo founder wants Nadia to do a **daily** GSC delta and a **weekly** LinkedIn draft without re-typing the task every time it's checked off.
- Ops team wants a "monthly log prune" to appear on the first of every month, and a "yearly cert audit" to appear every January 1.
- Marketing workflow should be `backlog → drafting → review → scheduled → published → done`, with review gating on a manager role — SharePoint-style states and rules.
- Agents already work in GitLab (`To Do / Doing / Blocked / Done` labels) and the team also runs Odoo. They shouldn't be forced to pick one system — the business layer should federate.

## What exists today

- `src/business/work-pool.ts` — `WorkSource` interface with 3 implementations: `BacklogWorkSource` (`.md` checkboxes), `WikiWorkSource` (scans `.md` files for checkboxes), `GitLabWorkSource` (issues + labels).
- `WorkItem` fields: `id`, `title`, `description?`, `assignee?`, `estimatedSeconds?`, `url?`, `priority?`. No dates, no state, no tags.
- `WorkReport` states: `in-progress | done | blocked`. That's the whole state alphabet.
- No recurrence anywhere. Once `- [ ]` becomes `- [x]`, that line is dead.
- `roles.<name>.responsibilities[]` is a free-text array inlined into prompts. Not executable.
- Only one `workSource` at a time.

## Proposed evolution, ranked by lift

### 1. Recurrence on backlog items (tiny)

Extend the line grammar:

```markdown
- [ ] @marketing-agent GSC daily delta      [time: 30m]  [every: day]
- [ ] @marketing-agent Weekly SEO roll-up   [time: 1h]   [every: mon]
- [ ] @devops-agent    Monthly log prune    [time: 20m]  [every: 1st]
- [ ] @devops-agent    Yearly cert audit                 [every: jan-1]
- [ ] @marketing-agent Monitor brand mentions            [every: always]
```

On `report(status: "done")` the BacklogWorkSource rewrites `- [x]` → `- [ ]` with a trailing `<!-- last: 2026-04-13 -->` marker; `listOpen` uses the marker + `[every: …]` rule to decide whether the item is due today.

`[every: always]` = never auto-closes after report (monitoring tasks).

**Grammar tokens** (MVP): `day | mon..sun | weekdays | weekends | 1st | 15th | jan-1 | always`.

**Scope:** ~150 LOC, one file (`work-pool.ts`), plus tests.

### 2. Role-predefined recurring tasks (small)

Let roles carry their own recurring task list, virtually injected into every agent wearing that role:

```jsonc
"roles": {
  "marketing": {
    "title": "Marketing",
    "recurringTasks": [
      { "title": "GSC daily delta",       "every": "day",  "time": "30m" },
      { "title": "LinkedIn draft",        "every": "tue",  "time": "1h"  },
      { "title": "Monthly content audit", "every": "1st",  "time": "2h"  }
    ]
  }
}
```

A new `RoleTemplateWorkSource` surfaces these as virtual items (`role-template:marketing:gsc-daily-delta:2026-04-13`) next to the user's explicit backlog. Explicit items take precedence when titles collide.

**Scope:** ~200 LOC. Depends on #1.

### 3. CompoundWorkSource — federate sources (small)

Drop the "pick exactly one source" constraint:

```jsonc
"workSource": {
  "type": "compound",
  "sources": [
    { "type": "linear",  "teamId": "MKT",                 "agents": ["marketing-agent"] },
    { "type": "gitlab",  "projects": ["mtgl/mtgl-system-v2"], "agents": ["devops-*"] },
    { "type": "odoo",    "project": "Support",             "agents": ["pm-hasanah"] },
    { "type": "backlog", "path": ".agentx/backlog.md" }
  ]
}
```

`listOpen` returns the union; `claim`/`report` route by `itemId` prefix (already namespaced: `gitlab:…`, `backlog:…`). Optional per-source `agents` whitelist gates which agents see items from which source.

**Scope:** ~150 LOC. No new backend, just federation + routing.

### 4. Workflow states + transition log (medium, MVP)

Add `state?: string` to `WorkItem` and `nextState?: string` to `WorkReport`. Per-workflow transition map in config:

```jsonc
"workflows": {
  "marketing-task": {
    "states": ["backlog", "drafting", "review", "scheduled", "published", "done"],
    "initial": "backlog",
    "transitions": [
      { "from": "backlog",    "to": "drafting",  "when": "claim"  },
      { "from": "drafting",   "to": "review",    "when": "report" },
      { "from": "review",     "to": "scheduled", "when": "approve", "role": "marketing-manager" },
      { "from": "scheduled",  "to": "published", "when": "auto"   },
      { "from": "*",          "to": "blocked",   "when": "escalate" }
    ]
  }
}
```

Every transition appended to `.agentx/workflow/<itemId>.jsonl` — the audit trail. No SLA / hooks yet.

**Scope:** ~400 LOC. Unblocks #6.

### 5. Odoo / Linear / Jira / Asana / HubSpot / generic-webhook sources (medium each)

Each is a new `WorkSource` implementing the 4-method interface. Priority for this repo: **Odoo first** (already deployed via `mtgl-odoo` skill), **Linear second** (simple GraphQL). Jira / HubSpot / Salesforce / Zoho are natural follow-ups for enterprise users.

A `WebhookWorkSource` that accepts items via `POST /business/work-import` is the escape hatch for any system we haven't written a native adapter for.

**Scope:** ~250-400 LOC per adapter.

### 6. Full workflow engine — SLA timers + transition hooks (big)

On top of #4:

- `sla: { review: "4h", drafting: "1d" }` — triggers a timer per state entry; expiration fires an escalation.
- `onEnter: { blocked: { notify: "reportsTo" }, published: { kpi: "increment.publishedCount" } }` — hooks into notifications + KPI.
- Manager-role gating (`transition.role`) — only agents carrying a role can execute the transition.

**Scope:** ~800-1500 LOC. Ship only if the lighter layers earn their keep in daily use.

## Dependency graph

```
#1 recurrence ─────┬── #2 role recurring tasks
                   └── (used by everything below)
#3 compound ─────────┐
#4 workflow MVP ─────┼── #5 Odoo / Linear / Jira / …
                   ──┘
#6 workflow engine (SLA + hooks) ── builds on #4
```

## Non-goals (explicit, so we don't drift)

- **Full PM suite.** This is a work router and schedule, not a replacement for Linear/Jira/Odoo. Integration > duplication.
- **Board UI.** KPI and workflow state are available via HTTP JSON; a drag-drop board is someone else's product.
- **Multi-agent negotiation.** Agents only see items assigned to them. No auction / bidding / load balancing across agents beyond simple round-robin on role.
- **Real-time collaboration.** Day-cycle ticks are minutes, not seconds. If you need sub-minute coordination, you want a different tool.

## Smallest next step (if someone picks this up)

Land #1 (recurrence) as a standalone PR — ~150 LOC plus tests, no schema migration needed, zero impact on existing installs that don't use `[every: …]`. That alone turns a perpetual checklist into a living backlog and unblocks the rest.
