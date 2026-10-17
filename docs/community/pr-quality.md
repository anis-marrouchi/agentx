# PR quality report

Some changes are merged, then fixed again the same day. This weekly report counts how often that happens, so that each new check on pull requests can be judged by what it changes. It is the first step of [issue #987](https://github.com/anis-marrouchi/agentx/issues/987).

A *pull request* (PR) is a proposed change to the code. A *fix* here is a merged PR whose title starts with `fix`, such as `fix(calls): clear the waiting mark`.

## What the report shows

A GitHub Action builds the report every Monday for the seven days before. It compares that week with the *baseline*, the week of 9 to 16 October 2026, measured before any new check was switched on.

| Row | What it counts |
|---|---|
| Merged PRs | Every PR merged in the week. |
| Fixes, Fix share | Merged PRs whose title starts with `fix`, and their share of all merged PRs. |
| Fix share, agent PRs only | The same share among PRs written by an agent, without release PRs. |
| Fixes that cite an earlier PR | Fixes whose title or description mentions an earlier merged PR, such as `#979`. |
| Median gap | The middle time between that earlier PR's merge and the fix's merge. |
| Fixes within 24 h, per 100 merged | Fixes merged within a day of the PR they cite, per 100 merged PRs. |
| Fixes that mention a review | Fixes whose title or description says "review". |
| Fixes that change tests, UI files | Fixes that touch `test/`, or the dashboard, web and app folders. |
| Median issue→merge lead time | The middle time from opening an issue to merging the PR that closes it. |
| Where the fixes land | The folders the fixes change most, test files left out. |

Below the table, **Success criteria** says for each goal of #987 whether this week meets it: `yes`, `no`, or `–` when there is not enough data.

Model cost is never in the public report as an amount. The GitHub Action has no cost data, so that row shows "not measured". A maintainer can add it locally, as a percentage change only (see below).

## Read the report

1. In the browser, open the **Actions** tab of the repository.
2. Click **PR quality report** in the list of workflows.
3. Click the latest run. The report is on the run's summary page.
4. To keep the numbers, download the **pr-quality** file under **Artifacts**. It holds the same counts as JSON.

## Run it for another week

1. In the browser, open **Actions**, then **PR quality report**.
2. Click **Run workflow**.
3. Type the last day of the week you want in **to**, such as `2026-10-23`, or leave it empty for the week that ended yesterday.
4. Click **Run workflow** again and wait for the run to finish.

## Run it on your computer

Use this to add model cost. Your cost file stays on your computer, and the report prints only how much the cost per merged PR changed.

1. In a terminal, from the repo root, write your daily spend to a file outside the repo, such as `~/spend.json`, in this form: `{ "2026-10-09": 12.5, "2026-10-10": 9.8 }`.
2. Run: `GITHUB_TOKEN=<a read-only token> node scripts/pr-quality.mjs --cost-file ~/spend.json`
3. Add `--to 2026-10-23` to pick the week, and `--json report.json` to save the counts.

## Settings

All settings live in `contrib/pr-quality.json`.

| Setting | What it does |
|---|---|
| `enabled` | `false` switches the report off. The Action still runs and says so. |
| `scope` | `all` counts every merged PR, as the #987 baseline does. `agent` counts agent PRs only. |
| `base` | Count only PRs merged into this branch, such as `main`. `null` counts every branch. |
| `baseline` | The first and last day of the baseline week. |
| `windowDays` | How many days a report covers. |
| `agent` | How an agent PR is recognised: label prefixes, branch name prefixes, and text in the description. |
| `exclude` | Branch name prefixes left out of the agent-only count, such as release PRs. |
| `fix` | Title types and title patterns that make a PR a fix. |
| `reviewPattern` | The text that counts as mentioning a review. |
| `fastFixHours` | How soon a fix must follow to count as fast. |
| `testPaths`, `uiPaths` | The files that count as tests and as UI. |
| `hotspots` | Folder depth and how many folders to list. |
| `budgets` | The most cost (in percent) and lead time (in hours) may rise before a criterion fails. |

## Check it worked

1. In the browser, open **Actions**, then **PR quality report**.
2. Check that the latest run is green and ran on the last Monday.
3. Open the run. The summary starts with **PR quality:** and the dates of the week, and the **Baseline** column shows a fix share of 37% (30/81).

## If something is wrong

- **The run failed with HTTP 403 or 401.** The token could not read pull requests. Check that the workflow still has `pull-requests: read` and `issues: read` under `permissions`.
- **The summary says the report is switched off.** Someone set `enabled` to `false` in `contrib/pr-quality.json`. Set it back to `true` to switch it on.
- **The baseline is no longer 37%.** The settings changed what counts. Check `scope`, `base` and `fix` in `contrib/pr-quality.json`; the #987 numbers use `all`, `null` and `fix` titles.
- **The cost row says "not measured" on your computer.** The cost file has no day inside the week. Check the dates in the file.
