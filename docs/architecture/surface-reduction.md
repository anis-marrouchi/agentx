# Surface reduction — the evidence and the bar

AgentX accumulated 46 CLI commands, 16 dashboard pages, 8 channel adapters and
roughly two dozen runtime subsystems. Some of them have never executed once.

This document is the standing record of what is actually used, the bar a
surface has to clear to stay, and the log of what has been cut.

## The bar

A surface is removed only when it fails **both** tests:

1. **Usage** — no measured traffic across the fleet in the last 30 days.
2. **Impact** — nothing depends on it being there for correctness, recovery, or
   safety.

Test 2 is why `agentx doctor` and the [rollback runbook](/reference/rollback-runbook)
stay regardless of how rarely they run. Insurance is not measured by how often
you claim on it.

## Method

Two nodes, both queried directly (`task_history` in each node's
`.agentx/db.sqlite`, plus runtime-directory contents):

- **mac** — dev + GitLab + cron workload
- **clawd** — production, GitLab-heavy, hosts WhatsApp

Single-node data is not evidence. The first version of this analysis was run on
`mac` alone and concluded WhatsApp had *never been used*. On `clawd` it has 62
tasks in the last 30 days. That mistake is the reason the two-node rule exists.

## Channel traffic — last 30 days

| Channel | mac | clawd | total | Verdict |
|---|---:|---:|---:|---|
| gitlab | 513 | 1350 | **1863** | Core |
| cron | 731 | 115 | **846** | Core |
| api | 652 | 125 | **777** | Core |
| telegram | 70 | 5 | **75** | Keep |
| whatsapp | 0 | 62 | **62** | Keep |
| workflow | 0 | 54 | **54** | Keep |
| github | 5 | 0 | **5** | Keep — low but live |
| discord | 0 | 0 | **0** | Candidate — never used, either node, ever |
| slack | 0 | 0 | **0** | Candidate — never used, either node, ever |

GitLab, cron and API are 95% of all traffic.

## Dead surfaces — zero traffic, both nodes

| Surface | Last used | Note |
|---|---|---|
| `chat-cli` | 2026-07-03 | 70 tasks (mac) + 2 (clawd), then nothing |
| `tui` | 2026-07-03 | 4 tasks ever, mac only |
| `web-chat` | 2026-06-01 | 140 tasks (clawd), then nothing |
| `workflow-editor` | 2026-05-10 | 6 tasks ever |

`chat-cli` and `tui` are the clearest signal in this whole document. Both were
built so you could talk to your agents from a terminal. Both died in the same
week, and neither has been touched since. They lost to Claude Code.

That is the finding [attach mode](/reference/attach) responds to: rather than
building a third attempt at a chat client, let the client you already prefer
wear the agent identity. **Attach mode is what earns the right to deprecate
these two** — the capability isn't being dropped, it's being replaced by a
better host.

## Runtime directories never written

Empty on both nodes — the subsystem has produced no artefact, ever:

| Directory | mac | clawd |
|---|---|---|
| `.agentx/actors/` | empty | empty |
| `.agentx/patterns/` | empty | empty |
| `.agentx/roles/` | empty | empty |
| `.agentx/rag/` | empty | absent |
| `.agentx/actions/` | empty | absent |

Correspondingly, `actions`, `rag`, `actors` and `roles` are unconfigured in both
`agentx.json` files.

Stale but non-empty (produced something once, nothing recently) — these need the
B1 soak before any decision:

`reports/` (Apr 6) · `groups/` (Apr 6) · `telegram/` cache (Apr 15) ·
`board-audit` (Apr 17) · `router/` (Apr 18) · `drift/` (Apr 20) ·
`references/` (Apr 27) · `intent/` (Apr 29) · `media/` (May 6)

Alive on both nodes: `sessions/`, `usage/`, `kpi/`, `graph/`, `wiki/`,
`workflows/`, `memory/`, `agent-memory/`, `guardrails/`, `cron/`.

## The gap this data does not cover

`task_history` records *agent dispatches*. It says nothing about which **CLI
commands** operators run or which **dashboard pages** they open — and those are
the two biggest surfaces by count (46 and 16).

Nothing counts them today. Guessing would be exactly the kind of opinion this
document exists to replace, so the next step is a one-line counter (command
name and page path only — no arguments, no payloads) into the existing
`usage_daily` table, then a two-week soak.

## Process

Deletion is staged, never big-bang:

| Stage | What happens | Reversible |
|---|---|---|
| **B0** | Measure across the fleet. This document | — |
| **B1** | Instrument CLI commands + dashboard pages. Soak 2 weeks | — |
| **B2** | Hide: deprecation notices, group commands, drop dead pages from nav | Yes, fully |
| **B3** | Remove: code, config keys, runtime dirs, docs, sidebar — together | One revert per subsystem |

Each B3 removal is a single commit covering one subsystem, so a mistake costs
one `git revert` rather than an archaeology session.

## Log

| Date | Change | Evidence |
|---|---|---|
| 2026-08-11 | Baseline recorded (this document) | Fleet query, both nodes |

*Nothing removed yet.*
