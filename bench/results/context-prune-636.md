# Pruning the history block with a Jev seat: measured, then parked

The result of the spike in #636, measured on 2026-10-04 and parked by the
owner the same day. The code is on the kept branch `636-jev-context-pruning`
(commit `f27f754b`, draft PR #637, closed without merging). Nothing from it
is on `main`. This page records what was measured so the idea is not
re-done from scratch, and what would make it worth reopening.

## The idea

Before each turn, ask a Jev seat (`context-prune`) which of today's earlier
messages the new message needs, and leave the rest out of the history
block. A floor is never scored: the new message, the last two turns from
the person, and any message matching an approval, instruction or pinned-fact
pattern. On a timeout or an error nothing is left out.

## Where the history block appears at all

AgentX adds today's earlier messages only when a session starts fresh.
A resumed session replays its own transcript, and the lean channels
(`github`, `a2a`, `workflow`, `cron`) get no block. That bounds the reach:

| 7-day replay on one node | Count |
|---|---|
| Runs | 4,241 (about $5,206 priced like `TokenTracker`) |
| Fresh turns | 1,645 |
| Fresh turns on a channel that gets the block | 576 |
| Of those still on disk to replay | 287 |
| With enough history to score (3 or more messages outside the floor) | **24** |

## What the replay measured

`scripts/bench-context-prune.ts` on the branch replays recorded fresh turns
through the seat (backend `typesafe`, every call real, nothing written to
the live decision store). Keep the last 2 turns; sweep the threshold:

| Threshold | Messages dropped | History tokens dropped | Saved per week |
|---|---|---|---|
| 0.1 | 64 / 827 (7.7%) | 3,608 / 141,780 (2.5%) | $0.11 |
| **0.2 (default)** | **147 (17.8%)** | **9,100 (6.4%)** | **$0.20** |
| 0.3 | 179 (21.6%) | 12,283 (8.7%) | $0.23 |
| 0.5 | 197 (23.8%) | 14,339 (10.1%) | $0.27 |

- **Ceiling.** Dropping every history message on every replayed turn saves
  $2.71 a week. Assuming a full 12,000-character block, all dropped, for the
  289 turns no longer on disk adds $24.03. Together that is at most about
  0.5 percent of the week's spend.
- **The seat itself.** 24 calls, about 3,500 input tokens each, p50 407 ms,
  p95 662 ms, no failures. It runs before the agent starts, so each scored
  turn waits 0.4 to 0.7 seconds longer.
- **Dropped messages that were needed.** A model graded 28 drops at the
  default threshold: 2 removed an instruction the later answer still
  needed. Both were standing instructions with no keyword the regex floor
  catches. Regex instruction detection is the weak part of the floor.
- **Not measured.** The prompt-cache effect: a history block that differs
  between fresh turns is a cache write where the unchanged block was a
  cache read. Fewer tokens could still cost more.

Assumptions that move the numbers: tokens are characters / 4; a dropped
token costs one cache write plus one cache read per later model call in
that chat until the next fresh turn; model prices come from each agent's
model in `agentx.json`; the Jev price is the OpenRouter rate ($0.042 per
million input tokens).

## The live trial measured nothing

A 60-minute window on the node with the seat `active` fell in a quiet
hour: 1 run, not a fresh one, so the seat was never asked. The same hour on
the previous 7 days had 13 to 109 runs.

## Why it was parked

- **Small ceiling.** The block is sent on a small share of turns, and
  most of those carry only the last turn or two, which the floor keeps.
- **The spend is elsewhere.** About half of the week's cost is tier-2
  cache reads in resumed sessions, which pruning the history block cannot
  touch. The #455 token test ([token-test-sonnet-5-5.md](token-test-sonnet-5-5.md))
  points the same way: what moves tokens is the number of model calls per
  task and what is re-read on every call.
- **Cost and risk for cents.** Half a second more per scored turn, and 2 of
  28 graded drops removed an instruction.

## Reopen if

- Resumed sessions start being rebuilt from a trimmed history (rotation),
  so the history block carries most of the context; or
- a busy-hour live trial shows a cache-read saving the offline replay
  could not see.

Reopening means reopening #636 and rebasing the kept branch; the seat,
the `contextPruning` settings and the replay script are complete there,
with tests and documentation.

## Check it worked

- `git log origin/main..origin/636-jev-context-pruning` shows exactly one
  commit, `f27f754b`.
- `grep -r context-prune src docs` on `main` finds nothing: the seat is not
  shipped.

## If something is wrong

- If a node still runs the branch build with the seat `active`, every
  fresh chat turn on a non-lean channel waits one extra Jev call. Roll
  that node back to a release and set `context-prune` to `off` or remove
  it from `decisions.seats`.
- If the replay is rerun and the counts differ a lot, check first how many
  session files are still on disk: sessions are trimmed and compacted, and
  the 289 missing turns were the largest unknown.
