# See what keeps going wrong

When something goes wrong for you, it usually shows up in one of a few ways: you reopen a request, an agent closes your request without doing what you asked, or agents fail to hand work to each other. Until now these happened in different parts of AgentX and nobody counted them.

AgentX now records each of them as a **failure signal**: one line with what happened, which agent, which request or hand-off, and when. Recording a signal uses no AI model and costs nothing. This is the first step of letting AgentX improve itself: count first, then fix the few problems that keep coming back.

## What is counted

| Signal | When it is recorded |
|---|---|
| `owner_reopened` | You reopen a request an agent had closed, for example with a comment on its post in the Hub. |
| `owner_check_mismatch` | The [owner-words check](./open-requests.md#when-someone-else-closes-your-request-the-owner-words-check) found that a close did not do what you asked, and reopened it. |
| `request_stalled` | A request needs attention: its work failed, timed out, was cut off, or went quiet. |
| `handoff_refused` | An agent's hand-off to another agent was refused: the [hand-off budget](./ask-another-agent.md) was used up, the hand-off would have looped back, or a person's permissions did not allow it. |
| `delegation_failed` | A hand-off ended in an error, ran out of time, or was lost in a restart. |
| `callback_repeat_skipped` | A helper agent wrote its answer, then ended its run with the same answer again. The repeat was not passed on. |
| `same_work_waited` | The same request reached an agent twice while one of its runs was already on it, so the second waited. |
| `close_proof_missing` | A check closed a request while some of the things you asked for had no proof link (`requests.closeProof.mode` is `"warn"`). See [Proof for each thing you asked for](./open-requests.md#proof-for-each-thing-you-asked-for). |
| `job_stalled` | A run of agent work ended without saying whether the work is done, continuing, waiting or blocked, and gave no state when asked once. See [Say where the work stands when a run ends](./end-of-run-state.md). |

The same signal about the same request or hand-off within 10 minutes is counted once. Signals are kept for 90 days.

## What is counted for cost

Some runs cost far more tokens than the same work needs. A **token** is the unit AI models are billed in. AgentX records four **cost signals** the same way as failures, just after each run's reply is recorded, with no AI model call:

| Signal | When it is recorded |
|---|---|
| `job_cost_high` | A run of a workflow or a scheduled job used 3 times or more the usual tokens of its **job type**, and at least 50,000 tokens. A job type is one agent on one channel, for one workflow or one scheduled job. Chat runs are not judged: one chat channel mixes unrelated conversations, so their usual cost means little. "Usual" is the middle value of that job type's last 30 successful runs in 14 days; a job type needs 10 such runs first. |
| `start_no_cache_reuse` | A new conversation started by writing 20,000 tokens or more to the model's **cache** (the copy of the conversation's start the model can reuse for up to an hour at a lower price) and reading nothing from it, although the same agent finished a run on the same model less than 60 minutes before. |
| `context_rewrite` | A call inside a run wrote 80% or more of a context of at least 20,000 tokens to the cache again, instead of reading it. The first call of a new conversation has to write it, and so does the first call of a continued conversation whose previous run ended more than 60 minutes before (the cache has expired by then), so neither is counted. |
| `model_switch` | The agent changed model inside a run, or a continued conversation went on with another model than its previous run. A new model cannot reuse the cache. |

Each cost signal names the job type first, for example `job cron nightly-report: rewrite 60k of 61k`, so the same waste in the same job is one problem. A **helper agent** (a subagent the run starts) writes a fresh context on purpose to save tokens, so its calls are left out of the last three signals. They still count in `job_cost_high`, because they are paid.

`start_no_cache_reuse`, `context_rewrite` and the in-run part of `model_switch` need the per-call numbers that Claude Code reports. Agents on other runtimes get `job_cost_high`, and `model_switch` when a continued conversation changes model.

The limits (3 times, 50,000 tokens, 20,000 tokens, 80%, 60 minutes) are first guesses. They will be tuned after a week of real signals.

## See the counts

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run `agentx improve signals`. It shows the last 24 hours:
   - **By kind:** how many of each signal.
   - **By agent:** which agents they came from.
   - **Seen more than once:** the same problem, with the same words, more than once. These are the ones worth fixing first.
3. **Terminal:** to look further back, add `--since 7d` (or `48h`, `30m`, or a date such as `2026-11-01`).
4. **Terminal:** to list the lines of one kind, add `--kind <kind>`, for example `agentx improve signals --kind owner_reopened --since 7d`.
5. **Terminal:** for a script, add `--json`.
6. **Terminal:** to see every kind with its weight and what it means, run `agentx improve kinds`. Cost signals end with `(cost)`.

## Rank what keeps coming back

One failure is noise; the same failure again and again is worth fixing. Every night, the [retro sweep](./retro.md#let-it-run-every-night) groups the day's signals into problems and ranks them:

- Signals of the same kind, from the same agent, that say the same thing are one problem. Numbers, request ids and links are left out when comparing, so "timed out after 612s" and "timed out after 30s" count as the same problem. Requests you reopened are grouped by agent only, because your words differ each time.
- A problem is kept only when it came from at least 3 separate requests, hand-offs or runs.
- The worst comes first. Each signal counts by how much it tells about you: a request you reopened, or a close that did not do what you asked, counts 3; a request that stalled or a hand-off that failed counts 2; the rest count 1.
- Cost signals rank in the same list: `job_cost_high` counts 2, the other three count 1. A cost problem scores at most 8 in any ranking, however many signals it has, so token waste always ranks below 3 requests you reopened (3 x 3 = 9).

Ranking uses no AI model. When `improve.enabled` is on, one small AI call a day may merge problems that say the same thing in different words. It counts against `improve.dailyUsd` (see [settings](../reference/config-automation.md#improve)).

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run `agentx improve rank`. It lists the problems of the last 24 hours, worst first, with how many signals and separate requests each came from. Nothing is saved.
3. **Terminal:** to look at a longer stretch, add `--since 7d`.
4. **Terminal:** the nightly `agentx retro sweep --commit` saves the day's ranking. To save it by hand, run `agentx improve rank --commit`.

## Turn the worst problem into fix choices

When `improve.enabled` is on, the nightly `agentx retro sweep --commit` hands the worst problem of the day to a [retro](./retro.md). The retro reads the problem's signals and one run where it happened, and raises one decision card with up to four fixes. You pick one, or none; the agent the run belongs to builds the fix for review. Nothing changes until you pick.

The limits all hold in code:

- **Cards:** at most `improve.maxCardsPerDay` (default 1) from this pass in any 24 hours, and the retro's own limit of three retro cards a day counts them too.
- **Money:** each retro call is counted against `improve.dailyUsd`. A call that would go past it is not started.
- **One card per problem:** while a card about a problem is waiting, no new one is raised for it. A fix you turned down is not offered again for 30 days.

1. **Terminal:** go to the folder that holds `agentx.json` and run `agentx retro sweep`. Under the ranking, a line `→ would retro problem <key> with run <run>` shows what tonight would hand over. Nothing is raised.
2. **Settings:** to let it run, set `improve.enabled` to `true` (see [settings](../reference/config-automation.md#improve)).
3. **Browser:** the morning after the nightly sweep, open **Approvals**. The card's source line names the run, and its title says what keeps going wrong.

## Check that a picked fix held

A fix only counts if the problem comes back less often. For each fix you picked on one of these cards, AgentX compares the problem's signals in the 7 days after you picked it with the 7 days before. This uses no AI model.

- **Held:** fewer signals after than before.
- **Did not hold:** the same number or more. No separate card is raised about it. The next card about the same problem opens with a line naming the earlier card and both counts, so you see it next to the new choices.
- **Waiting:** the 7 days after the pick are not over yet.

A fix for a cost problem must pass two checks instead:

1. **Tokens per run went down** for the problem's job types: the middle value of the runs after the pick against the middle value of the runs before. The job types are found from every run behind the problem in the 7 days before the pick. Those flagged runs are left out of the before side, because they were picked for being costly; when every run before was flagged, all of them count.
2. **Your reopens did not go up** for that agent: requests you reopened plus closes that did not do what you asked. One more is allowed, or 25% more when there were 4 or more before, so a single reopen does not fail a fix that saved tokens.

If either fails, the fix did not hold, and the note on the next card says which one.

The count starts on the day you pick, not the day the fix is deployed. A slow deploy can only make a fix look worse, never better, so a fix marked held did lower the count.

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run `agentx improve held`. Each picked fix is listed with its card, the agent, the counts before and after, and `held`, `did not hold` or `waiting, N day(s) left`. A cost problem adds a line `cost problem: tokens per run …k before, …k after; owner reopens … before, … after`.
3. **Terminal:** the nightly `agentx retro sweep` prints the same verdict for each fix whose 7 days are over.

## How the stages fit

Counting is stage 1, ranking stage 2, the retro on the worst problem stage 3, and the check that a picked fix held stage 4. Only stages 3 and 2's merge use an AI model, and only when `improve.enabled` is on, within `improve.dailyUsd`.

## Check it worked

1. **Browser:** on the Hub, write a comment on a request that an agent closed. The request opens again.
2. **Terminal:** run `agentx improve signals --kind owner_reopened`. The request is listed with the agent and your comment.
3. **Terminal:** run `agentx improve signals --since 7d`. The totals by kind and by agent are shown, or `none in this window` on a quiet install.
4. **Terminal:** run `agentx improve rank --since 7d`. It prints `Recurring problems:` with a count, and a line `Merge call: not run (preview)`.
5. **Terminal:** run `agentx improve held`. It lists the fixes you picked, or `No fix picked on a self-improvement card yet.`
6. **Terminal:** run `agentx improve kinds`. The list ends with `job_cost_high`, `start_no_cache_reuse`, `context_rewrite` and `model_switch`, each marked `(cost)`.
7. **Terminal:** after a day of work, run `agentx improve signals --kind context_rewrite --since 24h`. Each line names the run and its job type, or `none in this window`.

## If something is wrong

- **`no agentx.json here`:** run the command from the install folder, the one that holds `agentx.json`.
- **Every count is zero:** signals are only recorded since this version. Check with `agentx --version`, then wait for some work to happen.
- **No hand-off signals appear:** hand-off signals are recorded by the running daemon. Restart it after updating so the new version records them.
- **No cost signals at all:** they are recorded by the running daemon, from this version on. Restart it after updating. `start_no_cache_reuse`, `context_rewrite` and `model_switch` need an agent on Claude Code.
- **`job_cost_high` never appears for a job:** its job type needs 10 successful runs in the last 14 days first. Workflow steps count as one job type only from this version on.
- **`--since must look like …`:** use a number with `d`, `h` or `m` (for example `7d`), or a date.
- **`Recurring problems: 0` but signals are counted:** no problem came from 3 separate requests yet. Look at a longer stretch with `--since 7d`, or lower `improve.minRefs`.
- **`Merge call: not run (daily budget: …)`:** the day's `improve.dailyUsd` is used up. It frees as the 24 hours roll on.
- **`Retro on the worst problem: not run (improve.enabled is off)`:** model calls are off. Set `improve.enabled` to `true` to allow them.
- **`✗ problem <key>: no finished run found for its references`:** the runs behind the problem are gone from the trace history or still running. It is tried again the next night.
- **`✗ problem <key>: no candidate fix points to a moment in the run`:** the retro's ideas could not be tied to the run, so no card was raised. The call was still counted against the budget.
