# Small workflows and a cheaper reader: what #928 measured

The results of the token side of the spike in #928, measured on 2026-10-13
on one node's Claude Code session logs (10-09 to 10-12, 507 to 561 main
sessions depending on the count). Nothing from it is built, routed or switched on. This page records
what was measured so the ideas are not re-done from scratch, and what is
still open. The model-free parts can be re-run with
[`bench/slice-replay.py`](../slice-replay.py) (see the
[bench README](../README.md#small-reusable-workflows-928)). The graded runs
used scripts in the developer seat's workspace and are not in this
repository.

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
| Small workflows mined from repeated slices of calls, one call each | 1% to 4% (ceiling 8%) | Count of literal repeated sequences | Not built |
| Look ahead: the agent fixes its next 2 to 4 calls in one call, run with no model | 1% to 3% | Count, plus a replay of 60 moments | Not built |
| Checked batch: 2 to 4 steps in one call, a check on each, stop at the first failed check | 3.5% to 5% (6% at most) | 240 graded stretches, 40 graded by hand | Not built; below the 50% bar set before the test |
| A stronger model on the deciding call | A loss: about 1.19 USD per call against 0.07 to 0.11 saved | Arithmetic | Not built |
| Reader on the small model: the main model asks, a reader does the looking up and returns a short note | 20% to 27% (calculated); 15% in one offline run of 10 tasks | Priced on logged reading stretches; one real run | Open: answers graded lower than today's |

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
- **Not tested:** long sessions that change things, where most spend sits.

## What would reopen or close these

- **Checked batch:** reopen if a sample of another node or another period
  shows a check deciding the next step in half the places or more.
- **Reader design:** the proposed next test (three reader rules: quoted
  lines, re-read of the deciding lines, both; 20 tasks; about 12 USD) waits
  for the owner's yes. Go on only if a variant reaches the repeat's quality
  (5 of 10 as good) at 10% or more saved.
- **Session start (18%)** is shared with #615 and #947, not with these forms.
- **Prices:** check which of 4 / 20 and 5 / 25 matches the invoice for
  Opus 5.5, and whether AgentX's table needs a Haiku 5 family.
