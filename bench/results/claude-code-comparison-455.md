# AgentX against Claude Code alone: what was measured, and what was parked

The outcome of the spike in #455, as it stands on 2026-10-05. The owner
decided that day to skip the next steps: the task list for the higher
rungs, who runs the Claude Code-only side, and a larger Haiku series. The
Sonnet 5.5 and Haiku 4.5 token results stand as they are. This page
gathers them in one place so nothing is re-measured from scratch, and
says what would make the rest worth doing.

A note for readers: AgentX runs Claude Code as one of its engines. This is
not one tool against another; it compares the same engine alone (the
"bare CLI") and inside AgentX.

## What was measured

Only the first rung of the issue's ladder, "one prompt in one repo": the
same small coding task, the same model and prompt, a fresh copy of the
project each time, run on the bare CLI and through `agentx exec` with the
full and the lean session profile. Every run was correct in every series
below, so the results are about tokens and cost, not about who gets the
task right.

| Series | Model | Runs | Write-up |
|---|---|---|---|
| First run, one task, three runs a way | Haiku 4.5, then Sonnet 5.5 | 9 + 9 | [compare-claude-code-haiku-4-5.md](compare-claude-code-haiku-4-5.md) |
| Token test, three tasks, ten runs a way | Sonnet 5.5 | 90, then 90 again after two fixes | [token-test-sonnet-5-5.md](token-test-sonnet-5-5.md) (plan: [token-test-plan.md](token-test-plan.md)) |
| Why AgentX made an extra call on `trace`, and the fix | Sonnet 5.5 | 110 (one ingredient at a time) + 30 | [token-test-sonnet-5-5.md](token-test-sonnet-5-5.md), section *Follow-up* |
| The edit retry and the context seat | Sonnet 5.5, Haiku 4.5 | 60 + 48 decisions | [jev-and-edit-followups.md](jev-and-edit-followups.md) |
| Token test, three tasks, ten runs a way | Haiku 4.5 | 90 | [token-test-haiku-4-5.md](token-test-haiku-4-5.md) |

## The results that stand

Median tokens through AgentX over the bare CLI, pooled over the three
tasks, with the 95% interval. 1.00 means the same; the plan's rule calls
an interval wholly above 1.00 "uses more" and anything that straddles it
"no clear difference".

| Model, state of the code | Full AgentX | Lean AgentX | Verdict |
|---|---|---|---|
| Sonnet 5.5, before the fixes | 1.25 (1.13 to 1.26) | 1.12 (1.02 to 1.12) | both use more |
| Sonnet 5.5, after both fixes | 1.10 (1.10 to 1.16) | 1.02 (1.01 to 1.10) | full uses more; lean the same, within 10 percent |
| Haiku 4.5, after both fixes | 1.06 (0.83 to 1.28) | 1.15 (0.88 to 1.42) | no clear difference |

Cost over the bare CLI, same pooling: Sonnet full +22 percent, Sonnet lean
+2 percent; Haiku full +12 and lean +13 percent, neither clear.

The three claims fixed in the plan:

| Claim | Sonnet 5.5, after the fixes | Haiku 4.5 |
|---|---|---|
| H1: lean uses no more tokens than the bare CLI | Holds, at the limit (upper end 1.10) | Not shown |
| H2: full uses no more tokens than the bare CLI | No | Not shown |
| H3: AgentX uses fewer tokens | No | No |

In plain words: **on one-prompt coding tasks AgentX does not save tokens.
The lean profile costs the same as Claude Code alone; the full profile
costs about a tenth more on Sonnet.** Haiku's run-to-run spread is three
times Sonnet's, so ten runs a cell cannot tell the two apart there, and
matching Sonnet's precision would take about 100 runs a cell (some $65).

## What the spike changed in the product

Three changes came out of the measurements and are on `main`:

- **The 300-line rule is gone** from the generated
  `.claude/rules/code-quality.md`. With the rest of AgentX's setup, it
  made a coding agent count lines before reading files, one extra model
  call on every `trace` run. Existing workspaces whose rule is still the
  generated text are updated; a hand-edited rule is left alone
  (`src/agents/workspace-setup.ts`, #639).
- **Full `claude-code` sessions no longer send the project CLAUDE.md
  twice.** Claude Code loads it from the project; AgentX also appended it
  to the system prompt (#639).
- **Every `claude-code` agent is told to change files with the Edit
  tool**, not `sed` or a shell rewrite (`EDIT_TOOL_INSTRUCTION` in
  `src/agents/registry.ts`). On Sonnet it removes a retry seen in about 3
  of 10 `trace` runs, for 13 percent fewer tokens and 4 percent more
  money. On Haiku it changes nothing: Haiku already used the Edit tool in
  every run.

Also fixed on the way: the billed model a run reports is now the one it
spent the most on, not the first one the CLI lists (#639).

## What was skipped, and why

The owner's decision of 2026-10-05 parks the rest of the issue:

- **The higher rungs of the task list** (work across several repos, work
  that needs another person's approval, work that runs for days and
  survives a restart, work that starts from a message on a phone). These
  are what AgentX is for, and tokens are the wrong measure for them: the
  plan says they are measured by how often a person has to step in. No
  such run was made, so the issue's third acceptance item, a docs page
  "What AgentX adds to Claude Code", is not written: a claim with no run
  behind it does not go in.
- **Who drives the Claude Code-only side** of those rungs: not decided.
- **A larger Haiku 4.5 series** (about 100 runs a cell, some $65): not
  run. The Haiku verdicts stay "no clear difference".

Two smaller leads from the follow-ups are also left where they are:
trimming the full profile's message wrapper on coding channels (its
remaining 10 percent on Sonnet), and the context seat, which drops about
half the landscape safely but needs a fast decision backend to answer
within a live turn's 3-second wait.

## Reopen if

- A measure of stepping in exists for the higher rungs, with a person or
  a harness to run the Claude Code-only side; or
- the full profile's per-call overhead becomes a cost that matters on a
  busy coding channel, in which case trim the wrapper and rerun the Sonnet
  series; or
- a fast decision backend is in place, which makes the context seat worth
  turning on and measuring live.

Reopening means reopening #455. The bench itself stays usable:
`pnpm bench:compare --runs 10 --tasks all --model <id> --json <file>`
repeats any series here on another model or after a change.

## Check it worked

- `bench/results/` on `main` holds the raw file of every series above:
  `compare-claude-code-haiku-4-5.json`, `compare-claude-code-sonnet-5-5.json`,
  `token-test-sonnet-5-5.json`, `token-test-sonnet-5-5-after-fixes.json`,
  `token-test-trace-after-fix-sonnet-5-5.json`,
  `ablation-trace-sonnet-5-5.jsonl`, `context-seat-haiku-4-5.json` and
  `token-test-haiku-4-5.json`.
- Running the verdict over any of the 90-run files gives the numbers in
  its write-up: the bootstrap seed is fixed.
- #455 is open with the owner's decision as its last substantive comment.

## If something is wrong

- If a later series disagrees with a figure here, check the commit it ran
  on first: the Sonnet "before" numbers predate the two fixes, and the
  Haiku series ran after them.
- If a workspace still shows "Keep files under 300 lines" in its
  code-quality rule, the rule was hand-edited before the fix and is left
  alone on purpose; remove the line by hand if the agent surveys files
  before reading them.
