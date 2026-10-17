# Measure code quality with the quality report

`agentx quality report` looks at the pull requests (PRs: proposed code changes) merged into your main branch and tells you, week by week and part by part of the code:

- how many PRs merged, and how many of them were fixes,
- how many fixes repaired something merged a day or three days earlier (a regression: something that used to work and broke),
- how long work took, from the issue being opened to the PR being merged,
- how many minutes of automated checks (CI: continuous integration) the PRs used,
- what the AI models cost per merged PR, from AgentX's own records.

Use it to see whether a change in how your agents work makes things better or worse. Save one report as a baseline, change something, and compare the next report with it.

## Before you start

- The [GitHub CLI](https://cli.github.com/) (`gh`) is installed and signed in. The report reads GitHub through it, with your own access. It only reads; it never changes anything on GitHub.
- For model cost, run the command in the folder where AgentX runs, so it can read AgentX's task records in `.agentx/db.sqlite`. Without them, cost shows as `unattributed`.

## Run a report

1. In a terminal, go to a checkout of the repository you want to measure.
2. Run `agentx quality report --since 2026-01-05 --until 2026-01-18`.
3. Read the three tables: **Total**, **Week of** and **Area**.

Leave out `--since` and `--until` to get the last three weeks up to today. If you run it outside a checkout, add `--repo your-org/your-repo`.

A three-week report takes under a minute. Most of the time goes to reading CI timings, one GitHub call per CI run. Those timings are kept in `.agentx/quality/ci-runs/`, so the next report is faster. Add `--no-ci` to skip CI minutes.

## What each column means

These definitions are exact: the numbers are counted this way, and two reports are only comparable because they are.

- **Release PR**: a PR made by release-please, the tool that publishes versions. Its title starts with `chore(main): release` (or `chore: release`), its branch starts with `release-please--`, or it has an `autorelease:` label. Release PRs are left out of every row. The report says how many it left out, and what the fix share would be with them counted.
- **Agent PR**: a merged PR that is not a release PR, and has an `agent:` label (such as `agent:coder`) or a branch name starting with `claude/`. The week and area rows count agent PRs. Add `--scope all` to count every non-release PR there instead. The **Total** table always shows both.
- **PRs**: merged PRs, by the day they merged, in UTC (world time, no time zone).
- **Fixes**: PRs whose title starts with the type `fix`, as in `fix: …`, `fix(scope): …` or `fix!: …`.
- **Fix share**: fixes divided by PRs.
- **Reg ≤24h** and **Reg ≤72h**: regression fixes. A regression fix is a fix whose title or description mentions `#N` (or a link to pull request N), where N is a PR that merged at most 72 hours before the fix merged. **Reg ≤72h** counts all of them; **Reg ≤24h** counts those within 24 hours, so it is part of the 72-hour number. A PR merged up to 72 hours before `--since` still counts as the PR being fixed. The number in brackets is the same count per 100 merged PRs in the row, so a busy week and a quiet week can be compared.
- **Fix review/tests/UI**: three counts among the fixes, split by `/`. The first counts fixes whose title or description mentions a review (any word starting with `review`, such as `reviewer`). The second counts fixes that change a test: a file under `test/`, a file named like `name.test.ts`, or a file in a `__fixtures__` folder. The third counts fixes that change a screen: a file under `src/daemon/ui/`, `src/web/` or `apps/`.
- **Area**: the folder directly under `src/` with the most changed files in the PR, such as `daemon` or `channels`. Files directly in `src/` count as `src`. A PR that changes nothing under `src/` is `other`. Ties go to the name first in alphabetical order. Only the first 100 changed files are read.
- **Lead issue p50/p90**: for PRs that close an issue (GitHub's "closing issues" link, such as `Closes #12`), the time from that issue being opened to the PR being merged. With several issues, the oldest one counts. p50 is the median (half the PRs were faster); p90 means 9 in 10 PRs were faster. Both use the nearest-rank method.
- **Lead PR p50/p90**: the same for PRs that close no issue, from the PR being opened to it being merged.
- **CI min**: the sum of job durations of `ci.yml` runs on the PR's commits, including re-runs. It is `—` with `--no-ci`.
- **Cost/PR**: the model cost of the AgentX tasks that built the PR, divided by the PRs that have a cost. A task built a PR when it pushed the PR's branch (with `git push` naming the branch, or a GitHub tool naming it) or opened the PR. A task that only read, mentioned or answered on a PR does not count. A task that built two PRs is split between them. Costs use the same prices as the [Costs](../help/costs.md) page.
- **matched**: the attribution rate: the share of PRs with a cost. When no PR in a row has one, the cell says `unattributed`, never `$0.00`.
- **external**: PRs written in a Claude cloud session (their description links to `claude.ai/code/session_…`) that AgentX did not build. They are billed outside AgentX, so they are counted apart and left out of the attribution rate.

Model cost only covers tasks recorded on the machine where you run the report. Point `--db` at another copy of `.agentx/db.sqlite` to read a different machine's records.

## Compare with a baseline

A baseline is a saved report you compare later reports with. It is kept in `.agentx/quality/baselines/` on your machine, which git ignores.

1. Run `agentx quality report --since 2026-01-05 --until 2026-01-18 --save-baseline before`.
2. Make the change you want to measure, and let it run for a while.
3. Run `agentx quality report --since 2026-01-19 --until 2026-02-01 --compare before`.
4. Read the **Compared with baseline** lines under the tables: the change in PRs, fix share (in percentage points), regression fixes (also per 100 PRs), median lead time, CI minutes and cost per PR (in %).

## Share a report in public

Cost amounts stay on your machine. To post a report somewhere others can read it, add `--public`. It shows cost only as a percentage change against the baseline you compare with, and leaves every amount out, in the text and in the JSON.

1. Run `agentx quality report --compare before --public`.
2. Copy the output where you want to share it.

Without `--compare`, a public report says `no baseline` in the cost column.

## Use the JSON output

Add `--json` to get the same report as JSON, for scripts and for posting week by week. The shape is stable: fields are only added. A rename or removal changes the `schema` value.

```json
{
  "schema": "agentx.quality-report/v1",
  "repo": "your-org/your-repo",
  "base": "main",
  "since": "2026-01-05",
  "until": "2026-01-18",
  "generatedAt": "2026-01-19T08:00:00.000Z",
  "scope": "agent",
  "public": false,
  "totals": { "agent": "Row", "all": "Row" },
  "weeks": ["Row plus \"week\": the Monday the week starts, YYYY-MM-DD"],
  "areas": ["Row plus \"area\": the area name"],
  "excluded": { "releasePrs": 12, "fixShareWithReleases": 0.31 },
  "comparison": "only with --compare, see below"
}
```

Each `Row` has these fields:

| Field | Meaning |
|---|---|
| `mergedPrs` | PRs in the row. |
| `fixes` | Fixes among them. |
| `fixShare` | `fixes / mergedPrs`, from 0 to 1. `null` when there are no PRs. |
| `regressionFixes24h`, `regressionFixes72h` | Regression fixes within 24 and 72 hours. |
| `regressionFixes24hPer100`, `regressionFixes72hPer100` | The same, per 100 merged PRs, rounded to one decimal. `null` when there are no PRs. |
| `fixesMentioningReview`, `fixesTouchingTests`, `fixesTouchingUi` | Fixes that mention a review, change a test, or change a screen. |
| `leadTime.issue`, `leadTime.pr` | Each `{ "n", "medianHours", "p90Hours" }`. Hours are `null` when `n` is 0. |
| `ciMinutes` | CI minutes, or `null` with `--no-ci`. |
| `cost.perMergedPr`, `cost.total` | Dollars. `null` when nothing matched. Left out with `--public`. |
| `cost.attributedPrs` | PRs with a cost. |
| `cost.externalPrs` | Cloud-session PRs with no AgentX cost. |
| `cost.attributionRate` | `attributedPrs / (mergedPrs - externalPrs)`, from 0 to 1, or `null`. |
| `cost.status` | `attributed`, `unattributed`, or `external` when every PR in the row is external. |
| `cost.changePct` | Change of `perMergedPr` against the baseline, in %. Only with `--compare` (and `null` in public output without it). |

With `--compare`, `comparison` holds `baseline`, `baselineSince`, `baselineUntil`, `totals.agent`, `totals.all` and `areas` (one entry per area found in both reports). Each entry has `mergedPrs`, `fixSharePts`, `regressionFixes24h`, `regressionFixes72h`, `regressionFixes24hPer100`, `regressionFixes72hPer100` (`null` against a baseline saved before these fields existed), `issueLeadMedianHours`, `prLeadMedianHours`, `ciMinutes`, `costPerMergedPrPct` and `attributionRatePts`: the current value minus the baseline value.

## All options

| Option | Default | What it does |
|---|---|---|
| `--since <date>` | 20 days before `--until` | First merge day, `YYYY-MM-DD`. |
| `--until <date>` | today (UTC) | Last merge day, `YYYY-MM-DD`. |
| `--repo <owner/name>` | the checkout's `origin` | The GitHub repository to read. |
| `--base <branch>` | `main` | The branch PRs merged into. |
| `--scope <scope>` | `agent` | Which PRs the week and area rows count: `agent` or `all`. |
| `--no-ci` | — | Skip CI minutes. |
| `--db <path>` | `.agentx/db.sqlite` | AgentX task records to read cost from. |
| `--public` | — | Show cost only as % change against `--compare`. |
| `--save-baseline <name>` | — | Save this report as a baseline. Letters, digits, `.`, `-` and `_`. |
| `--compare <name>` | — | Show changes against a saved baseline. |
| `--json` | — | Print JSON instead of tables. |

## Check it worked

1. In a terminal, run `agentx quality report --no-ci`.
2. Check the first line names your repository and the dates you expect.
3. Check the **Total** table shows a number of PRs above 0, unless nothing merged in those dates.
4. Run `agentx quality report --save-baseline test`, then `agentx quality report --compare test`, and check the **Compared with baseline** lines show `+0` changes.

## If something is wrong

- **`gh auth login` or "not logged in"**: the GitHub CLI is missing or signed out. Install it, then run `gh auth login` in a terminal.
- **"Could not tell which GitHub repository this is"**: you are outside a checkout, or its `origin` is not on GitHub. Add `--repo your-org/your-repo`.
- **Cost says `unattributed` everywhere**: the report found no AgentX task records, or no task pushed or opened these PRs. Run it from the folder AgentX runs in, or add `--db` with the path to `.agentx/db.sqlite`. PRs built by a Claude cloud session show as `external` instead.
- **It takes longer than a minute**: most of the time is CI timings. The next run is faster, because finished runs are remembered. Add `--no-ci` if you don't need CI minutes.
- **The numbers differ from a count by hand**: check the definitions above. Merge days are in UTC, release PRs are left out, and the rows count agent PRs unless you add `--scope all`.
- **"No baseline"**: save one first with `--save-baseline <name>`, in the same folder. Baselines live in `.agentx/quality/baselines/`.
