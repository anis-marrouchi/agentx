# See what keeps going wrong

When something goes wrong for you, it usually shows up in one of a few ways: you reopen a request, an agent closes your request without doing what you asked, or agents fail to hand work to each other. Until now these happened in different parts of AgentX and nobody counted them.

AgentX now records each of them as a **failure signal**: one line with what happened, which agent, which request or hand-off, and when. Recording a signal uses no AI model and costs nothing. This is the first step of letting AgentX improve itself: count first, then fix the few problems that keep coming back.

## What is counted

| Signal | When it is recorded |
|---|---|
| `owner_reopened` | You send back a request an agent had closed: a comment on its closed post in the Hub, or a reply (or hand-off) when you are asked whether an agent's close as superseded stands. Your words are kept with it. A new message in a chat after a close starts a new request and is not counted. |
| `owner_check_mismatch` | The [owner-words check](./open-requests.md#when-someone-else-closes-your-request-the-owner-words-check) found that a close did not do what you asked, and reopened it. |
| `request_stalled` | A request needs attention: its work failed, timed out, was cut off, or went quiet. |
| `handoff_refused` | An agent's hand-off to another agent was refused: the [hand-off budget](./ask-another-agent.md) was used up, the hand-off would have looped back, or a person's permissions did not allow it. It is also recorded when the receiving agent was blocked by missing information (see [below](#what-is-counted-when-an-agent-did-not-know-or-was-not-clear)). |
| `delegation_failed` | A hand-off ended in an error, ran out of time, or was lost in a restart. |
| `callback_repeat_skipped` | A helper agent wrote its answer, then ended its run with the same answer again. The repeat was not passed on. |
| `same_work_waited` | The same request reached an agent twice while one of its runs was already on it, so the second waited. |
| `close_proof_missing` | A check closed a request while some of the things you asked for had no proof link (`requests.closeProof.mode` is `"warn"`). See [Proof for each thing you asked for](./open-requests.md#proof-for-each-thing-you-asked-for). |
| `job_stalled` | A run of agent work ended without saying whether the work is done, continuing, waiting or blocked, and gave no state when asked once. See [Say where the work stands when a run ends](./end-of-run-state.md). |

The same signal about the same request or hand-off within 10 minutes is counted once. Signals are kept for 90 days.

## What is counted for cost

Some runs cost far more tokens than the same work needs. A **token** is the unit AI models are billed in. AgentX records five **cost signals** the same way as failures, just after each run's reply is recorded, with no AI model call:

| Signal | When it is recorded |
|---|---|
| `job_cost_high` | A run of a workflow or a scheduled job used 3 times or more the usual tokens of its **job type**, and at least 50,000 tokens. A job type is one agent on one channel, for one workflow or one scheduled job. Chat runs are not judged: one chat channel mixes unrelated conversations, so their usual cost means little. "Usual" is the middle value of that job type's last 30 successful runs in 14 days; a job type needs 10 such runs first. |
| `start_no_cache_reuse` | A new conversation started by writing 20,000 tokens or more to the model's **cache** (the copy of the conversation's start the model can reuse for up to an hour at a lower price) and reading nothing from it, although the same agent finished a run on the same model less than 60 minutes before. 60 minutes is AgentX's one cache lifetime, the same value as in [One model per session](/reference/config-agents#one-model-per-session). |
| `context_rewrite` | A call inside a run wrote 80% or more of a context of at least 20,000 tokens to the cache again, instead of reading it. The first call of a new conversation has to write it, and so does the first call of a continued conversation whose previous run ended more than 60 minutes before (the cache has expired by then), so neither is counted. |
| `model_switch` | The agent changed model inside a run, or a continued conversation went on with another model than its previous run. A new model cannot reuse the cache. |
| `start_over_budget` | A new conversation's first call read more than 64,000 tokens: what the agent was given before it read the task. That is far over the 15,000-token target, so it marks a start that grew by mistake. See [The size of a start](#the-size-of-a-start). |

Each cost signal names the job type first, for example `job cron nightly-report: rewrite 60k of 61k`, so the same waste in the same job is one problem. A **helper agent** (a subagent the run starts) writes a fresh context on purpose to save tokens, so its calls are left out of the last four signals. They still count in `job_cost_high`, because they are paid.

`start_no_cache_reuse`, `context_rewrite`, `start_over_budget` and the in-run part of `model_switch` need the per-call numbers that Claude Code reports. Agents on other runtimes get `job_cost_high`, and `model_switch` when a continued conversation changes model.

The limits (3 times, 50,000 tokens, 20,000 tokens, 80%, 60 minutes) are first guesses. They will be tuned after a week of real signals.

Cost signals are ranked with the others, but they never become one of an agent's fix rules (see [Give each agent up to 3 fix rules](#give-each-agent-up-to-3-fix-rules)).

### The size of a start

Every new conversation starts with what the agent is given before it reads the task: Claude Code's own instructions and tool list, the `CLAUDE.md` files, the skill list, the memory lists, and what AgentX adds. The model reads all of it again on every call of the run, so a large start is paid many times over.

AgentX writes the size of each new conversation's start next to the run, in the `start_tokens` column of the run's trace (`task_traces` in `.agentx/db.sqlite`). It is the first call's tokens: new input, plus what the call read from the cache, plus what it wrote to the cache. The target is 15,000 tokens. Most starts are above it today, so for now only a start over 64,000 tokens records a `start_over_budget` signal, for example `job telegram chat: fresh start 70k, budget 15k`. That catches a start that suddenly grew without flagging every chat. The line moves down to 15,000 once the start is trimmed. The signal only reports: the run goes on as usual. `start_tokens` is written for every new conversation, whatever its size.

`start_tokens` is empty (NULL) when nothing was measured: a conversation that was picked up again, an agent on another engine than Claude Code, or a run from before this version.

To read the sizes:

1. **Terminal:** run `agentx improve signals --kind start_over_budget --since 24h`. Each line names a run over 64,000 tokens, its job type and the size of its start, or the command prints `none in this window`.
2. **Terminal:** run `agentx trace show <task id>` for any new conversation of a Claude Code agent. A `start` line shows the size in tokens.
3. **Terminal:** for the range of sizes per agent over the last day, run:

   ```sh
   sqlite3 -readonly .agentx/db.sqlite "SELECT agent_id, channel, COUNT(*) AS starts, MIN(start_tokens), MAX(start_tokens) FROM task_traces WHERE start_tokens IS NOT NULL AND started_at >= (strftime('%s','now') - 86400) * 1000 GROUP BY agent_id, channel ORDER BY MAX(start_tokens) DESC"
   ```

   Each row is one agent on one channel, with its number of new conversations and their smallest and largest start.

Full sessions (chat channels) start well above 15,000 tokens today, because they load the global instructions and every user skill. Their target is about 20,000 until those instructions are split; that is a named exception on the issue that sets the budget, not a setting. Lean sessions are held to 15,000.

## What is counted when an agent did not know, or was not clear

Some problems are not failures of the work but of what an agent knew or said. An agent can start the same work twice, say it waits on a helper that already finished, or hand work over without what the helper needs. AgentX records five more signals for these. They are found from what AgentX already stores, with no AI model call, just after the reply is sent:

| Signal | When it is recorded | Recorded on |
|---|---|---|
| `duplicate_session` | The same request reached an agent twice. The second run waited 15 minutes for the first, then went ahead beside it, so the work runs twice. A chat with a person never waits, so it is not counted. | The agent |
| `stale_status_told` | A run ended saying it waits on another agent of this install, but that agent's last hand-off from it had already ended **done**. Its answer was already passed on, and its own run said `State: done`. A wait on a build, a person or a time is not checked. Claims that something is merged or live are not checked yet. | The agent that said it waits |
| `clarification_asked` | The agent that received a hand-off ended its run with a question back ("Which branch do you mean?"), with the state waiting or blocked, instead of starting. A question at the end of finished work ("Want me to also tag it?") is not counted. | The agent that sent the hand-off |
| `handoff_refused` (missing information) | The agent that received a hand-off ended blocked because something was missing, for example a link or an issue number. It is shown as `missing information -> <agent>: blocked`. | The agent that sent the hand-off |
| `a2a_extra_rounds` | A hand-off was only started after one or more questions back on the same work, between the same two agents, in the last 2 hours. The detail says how many rounds it took. | The agent that sent the hand-off |
| `owner_asked_subject` | You asked what a reply was about, in a short message (80 characters or fewer), at most 6 hours after the agent replied in that chat. If the agent had just asked you a question, "which one?" is your answer, not a complaint, so it is not counted. | The agent that replied |

A **hand-off** is one agent giving work to another. The hand-off signals are only recorded when both agents run on this install, and only for a hand-off AgentX tracks, with its own chat (`a2a:<sender>:<receiver>:dlg-…`). A message from an agent on another machine, or from a guest, is never counted against anyone.

**Not counted yet.** In this version, these stay silent:

- **Install with the end-of-run state off.** If `jobState` is off, nothing records `clarification_asked`, `handoff_refused` (missing information) or `a2a_extra_rounds`. These signals read the state the run ends with. See [Say where the work stands when a run ends](./end-of-run-state.md).
- **Direct messages between agents.** About 3 in 10 agent-to-agent runs are direct messages, sent and answered at once, with no tracked hand-off. Their chat is the sender's name or `a2a:<sender>:<receiver>`, without `dlg-…`, and none of them is counted.
- **A second round inside the same hand-off.** A round is only counted when the answer to a question back comes as a new hand-off. If the question and its answer stay inside the same hand-off's chat, the extra round is not counted.
- **Claims that something is merged or live.** `stale_status_told` only checks waits on another agent.
- **A wait while another hand-off is still out.** If the same two agents have any other hand-off still open or waiting from the last 24 hours, `stale_status_told` is not recorded. Even an older one counts, because the wait may be about that one.

The phrases for "what is this about" are fixed in the code, in English, French, Arabic and Tunisian, for example "what is this about", "c'est quoi ça", "chnowa hedha", "شنوة هذا" and "ما هذا". A one-word form such as "which one?" counts only when it is the whole message.

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

## Give each agent up to 3 fix rules

Some problems are about how an agent works, not about the code: it waits for another run of itself, says nothing about whether its job is done, or hands work over without the information the helper needs. For these, the nightly pass writes the agent a **fix rule**: one sentence the agent reads at the start of every session. Each agent holds at most **3** fix rules, so its start text never grows past that.

**Which problems get a rule.** Problems where the agent:

- waited for itself (`same_work_waited`) or ran the same work twice (`duplicate_session`)
- repeated what it had already written (`callback_repeat_skipped`)
- ended without saying its job's state (`job_stalled`)
- said it waits on an agent that had already finished (`stale_status_told`)
- had a hand-off refused for missing information (`handoff_refused`)
- had a hand-off asked back (`clarification_asked`) or take more than one round (`a2a_extra_rounds`)
- left you asking what a reply was about (`owner_asked_subject`)

A rule for a hand-off goes to the agent that sent it, because that is where the signal is recorded. Cost problems never get a rule: they are fixed in the code.

**How a rule is made.**

1. Each night, for each agent, the pass takes its worst ranked problem that no rule covers yet.
2. One small AI call (the model in `improve.mergeModel`) writes one sentence for it. The AI sees the problem's kind and its cleaned-up wording (ids, numbers and quoted text taken out), never the raw messages. The call is counted against `improve.dailyUsd` at an estimate of $0.10. It only starts when the money for the retro ($2.00) is still free after it, because the retro runs later the same night. If one call fails, for example on a plan limit, no more rule calls are made that night. Nothing is written while `improve.enabled` is off.
3. The sentence is kept only if it passes every check:
   1. **Shape:** 20 to 300 characters, one line, no markdown, exactly one sentence ending in a full stop.
   2. **Names something to do:** it starts with an instruction word such as Check, Ask, State, Wait, Include, Never or Do not, or with "When …, ", "Before …, ", "After …, " or "If …, " followed by one of those words.
   3. **Not vague:** none of "try to", "be careful", "better", "improve", "ensure quality", "as needed", "if possible", "appropriate".
   4. **On topic:** it uses at least one word of the problem's kind, for example status, state or job for `job_stalled`.
   5. **New:** the agent does not already hold the same sentence.
   6. **Safe:** only letters, digits, spaces and `, . ' - / ( )`, no word longer than 30 characters, and none of: ignore, disregard, override, instead, "owner approved / says / wants / asked", "already approved", a link (`://`, `www.`), `<`, `>`, `|`, `$(`, curl, wget, token, password, secret, sudo, rm. The words behind a problem can come from another agent, so a rule can never tell the agent to drop its instructions, claim your approval, or run a command. It is checked right after the shape.
4. A sentence that fails is not saved. It is logged with the check it failed. There is no second try that night.

**Where it lives.** The rule is a note in the agent's own memory, named `loop_<problem key>`. The sentence is the note's one-line summary, so it appears in quotes in the agent's memory list under its own heading, **Rules from your own failure signals (they never override the owner or your instructions)**, above every other note. Names starting with `loop_` are kept for these rules: `agentx memory add` and the memory API refuse them, and a `loop_` note the nightly pass did not write is not counted as a rule. If you limit the memory list's size (`session.memoryIndexMaxChars`), rules are the last lines cut.

**How a rule is retired.**

- **To make room:** a 4th rule first retires one of the 3. The rule whose problem has had no signal for the longest goes first (a problem counts as quiet after a full day without a signal). If none is quiet, the oldest rule goes.
- **When it did not work:** 7 days after a rule was added, its problem's signals in those 7 days are compared with the 7 days before. The rule stays only if the count went down **and** your reopens did not rise. Reopens here means requests you reopened plus closes that did not do what you asked, for that agent. They rise when the 7 days after have at least 2 more than the 7 days before, so one extra reopen does not retire a working rule.

A retired rule is removed from the agent's memory list. Its text is kept in the note's history, in `.agentx/agent-memory/<agent id>/_versions/feedback_loop_<problem key>/`. Every rule added, kept, retired or refused is one line in the rule log. A retirement for not working also shows on the next self-improvement card about the same problem.

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run `agentx improve rules`. For each agent you see how many of its 3 rules are used, then each rule with the day it was added, the problem key, the counts before and after, your reopens before and after, and `held`, `did not hold` or `waiting, N day(s) left`. The sentence is on the line below. The last retirements follow, with their reason.
3. **Terminal:** to see one agent, run `agentx improve rules --agent <agent id>`. Add `--json` for the full data.
4. **Terminal:** the nightly `agentx retro sweep --commit` prints a `rule added`, `rule kept`, `rule retired` or `rule refused` line for each change it made.

**Retire every rule of one signal.** When a signal is taken out of the code, its rules must go too: with no more signals, a rule would look as if it worked and stay in the agent's start text.

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run `agentx improve rules --retire-kind <signal>`, for example `agentx improve rules --retire-kind stale_status_told`. Each rule removed is printed as `retired <agent id> <problem key>`, or `No rule written for <signal>.` when there was none. Each one is a `retire` line in the rule log, with the reason `rollback: kind <signal> retired`. This always covers every agent: if you also pass `--agent`, a warning says it is ignored.

## How the stages fit

Counting is stage 1, ranking stage 2, the retro on the worst problem stage 3, and the check that a picked fix held stage 4. Fix rules run in the same nightly pass, after the ranking and before the retro. Only stage 3, stage 2's merge and the fix-rule sentence use an AI model, and only when `improve.enabled` is on, within `improve.dailyUsd`.

## Check it worked

1. **Browser:** on the Hub, write a comment on a request that an agent closed. The request opens again.
2. **Terminal:** run `agentx improve signals --kind owner_reopened`. The request is listed with the agent and your comment.
3. **Terminal:** run `agentx improve signals --since 7d`. The totals by kind and by agent are shown, or `none in this window` on a quiet install.
4. **Terminal:** run `agentx improve rank --since 7d`. It prints `Recurring problems:` with a count, and a line `Merge call: not run (preview)`.
5. **Terminal:** run `agentx improve held`. It lists the fixes you picked, or `No fix picked on a self-improvement card yet.`
6. **Terminal:** run `agentx improve kinds`. The cost kinds `job_cost_high`, `start_no_cache_reuse`, `context_rewrite`, `model_switch` and `start_over_budget` are each marked `(cost)`. The list ends with `duplicate_session`, `stale_status_told`, `a2a_extra_rounds`, `clarification_asked` and `owner_asked_subject`.
7. **Terminal:** after a day of work, run `agentx improve signals --kind context_rewrite --since 24h`. Each line names the run and its job type, or `none in this window`.
8. **Terminal:** run `agentx improve rules`. It lists each agent's rules, or `No fix rule written yet.` on an install where the nightly pass has not written one.
9. **Terminal:** run `agentx memory index --agent <agent id>` for an agent that has a rule. The rule sentence is listed in quotes under `## Rules from your own failure signals …`, before the other notes.
10. **Terminal:** after a few days of hand-offs, run `agentx improve signals --kind clarification_asked --since 7d`. Each line names the agent that sent the hand-off, the hand-off id and `<agent> asked back before starting`, or `none in this window`.
11. **Phone or chat:** a few minutes after an agent replies to you, write "what is this about?". Then, in the **terminal**, run `agentx improve signals --kind owner_asked_subject --since 1h`. The agent is listed with `the owner asked what the reply was about (<channel>)`.
12. **Terminal:** run `agentx improve rules --retire-kind owner_asked_subject`. It prints the rules it retired, or `No rule written for owner_asked_subject.`
13. **Terminal:** after a new conversation with a Claude Code agent, run `agentx trace list --agent <agent id>`, then `agentx trace show <task id>` for that run. A `start` line shows the size of its start. `agentx improve signals --kind start_over_budget --since 1h` lists it only when that size is over 64,000 tokens.

## If something is wrong

- **`no agentx.json here`:** run the command from the install folder, the one that holds `agentx.json`.
- **Every count is zero:** signals are only recorded since this version. Check with `agentx --version`, then wait for some work to happen.
- **No hand-off signals appear:** hand-off signals are recorded by the running daemon. Restart it after updating so the new version records them.
- **No cost signals at all:** they are recorded by the running daemon, from this version on. Restart it after updating. `start_no_cache_reuse`, `context_rewrite` and `model_switch` need an agent on Claude Code.
- **No `clarification_asked`, `handoff_refused` (missing information) or `a2a_extra_rounds` rows:** they need the end-of-run state to be on (`jobState`, see [Say where the work stands when a run ends](./end-of-run-state.md)). They also need both agents on this install, and a hand-off with its own chat (`a2a:<sender>:<receiver>:dlg-…`). A direct message between agents, without a tracked hand-off, is not counted.
- **No `stale_status_told` rows although an agent waited on a finished helper:** the helper's own run must end with `State: done — …` in its answer, and its answer must have been passed on before the waiting run started. A helper on another machine is not checked.
- **No `owner_asked_subject` row:** your message must be 80 characters or fewer and use one of the fixed phrases. The agent must have replied in the same chat in the last 6 hours, and must not have asked you a question that is still waiting.
- **No `start_over_budget` row and no `start` line for a run:** the run continued an earlier conversation, or the agent is not on Claude Code. Only a new Claude Code conversation is measured. Restart the daemon after updating.
- **`start_over_budget` rows appear:** a new conversation read more than 64,000 tokens before its task. Compare its `start` size with earlier runs of the same agent (`agentx trace show`): a jump points to something newly added to its start, such as a large `CLAUDE.md`, a new tool server or many new skills.
- **No `start_over_budget` row although starts are above 15,000:** expected for now. Only starts over 64,000 tokens are signalled until the start is trimmed. Read the sizes from `start_tokens` instead.
- **`unknown kind "…"` from `--retire-kind`:** use a name from `agentx improve kinds`.
- **`job_cost_high` never appears for a job:** its job type needs 10 successful runs in the last 14 days first. Workflow steps count as one job type only from this version on.
- **`--since must look like …`:** use a number with `d`, `h` or `m` (for example `7d`), or a date.
- **`Recurring problems: 0` but signals are counted:** no problem came from 3 separate requests yet. Look at a longer stretch with `--since 7d`, or lower `improve.minRefs`.
- **`Merge call: not run (daily budget: …)`:** the day's `improve.dailyUsd` is used up. It frees as the 24 hours roll on.
- **`Retro on the worst problem: not run (improve.enabled is off)`:** model calls are off. Set `improve.enabled` to `true` to allow them.
- **`✗ problem <key>: no finished run found for its references`:** the runs behind the problem are gone from the trace history or still running. It is tried again the next night.
- **`Fix rules: not run (improve.enabled is off)`:** model calls are off, so no rule is written or retired. Set `improve.enabled` to `true`.
- **`rule skipped: … daily budget: …`:** the day's `improve.dailyUsd` is used up, or what is left would not leave $2.00 for the retro. The rule is tried again the next night.
- **`rule skipped: a rule call already failed tonight`:** an earlier rule call failed (see the `rule failed` line). The other agents wait for the next night, so failures do not use up the retro's money.
- **`--name may not start with loop_`:** that name is kept for the nightly pass's rules. Pick another name.
- **`rule refused: … check N (…)`:** the AI's sentence failed check N in [Give each agent up to 3 fix rules](#give-each-agent-up-to-3-fix-rules). Nothing was saved and the call still counted against the budget. It is tried again the next night.
- **An agent never gets a rule:** only the problem kinds listed in that section get rules, and only after the problem was seen in 3 separate requests, hand-offs or runs. Check with `agentx improve rank --since 7d`.
- **A rule you want back was retired:** its text is in `.agentx/agent-memory/<agent id>/_versions/feedback_loop_<problem key>/`. To keep it for good, outside the budget of 3, add it as your own note: `agentx memory add --agent <agent id> --type feedback --name <a name not starting with loop_> --description "<the sentence>"`.
- **`✗ problem <key>: no candidate fix points to a moment in the run`:** the retro's ideas could not be tied to the run, so no card was raised. The call was still counted against the budget.
