# Post a weekly quality report

AgentX can post a short quality report on a GitHub issue every Monday. A quality *gate* is an extra check a pull request must pass before it is merged, such as a second review. The report shows whether the gates you turned on make agent work better, and what they cost. After three weeks with the gates on, you decide for each gate whether to keep it, tune it or switch it off, and AgentX posts that decision on the same issue.

![Every Monday the daemon runs the report for last week, checks it holds no cost amounts and no names, and posts or edits one comment on the epic issue. A failure is logged and tried again hourly. After week 3 you decide keep, tune or switch-off per gate and post one verdict comment.](/diagrams/quality-report.svg)

The numbers come from `agentx quality report` (see [Measure code quality](../guides/quality-report.md)), run for that one week and compared with a saved *baseline*: a report from before the gates went on. It prints, for agent pull requests and for all pull requests except releases: how many merged, the share that fix an earlier one, fixes that land within 24 and 72 hours, the typical (median) time from issue to merge and the time 9 in 10 pull requests stay under, CI minutes, and the change in cost per pull request as a percentage. This page covers posting it.

## What the comment holds

- The week it covers (Monday to Sunday) and its week number, such as `2026-W42`.
- A table of the gates and how each one stood that week: on, turned on during the week (with the date), or off.
- The report's numbers, as a fixed-width table.
- When a week was missed, a line naming it, and whether the daemon was off or every try failed.
- After week 3 with the gates on, a line saying the verdict is due.

The issue is public, so the comment never carries cost amounts or names. Before posting, AgentX checks the text for an amount of money (such as `$12`), an email address or a GitHub name (such as `@someone`). If it finds one, it posts nothing and writes the reason to the daemon log.

Each week gets one comment. If the same week is posted again, AgentX edits that week's comment instead of adding another one. It finds the comment by a hidden tag, so this works even when its own records are lost.

## Turn it on

Turn it on on **one computer only**. Two daemons with it on would both run the report and edit the same comment.

1. **Terminal:** open the folder that holds `agentx.json` (the folder the daemon runs in).
2. Check that the GitHub command-line tool is signed in, because the report reads GitHub through it:

   ```sh
   gh auth status
   ```

3. Save the baseline once, for the days before the gates went on. Use your own dates, for example:

   ```sh
   agentx quality report --repo acme/widgets --since 2026-10-09 --until 2026-10-16 --save-baseline baseline
   ```

   Use the same repository you set as `repo` in step 5. Without `--repo`, the report reads the repository this folder was cloned from, which may be a different one.

   It prints the report and saves it in `.agentx/quality/baselines/baseline.json`. Every weekly report is compared with it, and the verdict quotes its fix share. Without it, every try fails with `No baseline "baseline"`.
4. Open `agentx.json` in a text editor.
5. Add a `qualityReport` section. Use your own repository and issue number:

   ```json
   "qualityReport": {
     "enabled": true,
     "repo": "acme/widgets",
     "issue": 42,
     "time": "08:00",
     "timezone": "Europe/Paris",
     "gates": [
       { "id": "review", "label": "Pre-merge review", "since": "2026-10-20" }
     ]
   }
   ```

6. Check that `channels.github` has a token that may comment on that repository (`token` or `tokenFile`), or that the daemon runs with `GITHUB_TOKEN` (or `GH_TOKEN`) set.
7. Save the file. The running daemon reads the change on its own.

Each time you turn a gate on or off, add or change its entry in `gates`: `since` is the day it went on, and `until` the day it went off. That way each week's comment says which gates were on, and changes in the numbers can be traced to a gate.

