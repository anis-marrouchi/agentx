# AgentX against the bare Claude Code CLI: one task, Haiku 4.5

First measured run of #455, made with `pnpm bench:compare` on 2026-10-04 in a
cloud VM. Raw results: `compare-claude-code-haiku-4-5.json` (three runs per
mode, interleaved) and `compare-claude-code-haiku-4-5-agentx-extra.json`
(three more runs of the full profile, kept to read their session logs).

**The task.** A small Node project whose tests fail because of four bugs in
two source files (5 of 10 tests fail). The prompt: run the tests, fix the
code under `src/` without touching `test/`, run the tests again, report how
many pass. The check is mechanical: the tests pass and the test file hash
is unchanged.

**The sides.** Same model (`claude-haiku-4-5-20251001`), same prompt, same
fresh copy of the project, permissions skipped on both.

| Mode | What runs |
|---|---|
| `claude` | `claude -p <prompt> --dangerously-skip-permissions` in the project; no CLAUDE.md, nothing from AgentX. |
| `agentx` | `agentx exec` with one `claude-code` agent whose workspace is the project; AgentX writes its managed `CLAUDE.md`, `AGENTS.md`, `.claude/rules` and `.claude/settings.json` first, and appends its own system prompt; full session profile. |
| `agentx-lean` | The same with the lean session profile (#615). |

## Results

| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | 1 | yes | 13 | 66 | 2.0k | 246.7k | 11.4k | 260.1k | $0.0584 | 21s |
| agentx | 1 | yes | 12 | 98 | 2.5k | 431.4k | 14.1k | 448.1k | $0.0858 | 28s |
| agentx-lean | 1 | yes | 12 | 58 | 2.2k | 231.8k | 14.1k | 248.2k | $0.0636 | 21s |
| claude | 2 | yes | 12 | 66 | 2.3k | 253.7k | 11.4k | 267.6k | $0.0610 | 24s |
| agentx | 2 | yes | 12 | 58 | 2.4k | 242.9k | 13.9k | 259.3k | $0.0662 | 23s |
| agentx-lean | 2 | yes | 12 | 66 | 2.0k | 267.5k | 12.8k | 282.4k | $0.0635 | 21s |
| claude | 3 | yes | 12 | 66 | 2.1k | 256.1k | 11.3k | 269.6k | $0.0599 | 22s |
| agentx | 3 | yes | 12 | 98 | 2.5k | 430.5k | 14.1k | 447.1k | $0.0860 | 28s |
| agentx-lean | 3 | yes | 13 | 58 | 2.3k | 234.7k | 13.4k | 250.5k | $0.0631 | 22s |

Medians:

| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|
| claude | 3/3 | 12 | 267.6k | 253.7k | $0.0599 | 22s |
| agentx | 3/3 | 12 | 447.1k | 430.5k | $0.0858 | 28s |
| agentx-lean | 3/3 | 12 | 250.5k | 234.7k | $0.0635 | 21s |

Three more full-profile runs, kept for their logs: 375.2k / $0.0795 / 29s,
295.7k / $0.0701 / 25s, 258.7k / $0.0652 / 23s.

## What the session logs say

Claude Code's own logs for every run give the context of each API call
and the tool calls made.

| Mode | First request (tokens) | API calls per run | Tool calls | Tool result bytes |
|---|---|---|---|---|
| claude | 29.3k | 8, 8, 8 | npm test, read test, read 2 files, 4 edits, npm test | about 10.5k |
| agentx-lean | 31.2k | 7, 8, 7 | the same, plus one `ls` | about 10.6k |
| agentx | 32.7k | 12, 7, 12, then 10, 8, 7 | the same, plus one `ls` or `find` | about 10.5k |

- **What AgentX adds to the start is small on this task:** 1.9k tokens
  with the lean profile and 3.3k with the full one, on a 29.3k first
  request. The cache write per run, which is what a fresh session pays
  for, is 14k against 11.4k.
- **The spread between runs is the number of API calls, not the
  context.** Every run made the same edits and read the same files; the
  model took between 7 and 12 calls to do it. Cache read grows with each
  call, so a 12-call run reads 1.7 times the tokens of a 7-call run. On six
  full-profile runs the median is 9 calls against 8 bare and 7 lean. Six
  runs are too few to say whether AgentX's system prompt causes that;
  the extra calls were not extra tool calls.
- **Correctness and wall time are the same.** Nine of nine correct; 21 to
  29 seconds; the extra seconds track the extra API calls.
- **The lean profile costs the same as the bare CLI** (within 6 percent on
  Haiku, the difference being the larger cache write).

## What this does and does not show

This is the first rung of the #455 ladder, "one prompt in one repo". On
it, Claude Code alone is as good as AgentX, and the full profile is dearer.
What AgentX is for (routing a message from a channel to the right agent,
keeping the session across events, the trace, approvals, the mesh) is not
exercised by one prompt in one repo, so this run makes no claim about it.
The next rungs on the issue are where that would show.

Caveats: Haiku 4.5 only; a cloud VM with no user-level Claude Code
settings, so the bare CLI started with nothing extra, which is not how a
developer's machine looks; `agentx exec` in a fresh state directory, so no
history, memory or wiki was pushed into the prompt.

To repeat on another model: `pnpm bench:compare --model <id> --runs 3`.

## Second run: Sonnet 5.5

Same task, same prompt, same three modes, 2026-10-04, raw results in
`compare-claude-code-sonnet-5-5.json`.

| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | 1 | yes | 4 | 8 | 455 | 128.2k | 11.2k | 139.8k | $0.0760 | 12s |
| agentx | 1 | yes | 4 | 8 | 562 | 116.7k | 40.2k | 157.5k | $0.1919 | 15s |
| agentx-lean | 1 | yes | 4 | 8 | 575 | 124.0k | 10.8k | 135.3k | $0.0749 | 13s |
| claude | 2 | yes | 4 | 8 | 470 | 128.3k | 11.4k | 140.2k | $0.0768 | 11s |
| agentx | 2 | yes | 4 | 8 | 537 | 142.8k | 14.1k | 157.4k | $0.0925 | 13s |
| agentx-lean | 2 | yes | 4 | 8 | 413 | 124.6k | 9.4k | 134.5k | $0.0679 | 11s |
| claude | 3 | yes | 4 | 8 | 495 | 128.3k | 11.3k | 140.2k | $0.0770 | 11s |
| agentx | 3 | yes | 4 | 8 | 502 | 143.1k | 14.3k | 158.0k | $0.0930 | 12s |
| agentx-lean | 3 | yes | 4 | 8 | 501 | 125.3k | 9.8k | 135.6k | $0.0704 | 14s |

Medians:

| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|
| claude | 3/3 | 4 | 140.2k | 128.3k | $0.0768 | 11s |
| agentx | 3/3 | 4 | 157.5k | 142.8k | $0.0930 | 13s |
| agentx-lean | 3/3 | 4 | 135.3k | 124.6k | $0.0704 | 13s |

From the session logs: every run made exactly 4 API calls and 3 tool
calls. Sonnet batches the work: one `npm test` with `ls`, one read of the
test and source files, then the edits and the test rerun in a single
command (in most runs it rewrote the two files from a `python3 -c`
one-liner rather than with Edit). First request: 33.5k tokens bare, 32.4k
lean, 38.0k full.

- **Sonnet does the task in a third of the tokens Haiku needs** (140k
  against 268k) and half the time, at a similar price per run on this
  task ($0.077 against $0.060), because it makes 4 calls where Haiku makes
  8 to 12.
- **Full profile: 12 percent more tokens and 21 percent more cost than
  the bare CLI** (medians), all of it the larger prefix read on every
  call. Its first run paid a 40k cache write ($0.19): AgentX's prefix was
  not yet in the prompt cache, and the two runs after it read it from
  there. Across a day of runs that first write is paid once per hour of
  idle time, not per run.
- **Lean profile: 3 percent fewer tokens and 8 percent less cost than the
  bare CLI.** Its first request is smaller than the bare CLI's here, since
  the bare CLI loads this VM's user-level settings and the lean session
  does not.
- **Correct 9 of 9, 11 to 15 seconds.**

The variance seen on Haiku (7 to 12 API calls for the same work) does not
appear on Sonnet; the full profile's extra cost on Sonnet is purely its
larger prefix.
