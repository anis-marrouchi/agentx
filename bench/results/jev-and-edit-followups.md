# Follow-ups to the token test: the edit retry and the context seat

Two experiments for #455, run on 2026-10-04 after the 90-run rerun in
[token-test-sonnet-5-5.md](token-test-sonnet-5-5.md). Both measure before
anything changes for agents.

## 1. The edit retry

**The problem.** In about 3 of 10 runs of the `trace` task, in every mode
(the bare CLI too), the agent edits `src/checkout.js` with a multi-line
`sed`, leaves a duplicate line, and spends one to three more model calls
repairing it. That is the largest variable cost left on the task.

**What was tested.** Lean AgentX as it is now, on `trace` with Sonnet
5.5, 20 runs each, with one instruction appended to the system prompt
(`bench/ablate-trace.py`, raw runs in `ablation-trace-sonnet-5-5.jsonl`,
variants `now`, `now-edit`, `now-edit2`):

- **A** ([edit-rule-a.txt](edit-rule-a.txt)): change files with the Edit
  tool, not with `sed`, `awk` or a shell rewrite.
- **B** ([edit-rule-b.txt](edit-rule-b.txt)): a one-line `sed`
  substitution is fine; anything that adds, removes or moves lines goes
  through the Edit tool.

| Instruction | Correct | Runs over 3 calls | Mean tokens | Mean cost | Median output tokens |
|---|---|---|---|---|---|
| none (today) | 20/20 | 7/20 | 122.3k | $0.0750 | 754 |
| A: Edit tool | 20/20 | **0/20** | **106.8k** | $0.0783 | 1,299 |
| B: `sed` for one line | 20/20 | 14/20 | 135.1k | $0.0786 | 874 |

- **A removes the retry.** Every run finished in 3 calls (7 of 20 runs
  took more without it; Fisher's exact test p = 0.008), and mean tokens
  fell 13 percent.
- **A costs about 4 percent more.** An Edit call writes out the old and
  the new text, so output tokens rise from about 750 to 1,300 a run, and
  output is the dearest kind of token. The saving is in cheap cached
  reads; the extra is in output.
- **B is worse on both.** Mixing `sed` and Edit led to more calls, not
  fewer.

**Not shipped.** A trades 13 percent fewer tokens and steadier runs for
4 percent more money. That is a choice for the owner, not a default.

## 2. The context seat on the landscape sections

**The change** (`src/agents/request-planner.ts`): the request-context seat
now decides the landscape section by section (agent directory,
cross-channel messaging, conversation recall, background monitoring,
agent teams) instead of as one block, and never offers the group-chat
[Rules].

**What was tested** (`bench/context-seat.ts`, raw answers in
`context-seat-haiku-4-5.json`): 16 messages a person labelled with the
sections each one needs, each asked three times, through the local
decision backend (Claude Code with Haiku 4.5), on a demo node with four
agents and two channels. The landscape is 4,429 characters.

| Section | Characters | Messages that need it | Dropped when needed | Dropped when not needed |
|---|---|---|---|---|
| Agent directory | 442 | 3 | 0/9 | 27/39 |
| Cross-channel messaging | 596 | 2 | 0/6 | 30/42 |
| Conversation recall | 1,605 | 2 | 0/6 | 28/42 |
| Background monitoring | 326 | 1 | 0/3 | 42/45 |
| Agent teams | 502 | 1 | 0/3 | 45/45 |

- **No wrong drops in 48 decisions**: no section a message needed was
  removed.
- **It saves about half the landscape**: 2,313 characters a turn on
  average (52 percent), about 600 tokens. Coding questions, greetings and
  thanks lose all of it; "ask the ops agent" keeps the directory;
  "continue what we discussed" keeps recall.
- **It errs on the side of keeping**: recall is kept for a third of the
  messages that do not need it.

**Two limits found.**

1. **Too slow on the local backend.** A decision took a median 12.7
   seconds; a live turn waits at most 3 seconds for this seat, so with the
   local backend every decision times out and nothing is dropped. The
   seat needs a fast backend: Jev through OpenRouter answers in about half
   a second (measured on 2026-09-19, `src/daemon/config.ts`).
2. **The saving is small per turn.** About 600 tokens of prompt, re-read
   on each call of the turn mostly from the cache. A decision has to cost
   less than that to pay; on a chat channel with long sessions it does,
   on a one-shot coding task it barely does.

## Check it worked

- `ablation-trace-sonnet-5-5.jsonl` has 20 rows each for `now`,
  `now-edit` and `now-edit2`.
- `context-seat-haiku-4-5.json` has 48 results, none with `wrongDrops`.

## If something is wrong

- If the context seat drops nothing at all, check its timeout first: the
  live path waits 3 seconds, and a slower backend fails open.
- If a rerun of the edit test disagrees, compare the median output tokens
  first; that is where the two instructions differ in cost.
