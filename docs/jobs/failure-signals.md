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

## What comes next

Counting is stage 1 and ranking stage 2. The plan, in order, is to hand the worst problem each day to a [retro](./retro.md) (which proposes fixes on one decision card for you to pick), and then check that the picked fix lowered its count. Each stage runs on a fixed daily budget.

## Check it worked

1. **Browser:** on the Hub, write a comment on a request that an agent closed. The request opens again.
2. **Terminal:** run `agentx improve signals --kind owner_reopened`. The request is listed with the agent and your comment.
3. **Terminal:** run `agentx improve signals --since 7d`. The totals by kind and by agent are shown, or `none in this window` on a quiet install.
4. **Terminal:** run `agentx improve rank --since 7d`. It prints `Recurring problems:` with a count, and a line `Merge call: not run (preview)`.

## If something is wrong

- **`no agentx.json here`:** run the command from the install folder, the one that holds `agentx.json`.
- **Every count is zero:** signals are only recorded since this version. Check with `agentx --version`, then wait for some work to happen.
- **No hand-off signals appear:** hand-off signals are recorded by the running daemon. Restart it after updating so the new version records them.
- **`--since must look like …`:** use a number with `d`, `h` or `m` (for example `7d`), or a date.
- **`Recurring problems: 0` but signals are counted:** no problem came from 3 separate requests yet. Look at a longer stretch with `--since 7d`, or lower `improve.minRefs`.
- **`Merge call: not run (daily budget: …)`:** the day's `improve.dailyUsd` is used up. It frees as the 24 hours roll on.
