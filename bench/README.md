# Benchmarks

Three levels, from free and every-commit to expensive and rare. Optimize
against the cheap ones; use the expensive ones to confirm.

| Level | Command | Cost | Answers |
|---|---|---|---|
| 0 | `pnpm bench:context` | free | How much context does agentx add before the model starts? |
| 0 | `pnpm bench:profiles` | free | What does the lean session profile save per channel and prompt section? |
| 1 | `bench/harbor/dev.sh` | ~$8 per run on Haiku | Does a change make agentx cheaper or worse on real tasks? |
| 2+ | `harbor run` directly, see [harbor/README.md](harbor/README.md) | $60 to $1,300+ | Publishable numbers on the full Terminal-Bench 2.0 |

## Level 0: context size

Runs the real `agentx exec` path against a fake `claude` and counts what
agentx hands it: the system-prompt preamble, the prompt around the task,
and the workspace files Claude Code loads on its own. No model is called.
Every token here is re-read on every model call of every task.

```bash
pnpm bench:context                 # estimate (~4 chars per token)
pnpm bench:context --exact         # exact, via the free count_tokens API
pnpm bench:context --budget 2000   # exit 1 above 2000 tokens
pnpm bench:context --channel github --sections   # one channel, one row per prompt section
pnpm bench:context --channel a2a --profile lean  # force the session profile
```

### Session profiles (#615)

`pnpm bench:profiles` measures the same thing twice per channel, with the
`full` and the `lean` session profile, and prints a table with the saving
per prompt section. By default it covers `github`, `a2a`, `workflow` and
`cron` on the third turn of a chat (`--warm 2`), which is when a full
session has a history and a cross-chat hint to push.

```bash
pnpm bench:profiles                               # the four lean-by-default channels
pnpm bench:profiles --channels github,telegram    # pick channels
pnpm bench:profiles --exact                       # exact counts (ANTHROPIC_API_KEY)
pnpm bench:profiles --config agentx.json --agent devops   # a real agent
```

It counts what agentx hands the session. Claude Code's own start (built-in
tool schemas, the skill list, user-level MCP tool schemas, the global
CLAUDE.md) is not visible to a fake `claude`; the `claude flags` row shows
which of it a lean session leaves out, and issue #615 has its measured size.

### Tool results (#621)

`bench/observation-pack-replay.py` reads the Claude Code session logs of a
fixed range of days and counts the tool results over the ObservationPack
limit: per tool and per channel, how many bytes they are and how many tokens
later requests re-read. No model is called. Use it to see what
`session.observationPack` can reach on a node before turning it on.

```bash
python3 bench/observation-pack-replay.py --from 2026-10-01 --to 2026-10-03
python3 bench/observation-pack-replay.py --from 2026-10-01 --to 2026-10-03 --limit 20480 --json replay.json
```

The token column is an estimate (bytes / 4, once per later request in the
same session log). It is an upper limit: it ignores compaction and what the
agent reads back from a saved original. The recorded cost per channel, before
and after, comes from `agentx usage channels`.

### The history block (#636, parked)

Pruning today's earlier messages with a Jev seat before a fresh session
starts was measured and parked: the block is sent on few turns and the
saving is cents a week. The numbers, the reasons and the conditions for
reopening are in [results/context-prune-636.md](results/context-prune-636.md);
the code stays on the branch `636-jev-context-pruning`.

## Level 1, small: AgentX against the bare CLI (#455)

`pnpm bench:compare` runs the same coding tasks on the bare Claude Code CLI
and through `agentx exec`, same model, same prompt, several times each, and
prints tokens, turns, wall time, the CLI's own cost figure and whether each
task came out right. Each task is a small Node project with failing tests
([compare-tasks.ts](compare-tasks.ts)); the check afterwards is mechanical
(the tests pass; no file under `test/` changed).

| Task | What the agent has to do |
|---|---|
| `fix-bugs` (default) | Fix four bugs the failing tests point at, in two files. |
| `implement` | Write two empty functions; the tests are the spec. |
| `trace` | Find four causes of a bug report across six files, with the rules in a README. |

```bash
pnpm build                                   # agentx exec runs from dist/
pnpm bench:compare                           # 3 runs each of claude, agentx, agentx-lean on Haiku 4.5
pnpm bench:compare --runs 10 --tasks all --model claude-sonnet-5-5 --json results.json
pnpm bench:compare --modes claude,agentx --tasks trace --keep
```

Every run calls the model and costs money (cents per run on Haiku). The
`claude` CLI must be signed in; both sides bill the same account. The modes:

| Mode | What runs |
|---|---|
| `claude` | `claude -p <prompt> --dangerously-skip-permissions` in a fresh copy of the project; no CLAUDE.md, nothing from AgentX. |
| `agentx` | `agentx exec` with one `claude-code` agent on the same copy, the managed workspace files written first as the daemon does, full session profile. |
| `agentx-lean` | The same with the lean session profile (#615). |

Runs are interleaved across tasks and modes so a slow hour hits every mode
alike, and `--json` rewrites the raw file after every run. The output ends
with a verdict per AgentX mode against the bare CLI: the ratio of median
tokens (and cost), a 95% bootstrap interval, and "uses less", "uses more"
or "no clear difference". The rule is written out in
[results/token-test-plan.md](results/token-test-plan.md).

The cost column is `total_cost_usd` as the CLI reports it (list price); the
`agentx` rows get it through `agentx exec --json` (`costUsd`).

## Level 1: dev set

Claude Code and agentx, same model (Haiku 4.5), same 8 Terminal-Bench tasks
([harbor/dev-set.txt](harbor/dev-set.txt)), 2 attempts each, both billed to
`ANTHROPIC_API_KEY` so the fleet's subscription quota is never touched.

```bash
export ANTHROPIC_API_KEY=...
bench/harbor/dev.sh baseline --yes   # once; reused until the model or task list changes
bench/harbor/dev.sh agentx --yes     # per change; built from this checkout
bench/harbor/dev.sh compare
```

Nothing runs without `--yes`; without it the script prints what the run
would cost. Jobs are cached by name (`dev-agentx-<commit>-<model>`), so an
unchanged commit is never paid for twice.

Reading `compare`:

- **cost / tokens B/A** is the number to optimize: a geometric mean over the
  tasks both sides solved, comparing each task to itself, with a 95%
  bootstrap interval. If the interval contains 1.00 there is no measurable
  change; run another agentx job or go to Level 2 before believing it.
- **solved tasks** is the guardrail. B solving 2+ fewer tasks than A is a
  regression whatever it saves, and `compare` exits 1.
- With 8 tasks, only changes of roughly 15% or more are detectable. That is
  the price of $8 runs.
