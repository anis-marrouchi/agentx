# Stop a mistake from coming back

![A run struggles, you run agentx retro, a reviewer proposes up to four fixes tied to steps of the run, one card lists them in Approvals, you pick one, and the agent that ran the task builds it for you to review. A card nobody answers is discarded.](/diagrams/retro.svg)

Writing a lesson down doesn't always stop the same mistake from happening again. A *retro* (short for retrospective: looking back at what went wrong) turns one run that went badly into a change to the agents' setup: a check that fails, a script, a fix to a tool, or wider access to information.

A retro only proposes. It reads the run, suggests up to four fixes, and puts them on one *decision card* in [Approvals](../dashboard/approvals.md). Nothing changes until you pick one. If nobody answers, the card is discarded.

## What a retro looks at

A *run* is one task an agent worked on. AgentX keeps a record of each one, called a *trace*: the message, every tool the agent used, and how it ended. A retro reads the trace and, when there is one, the [Monitor](../dashboard/monitor.md) review of the same run.

A run counts as struggling when at least one of these is true:

| Sign | What it means |
|---|---|
| Failed | The run ended with an error or ran out of time |
| Cut off by a restart | The daemon restarted while the run was working |
| Slow | It took more than three times as long as the agent's usual successful run |
| Many tool calls | It made more than three times as many tool calls as usual |
| Friction | The Monitor review noted time lost to missing information |
| Delegation failed | A hand-off to another agent failed |
| Recurring | The same failure hit at least two sessions in the last 30 days |

"Usual" is the middle value of the agent's successful runs in the last 30 days, and needs at least five of them.

## Where each kind of fix goes

The reviewer must match each fix to what went wrong. A fix in the wrong place is dropped before the card is raised.

| What went wrong | Fix it with |
|---|---|
| A mistake a tool can detect | A guard rule (warn mode first), a hook, a CI check or a script. Never a note in `CLAUDE.md` |
| The agent searched too long | A pointer in the agent workspace's `CLAUDE.md`, a wiki entry or a runbook |
| A coding slip that review should catch | A rule in the standards the review agents read |
| Too much context loaded into the prompt | Trim a layer: skills, wiki catalog, patterns or memory |
| A tool call cost too much | Change the tool, or keep its output out of the prompt |
| The agent could not reach information | A token, mesh access or a log file |
| A problem the fleet can't see | A health watchdog or alert |

Every fix must also point to a moment in the run: a step number from the trace together with an exact quote from that step, or an exact quote from the run's error. A fix that can't is dropped.

## Run a retro

1. **Terminal:** go to the folder the daemon runs from, and find the run:
   ```sh
   agentx trace list --status error --since 24h
   ```
   Each line starts with the run's task id.
2. **Terminal:** preview the card without raising it:
   ```sh
   agentx retro <taskId> --dry-run
   ```
   It prints why the run counts as struggling, any fix it dropped and why, then the card.
3. **Terminal:** raise the card:
   ```sh
   agentx retro <taskId>
   ```
   It prints the card's key, such as `card:2026-01-05-service-left-stopped-after-a-deploy-ab12`.

The reviewer runs `claude -p` with no tools, so the Claude Code command must be installed on this computer. A retro takes a minute or two.

## Pick a fix

The card lists the fixes, most severe first, then **None of these**. The most severe fix is already picked. Below the fixes is a short description of each one; you can edit it before you answer.

1. **Browser:** open **Approvals** on the dashboard. Find the card, pick a fix, and change the text below it if you like.

   ![A retro card on the Approvals page: four choices with the recommended one picked, and the message the agent gets](/screenshots/approvals/choices.png)

2. **Browser:** click **Yes**.

Or from the phone app:

1. **Phone:** tap **Activity**, then **Choose…** on the card.
2. **Phone:** pick a fix, edit the message if you like, and tap **Choose**.

   <img src="/screenshots/mobile-app/activity-choice-sheet.png" alt="The phone app's choice sheet for a retro card" width="320">

Or in the terminal:

1. **Terminal:** run `agentx approvals approve <key> --choice 2`. Add `--text "…"` to change the message.

