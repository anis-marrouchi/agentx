# Cost

Path: `/admin/cost`

Where you go to answer "how much are we spending on Claude, and which agent is burning it?" One page, plain numbers, no spreadsheets. The standalone `agentx usage serve` process was retired and folded into this page — same data, now living next to everything else in `/admin`.

The point of this page is not to make you a cost analyst. It's to put the three or four numbers you actually need on one screen, so a non-technical operator can answer "is spend healthy?" in under a minute.

## What you'll see

- **Today / Last 7 days / Last 30 days**: three big number tiles at the top. Each tile shows total spend in USD plus the task count it covers, so you can tell whether a high number reflects more work or more expensive work.
- **Tier-2 surcharge KPI**: a single number — how many extra dollars you paid this month because sessions crossed the tier-2 token threshold. Anthropic charges 1.5x once a session goes long; this KPI is the chunk of your bill that came from *not rotating in time*. If it's creeping up week over week, agents are running long without rotating and you're paying the surcharge unnecessarily.
- **30-day trend chart**: one bar per day, height = spend. Hover any bar for the exact figure. The fastest way to spot a spike *before* it becomes a habit — three days of growing bars is the cue to investigate.
- **Per-agent table**: one row per agent. Columns: agent id, tasks run, total spend, and the slice of that spend that came from the tier-2 surcharge. Sortable on every column — click "Spend" to find the biggest spender; click "Tier-2" to find the worst rotators.

The numbers come from `/api/admin/observability/cost`, which reads the `task_history` table in `.agentx/db.sqlite`. No live polling of Anthropic — costs are computed locally from token counts using a built-in rate card. That means the page works offline and there's no API quota to worry about.

## What you can do

- Sort the per-agent table by any column to find your top spender or your worst tier-2 offender.
- Click an agent's row to open that agent's page (`/admin/agents/<id>`) and dig into individual tasks. From there you can see exactly which task drove the cost.
- Hover the trend chart to compare any two days at a glance.
- Read the tier-2 KPI as a leading indicator: if it's growing, lower `session.tierTwoThresholdTokens` so sessions rotate sooner. The cost reduction is usually immediate.
- Switch the per-agent table between Today / 7d / 30d to localise a problem to a specific window.
- Bookmark a deep link for any view — the time range and sort column are encoded in the URL, so you can save "/admin/cost?range=7d&sort=tier2" as your morning check.

The page is read-only. There's nothing here you can break by clicking around. To actually change cost-related settings — model, rotation thresholds, agent budgets — go to [Admin → Agents](./admin) or [Admin → Advanced](./admin).

## Anthropic rate card (built in)

Costs are computed using these per-million-token rates:

| Model | Input | Output | Cache read |
|---|---|---|---|
| Opus | $15 | $75 | $1.50 |
| Sonnet | $3 | $15 | $0.30 |
| Haiku | $0.25 | $1.25 | $0.025 |

Output is always 5x more expensive than input, so an agent that talks a lot is more expensive than one that listens a lot. Cache reads land between $0.025/M and $1.50/M depending on model — they're an order of magnitude cheaper than fresh input, which is why prompt caching is on by default. If Anthropic publishes new prices, the rate table lives in `src/observability/pricing.ts` — one edit and every figure on this page updates.

## Common tasks

1. **"Which agent burned the most this week?"**
   Switch the per-agent table to "Last 7 days," sort by Spend descending. Top row wins. Click into them to see *which tasks* drove the spend.

2. **"We had a tier-2 hotspot — who?"**
   Sort the per-agent table by Tier-2 surcharge. The agent at the top is rotating too late. Two fixes: lower `session.tierTwoThresholdTokens` for that agent specifically, or audit its prompt for runaway context growth (huge system prompts, accumulating tool outputs, etc.).

3. **"Did today cost more than yesterday?"**
   Look at the trend chart's last two bars. The tile at the top shows today's running total; hover the previous bar for yesterday's final. If today is on track to exceed yesterday and it's only noon, that's worth investigating.

4. **"Finance wants a monthly export."**
   The CLI is the right tool here: `agentx usage report --days 30` produces a CSV-friendly summary. The dashboard is for scanning; the CLI is for piping.

5. **"Spend doubled overnight — what changed?"**
   Open the trend chart, find yesterday's bar, then go to [Health → Activity](./health) for the same date to see if task volume went up. If volume is flat but spend doubled, someone changed a model setting (Sonnet → Opus, or cache disabled). Check the Agents tab for recent edits.

6. **"Set a soft budget alert for an agent."**
   The page itself doesn't alert, but the data feeding it does. Pair it with `agentx usage today --json` in a cron job that pings you when an agent's daily spend crosses your threshold. The dashboard then becomes the place you look once the alert fires.

7. **"Compare two clients for monthly billing."**
   Sort the per-agent table, but also cross-reference [Business → Projects](./business) to see which agents map to which client. The cost page itself doesn't aggregate by client today — for that, lean on `agentx usage report` plus the projects table.

## Troubleshooting

- **Spend says $0 across the board.** Either the daemon hasn't run any tasks yet (so `task_history` is empty), or the dashboard is pointed at a different `.agentx/db.sqlite` than the daemon writes to. Run `agentx db tasks` from the same working directory — if that returns rows, the page is reading the wrong DB; pass `--cwd` or run the dashboard from the project root.
- **Per-task cost looks suspiciously low or zero.** Token counts exist but the model name didn't match the rate table. Check `src/observability/pricing.ts` — model aliases (`claude-3-5-sonnet-latest` etc.) need an entry there.
- **Tier-2 KPI is huge and you don't know why.** Open [Health → Rotations](./health) and filter for reason `tier-2`. The rotation log shows which sessions kept growing past the threshold and when.
- **Trend chart has gaps.** Days where no tasks ran show up as zero-height bars, not gaps. If you see literal gaps, the daemon was offline that day — cross-check with `systemctl status agentx`.
- **The 30-day total disagrees with what Anthropic invoiced.** Local computation uses the rate card in `src/observability/pricing.ts` and the token counts the daemon recorded. Anthropic's invoice may include charges for sessions outside agentx (Claude Code dev sessions, ad-hoc API calls), or for usage from a different API key. The dashboard is "what agentx spent," not "what your Anthropic account spent."
- **Page loads but every chart is blank.** The browser couldn't reach `/api/admin/observability/cost`. Open dev tools → Network and look at the response — usually a 401 (token missing) or a 500 (DB locked because another process is writing). The daemon log under [Health → Logs](./health) names the cause.

## A note on what the dashboard does *not* do

It doesn't budget. It doesn't enforce caps. It doesn't email finance when you cross a number. agentx treats the dashboard as a passive observability surface — the loop "see spend → adjust config → save" is human-driven by design. If you want hard limits, wire `agentx usage today --json` into a cron with a comparison and a Slack notifier; the dashboard is for the sit-down review, not the realtime guardrail.

## CLI parity

- `agentx usage today` — same today / 7-day rollup as the top tiles, printed to terminal. Useful in shell scripts and cron alerts.
- `agentx usage report --days 7` — full Python-analyzer report; richer than the dashboard if you want per-day, per-model, or per-session breakdowns.
- `agentx db tasks` — raw `task_history` rows, useful when you suspect the dashboard is misreading something.
- `agentx db rotations` — raw rotation events, the source of the tier-2 surcharge calculation.
