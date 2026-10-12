# Token use: published findings AgentX does not apply yet (#947)

A research spike, done on 2026-10-12. Nothing here changes how agents
behave: no setting was switched on and no default moved. The one code
addition is a measuring script, `bench/cache-gap-replay.py`, which reads
session logs and calls no model.

The owner suspected something was being skipped "between the lines". Two
things were. Neither is a missing technique from a paper:

- **AgentX's price list is out of date**, so the figures behind earlier
  decisions are wrong ([before the list](#before-the-list-the-price-list-is-out-of-date)).
- **Two background costs are not counted**, or are counted only by
  accident: the Monitor reviewer, and the history every scheduled job
  carries from one run to the next (findings 1 and 2).

## How this was done

- **Code.** Every "today" line below was read from the code on `main` at
  `aee4db7` and gives a file and line.
- **Sources.** Each claim links to a page that can be opened. Where the
  headline figure did not match the source's own table or text, the
  mismatch is noted. arXiv was blocked from this environment. The
  Complexity Trap figures were therefore recomputed from the authors'
  released result files. The figures from RouteLLM, FrugalGPT and
  AgentDiet are marked *not checked against the paper's tables*.
- **Already covered, not repeated:** #621 (ObservationPack, decide
  before spawning), #615 (lean sessions), #612 (duplicate wake-ups), #614,
  #636 (history pruning), #855, and local search against grep.
- **Spend.** No paid API call. Three research helpers used about 470,000
  tokens on this session's plan, plus the session itself. Nothing was
  measured on a live node; each finding says how to measure it there.

## Before the list: the price list is out of date

The Cost page, `agentx usage channels` and the #636 replay all price
tokens with `CACHE_AWARE_PRICING` (`src/daemon/token-tracker.ts:35`). The
official [pricing page](https://platform.claude.com/docs/en/about-claude/pricing)
differs from it on the models the fleet now runs:

| | AgentX prices it as | Actual price |
|---|---|---|
| Opus 5.5, per million tokens: input / output | Opus 5: $5 / $25 (`getModelFamily`, `token-tracker.ts:80`) | $4 / $20 |
| Opus 5.5 cache read | $0.50 | $0.20 (0.05× input) |
| Sonnet 5.5 cache read | $0.20 (Sonnet 5 row) | $0.10 (0.05× input) |
| Fable 5.1 cache read | $1.00 | $0.25 (0.025× input) |
| Cache write | always the 5-minute price, 1.25× (`token-tracker.ts:33`) | 2× when the 1-hour cache is used, which is Claude Code's default on a subscription ([Claude Code docs](https://code.claude.com/docs/en/prompt-caching#which-ttl-each-request-gets)) |
| Turns above 200,000 tokens | every rate × 1.5 (`TIER2_MULTIPLIER`, `token-tracker.ts:58`), tested on the whole turn's summed input (`token-tracker.ts:174`) | No surcharge: "Claude 4.6 and later models … include the full 1M token context window at standard pricing" |

What this changes:

- **Cache reads in long, resumed sessions are priced 3 to 3.75 times too
  high.** Taking Opus 5.5 at the tier-2 rate: $0.50 × 1.5 = $0.75 per
  million, against $0.20.
- **#636 parked pruning partly on that figure.** Its reason was that
  "about half of the week's cost is tier-2 cache reads in resumed
  sessions". That share was priced with this table, so the true share is
  much smaller. It has to be recomputed before it steers more work.
- **Cache writes are priced too low** on subscription sessions (1.25×
  instead of 2×). Writes are what findings 1, 3 and 4 below are about.
- **The 180,000-token rotation** (`sessions.ts:78`) was set to stay under
  a surcharge that no longer applies to Opus or Sonnet 4.6 and later. It
  still limits context size, which is reason enough to keep it, but not
  for the reason in its comment.

**Cost to fix:** small. The fix is one table, the family mapping and the
tier-2 rule, plus their tests. It changes past figures on the Cost page,
so it needs a release note. This is a measuring fix, not a token saving,
and it is listed first because every estimate below depends on it.

## The ranked list

Each finding is ranked by expected saving, then by how cheaply it can be
tested.

### 1. Scheduled jobs carry their whole history from run to run

- **Source.** The Claude Code cost guide, ["Why usage climbs in a long
  session"](https://code.claude.com/docs/en/costs#why-usage-climbs-in-a-long-session):
  "a scheduled task fires on its interval even while the session is idle,
  sending your full context each time". [The Complexity Trap](https://github.com/JetBrains-Research/the-complexity-trap)
  (Lindenbauer et al., JetBrains, 2025; [arXiv 2508.21433](https://arxiv.org/abs/2508.21433))
  measured SWE-agent on all 500 SWE-bench Verified tasks. Dropping old
  tool output cut the mean cost per task by 50 to 57 percent in four of
  five model setups (Qwen3-Coder 480B: $1.288 to $0.610, solve rate 53.3%
  to 54.8%). The fifth setup saved 10 percent. With Gemini 2.5 Flash in
  thinking mode, the solve rate fell 4 points. Figures recomputed from
  the released `bootstrapped_cis.csv`.
- **What AgentX does today.**
  - Every run of a job uses the chat `cron:<jobId>` (`src/crons/scheduler.ts:605`)
    and never sets `freshSession`. Each run therefore resumes the
    previous run's conversation.
  - That conversation is only dropped after 12 hours idle
    (`sessions.ts:67`), 40 runs (`sessions.ts:73`) or 180,000 tokens of
    context.
  - No job-level setting starts each run fresh, and there is no
    per-channel `staleMinutes`.
  - A job that runs every hour is just past a one-hour cache lifetime, so
    each run first writes the whole carried history to the cache again,
    at 2×, and then reads it on every later step.
  - Jobs that run less often than every 12 hours already start fresh.
- **Expected saving.** Not measured on a live node. As an illustration:
  a lean start of 30,000 tokens (#615) plus 5,000 tokens per run reaches
  180,000 tokens at about run 31. Across those runs, the average carried
  context is about 105,000 tokens, against 30,000 if each run starts
  fresh. That is about 3.5 times the input on every step of every run,
  for jobs that fire more often than every 12 hours.
- **How to measure it.** For free, from the node's own database. The
  query compares runs that resumed with runs that started fresh, job by
  job:

  ```sql
  -- sqlite3 .agentx/db.sqlite
  SELECT chat_id,
         COUNT(*) AS runs,
         SUM(resume_session_id IS NOT NULL) AS resumed,
         ROUND(AVG(CASE WHEN resume_session_id IS NULL
                   THEN input_tokens + cache_read_tokens + cache_create_tokens END)) AS fresh_in,
         ROUND(AVG(CASE WHEN resume_session_id IS NOT NULL
                   THEN input_tokens + cache_read_tokens + cache_create_tokens END)) AS resumed_in,
         ROUND(AVG(CASE WHEN resume_session_id IS NOT NULL
                   THEN cache_create_tokens END)) AS resumed_write
  FROM task_traces
  WHERE channel = 'cron' AND started_at >= (strftime('%s','now','-7 days') * 1000)
  GROUP BY chat_id ORDER BY runs DESC;
  ```

  `resumed_in / fresh_in` is the multiple each resumed run pays.
  `python3 bench/cache-gap-replay.py --from <day> --to <day>` gives the
  same per channel, split by the gap since the previous call.
- **Cost.** Small: a per-job `freshSession` setting (or a default for the
  `cron` channel) in `scheduler.ts`, plus the config schema and docs.
- **Risk.** A job whose prompt relies on what it said last time ("do not
  repeat yesterday's items") loses that memory. Such jobs should keep
  continuity, or read their own last result from the run files, which
  are already the source of truth for run status.

### 2. Monitor reviews every finished run with Opus, and nothing counts it

- **Source.** [FrugalGPT](https://arxiv.org/abs/2305.05176) (Chen, Zaharia,
  Zou, 2023): a cascade that asks a cheap model first matched the best
  single model "with up to 98% cost reduction". That is the best result,
  on one dataset of classification-style tasks; *not checked against the
  paper's tables*. [RouteLLM](https://arxiv.org/abs/2406.18665) (Ong et
  al., 2024): routing between a strong and a weak model "reduces costs by
  over 2 times in certain cases". The 85 percent often quoted is MT Bench
  only; *not checked against the tables*. Both make the same point: a
  review that rarely needs the top model should not always get it.
- **What AgentX does today.**
  - `SessionMonitor` queues a review for every finished run except
    successful cron runs, workflow steps and dashboard questions
    (`src/daemon/session-monitor.ts:221`).
  - Each review runs `claude -p --model opus` (`session-monitor.ts:104`,
    model from `AGENTX_MONITOR_MODEL`, default `opus`, `:171`) on
    evidence of up to 16,000 characters of prompt, 24,000 of reply and 60
    trace steps (`:227`).
  - The reply's usage is discarded (`:125-127`). `--no-session-persistence`
    keeps it out of Claude Code's session logs too. So this spend is in
    neither `agentx usage` nor the Cost page, and
    [docs/help/costs.md](../../docs/help/costs.md) says as much.
  - The pre-filter seat that could skip reviews is off by default.
- **Expected saving.** Not measured. The evidence cap is about 33,000
  tokens. At an assumed 10,000 tokens in and 1,500 out, one review costs
  about $0.07 on Opus 5.5 at list price. #636 counted 4,241 runs a week
  on one node. If about 3,000 of them are reviewed, that is roughly $200 a
  week, or plan quota on a subscription. It is invisible today, which is
  the point. Sonnet 5.5 costs half as much per token; Haiku 4.5, at $1 /
  $5 per million, costs a quarter.
- **How to measure it.**
  1. Count reviews per week:
     `SELECT status, COUNT(*) FROM session_reviews WHERE updated_at >= (strftime('%s','now','-7 days')*1000) GROUP BY status;`
  2. A finished review's `input` is cleared (`session-monitor.ts:245`).
     For its size, rebuild the evidence for 30 recent `task_id`s with
     `getTrace`, as `tick()` does, and count it with the free
     `count_tokens` API.
  3. For quality, run the same 30 inputs through `opus` and `sonnet`
     (about $1 to $2) and compare the actions each review proposes.
- **Cost.** The model switch already exists (`AGENTX_MONITOR_MODEL`).
  Recording the reviewer's usage from the JSON envelope the CLI already
  returns is a few lines.
- **Risk.** Weaker reviews on a cheaper model, which the 30-review
  comparison checks before anything changes.

### 3. API-key agents get a five-minute cache, and AgentX never asks for longer

- **Source.** The [prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
  - A 5-minute write costs 1.25× input; a 1-hour write costs 2×.
  - A read costs 0.1×, or 0.05× on Opus and Sonnet 5.5.
  - The default lifetime is five minutes, refreshed on each use.

  The Claude Code page [Which TTL each request
  gets](https://code.claude.com/docs/en/prompt-caching#which-ttl-each-request-gets)
  says the main conversation gets one hour on a subscription within plan
  usage, and five minutes "on usage credits, API key, or cloud provider".
  `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` asks for the hour. Subagents get five
  minutes even on a subscription unless `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`
  is set.
- **What AgentX does today.**
  - Neither variable is set anywhere in `src`. The only env var AgentX
    writes into workspace settings is `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
    (`src/agents/workspace-setup.ts:259`).
  - The resume gate (`resume-gate.ts`, `cacheTtlMinutes` 60) and the
    router (`routing.ts:74`) both assume a one-hour cache. That is wrong
    for any agent billed by API key or past its plan's limit.
- **Expected saving.** For those agents only: a turn that comes 5 to 60
  minutes after the previous one stops rewriting the whole conversation
  (for example 100,000 tokens at 1.25× becomes a read at 0.05×). Short
  bursts pay 2× instead of 1.25× on their writes. Which effect wins
  depends on the node's gaps, so measure before choosing.
- **How to measure it.**
  `python3 bench/cache-gap-replay.py --from <day> --to <day>` reads the
  logs' own usage. Its `1h writes` column shows which cache each channel
  already gets: 100 percent means the hour is in use, and this finding
  does not apply there. Its `ttl1h` column is the change if every write
  used the hour. A negative value means a saving.
- **Cost.** One environment variable in the agent's spawn environment,
  for API-key agents only.
- **Risk.** Low. Bursty sessions cost a little more, as the column shows.

### 4. A chat idle for hours is resumed in full

- **Source.** The same cost guide: "your first message after a break
  longer than the cache lifetime misses the cache and reprocesses your
  full context". Claude Code itself now "offers to resume from a summary"
  after a long break ([sessions](https://code.claude.com/docs/en/sessions#resume-from-a-summary)).
  [AgentDiet](https://arxiv.org/abs/2509.23586) (2025) reports that
  trimming an agent's past steps cut input tokens by 39.9 to 59.7 percent
  and total cost by 21.1 to 35.9 percent, at the same task success; *not
  checked against the paper's tables*.
- **What AgentX does today.** A conversation is resumed in full for up to
  12 hours of silence (`staleMinutes` 720, `sessions.ts:67`). The cost
  gate that would start fresh when that is clearly cheaper exists
  (`src/agents/resume-gate.ts`) but is `off` by default
  (`config.ts:1997`). It also prices reads at 0.1×, where the 5.5 models
  pay 0.05×. AgentX's own summariser (`src/agents/compaction.ts`) cannot
  reach its 50,000-character trigger: stored history is cut to 12,000
  characters on every add (`sessions.ts:57-58`). It also never shrinks
  what `--resume` replays.
- **Expected saving.** The `rotate` column of
  `bench/cache-gap-replay.py` prices it per gap bucket. It is an upper
  limit: it ignores what the next steps lose by not having the old
  context.
- **How to measure it on a node.** Set `session.resumeGate.mode` to
  `"shadow"` for a week. It only writes what it would do to the daemon
  log. Then compare those lines with the replay. That is a setting
  change, so it is the owner's call, and this spike did not make it.
- **Cost.** None to try: the gate and its settings are in place.
- **Risk.** Loss of continuity on a rotated chat. The rotation memo
  softens it, and the gate's `margin` of 1.5 asks for a clear saving.

### 5. Old tool output stays in long sessions

- **Source.** [The Complexity Trap](https://github.com/JetBrains-Research/the-complexity-trap),
  figures as in finding 1. Anthropic's [context management
  post](https://claude.com/blog/context-management) reports that context
  editing cut tokens by 84 percent in a 100-turn web search eval. That
  eval is internal and the model is not named. Its "39 percent" is a gain
  in task performance, not a token saving.
- **What AgentX does today.** ObservationPack shortens a large result when
  it arrives (`src/agents/observation-pack.ts`, off by default). Nothing
  removes old results later in a session; `clear_tool_uses` and
  `context_management` are not used. Long sessions are limited only by
  the 180,000-token and 40-turn rotation.
- **Expected saving.** Probably small for AgentX, which is why it ranks
  last. The papers' agents ran without a cached prefix, or the report
  does not say. With caching, a removed old result saves only its read
  price (0.05× on the 5.5 models) on each later step. Meanwhile every
  removal changes the prefix and forces one rewrite of everything after
  it. #636 flagged the same trade-off.
- **How to measure it.** `bench/observation-pack-replay.py` already gives
  the upper limit: the tokens later steps re-read.
- **Cost and risk.** Medium cost. It needs a Claude Code hook or engine
  support, plus a live trial. The risk is a model that needs an old
  result and has to fetch it again.

### Checked and already applied, or not applicable

- **Tool search** ([Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)):
  85 percent fewer tool-definition tokens. Its own example, 77K to 8.7K,
  is 88.7 percent. Claude Code turns it on by default
  ([MCP docs](https://code.claude.com/docs/en/mcp)), and lean sessions
  keep `ToolSearch` in any `--tools` list (`session-profile.ts:212-221`).
  Applied.
- **Programmatic tool calling** (37 percent, same post) and **code
  execution with MCP** ([150,000 to 2,000 tokens](https://www.anthropic.com/engineering/code-execution-with-mcp),
  a single illustration, not a benchmark). Both are API features for
  custom agents and not settings of the Claude Code CLI that AgentX
  drives. Not applicable today.
- **Model routing for agent turns** (RouteLLM, FrugalGPT): AgentX has a
  `task-tier` seat that can move a turn to a cheaper model
  (`routing.ts:120-186`). It is off with the other decision seats and
  was outside this spike. Monitor (finding 2) is the place where the same
  idea is cheapest to test.
- **Thinking effort**: AgentX never sets effort, so the CLI default
  applies. The [cost guide](https://code.claude.com/docs/en/costs#adjust-extended-thinking)
  advises lower effort for simple tasks but publishes no measured
  figure, so it is not ranked.
- **Anthropic's [multi-agent report](https://www.anthropic.com/engineering/multi-agent-research-system)**:
  agents use about 4 times the tokens of chat, and multi-agent setups
  about 15 times. Token use explains 80 percent of the performance
  variance on BrowseComp. That figure argues that tokens buy results,
  not for cutting them, so it is not used as a reason for any finding
  here.

## Recommendation

1. **Fix the price list first.** It is small, has no effect on agents,
   and every saving above is priced with it.
2. **Then test findings 1 and 2.** Both can be measured for free from
   `.agentx/db.sqlite` on a live node: the cron query above, and the
   review count plus 30 rebuilt inputs. Both changes are small and easy
   to reverse. Monitor's quality check costs about $1 to $2. Of the five
   findings, these two are the most likely to save the most, and neither
   needs a new mechanism.

Findings 3 and 4 come next, after one run of
`bench/cache-gap-replay.py` on a week of a node's session logs. That run
says, from the logs' own numbers, whether the node's cache is already the
one-hour one, and how much of its spend is rewrites after a pause.

## Check it worked

- `python3 bench/cache-gap-replay.py --from <day> --to <day>` prints two
  tables, by gap and by channel, on a machine with
  `~/.claude/projects/*/*.jsonl` session logs. `--json out.json` writes
  the raw numbers.
- Each "today" line above points at a file and line on `main` at
  `aee4db7`. Opening it shows the value quoted.

## If something is wrong

- If the replay shows `1h writes` at 100 percent and every `ttl1h` value
  is positive, the node already uses the one-hour cache. Finding 3 does
  not apply to it.
- If the replay prints only a header, the date window holds no session
  logs. Claude Code removes logs older than `cleanupPeriodDays` (30 by
  default), and AgentX's Monitor reviews are never written there.
- If the cron query shows `resumed` at 0 for every job, the jobs already
  start fresh (they run less often than every 12 hours). Finding 1 does
  not apply to that node.
