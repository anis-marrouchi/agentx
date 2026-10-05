# Token test, Haiku 4.5: no clear difference, and why

The same test as [token-test-sonnet-5-5.md](token-test-sonnet-5-5.md)
(plan: [token-test-plan.md](token-test-plan.md)), run on 2026-10-04 on
`claude-haiku-4-5-20251001` against `main` after #639 (all fixes in): three
tasks, three ways, ten runs each, 90 runs. Raw runs:
`token-test-haiku-4-5.json`; tables as printed:
`token-test-haiku-4-5-table.md`. 90 of 90 correct; $6.54.

**How it was run.** A container restart stopped the series after five
full rounds. Those 45 runs are kept; the 6 runs of the interrupted sixth
round are left out so every cell has the same number of runs. Five more
rounds ran afterwards on the same commit, model and run order; they are
numbered 6 to 10 in the raw file.

## The answer

**On Haiku the test cannot tell AgentX and Claude Code alone apart.**
Every token verdict is "no clear difference", including both pooled
ones. The intervals are wide (about 0.6 to 1.7), so this is not evidence
that they are the same either.

| Median tokens | Bare CLI | Full AgentX | Lean AgentX | Full / bare | Lean / bare |
|---|---|---|---|---|---|
| `fix-bugs` | 270.2k | 381.5k | 395.3k | 1.41 (0.79 to 1.62) | 1.46 (0.83 to 1.68) |
| `implement` | 237.5k | 203.9k | 232.6k | 0.86 (0.62 to 1.33) | 0.98 (0.71 to 1.56) |
| `trace` | 351.5k | 348.2k | 368.9k | 0.99 (0.76 to 1.44) | 1.05 (0.74 to 1.66) |
| All three | | | | **1.06** (0.83 to 1.28) | **1.15** (0.88 to 1.42) |

Cost over the three tasks: full +12 percent (0.97 to 1.24), lean +13
percent (0.97 to 1.32), both "no clear difference". The one clear result
is full AgentX on `fix-bugs`, which costs more (+29 percent, 1.02 to
1.38).

| Claim (from the plan) | Haiku result |
|---|---|
| H1: lean uses no more tokens (pooled upper end ≤ 1.10) | Not shown (upper end 1.42) |
| H2: full uses no more tokens | Not shown (1.28) |
| H3: AgentX uses fewer tokens | No |

## Why the test cannot decide on Haiku

- **Haiku varies far more than Sonnet.** The spread of tokens across ten
  runs of the same task and mode (standard deviation over mean, median
  over the nine cells) is 0.27 on Haiku against 0.08 on Sonnet. Haiku
  takes a different number of model calls for the same work from run to
  run (the first Haiku run showed 7 to 12), and every call re-reads the
  whole conversation.
- **To reach Sonnet's precision** at that spread would take roughly
  (0.27 / 0.08)² ≈ 11 times as many runs: about 100 per cell, 900 runs,
  some $65.

## The Edit-tool instruction does nothing on Haiku

Haiku edited with the Edit tool in every run, Claude Code alone
included, and never with `sed -i`. The duplicate-line retries that the
instruction removed were a Sonnet habit; on Haiku the instruction costs
its few dozen tokens and changes no behaviour.

## Check it worked

- `token-test-haiku-4-5.json` holds 90 runs, 30 per way, numbered 1 to 10
  per task and mode, all with `"ok": true`.
- Running `renderTable` over it reproduces `token-test-haiku-4-5-table.md`;
  the bootstrap seed is fixed.

## If something is wrong

- If a rerun gives a clear verdict, check its number of runs first: with
  this spread, ten runs per cell can swing a median by 30 percent.
- Do not combine runs from different commits; rounds 1 to 5 and 6 to 10
  here share one commit.
