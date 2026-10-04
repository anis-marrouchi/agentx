# Token test, Sonnet 5.5: AgentX uses more tokens than Claude Code alone

The result of the plan in [token-test-plan.md](token-test-plan.md) (#455),
run on 2026-10-04: 90 runs, three tasks, three ways, ten runs each, all
on `claude-sonnet-5-5`. Raw runs: `token-test-sonnet-5-5.json`. Full
per-run tables as the tool printed them: `token-test-sonnet-5-5-table.md`.

## The answer

**No: on these tasks AgentX does not use fewer tokens than Claude Code
alone.** Lean AgentX uses about the same on the simpler tasks and more on
the harder one. Full AgentX uses more on all three. Every one of the 90
runs solved its task, so correctness does not separate them.

| Claim (fixed before the runs) | Result | Holds? |
|---|---|---|
| H1: lean AgentX uses no more tokens (pooled upper end ≤ 1.10) | 1.12, interval 1.02 to 1.12 | **No**, narrowly; it holds on two of the three tasks |
| H2: full AgentX uses no more tokens (same rule) | 1.25, interval 1.13 to 1.26 | **No** |
| H3: AgentX uses fewer tokens (upper end < 1.00) | lowest lower end is 1.01 | **No** |

## Results

Median tokens per run, and AgentX over the bare CLI (1.00 means the same):

| Task | Bare CLI | Full AgentX | Lean AgentX | Full / bare | Lean / bare |
|---|---|---|---|---|---|
| `fix-bugs` | 133.3k | 151.4k | 135.5k | 1.14 | 1.02 |
| `implement` | 99.0k | 112.8k | 100.9k | 1.14 | 1.02 |
| `trace` | 100.9k | 152.3k | 136.5k | 1.51 | 1.35 |
| All three (geometric mean) | | | | **1.25** | **1.12** |

Cost as the CLI reports it, over the three tasks: full AgentX **+27
percent** (interval 1.23 to 1.30), lean AgentX **+5 percent** (1.01 to
1.07, within 10 percent). Cost rises less than tokens for lean because
most of its extra tokens are cheap cache reads.

Correct: 30 of 30 for each way. Median wall time: 9 to 12 seconds for all
three ways on every task.

## Why: tokens follow the number of calls to the model

Each run is a handful of calls to the model (here about 3 to 6), and each call
re-sends the whole conversation so far. So a run's tokens are set by two
things: how much each call carries, and how many calls the run makes.

**1. What each call carries.** When two runs make the same number of
calls, the gap is fixed and small:

| | Extra tokens per call, over the bare CLI |
|---|---|
| Lean AgentX | about 0.5k (2.2k over a 4-call run, 1.9k over a 3-call run) |
| Full AgentX | about 4.5k (18.1k over 4 calls, 13.8k over 3 calls) |

That is AgentX's own instructions and tool list. Lean keeps it to 2
percent; full adds 14 percent.

**2. How many calls a run makes.** On `fix-bugs` and `implement` every
way made the same number of calls in almost every run, so only the
per-call gap shows. On `trace` they did not:

| `trace`: runs by size | Short (about 100k to 113k) | Usual (135k to 152k) | Long (175k to 232k) |
|---|---|---|---|
| Bare CLI | 6 | 3 | 1 |
| Full AgentX | 1 | 8 | 1 |
| Lean AgentX | 0 | 9 | 1 |

A short run is one call fewer than a usual one. The bare CLI finished
short in 6 of 10 runs; AgentX did so in 1 of 20. A short run of `trace`
costs about 100k tokens and a usual one about 135k on the bare CLI, so
this one difference produces the +35 and +51 percent on `trace`. (Runs
are grouped by tokens rather than by the CLI's turn count, which does not
always match the number of calls: one bare run reports 4 turns at 101k
tokens.) The gap between bare and lean is unlikely to be chance
(Fisher's exact test, p = 0.01); between bare and full it is borderline
(p = 0.06). These runs do not show *why* AgentX took the extra call; the
session logs would. Until that is read, treat it as observed, not
explained.

## Reading the intervals with care

- On `fix-bugs` and `implement` the runs are almost identical, so the
  intervals are very narrow (1.14 to 1.15, for example). That reflects
  how repeatable these small tasks are, not a law about all tasks.
- On `trace` the runs fall into groups (3 calls or 4), and a median of
  grouped values jumps between them. That is why its interval is lopsided
  (full: 1.51, interval 1.12 to 1.52). The verdict, "uses more", does not
  depend on that: the whole interval is above 1.

## What this does and does not show

- It shows: for one-prompt coding tasks in one repository, on Sonnet 5.5,
  AgentX's lean profile costs about the same as Claude Code alone (+2
  percent per call) and its full profile about a quarter more. AgentX
  does not save tokens here.
- It does not show anything about what AgentX is for: taking work from a
  channel or a phone, approvals, work that spans days, the mesh. Those
  are measured by how often a person has to step in, not by tokens.
- Limits, as stated in the plan: three small tasks, one model, a cloud
  machine with no user-level Claude Code settings, AgentX with no history
  or memory.

## What to do with it

1. Use the lean profile wherever a channel runs one-shot coding tasks; it
   is within 2 percent of the bare CLI per call.
2. Read the `trace` session logs to find why AgentX more often takes a
   fourth call, and fix it if its instructions cause it (for example, a
   rule to run the tests before editing).
3. Repeat on Haiku 4.5, where the earlier run showed far more variation
   in the number of calls.

## Check it worked

- `token-test-sonnet-5-5.json` holds 90 runs, 30 per way, all with
  `"ok": true`.
- Running the verdict again over the raw file gives the same numbers: the
  bootstrap seed is fixed.

## If something is wrong

- If a later run disagrees, compare the calls per run first: a different
  call pattern explains most token gaps here.
- Do not mix runs from two series in one verdict; start a new series
  instead.