*Fictional demo data. No real agents, people or machines.*

Within a minute the agent that ran the task is told your pick, with the description of that one fix only. The description was written by the reviewer, so the agent is told to check it rather than follow it word for word. If you edited the message, the agent gets your text as your note. It builds the fix as a pull request, or as a guard rule in warn mode, so you review it a second time before anything is enforced. What it adds is tagged `retro:<taskId>`, so you can find it later. If you pick **None of these** (even with **Yes**) or answer **No**, the agent is told to change nothing.

## Limits on noise

- **One card per failure.** While a retro card about the same failure is waiting, `agentx retro` refuses to raise another.
- **No second asking.** A fix you passed over on an answered card is not offered again for the same failure for 30 days.
- **Never on its own runs.** The run in which an agent builds a picked fix is never read by a retro.
- **Never applied by silence.** Every retro card is discarded when it expires.
- **Separate from the agent's own cards.** Retro cards are counted apart from the cards an agent raises itself, so they never use up its room for its own questions.

`agentx retro` is started by hand for now. A nightly pass that picks the day's worst runs by itself, with a daily limit, is planned.

## Settings

A retro has no settings in `agentx.json`. These options and environment variables change how it runs:

| Option or variable | What it does |
|---|---|
| `--dry-run` | Print the card without raising it |
| `--force` | Raise a card even when the run shows no sign of struggling, or a card about the same failure is still waiting |
| `--model <model>` | The reviewer model |
| `--path <db>` | The trace database. Default: `.agentx/db.sqlite` |
| `AGENTX_RETRO_MODEL` | The reviewer model when `--model` is not given. Unset: `AGENTX_MONITOR_MODEL`, else `opus` |

Cards follow your usual [Approvals settings](../dashboard/approvals.md#settings), such as how long they wait. Retro cards can't be sent to another machine yet: when `approvals.forwardTo` is set, `agentx retro` refuses to raise the card. Run it on a machine that keeps its own cards, or use `--dry-run` to read the fixes.

## Check it worked

1. **Terminal:** run `agentx retro <taskId> --dry-run` on a run that failed. It lists at least one sign, such as `failed: the run ended error`, and prints a card that ends with **None of these**.
2. **Terminal:** run `agentx retro <taskId>`. It prints `✓ card:… raised for <agent>`.
3. **Browser:** open **Approvals**. The card is there with its fixes and **Expires in 3 days, then: discard**.
4. **Browser:** pick a fix and click **Yes**. The page says `<agent> will be told yes (<your pick>)`.
5. **Browser:** within a minute, the **Activity** tab shows a run for that agent on the `approvals` channel. That is the agent starting on the fix.

## If something is wrong

- **"shows no sign of struggling":** the run ended well and nothing in it looks unusual. Pick a run that failed, or add `--force` if you know it went badly.
- **"no candidate fix points to a moment in the run":** the reviewer's fixes were not tied to a step, or were in the wrong place, so they were dropped. The lines starting with `✗ dropped` say why. Try again later, or with `--model` set to a stronger model.
- **"already asks about this failure":** a retro card about the same failure is still waiting. Answer it first, or add `--force`.
- **"was itself started by a retro":** that run is an agent building a fix you picked. Retros never read those.
- **"the reviewer's answer could not be used":** the reviewer failed or returned something that isn't the expected answer. `claude CLI not found` means Claude Code is not installed for the user running the command. Run it again; if it keeps failing, run `claude -p "hello"` to check that Claude Code works.
- **"retro cards can't be forwarded to another machine yet":** this machine sends its cards to another one (`approvals.forwardTo`). Run the retro on a machine that keeps its own cards, or use `--dry-run` to read the fixes.
- **"No trace database":** run the command in the folder the daemon runs from, or pass `--path`.
- **Yes does nothing on the dashboard:** the card offers choices. Pick one first; the page says so in red.
- **The agent never started on the fix:** check the daemon log for a line starting `[approvals]`, and that `notifyAgent` is on in [Approvals settings](../dashboard/approvals.md#settings).
