# agentx on Terminal-Bench (Harbor)

Runs agentx through [Harbor](https://docs.harborframework.com), the official
Terminal-Bench 2.0 harness, next to Harbor's built-in `claude-code` and
`codex` agents. Every agent gets the same task containers and the same
verifier, and Harbor records pass/fail, timings, tokens and cost per trial.

| File | What it is |
|---|---|
| `agentx_agent.py` | Harbor agent: installs agentx in the task container and runs the task through `agentx exec --json` |
| `report.py` | Turns Harbor job folders into one comparison table (pass rate, time, tokens, cost) |

## Setup

```bash
brew install uv && uv tool install harbor
```

Build agentx from a **clean checkout** so the benchmark measures committed
code, not whatever is in your working tree:

```bash
git worktree add /tmp/agentx-bench HEAD
cd /tmp/agentx-bench && pnpm install && pnpm build && npm pack
# → /tmp/agentx-bench/agentix-cli-<version>.tgz
```

Credentials, the same kind for every agent. Prefer the API key: it bills
per token and leaves the fleet's subscription quota alone.

```bash
# API billing (recommended)
export ANTHROPIC_API_KEY=...         # baseline uses it; agentx needs --ak billing=api
export OPENAI_API_KEY=...            # codex / codex-cli tier

# or subscription billing: shares the fleet's quota
export CLAUDE_CODE_OAUTH_TOKEN=...   # from `claude setup-token`
export CLAUDE_FORCE_OAUTH=1          # make Harbor's claude-code baseline use it too
```

agentx's `claude-code` tier uses the subscription unless the agent sets
`billing: "api"`, so pass `--ak billing=api` whenever the baseline runs on
the API key, or the two are billed differently.

## Run

Start with a 5-task pilot per agent, then drop `-l` and set `-k 3`.

```bash
TGZ=/tmp/agentx-bench/agentix-cli-<version>.tgz
M=anthropic/claude-opus-5-5

harbor run -d terminal-bench@2.0 -a claude-code -m $M -n 2 -k 1 -l 5 -o jobs --job-name claude-code

PYTHONPATH=bench/harbor harbor run -d terminal-bench@2.0 \
  -a agentx_agent:AgentX -m $M --ak tier=claude-code --ak billing=api --ak tarball=$TGZ \
  -n 2 -k 1 -l 5 -o jobs --job-name agentx-claude-code

harbor run -d terminal-bench@2.0 -a codex -m openai/<model> -n 2 -k 1 -l 5 -o jobs --job-name codex

PYTHONPATH=bench/harbor harbor run -d terminal-bench@2.0 \
  -a agentx_agent:AgentX -m openai/<model> --ak tier=codex-cli --ak tarball=$TGZ \
  -n 2 -k 1 -l 5 -o jobs --job-name agentx-codex-cli
```

Then:

```bash
python3 bench/harbor/report.py jobs/
```

## Agent options (`--ak key=value`)

| Key | Default | Meaning |
|---|---|---|
| `tier` | `claude-code` | agentx execution tier: `claude-code` or `codex-cli` |
| `billing` | `subscription` | `api` bills `ANTHROPIC_API_KEY` instead of the OAuth token (claude-code tier) |
| `tarball` | npm `agentix-cli` | local `npm pack` output to install; without it, `--agent-version` pins the npm release |
| `setup_workspace` | `true` | write agentx's managed workspace files (CLAUDE.md, settings) into the task directory, as daemon boot does. Set `false` if a task's tests object to extra files |
| `max_minutes` | `240` | agentx's own time cap |

## How to read the comparison

- **Same engine, same model** (`claude-code` vs `agentx [claude-code]`) measures
  what agentx adds on top of Claude Code: its context layers, workspace
  setup and dispatch. It is not agentx against a different agent.
- agentx's own agent loop (the `orchestrator` / `sdk` tiers) is not
  benchmarkable yet: its usage drops cache counts and falls back to a 70/30
  input/output estimate. The adapter refuses those tiers until that is fixed.
- **`claude-code` vs `codex`** compares models as much as tools.
- Each run starts from an empty agentx: no fleet wiki, memory or skills.

## Accounting

- `n_input_tokens` = fresh input + cache reads + cache writes; `n_cache_tokens`
  = cache reads. Same definition as Harbor's `claude-code` agent. agentx's
  cache writes are also kept in the trial's `metadata.cache_write_tokens`.
- Cost is priced from tokens with LiteLLM, the way Harbor prices codex. If
  LiteLLM has no entry for the model, `cost_usd` is empty and `report.py`
  flags the trials as unpriced.
- Harbor's `claude-code` agent prefers Claude Code's own `total_cost_usd`
  and only falls back to LiteLLM. On a new model, check both agents priced
  the same way before comparing cost.

## Known gaps

- **Timeouts lose agentx's usage.** `agentx exec` reports tokens when it
  exits. If Harbor's task timeout kills it first, that trial records no
  tokens or cost (it still counts as unsolved). Built-in agents stream
  usage to their logs, so they keep partial counts. Report timeouts
  separately (`err` column) and treat agentx's cost as a floor if there
  are many.
- Alpine/musl task images are not supported (agentx installs Node via nvm).
- On a 6 GB Docker VM keep `-n` at 2 or lower; use `-e daytona` or a bigger
  host for full runs.
