# Procedures

A **procedure** is a recurring activity described from the user's perspective: a named routine with a trigger, inputs, ordered steps, and an expected outcome. The system that executes it is a black box — a procedure says *"Download the attached notice, save it as `YYYY-MM-DD-zitouna.pdf` in Invoices/, reply on the same thread"*, never *"run this command"*.

Procedures are the front door to automation in agentx:

1. **Mined, not written.** The miner watches real activity (what you asked, what actually happened) and drafts a procedure once the same pattern recurs enough times.
2. **Reviewed by you.** Drafts wait under `_drafts/` until you promote or reject them.
3. **Followed by agents.** When a new task matches an active procedure, its steps are injected as guidance — the agent follows the known-good path instead of rediscovering it (and failing steps along the way).
4. **Optionally promoted to workflows.** A procedure that proves stable and needs deterministic, trigger-driven automation can later be re-expressed as an executable [workflow](./workflows.md). Workflows are the execution backend; procedures are the language you and your agents share.

## Anatomy

One markdown file per procedure in `.agentx/procedures/`:

```markdown
---
id: process-zitouna-payment-notice
title: "Zitouna bank notice → signed invoice reply"
trigger: "When a payment notification email arrives from Zitouna bank"
inputs: ["notification email", "signature image"]
expected: "Signed invoice sent back on the same thread"
kpis: ["reply within 1h"]
tags: ["billing"]
status: active
source: "mined:telegram:zitouna-<email>-notice:email>file>shell>email"
evidence: ["01J8...", "01J9..."]
---

## Steps
1. Open the bank notification email
2. Download the attached PDF notice
3. Add the signature to the invoice
4. Save it as `YYYY-MM-DD-zitouna-invoice.pdf` in Invoices/
5. Reply on the same email thread with the signed file
```

- `trigger` — one plain-language sentence starting "When …". This is the primary matching signal.
- `inputs` — the parts that vary between occurrences.
- `status` — the **single** lifecycle axis: `draft` (unreviewed, lives in `_drafts/`), `active` (matched and injected), `deprecated` (kept, never surfaced).
- `source` / `evidence` — provenance: the mined cluster key and the trace ids it was distilled from. Hand-written procedures (`agentx procedure add`) simply omit them.

## How mining works

```
traces (what ran) ─┐
                   ├─→ episodes → clusters → recurrence counts → LLM distillation → draft
sessions (what ────┘                              │
you said)                          .agentx/procedures/_candidates.json
```

1. **Episodes** join each successful task's trace (SQLite `task_traces` + step ledger) with the surrounding conversation turns. Machine-originated activity (crons, the miner itself, the workflow architect) is excluded.
2. **Clustering** keys each episode by channel + normalized intent ("process the June invoice" ≡ "process the July invoice") + a coarse activity skeleton (`email>file>shell>email`). Exact tool choice doesn't split a cluster.
3. **Recurrence** counts accumulate in `_candidates.json` across runs (a watermark keeps re-scans idempotent). A pattern becomes draft-worthy after `minOccurrences` (default 3) sightings.
4. **Distillation** sends ready clusters — user language plus a black-box activity outline only — to an LLM (through a running agent's session via `--via`, no API key needed). The reply is linted: any tool/system vocabulary in the draft triggers one correction round, then the draft is dropped. A leaking draft is never written.

## Cadence — when the miner runs

Pick whatever rhythm fits, all through one command:

```bash
agentx procedure watch --daily --via coo-agent          # every day at 03:00
agentx procedure watch --hourly --via coo-agent         # every hour
agentx procedure watch --cron "0 */4 * * *" --via coo-agent   # custom cron
agentx procedure watch --daily --on-task --via coo-agent      # + live counting after each task
agentx procedure watch --off                            # stop
```

This writes two things: a `crons.procedure-extract` entry (the scheduled run — standard cron machinery, catch-up and retries included) and the `procedures.extraction` config block. `--on-task` additionally counts patterns right after each completed task (debounced, no LLM cost) so a pattern that crosses the threshold mid-day drafts immediately instead of waiting for the nightly run.

> Restart the daemon after `watch` — hot-reload does not pick up new config blocks.

## Review loop

```bash
agentx procedure extract --since 7d              # dry run: see clusters + counts, writes nothing
agentx procedure extract --since 7d --via coo-agent --commit   # mine for real
agentx procedure list --drafts                   # what's waiting for review
agentx procedure show <id>                       # read a draft
agentx procedure promote <id>                    # activate — agents start following it
agentx procedure reject <id>                     # park it; the miner never re-drafts it
agentx procedure deprecate <id>                  # retire an active procedure
```

## How agents consume procedures

On each **fresh** agent session, the incoming task is scored against active procedures' trigger/title/tags (cheap keyword overlap, no LLM). Matches above `procedures.injection.minScore` are injected into the agent's context as a "known procedure — follow these steps" block. Warm (resumed) sessions are deliberately not re-injected — that per-turn bloat is what forces premature session rotation; a warm agent can run `agentx procedure match "<task>"` on demand instead.

## Config

```jsonc
"procedures": {
  "enabled": true,
  "dir": ".agentx/procedures",
  "extraction": {
    "enabled": true,
    "onTaskCompletion": false,   // live counting after each task
    "minOccurrences": 3,         // sightings before a draft
    "sinceDays": 7,
    "maxClusters": 5,            // max drafts distilled per run
    "via": "coo-agent"           // agent whose session runs distillation
  },
  "injection": {
    "enabled": true,
    "maxProcedures": 2,          // max procedures injected per fresh session
    "minScore": 0.5
  }
}
```

## On disk

```
.agentx/procedures/
  <id>.md                 # active + deprecated procedures
  _drafts/<id>.md         # mined, awaiting review
  _drafts/_rejected/      # rejected drafts (suppresses re-mining)
  _candidates.json        # recurrence ledger + scan watermark
```

## Relation to workflows

| | Procedure | Workflow |
|---|---|---|
| Language | User activity ("Download the notice…") | System DAG (nodes, edges, node configs) |
| Created by | Mined from activity, or `procedure add` | Hand-authored or `workflow absorb` |
| Execution | Agent follows steps as guidance | Engine executes nodes deterministically |
| Right for | Anything you do repeatedly | Stable procedures needing hard automation |

Start with procedures. When one has run reliably for a while and you want it to fire without an agent in the loop, express it as a [workflow](./workflows.md).
