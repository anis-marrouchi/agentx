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

## Follow-up: why AgentX took the extra call, and the fix

**Cause.** The session logs show the extra call is a survey. In 8 of 10
runs of each AgentX profile, the first call listed the files and counted
their lines (`ls`, `wc -l`) without reading them, so reading took a
second call. The bare CLI read everything in its first call in 9 of 10.

**Pinpointed by ablation** (`bench/ablate-trace.py`, raw runs in
`ablation-trace-sonnet-5-5.jsonl`): the bare CLI on `trace`, with one
lean-AgentX ingredient added at a time, 10 runs each.

| Added to the bare CLI | First call counts lines | First call only surveys | Median tokens |
|---|---|---|---|
| nothing | 0/10 | 0/10 | 104k |
| AgentX's prompt wrapper | 0/10 | 0/10 | 105k |
| AgentX's appended instructions | 0/10 | 0/10 | 105k |
| AgentX's tool server (MCP) | 0/10 | 0/10 | 142k |
| `.claude/settings.json` only | 0/10 | 0/10 | 105k |
| CLAUDE.md and AGENTS.md only | 0/10 | 0/10 | 108k |
| `.claude/rules` only | 2/10 | 0/10 | 105k |
| all project files | 5/10 | 1/10 | 128k |
| everything (lean AgentX) | **10/10** | **6/10** | **160k** |
| everything but the rule "Keep files under 300 lines" | 2/10 | 2/10 | 124k |

The trigger is one line in the generated `.claude/rules/code-quality.md`:
"Keep files under 300 lines". On its own it rarely changes anything; with
the rest of AgentX's setup the agent counts lines on every run (10 of 10
against 2 of 10 without it; Fisher's exact test p = 0.0001). The tool
server alone made more runs go past 3 calls (7 of 10 against 3 of 10),
but that is not significant at 10 runs (p = 0.18) and its extra calls
were edit retries, not surveys.

**Fix.** The line is removed from the generated rule; a workspace whose
rule is still the old generated text is updated, a hand-edited rule is
left alone (`src/agents/workspace-setup.ts`).

**Checked through `agentx exec`** after the fix: `trace`, 10 runs each,
raw runs in `token-test-trace-after-fix-sonnet-5-5.json`.

| `trace` | First call only surveys, before | After | Median tokens, before | After | Over bare, after |
|---|---|---|---|---|---|
| Bare CLI | 1/10 | 2/10 | 100.9k | 117.7k | |
| Full AgentX | 8/10 | 2/10 | 152.3k | 152.2k | 1.29 (0.84 to 1.96), no clear difference |
| Lean AgentX | 8/10 | 1/10 | 136.5k | **102.3k** | **0.87** (0.76 to 1.37), no clear difference |

The survey call is gone for both profiles. Lean AgentX's median on
`trace` is now below the bare CLI's; with 10 runs the interval still
includes 1, so this is "no longer more", not yet "less".

**What remains** is a second kind of extra call, not caused by AgentX:
the model edits `checkout.js` with `sed`, leaves a duplicate line, and
spends one to three calls fixing it. After the fix it happened in 3 of 10
runs in every mode, bare CLI included. It costs full AgentX more than
the others because each of its calls carries about 4.5k more tokens;
three such runs at about 230k are what keep its median cost 29 percent
above the bare CLI.

## Rerun after both fixes

The same 90-run series (three tasks, three ways, ten runs, Sonnet 5.5)
after the two fixes: the 300-line rule removed, and full sessions no
longer sending the project CLAUDE.md twice (it was appended to the
system prompt and also loaded by Claude Code; now only loaded, as lean
already did). Raw runs: `token-test-sonnet-5-5-after-fixes.json`; tables
as printed: `token-test-sonnet-5-5-after-fixes-table.md`. 90 of 90
correct; $6.35.

Median tokens per run, before → after:

| Task | Bare CLI | Full AgentX | Lean AgentX | Full / bare | Lean / bare |
|---|---|---|---|---|---|
| `fix-bugs` | 133.3k → 133.3k | 151.4k → 147.1k | 135.5k → 135.7k | 1.14 → 1.10 | 1.02 → 1.02 |
| `implement` | 99.0k → 99.0k | 112.8k → 109.5k | 100.9k → 100.9k | 1.14 → 1.11 | 1.02 → 1.02 |
| `trace` | 100.9k → 100.3k | 152.3k → 110.8k | 136.5k → 102.2k | 1.51 → 1.10 | 1.35 → 1.02 |
| All three | | | | **1.25 → 1.10** (1.10 to 1.16) | **1.12 → 1.02** (1.01 to 1.10) |

Cost over the three tasks: full **+27 → +22 percent**, lean **+5 → +2
percent** (within 10 percent).

The claims, by the rule fixed in the plan:

| Claim | Before | After |
|---|---|---|
| H1: lean uses no more tokens (pooled upper end ≤ 1.10) | No (1.12) | **Holds, at the limit** (upper end 1.10) |
| H2: full uses no more tokens | No (1.26) | No (1.16) |
| H3: AgentX uses fewer tokens | No | No |

- **`trace` is fixed for both profiles.** The extra survey call is gone;
  lean is now 2 percent above the bare CLI on every task, the size of its
  added instructions.
- **Full AgentX is a steady 10 percent above the bare CLI** on every
  task, down from 14 to 51. What is left is its message wrapper (the
  agent list, chat-channel rules, cross-channel and recall instructions:
  about 3,900 characters a call), which full keeps for chat channels and
  lean drops.
- **H1 holds by the narrowest margin** (upper end exactly 1.10): treat it
  as "lean costs the same as the bare CLI", not as a saving.

## What to do with it

1. Use the lean profile wherever a channel runs one-shot coding tasks: it
   now costs the same as Claude Code alone, within 2 percent.
2. For full sessions on coding channels, trim the wrapper: the
   cross-channel block appears both in the prompt wrapper and in the
   generated CLAUDE.md, and the Telegram/WhatsApp/GitLab rules do not
   apply to an `exec` or GitHub task.
3. To make AgentX *save* tokens rather than match, the remaining lever is
   the number of calls: the edit retry (a `sed` that leaves a duplicate
   line, 1 to 3 extra calls in about 3 of 10 `trace` runs in every mode)
   is the largest variable cost left.
4. Repeat on Haiku 4.5, where the number of calls varied far more. Done:
   [token-test-haiku-4-5.md](token-test-haiku-4-5.md), no clear difference
   at ten runs a cell.

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
