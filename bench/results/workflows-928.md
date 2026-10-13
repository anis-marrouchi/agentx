# Small workflows and a cheaper reader: what #928 measured

The results of the token side of the spike in #928, measured on 2026-10-13
on one node's Claude Code session logs (10-09 to 10-12, 507 to 561 main
sessions depending on the count). Nothing from it is built, routed or
switched on. This page records what was measured so the ideas are not
re-done from scratch, and what is still open.

Every figure on this page comes from scripts in the developer seat's
workspace, which are not in this repository. This repository's
[`bench/slice-replay.py`](../slice-replay.py) measures the same things with
its own rules and **does not reproduce these figures** on the same logs: see
[Re-running with this repository's script](#re-running-with-this-repositorys-script).

Prices: the runtime reported Opus 5.5 at 4 / 20 USD per million input /
output tokens. AgentX's `CACHE_AWARE_PRICING` has 5 / 25, and which one
matches the invoice is not checked. Percentages do not depend on it; USD
figures would be 25% higher at 5 / 25.

## Where the spend goes

| What a request does | Share of spend |
|---|---|
| First call of a session (instructions, tools, memory) | 18% |
| Only reads (code, files, the tracker, the fleet's own notes) | 37% |
| Reads plus a test or script run | 9% |
| Changes something (edit, commit, post, send, deploy) | 30% |
| Writes the answer, no tool | 5% |

A tool call inside a chain costs about 0.072 USD: 33% re-reading the
context, 38% writing what is new into the cache (mostly the result before
it), 29% output. Removing a call saves the re-read and part of the output,
not the cache write, unless the raw result also stays out of the context.

## The forms measured, and what each is worth

| Form | Saving, share of spend | How it was measured | Status |
|---|---|---|---|
| Whole job as one workflow (the first pilot on #928, not measured here) | 78% cheaper on its own job, which is about 1% of spend | Offline replay on #928 | Stopped 2026-10-13: the owner declined the live dry-run |
| Small workflows mined from repeated slices of calls, one call each | 1% to 4% (ceiling 8%) | Count of literal repeated sequences | Not built |
| Look ahead: the agent fixes its next 2 to 4 calls in one call, run with no model | 1% to 3% | Count, plus a replay of 60 moments | Not built |
| Checked batch: 2 to 4 steps in one call, a check on each, stop at the first failed check | 3.5% to 5% (6% at most) | 240 graded stretches, 40 graded by hand | Not built; below the 50% bar set before the test |
| A stronger model on the deciding call | A loss: about 1.19 USD per call against 0.07 to 0.11 saved | Arithmetic | Not built |
| Reader on the small model: the main model asks, a reader does the looking up and returns a short note | 20% to 27% (calculated); 12% on 9 small tasks with the copied-lines rule | Priced on logged reading stretches; two offline runs | Stopped 2026-10-13: the owner declined a live trial; no seat changed. Offline: quality at today's run-to-run level, 12% cheaper, 3 to 4 times slower |

### The checked batch, in more detail

Of the places where the agent ran a step, waited, then ran a next step whose
arguments looked independent of the result, a check a script can do (exit
code, no error, a word present, a named value) would have decided the next
step in **28%** (sampling margin 23% to 33%; about 35% on the more lenient
hand reading). The bars set before the test: 50% or more to build, under 25%
to keep the earlier conclusion.

- By length: 45% for 2 steps, 21% for 3, 23% for 4. The gain is in simple
  "run this, and if it passed, run that" pairs, which an agent can already
  write as one shell line.
- By seat: 21% to 29%.
- The model grader and the hand grading agreed on 92% of places after a
  re-read; the model was the stricter of the two.

### What the automatic rule gets wrong

`slice-replay.py ahead` calls a window "fixed" when no later call uses a
named thing (path, hash, number, identifier) that first came back in a
result inside the window. On the graded sample the model found that in 54%
of places the next step did use something the result gave (a line number, a
file name, an identity) that the rule missed. The rule's "39% of calls are
independent of the result before them" is nearer 18%. Treat `ahead` as a
loose ceiling, not an estimate.

Also: the agent's thinking is mostly not in the logs (a token count only).
Only 75 of 480 graded places had any text from the agent between calls.

## The reader design

The main model does not read raw results. It asks a question; a reader on
the small model makes the look-ups in its own short context and returns a
short note. Text the main model is about to edit it reads itself.

- **Calculated:** 1,052 reading stretches of 2+ calls, results 10.7M tokens,
  9.8M of which would stay out of the main model. Reader on Haiku 5.5: 22%
  to 27% of spend saved, 20% to 23% with harsh settings (twice the calls,
  twice the note length, half the questions asked again). On Sonnet 5.5:
  2% to 5%, a loss under the harsh settings.
- **Run for real, 10 past read-only tasks:** 15% cheaper, 4 times slower,
  and graded as good as today's answer in 2 of 10 (a repeat of today's
  setting: 5 of 10). In the 3 "worse" cases the note had a gap or a wrong
  fact that the main model repeated.
- **Second run, three reader rules on 9 of the same tasks** (27 runs; the
  tenth was stopped by the spend guard). Main model Opus 5.5 at high effort,
  reader Haiku 5.5, all answers for a task graded in one blind pass:

  | | Repeat of today | First design | Copied lines | Re-read | Both |
  |---|---|---|---|---|---|
  | As good as today's answer, or better | 4 | 2 | **4** | 3 | 3 |
  | Slightly worse | 2 | 3 | 2 | 4 | 3 |
  | Worse | 3 | 4 | 3 | 2 | 3 |
  | Cost against today (5.69 USD) | same | 15% less | **12% less** | 12% less | 6% less |
  | Time for the 9 tasks (today: 493 s) | 524 s | 2,055 s | 1,991 s | 1,495 s | 1,976 s |

  - **Copied lines:** the reader may only state a fact backed by a line
    copied from a file or a command, with its location, and lists what it
    could not back. **Re-read:** the main model checks the facts its answer
    turns on itself, in at most six look-ups. **Both:** the two together.
  - Copied lines meets the rule set before the run (the repeat's quality at
    10% or more saved), narrowly. Re-read adds no quality here and, with
    copied lines, halves the saving.
  - The references were written a day earlier. On two tasks the work had
    since been done and the answers that said so were graded "worse"
    (every answer on one of them, the repeat included). Without those two:
    copied lines 4 / 2 / 1, re-read 3 / 4 / 0, repeat 3 / 2 / 2. This is
    read from the grader's reasons, not checked at the source.
  - Small read-only tasks are about half session start, which the design
    does not touch, and drift day to day against their reference. More of
    them will not settle the question.
- **Not tested:** long sessions that change things, where most spend sits.

## Re-running with this repository's script

An owner-sweep check of PR #954 (at `d5b76a9`) ran `slice-replay.py` on the
same node and window, agent workspace seats only (580 main sessions against
561):

| Figure | This page (seat scripts) | `slice-replay.py` |
|---|---|---|
| First call of a session | 18% | 11% |
| Only reads | 37% | 27% |
| Reads plus a run | 9% | 10% |
| Changes something | 30% | 43% |
| Answer, no tool | 5% | 9% |
| Reading stretches of 2+ calls | 1,052, results 10.7M tokens | 987, results 4.1M tokens |
| One call inside a chain | 0.072 USD: 33% re-read, 38% cache write, 29% output | 0.085 USD: 55% re-read, 20% cache write, 25% output |

- Prices do not explain it: with 4 / 20 through `--prices` the shares move
  by less than a point. Adding scratch seats under `/tmp` does not either.
- Which side is right is not known. The two have not been compared rule by
  rule. Differences in `slice-replay.py` that could explain it, none
  checked against the seat scripts:
  - **First call:** only the first request of each session file in the
    window counts. A session resumed for a new task, or the first call of
    each run inside a long session, counts as a tool call or an answer.
  - **Changes something:** broad. Any shell line with `cp`, `mkdir`, `tee`
    or a `>` redirect to a file, and any MCP tool whose name contains add,
    set, update or similar, counts as a change, and a request takes its
    strongest call.
  - **Result size:** only the text parts of a tool result are counted
    (bytes / 4). Images and any other parts are left out.
  - **Chain:** a run of requests with tool calls and no message between;
    a request after a message is not "inside a chain".
- **The reader saving (20% to 27%) rests on the "only reads" share and the
  10.7M result tokens**, the two figures that differ most. Until the rules
  are reconciled, treat it as the seat scripts' figure, not one this
  repository can re-derive.

## What would reopen or close these

- **Checked batch:** reopen if a sample of another node or another period
  shows a check deciding the next step in half the places or more.
- **Reader design: stopped.** On 2026-10-13 the owner answered "No, stop
  here" to a live trial: no seat is switched to the reader and nothing is
  built for it. The offline result above stays as the record. If it is ever
  reopened, start from the copied-lines rule (the re-read added no
  quality). What offline runs cannot answer is the saving and the
  corrections on long work that changes things, which needs one live seat
  (not voice, because of the speed) for a few days. Do not expect the
  calculated 20% to 27% from it: measured so far is 12% on small tasks.
- **Whole job as one workflow: stopped.** On 2026-10-13 the owner answered
  "No, stop it" to running the fixed version in the live dry-run: no
  routing, no merge, the idea set aside. The record on #928 stays: 78%
  cheaper on the job it was written for, a job that is about 1% of spend.

With both answers, nothing from #928 goes live. The repo keeps only the
read-only script and this page.
- **Session start (18%)** is shared with #615 and #947, not with these forms.
- **Prices:** check which of 4 / 20 and 5 / 25 matches the invoice for
  Opus 5.5, and whether AgentX's table needs a Haiku 5 family.