All the settings are in the [configuration reference](../reference/config-automation.md#qualityreport).

## When it posts

The report covers last week, Monday to Sunday. It is due on Monday at `time`. If the daemon was not running then, it posts as soon as it is back, any day that week.

Each Monday the daemon runs `agentx quality report --public --repo <repo> --since <Monday> --until <Sunday> --compare baseline` for last week (`<repo>` is `qualityReport.repo`), with the same AgentX install it runs from.

If the report fails (the report command errors, GitHub refuses the comment, or the text fails the public check), the daemon writes a line starting with `[quality]` to its log and tries again an hour later, until it succeeds. If a week is never posted, the next comment names it and says why: the daemon was off, or every try failed. The log says so too. You can post a missed week by hand (below).

## Post or preview a week by hand

1. **Terminal:** open the folder that holds `agentx.json`.
2. To see the comment without posting it, run:

   ```sh
   agentx quality weekly --dry-run
   ```

3. To post last week's report, run `agentx quality weekly`. To post another week, add `--week`, for example `agentx quality weekly --week 2026-W41`.

## Post the week-3 verdict

After three weeks with the gates on, the weekly comment says the verdict is due. The decision for each gate is yours.

1. **Browser:** read the latest weekly comment on the issue and compare the numbers with the goals set in the issue.
2. **Terminal:** open the folder that holds `agentx.json`.
3. Preview the verdict, with one `--gate` for every gate in `gates`. Each one is `<gate id>=keep`, `=tune` or `=switch-off`, with an optional reason after a colon:

   ```sh
   agentx quality verdict --dry-run \
     --gate "review=keep:same-day fixes down by a third" \
     --gate "ui-evidence=switch-off:slower merges, no fewer fixes"
   ```

4. Read the preview. It lists each gate's verdict, the goals (with the fix share from your baseline), and the numbers from the latest weekly report.
5. Run the same command without `--dry-run` to post it.
6. For each gate you switched off, turn its own setting off and add `until` to its entry in `gates`.

Running the verdict again edits the same comment.

## Check it worked

- On Monday after `time`, the issue has a new comment titled **Quality report, 2026-Wnn**.
- The daemon log has a line like `[quality] weekly report 2026-W42 posted: https://github.com/...`.
- Running `agentx quality weekly` again for the same week prints `updated:`, and the issue still has one comment for that week.
- After `agentx quality verdict`, the issue has one comment titled **Week-3 verdict per gate**.

## If something is wrong

- **No comment on Monday.** Search the daemon log for `[quality]`. Check that `qualityReport.enabled` is `true` and that `repo` and `issue` are set.
- **`FAILED … contains a cost amount`.** The report printed an amount of money. Make sure the report command runs with `--public`, and fix the report so it shows cost as a percentage change.
- **`FAILED … contains a name`.** The report printed a GitHub name or an email address. Remove it from the report.
- **`no GitHub token`.** Set `channels.github.token` or `tokenFile`, or set `GITHUB_TOKEN` for the daemon.
- **`GitHub POST … 403` or `404`.** The token may not comment on that repository, or the issue number is wrong.
- **`No baseline "baseline"`.** The baseline was not saved in the folder the daemon runs in. See step 3 of [Turn it on](#turn-it-on).
- **`gh auth login` or `not logged in`.** The report reads GitHub through `gh`. Run `gh auth login` as the user the daemon runs as.
- **`No report was posted for 2026-W41: the daemon was not running`.** You can post that week with `agentx quality weekly --week 2026-W41`.
- **`No report was posted for 2026-W41: every try failed`.** The reason is in the daemon log, on the lines starting `[quality] weekly report 2026-W41 FAILED`. Once it is fixed, post that week with `agentx quality weekly --week 2026-W41`.
- **`no verdict for: …`.** Every gate in `gates` needs one `--gate`. **`not a configured gate`**: check the id against `gates`.
- **`no baseline` from `agentx quality verdict`.** The verdict quotes the baseline's fix share, so it needs the baseline from step 3 of [Turn it on](#turn-it-on).
- **`no weekly report stored yet`.** The verdict cites the latest weekly report kept on this computer. Post one with `agentx quality weekly` first.
