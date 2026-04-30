# Usage dashboard

The token-usage dashboard runs on a **separate process** from the main board dashboard. Start it with:

```bash
agentx usage serve --port 4203
```

Default port `4203` so it doesn't collide with the board on `4202`.

This is intentionally isolated: the usage dashboard reads from the operational SQLite (`.agentx/db.sqlite`) plus the Claude Code session JSONL on disk. It doesn't talk to the running daemon — safe to run as a cron-spawned readonly process or inside CI when investigating cost spikes.

## What you'll see

- **Top row**: today / 7-day / 30-day rollup. Total cost, total input + output tokens, average per task.
- **Per-agent breakdown**: cost + tokens + task count + p50/p95 duration per agent.
- **Tier-2 hotspots**: which agents crossed `session.tierTwoThresholdTokens` and how often. Tier-2 is billed at 1.5× — these are the sessions to rotate proactively.
- **Rotation reasons**: `stale` (idle timeout), `tier-2` (proactive rotation to dodge the multiplier), `max-turns` (hit per-session cap). Read-out from the `rotations` table.
- **Session JSONL inspector**: pick a Claude Code session by id, see every turn's tokens + cost.

## What you can do

- Drill into any agent (link to that agent's task list).
- Export the rollup as CSV for finance.
- Filter to a specific day to investigate a spike.
- Compare two date ranges.

## Common tasks

| You want to… | Do this |
|---|---|
| Find what blew up the bill yesterday | Switch to **Yesterday** → look at per-agent → click the spike → session JSONL inspector |
| See how often tier-2 fires | **Rotation reasons** → filter `tier-2`. If high, lower `session.tierTwoThresholdTokens` |
| Get the same numbers from the CLI | `agentx usage today` (last 7 days) or `agentx usage report --days 30` |

## CLI vs dashboard

The CLI is the source of truth for scripting; the dashboard is the same data with charts. The dashboard does NOT register a hot-reload listener with the daemon — it polls SQLite at a configurable interval (default 30s).

## Troubleshooting

- **"No data."** No tasks in the SQLite store yet, or the store is at a different path. Confirm with `agentx db tables`.
- **Per-task cost looks zero.** Provider rates aren't configured in `providers.<name>`. The `usage` reader infers cost from token counts × model rate; rates default to a built-in table that may be stale. Check `src/observability/pricing.ts` for the table.
- **Dashboard is empty but `agentx db tasks` returns rows.** The dashboard reads from a different `.agentx` directory than the daemon. Run `agentx usage serve --cwd /path/to/agentx-data`.

## Implementation pointers

- Server: `src/daemon/usage-dashboard.ts`
- CLI siblings: [`agentx usage today / serve / report`](/reference/cli#usage--tokens), [`agentx db tasks / rotations / usage`](/reference/cli#database-read-only)
- Data sources: `task_history` and `rotations` tables in `.agentx/db.sqlite`; Claude Code session JSONL under `~/.claude/projects/`
