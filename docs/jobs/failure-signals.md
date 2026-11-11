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

The same signal about the same request or hand-off within 10 minutes is counted once. Signals are kept for 90 days.

## See the counts

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run `agentx improve signals`. It shows the last 24 hours:
   - **By kind:** how many of each signal.
   - **By agent:** which agents they came from.
   - **Seen more than once:** the same problem, with the same words, more than once. These are the ones worth fixing first.
3. **Terminal:** to look further back, add `--since 7d` (or `48h`, `30m`, or a date such as `2026-11-01`).
4. **Terminal:** to list the lines of one kind, add `--kind <kind>`, for example `agentx improve signals --kind owner_reopened --since 7d`.
5. **Terminal:** for a script, add `--json`.

## Rank what keeps coming back

One failure is noise; the same failure again and again is worth fixing. Every night, the [retro sweep](./retro.md#let-it-run-every-night) groups the day's signals into problems and ranks them:

- Signals of the same kind, from the same agent, that say the same thing are one problem. Numbers, request ids and links are left out when comparing, so "timed out after 612s" and "timed out after 30s" count as the same problem. Requests you reopened are grouped by agent only, because your words differ each time.
- A problem is kept only when it came from at least 3 separate requests, hand-offs or runs.
- The worst comes first. Each signal counts by how much it tells about you: a request you reopened, or a close that did not do what you asked, counts 3; a request that stalled or a hand-off that failed counts 2; the rest count 1.

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

The count starts on the day you pick, not the day the fix is deployed. A slow deploy can only make a fix look worse, never better, so a fix marked held did lower the count.

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run `agentx improve held`. Each picked fix is listed with its card, the agent, the counts before and after, and `held`, `did not hold` or `waiting, N day(s) left`.
3. **Terminal:** the nightly `agentx retro sweep` prints the same verdict for each fix whose 7 days are over.

## How the stages fit

Counting is stage 1, ranking stage 2, the retro on the worst problem stage 3, and the check that a picked fix held stage 4. Only stages 3 and 2's merge use an AI model, and only when `improve.enabled` is on, within `improve.dailyUsd`.

## Check it worked

1. **Browser:** on the Hub, write a comment on a request that an agent closed. The request opens again.
2. **Terminal:** run `agentx improve signals --kind owner_reopened`. The request is listed with the agent and your comment.
3. **Terminal:** run `agentx improve signals --since 7d`. The totals by kind and by agent are shown, or `none in this window` on a quiet install.
4. **Terminal:** run `agentx improve rank --since 7d`. It prints `Recurring problems:` with a count, and a line `Merge call: not run (preview)`.
5. **Terminal:** run `agentx improve held`. It lists the fixes you picked, or `No fix picked on a self-improvement card yet.`

## If something is wrong

- **`no agentx.json here`:** run the command from the install folder, the one that holds `agentx.json`.
- **Every count is zero:** signals are only recorded since this version. Check with `agentx --version`, then wait for some work to happen.
- **No hand-off signals appear:** hand-off signals are recorded by the running daemon. Restart it after updating so the new version records them.
- **`--since must look like …`:** use a number with `d`, `h` or `m` (for example `7d`), or a date.
- **`Recurring problems: 0` but signals are counted:** no problem came from 3 separate requests yet. Look at a longer stretch with `--since 7d`, or lower `improve.minRefs`.
- **`Merge call: not run (daily budget: …)`:** the day's `improve.dailyUsd` is used up. It frees as the 24 hours roll on.
- **`Retro on the worst problem: not run (improve.enabled is off)`:** model calls are off. Set `improve.enabled` to `true` to allow them.
- **`✗ problem <key>: no finished run found for its references`:** the runs behind the problem are gone from the trace history or still running. It is tried again the next night.
- **`✗ problem <key>: no candidate fix points to a moment in the run`:** the retro's ideas could not be tied to the run, so no card was raised. The call was still counted against the budget.
