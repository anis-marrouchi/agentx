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

## Runtime directories never written — and why that proved almost nothing

Empty on both nodes, and unconfigured in both `agentx.json` files:

| Directory | mac | clawd |
|---|---|---|
| `.agentx/actors/` | empty | empty |
| `.agentx/patterns/` | empty | empty |
| `.agentx/roles/` | empty | empty |
| `.agentx/rag/` | empty | absent |
| `.agentx/actions/` | empty | absent |

The first read of this table was that all five subsystems were dead. **Four of
the five were not**, and checking the import graph before deleting is what
caught it:

| Subsystem | Imported by | Verdict |
|---|---|---|
| `actions` | `workflows/nodes/handlers.ts`, daemon, admin panel | **Keep** — workflow `action` nodes depend on it |
| `actors` | workflow dispatcher, Telegram/WhatsApp form renderers, admin panel | **Keep** — the BPM assignee model |
| `roles` | workflow dispatcher, `actors/types.ts`, admin panel | **Keep** |
| `patterns` | `agents/registry.ts` — the dispatch hot path | Candidate, see below |
| `rag` | only `actions/builtin/rag.ts` (the `rag.lexical` action) | Candidate |

An empty runtime directory means **no operator ever created that kind of
data** — no custom actions, no actors, no roles. It does *not* mean the code is
unreachable. Workflows (54 tasks in 30d) and the business layer (8 entries) both
run through `actions` and `actors` continuously; deleting them on directory
evidence alone would have broken live production paths on clawd.

This is the impact half of the bar catching what the usage half missed, and it
is the strongest argument for the two-part test.

### The two genuine candidates

`patterns` is reachable but inert. `extractPatterns()` runs fire-and-forget
after **every** task and `patternStore.findRelevant()` feeds `patternContext`
into context assembly — yet the store is empty on both nodes after months and
thousands of dispatches. Removing it is behaviour-preserving by definition
(an always-empty context contribution), but it touches the dispatch hot path in
four places, so it wants its own commit and its own sign-off rather than being
swept in with an adapter deletion.

`rag` is reachable only through the `rag.lexical` built-in action, which no
configured workflow references. Self-contained, low risk, small payoff.

Stale but non-empty (produced something once, nothing recently) — these need the
B1 soak before any decision:

`reports/` (Apr 6) · `groups/` (Apr 6) · `telegram/` cache (Apr 15) ·
`board-audit` (Apr 17) · `router/` (Apr 18) · `drift/` (Apr 20) ·
`references/` (Apr 27) · `intent/` (Apr 29) · `media/` (May 6)

Alive on both nodes: `sessions/`, `usage/`, `kpi/`, `graph/`, `wiki/`,
`workflows/`, `memory/`, `agent-memory/`, `guardrails/`, `cron/`.

## Wait for the instrument, or don't

The first version of this plan gated **every** removal behind a two-week soak of
the new `surface_usage` counter. That was wrong, and it is worth writing down
why so the mistake isn't repeated.

`surface_usage` counts CLI commands and dashboard pages. It does not count
channels, and it does not count runtime directories. Gating a channel removal on
it measures nothing about that channel — the wait was cargo-culted from "we
built an instrument" to "everything waits for the instrument."

Worse, a calendar date cannot distinguish **unused** from **unobserved**. On a
small fleet, two quiet weeks produce almost no signal, and `--unused` reported
265 of 268 commands unused after a single day — mostly because nobody was typing
commands. The gate has to be *observations accumulated*, not *days elapsed*.

So decisions are made on **evidence type**:

| Evidence | Gate |
|---|---|
| Historical and complete — `task_history` covers the whole life of the feature | Cut now |
| A retrospective source exists — shell history for CLI commands | Cut now |
| Only prospective — dashboard page views, where no access log has ever existed | Wait for views to accumulate on pages known to be alive |

