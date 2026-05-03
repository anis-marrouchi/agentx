---
title: "PM gating — org-chart governance"
---

# PM gating — org-chart governance

PM-gating lets you say "only the PM (project manager) for this project can authorize work on it" or "developers can only file infrastructure tickets, not marketing requests." Without it, any agent can dispatch any task. With it, agentx checks the org chart on every dispatch — if the requesting agent isn't authorized for that project's intent, the dispatch is refused and logged. This playbook walks you through enabling the gate, defining a tiny org chart, and verifying that the gate refuses an out-of-scope request.

When the project has a "human" hierarchy — director, project managers, coders — letting every inbound dispatch hit any agent loses the org-chart's intent. PM gating routes project-scoped events through the agent acting as that project's PM first; the PM then decides whether to handle, delegate, or escalate.

This is Phase 3 of the architectural rescue. It rides on top of the [intent ledger](/reference/cli#ledger) (Phase 1) so every gate decision is auditable.

## Why org-chart governance

Without PM gating:
- A GitLab issue on `mtgl/mtgl-system-v2` hits a `gitlab` route → routes to `mtgl-v2` (the coder agent).
- The coder dispatches. PM never sees it.
- If the coder refuses or fails, the dispatch ends — no escalation up the chain.

With PM gating:
- Same inbound hits the route → the dispatcher checks `business.projects[].pm` for the project → finds `pm-mtgl` → dispatches to `pm-mtgl` first.
- `pm-mtgl` decides: handle, delegate to `mtgl-v2`, or escalate to `product-director`.
- The ledger records each step (the PM gate's decision, the coder's resolution, any escalation). `agentx ledger lineage` walks the chain.

## Enabling

Two settings, both required:

```bash
# 1. The flag — read once at daemon startup
export INTENT_PM_GATE_ENABLED=true

# 2. business.enabled = true
agentx config set business.enabled true
```

Verify:

```bash
agentx config governance
```

Expected output:

```
  Governance flags

  INTENT_LEDGER_MODE        shadow              (or authoritative)
  INTENT_PM_GATE_ENABLED    active
    business.enabled        true
    business.projects[]     <count>
```

If you see `env=true but business.enabled=false → inactive`, the flag isn't doing anything. Set `business.enabled=true` first.

## Defining `business.projects[]`

For each project that should go through a PM:

```bash
agentx config set business.projects '[
  { "id": "mtgl/mtgl-system-v2", "pm": "pm-mtgl" },
  { "id": "mtgl/mtgl_system",    "pm": "pm-mtgl" },
  { "id": "ksi/ksi-v2",          "pm": "pm-ksi" },
  { "id": "ksi/ksi.tn",          "pm": "pm-ksi" },
  { "id": "noqta/hackathonat",   "pm": "pm-hackathonat" }
]'
```

The `id` shape depends on the source:

- GitLab: `<group>/<project>` (matches GitLab's `references.full` minus the issue number)
- GitHub: `<owner>/<repo>`
- Internal projects: any stable string the dispatcher correlates by

A project without a `pm` entry falls through with the legacy direct-routing behaviour — useful as a graceful migration knob (turn the gate on, migrate projects one at a time).

## Org chart prerequisites

`pm-mtgl` (and any agent listed as a PM) must be registered in `business.orgChart`:

```json
"business": {
  "orgChart": {
    "product-director": {
      "role": "director",
      "schedule": { "start": "09:00", "end": "17:00" }
    },
    "pm-mtgl": {
      "role": "pm",
      "reportsTo": "product-director",
      "schedule": { "start": "09:00", "end": "17:00" }
    },
    "mtgl-v2": {
      "role": "coder",
      "reportsTo": "pm-mtgl",
      "schedule": { "start": "09:00", "end": "17:00" }
    }
  }
}
```

The `Organization` class (in `src/business/organization.ts`) validates the chain at construction — unknown `reportsTo`, cycles, or unknown roles all fail fast.

When `orgChart` is **empty** (`employees.size === 0`), the gate is **permissive** — every agent can handle every dispatch. This is the safe default for partially-configured installs that populate `projects[].pm` for the gate but haven't filled the chart yet.

## Gate behaviours

The gate runs `Organization.canHandle(agentId, project, intent)` before dispatching. Outcomes:

| Outcome | When | Result |
|---|---|---|
| **Pass** | Agent is in the org chart and (today) any registered agent can handle | Dispatch proceeds to the agent |
| **Reject** | Agent is not in the org chart | Decision recorded as `dropped` in the ledger; escalation chain available |
| **PM-route** | The matched agent is not the project's PM, but the project has one | Dispatcher rewrites the target to the PM; original agent is the second hop |

The `decideAndCommit` orchestration primitive (in `src/intent/decide.ts`) reads the gate decisions through the `DispatchGovernance` interface — so policy is testable without a live daemon.

## Audit trail in the ledger

Every gate decision is a row in `intent_decisions` with `decided_by = "pm-gate"`. To inspect:

```bash
# Stats — how many gate-rerouted dispatches in the last 24h?
agentx ledger stats --since 24h

# Recent active dispatches — what's in flight under the gate?
agentx ledger active

# Walk one event's lineage — see the gate's call + the agent's resolution
agentx ledger lineage <event-id>

# Replay — does the gate produce the same answer when re-run on the snapshot?
agentx ledger replay --since 24h
```

Replay is the reproducibility check: run weekly. Divergences > 0 mean something non-deterministic crept into the gate logic (or the orgchart changed mid-flight).

## Common pitfalls

- **Flag set, no effect.** `INTENT_PM_GATE_ENABLED=true` requires `business.enabled=true`. The `agentx config governance` command makes this gotcha explicit.
- **Day-cycle flood.** If you flip on `business.enabled` *and* `business.workSource.type=gitlab`, the work-pool starts pulling every assigned issue — agents work like crazy. Use `workSource.type=backlog` and import deliberately ([backlog playbook](./backlog-import-sync)).
- **Agent rejected with "agent X cannot handle".** The agent isn't in `orgChart`. Either add it or accept the empty-orgchart permissive default.
- **PM-route appears to no-op.** The dispatcher writes the rewrite in the ledger but the legacy router still runs in shadow mode. Look in the [Live page](/reference/dashboard/live) — both are visible during shadow.

## Disabling

To roll back without losing the ledger:

```bash
unset INTENT_PM_GATE_ENABLED
# or in .env:
# INTENT_PM_GATE_ENABLED=false
sudo systemctl restart agentx
```

The ledger keeps recording in `shadow` mode (if `INTENT_LEDGER_MODE=shadow`); only the gate itself stops firing. To go further, see the [Rollback runbook](/reference/rollback-runbook).

## Next

- [Capability audit playbook](./capability-audit) — Phase 5/8 admission control on top of PM gating
- [`agentx ledger` CLI reference](/reference/cli#ledger)
- [Architectural rescue plan](https://github.com/anis-marrouchi/agentx/blob/master/docs/architecture/research-rescue-plan.md) — the full Phase 3 rationale (private design doc)
