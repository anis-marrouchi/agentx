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
