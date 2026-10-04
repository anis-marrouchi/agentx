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
