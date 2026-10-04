# Token test: does AgentX use fewer tokens than Claude Code alone?

Plan for #455, written on 2026-10-04 before the runs it describes. The
claims and the rule that decides them are fixed here, so the result cannot
move them.

## The question

For the same coding task, on the same model, does a run through AgentX use
fewer, the same, or more tokens than the same run on the Claude Code
command-line tool alone (the "bare CLI")?

A **token** is the unit the model provider bills by: roughly three
quarters of a word, counted on everything sent to the model and everything
it writes back.

## The claims, stated before running

| | Claim | Holds when |
|---|---|---|
| H1 | Lean AgentX uses no more tokens than the bare CLI. | The pooled 95% interval's upper end is 1.10 or less. |
| H2 | Full AgentX uses no more tokens than the bare CLI. | The same rule. |
| H3 | AgentX (either mode) uses fewer tokens than the bare CLI. | The pooled 95% interval's upper end is below 1.00. |

"Lean" and "full" are AgentX's two session profiles: lean sends a shorter
set of instructions with each task (#615).

## How it is run

1. Three tasks, each a small Node project with failing tests
   ([compare-tasks.ts](../compare-tasks.ts)):
   - `fix-bugs`: the failing tests point at four bugs in two files.
   - `implement`: two functions are empty; the tests are the spec.
   - `trace`: a bug report in plain words; four causes across six files.
2. Three ways to run each: the bare CLI, AgentX full, AgentX lean.
3. Ten runs of each task in each way: 90 runs. They are interleaved (task
   by task, way by way) so a slow hour hits all of them alike.
4. Model: Sonnet 5.5 (`claude-sonnet-5-5`) on every run, the same prompt,
   a fresh copy of the project each time, permissions skipped on both
   sides.
5. Command (terminal):

   ```bash
   pnpm build
   pnpm bench:compare --runs 10 --tasks all --model claude-sonnet-5-5 \
     --json bench/results/token-test-sonnet-5-5.json
   ```

## What is measured

- **Main measure: total tokens per run**: input, output, cache read and
  cache write added up, as the CLI reports them. Every run counts, correct
  or not: tokens spent on a wrong answer are still spent.
- Also recorded: whether the run was correct (tests pass, test files
  untouched), the cost the CLI reports, the number of turns, wall time.

## How it is decided

1. Per task and per AgentX mode: the median tokens of the AgentX runs
   divided by the median tokens of the bare runs. 1.00 means the same,
   0.90 means AgentX used 10 percent fewer.
2. Across the three tasks: the geometric mean of those three ratios (each
   task counts the same, whatever its size).
3. A 95% interval for each ratio from 5,000 bootstrap resamples (drawing
   the runs again at random, with replacement, to see how much the ratio
   moves). The seed is fixed, so the same results give the same interval.
4. Verdict from the interval:
   - upper end below 1.00: **AgentX uses less**;
   - lower end above 1.00: **AgentX uses more**;
   - otherwise: **no clear difference** at this number of runs;
   - and **within 10 percent** when the whole interval is between 0.90
     and 1.10.
5. A mode that gets fewer tasks right than the bare CLI does not get a
   "uses less" verdict, whatever its tokens: cheaper and wrong is not
   better.

## What this test cannot show

- Only small, single-repo tasks. What AgentX is for (channels, approvals,
  work across days, the mesh) is not in it; those are measured separately
  by how often a person has to step in.
- One model. A Haiku 4.5 series follows if the Sonnet result is clear.
- A cloud machine with no user-level Claude Code settings, and AgentX with
  no history or memory. A real developer machine and a real AgentX node
  both carry more context than this.
- The first run of each way pays to write its instructions into the
  model's cache; later runs read them. Medians keep one such run from
  moving the result.

## Cost

About $0.06 to $0.17 a run on Sonnet 5.5 in the smoke runs, so roughly
$8 to $12 for the 90 runs.

## Check it worked

- The raw file `token-test-sonnet-5-5.json` lists 90 runs, 30 per way.
- The printed table ends with a verdict row per mode and metric, including
  an "all tasks" row.

## If something is wrong

- A run that ends with an error (`NOT correct ... error=`) still counts in
  the tokens; if many runs error the same way, stop and fix the cause
  before reading any verdict.
- If the series stops part way, the raw file keeps every finished run.
  Start a new series rather than mixing two.