Shell history turned out to be the strongest evidence in the whole exercise.
Every `agentx chat` and `agentx tui` invocation on this machine is dated
**2026-07-03** — the day they shipped. Not "fell out of use"; tried once, never
again.

## The CLI on the production node: zero

`~/.bash_history` on clawd holds 467 commands (HISTSIZE is 1000, so the file
is complete, not truncated; no timestamps, last written 2026-07-31).

**It contains no `agentx <subcommand>` invocations at all.** Every one of the
29 lines mentioning agentx is infrastructure:

| What the operator actually does on production | Count |
|---|---|
| `journalctl -u agentx` (read logs) | 7 |
| `systemctl restart/edit agentx` | 8 |
| `nano agentx.json` (hand-edit config) | 4 |
| `cd agentx` | 5 |

The 268-command CLI surface is a **development** tool. On the node carrying
95% of the fleet's traffic it is never invoked — the operator uses systemd,
journalctl, a text editor, and the dashboard.

The `nano agentx.json` entries are their own finding: config is edited by hand
rather than through `agentx config set`, which suggests the config commands
are not just unused but not preferred even when they'd fit.

> Correction: an earlier note in this document described clawd's shell history
> as "months" of data. There are no timestamps in the file, so no span can be
> claimed — only that these 467 commands are everything bash recorded.

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

| Date | Stage | Change | Evidence |
|---|---|---|---|
| 2026-08-11 | B0 | Baseline recorded (this document) | Fleet query, both nodes |
| 2026-08-11 | B1 | `surface_usage` table + `agentx usage surfaces` — CLI commands and dashboard pages are now counted | The gap above |
| 2026-08-11 | B2 | `agentx chat` and `agentx tui` deprecated (warn on use, still run) | Zero use on either node since 2026-07-03; replaced by [attach mode](/reference/attach) |
| 2026-08-11 | B3 | **Removed** the Discord and Slack channel adapters, their config schema, the Slack user-task renderer, and `docs/reference/slack.md` | Zero tasks in the entire history of `task_history` on both nodes; unconfigured in both `agentx.json` |

Deprecation is a warning, never a block — an operator mid-incident should not be
stopped by a message about roadmaps. Removal is one commit per subsystem, so
reversing a bad call costs a `git revert`, not archaeology.

### Note on the Discord/Slack removal

This shortens the marketed channel list in the README, the docs hero, and the
og:description. That is a real positioning cost and was taken deliberately: an
adapter that has never carried a single message is not a feature, it is a claim.
Re-adding either is a contained change — the removal touched two adapter files,
two registration blocks, and a schema entry, not the channel abstraction itself.

Channel-name strings (`"slack"`, `"discord"`) survive in generic union types and
`sourceFilter` arrays. Purging those would churn 20+ files to no benefit and
would make re-adding a channel harder, which fails the impact half of the bar.

### Kept after review

`actions`, `actors` and `roles` were on the removal list from directory evidence
and came off it after the import graph showed workflows and the business layer
depend on them. Recorded here so the next pass doesn't re-propose them.

### The counter measured itself

The first `surface_usage` data was unusable: three suites (trace-cli,
process-cli, intent-ledger-cli) shell out to the real CLI and inherit the
parent env, so a full `pnpm test` recorded `trace list` 72 times against a
human total of zero.

That is worse than no data — it inverts the ranking, making well-tested
commands look popular and untested ones look dead, which is exactly backwards
for deciding what to cut. Fixed by skipping under `VITEST` / `NODE_ENV=test`;
polluted rows cleared and the soak restarted. Page counts were never affected
(they come from the daemon, which tests don't drive).

Worth remembering as a general hazard: instrumentation added to decide what to
delete will be exercised by the test suite that covers the thing being deleted.

### Still gated

Dashboard page removals wait on real view counts — no page-access log has ever
existed, so this is the one decision with only prospective evidence. Check with
`agentx usage surfaces --kind page` once `/live` and `/admin` show traffic; if
nothing has views, the data is unobserved rather than unused and says nothing.
