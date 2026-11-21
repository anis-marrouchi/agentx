# Keep track of what you asked for

You give agents requests all day. Some need more than one answer: the agent hands the work to another agent, the task runs out of time, or the computer restarts in the middle. Open requests keeps a record of each of these until someone closes it, so nothing is forgotten without you knowing.

It is off until you turn it on.

## What it records

AgentX notes every message you send to an agent. Most leave nothing behind: the agent answers and that is the end. A request stays on your list when:

- the agent hands the work to another agent,
- the task fails or runs out of time,
- a restart cuts the task off,
- or the agent says it is taking the request on (agents have a tool for this, `agentx_request`).

Each request has one state:

| State | What it means |
|---|---|
| In progress | Work is going on. |
| Waiting on you | The agent asked you a question and needs your answer. The question is shown. |
| Waiting on another agent | The work was handed on and the answer is not back yet. |
| Needs attention | The work failed, ran out of time, was cut off and not picked up again, or nothing happened for a day. |
| Done, declined, dropped | Closed. Done has a link to the proof, or the words of the check that closed it. Declined and dropped have a reason. |

A request waits on you when the agent raises a [decision card](../dashboard/approvals.md) for it, or says so with its tool. The card reminds you the usual way: the Approvals inbox, the Mac card, check-ins and the daily digest. When you answer, the request goes on. If the card expires without your answer, the request needs attention; it does not close. A card never approves itself.

When a request needs attention you are told once, through your normal [notifications](./notifications.md). They are held while Focus is on. After that the request stays on the list. Nothing closes because it got old. One kind of failure is tried again for you first: see [Resend once after a limit or a restart](#resend-once-after-a-limit-or-a-restart).

### Jobs: all assigned work, not only yours

A request is work you asked for. Agents also get work from other agents, issue mentions, schedules and workflows. The Hub's **Jobs** page lists all of it, your requests included, each with one status line that says what it is doing now. See [Jobs](../dashboard/jobs.md).

## Turn it on

In the dashboard: on the [Hub](../dashboard/hub.md#choose-approvals-and-requests), open **Settings** › **Requests**, tick **Record and follow my requests** and select **Save**. Or from the terminal:

1. **Terminal:** go to the folder that holds `agentx.json`.
2. **Terminal:** run `agentx requests settings --enabled on`.
3. Messages you speak to the Mac, type in the phone app or type in the dashboard now count as yours. They count because this computer's own surfaces vouch for them: the daemon marks the turns it starts itself, and the dashboard shows the daemon a key it keeps in `.agentx/operator.key`, next to `agentx.json`, for the phone app. A program that merely names one of those surfaces when it calls the daemon is not you.
4. Every agent on this computer gets AgentX's own tool server in its workspace at the next daemon start, so it can say what it is doing with a request and close it. A workspace whose `.mcp.json` you wrote by hand is left alone.
5. To count your messages on Telegram, WhatsApp, Slack, Discord, GitLab or GitHub too, give your id on that channel: `agentx requests settings --from telegram:123456789,github:your-login`. On GitLab and GitHub it is your login, on Telegram your numeric id, on WhatsApp your number. Telegram usernames and display names are not accepted, because the person chooses them. Each entry is `channel:id` and only applies to that channel.

Other people's messages are never recorded.

## See what is open

1. **Terminal:** run `agentx requests`.
2. You see every open request, oldest first, with when and where you asked, the agent, your words and the state.
3. For one request and what is linked to it, run `agentx requests show <id>`.

In the dashboard, each request is a post on the [Hub](../dashboard/hub.md). Open a post to see the whole request. What it shows is described in the next section.

### What a request's card shows

Every place that shows you a request uses the same words: its post on the Hub, its line on the phone app's **Desk**, the Mac card popup, and the notification when it needs attention.

- **The headline:** a few plain words that say what the request is, for example "Check the invoices batch". The agent writes it when it takes the request on. When it did not, AgentX writes it once with one short model call (`requests.headlines`). Until then, or with that setting off, the title is the start of your own words.
- **Needed from you:** the one thing the request needs from you. When nothing is needed, it says "Nothing, just so you know.". A request waiting on your answer shows the question. A request that stopped asks you to hand it back or drop it.
- **The request:** your own words, in full, behind the headline. For a request you spoke, this is the transcript.
- Its state, the agent that has it, and why it is not finished.
- **Thread:** what happened, in order, ending with what the agent last told you.

![An open post on the Hub: its headline, where it stands, its plan, and the facts under it](/screenshots/wall/task.png)

A headline must say what the request is in words. One that is only a reference, such as "#412" or a link, is refused. A popup card whose title is only a reference is not shown, and its agent is told to describe the request.

## Decide on a request

Open the request's post on the [Hub](../dashboard/hub.md#act-on-a-post), one step each:

- **Comment:** write your reply in the box and select **Comment**. The agent that has the request gets your reply together with the request, within a minute, and goes on.
- **Hand to…:** pick an agent on the same machine. Pick the same agent to make it try again, or another one to give it the work. Text in the comment box goes along as a note. The request stays open until it is closed. Another agent does not answer in the chat where you first asked: that chat belongs to the first agent, and the new one may have no way to write there. Read its answer in the post's **Thread**. If it has a chat of its own with you, it may also write to you there.
- **Done:** closes it as finished. A link to the evidence in the comment box is optional when you close it yourself.
- **Drop:** closes one you no longer want. Text in the comment box is kept as the reason.

**Hand to…**, **Done** and **Drop** each ask you to confirm first. See [Close or hand off a request](../dashboard/hub.md#close-or-hand-off-a-request). A request that waits on you is also on **Needs you**, with a reply box and the same buttons.

Reply and hand-off need open requests turned on, because the daemon's check is what tells the agent.

You can also ask any agent "what is still open?". It reads the same list.

A request with several steps can be run as a workflow that AgentX follows to the end; the request then closes by itself when the workflow is done. See [Let a workflow follow a request](./follow-up-workflows.md).

## When a request needs attention

You are told once. On a Mac with the [card popup](../dashboard/approvals.md) on, the request then shows as a card that stays on screen like a decision card, when no decision card is waiting: **Hand it back**, **Drop** or **Not now**. It shows once, and only for a request that came to need attention in the last day. After that it waits in the [Approvals inbox](../dashboard/approvals.md#requests-that-are-not-finished) as a **Request**, and counts in the daily digest:

- **Yes** (or `agentx approvals approve request:<id>`) hands it back to the agent, which gets your request again and works on it. If the agent is still busy with the earlier attempt, your yes waits its turn and runs right after; the request stays in progress meanwhile. If the hand-back fails, it comes back.
- **No** (or `agentx approvals reject request:<id>`) drops it.
- **Later** puts it off.

## Resend once after a limit or a restart

Some requests stop for a reason a second try fixes: the agent hit its usage limit (the most it may use in a window of time), or the computer restarted while the agent worked. Such a request is sent back to its agent once, on its own, before you hear about it.

- **Usage limit:** it is sent again once the limit has reset, and at least 5 minutes after it stopped.
- **Restart:** it is sent again 5 minutes after it stopped. This covers work handed to another agent and lost in a restart, an answer a restart kept from reaching you, and work cut off by a restart that AgentX could not pick up again: it was too old, it had no way back in or nowhere to answer, or the attempt to pick it up failed. Work that AgentX chose not to pick up again is not resent, and you are told at once: work you stopped with a stop-all (it resumes from its plan), work another part of AgentX runs again, a computer restarting over and over, work already cut off once while being picked up, a workflow step, and work where picking up after a restart is turned off or set to report only.

The agent gets your request again, with a line saying why it comes back. While the resend waits, you are not told. You are told as before, once, when:

- the resent request stops again. The notice then says `Resent once at …, stopped again.`
- the limit has not reset after 12 hours.

Each request is resent at most once. These are never resent: promises, requests in a [tracked plan](./tracked-plans.md) (the plan follows its own steps), requests with a check of their own, and requests whose agent is not on this computer.

Turn it off with `agentx requests settings --auto-resend off`. Change the wait with `--resend-after <minutes>` and how long your notice waits with `--resend-hold-hours <n>`.

## Close a request

- **It is finished:** `agentx requests done <id> --evidence <link>`. The link is the proof: a pull request, an issue, a message, a deploy. On the Hub, put the link in the comment box and select **Done** on the post; the link is optional there.
- **You checked it yourself:** `agentx requests done <id> --reason "checked by hand"`. This also closes a request whose check cannot tell. The proof then reads `closed by owner: checked by hand`. On the Hub, write the reason in the comment box, then select **Done**.
- **You no longer want it:** `agentx requests drop <id>`. Add `--reason "…"` to say why.

Agents close their own requests as done or declined. When work an agent handed on comes back, it is reminded to close the request. Only you can drop one. An agent that runs `agentx requests drop` or `agentx requests done` from its own run is recorded as that agent, not as you, and its close is checked as described below.

### When handed-on work came back and nobody closed it

Agents often forget to close a request after the work they handed on comes back. Such a request used to come back to you as "Not finished", even though the work was done. Now the daily check closes it:

- It applies to a request that is in progress, has had no activity for `staleAfterHours` (default 24), and whose handed-on work **all** came back done.
- It is closed as **done**. Its proof is the first link in the other agent's answer, for example a pull request or a deploy page. Nothing opens that link to check it, so the request is marked `unverified`.
- With no link in the answer, it is **not** closed. It stays in progress, and the agent is woken once with "the hand-off came back with no proof: bring the link for each thing asked", and the list of what was asked when the request has one. If no link comes, it returns to you as quiet after `staleAfterHours`.
- Once you send a request back (a reply, a hand-off, **Pick it up again**), the work that came back before no longer counts. Only work handed on and done after that can close it. If none comes back, the request returns to you as before.
- You are not told. It simply leaves your list.
- A due time does not stop it. The agent sets that time itself, for example from its own estimate of how long the work takes. Once the work came back done, the request is not sent to you as "Past its due time"; it waits to be closed this way.
- A request already sent to you as "Past its due time" is closed the same way, once its handed-on work has been back for `staleAfterHours`.
- It does **not** apply to promises, to requests with a check, to tracked plans, to requests with a follow-up workflow, or when any handed-on work failed or is still out. Those still come back to you as before.
- Any other request that already needs attention is left as it is.
- It does **not** apply while the request still waits on you. A request marked as waiting on you is never closed this way. Once you answer, it goes back to work and can close after another `staleAfterHours` of quiet. The same goes for a request whose last reply asked you something with tap answers (quick replies, reply buttons or a poll), when none of those answers came back in that chat: it stays open and comes back to you once quiet.

The last rule is set by `requests.settleOwnerWait` in `agentx.json`. With `warn`, the default, such a request is left open and the daemon log notes it. `off` turns the check off.

To keep the old behaviour, run `agentx requests settings --settle off`.

### When someone else closes your request: the owner-words check

An agent can close your request in a way that does not do what you asked. It may do a smaller task, wait for something you never asked for (another person, a test, an approval you already gave), or decline it for a reason that goes against your words. The owner-words check reads every such close against your own words.

- **What is checked:** every close you did not make yourself. That includes an agent closing it as done or declined, a plan finishing, a promise or a check closing it, handed-on work settling it, and an agent running `agentx requests` from its own run. Your own closes (the Hub, the terminal, a card or a chat answer) are never checked.
- **How:** within a minute or two of the close, AgentX makes one short call to the model you set (Sonnet by default, through the provider you already use). It sends your words, your latest note on the request, how the request was closed, and every proof link the agent gave for each thing you asked for. The model answers **match**, **mismatch** or **unclear**.
- **When a check closed it:** the model is told what the check found (for example "the merge request is merged") and that the check proves only that one thing. The agent's own evidence and its proof links for the other things you asked for ("it is live") are sent beside it, so the request is not reopened for something the agent did prove. The agent's words are quoted and kept on one line, so they cannot pass for the check's result. The model is also told that the agent chose the check. The agent's reply after its `done` lists the proof links that were kept.
- **On a mismatch:** the request opens again as **needs attention**, with the reason starting `Closed without doing what you asked`. You are told once, like any request that needs attention. How it was closed stays in its record.
- **On a mismatch after a plan finished:** a plan of steps closes its request when its last step finishes. If that close is a mismatch, the agent that owns the request is also woken with a new run. The run gets your words and the reason, and is told to do what is still missing. Before, the request only showed **needs attention** and no agent was woken. To only be told, with no agent woken, set `"wakeOnPlanMismatch": false` beside `"enabled"`: see [Turn one of these wake-ups off](#turn-one-of-these-wake-ups-off).
- **On a mismatch after any other close:** an agent's own done, decline or drop wakes that agent; a check or a settle wakes the agent that owns the request. The run gets your words, the reason and each thing you asked for that still has no proof link. Your notice then says the next step is that agent's and nothing is needed from you. To only be told, set `"wakeOnMismatch": false` beside `"enabled"`.
- **On a mismatch after two reopens:** a request is reopened by this check at most twice. The next mismatch leaves the close as it is and you are told once, with the reason, so a close that keeps coming back the same way does not loop. Reopen it or ask again to have it done. Set `"maxReopens"` beside `"enabled"` to change the number.
- **On a match or unclear:** nothing happens. `agentx requests show <id>` shows the result.
- Closes older than 48 hours are not read. A call that fails is tried again at the next check; after three failures the close is marked unclear.

It is off by default. To turn it on, add this to `agentx.json` under `requests`, then restart AgentX:

```json
"ownerCheck": { "enabled": true }
```

The other settings are listed in [requests settings](/reference/config-automation#requests).

**Reopened once, not every check.** When the owner-words check reopens a request that a check closed (a `closeWhen` or its issue home), the same check result does not close it again. It can close again only when one of these happens:

- the agent gives a new proof link after the reopen (and after your last reply on it);
- the check itself says something different;
- you close it yourself.

Your reply alone gives the work back to the agent. It does not let the check close the request. Until one of the three happens, `agentx requests show <id>` shows the check as **held**, and you are told only once.

### Proof for each thing you asked for

A check on an issue's state ("closes when the issue is closed") says nothing about what you asked for. When you asked for several things ("confirm each stage: build, review, merge"), a check like that could close your request with no proof for any of them.

With `requests.closeProof.mode` set, a close by check needs one proof link for each thing you asked for:

1. AgentX reads your words once, with the owner-words check's model, and keeps a short numbered list of what you asked for. The agent sees it with `agentx_request list`. A request with a plan of steps needs no reading: its steps are the list, and each step's own link is its proof.
2. The agent gives one link per item as it goes: a note, a comment, a commit or a deploy that shows that item done. The request's own issue does not count.
3. When the check is met, AgentX looks for a link for each item. One item, or words it could not read, closes as before.

The mode decides what happens when items have no link:

| Mode | What happens |
|---|---|
| `off` (default) | Nothing changes. Links are still kept. |
| `warn` | The request closes. One log line and one `close_proof_missing` signal name the items with no link. |
| `block` | The request stays open. `agentx requests show <id>` says `proof_missing` and lists the items. The agent is told once. |

When the mode is not `off`, your words go to the model before any close, not only after one. To try it, add this to `agentx.json` under `requests`, then restart AgentX:

```json
"closeProof": { "mode": "warn" }
```

## Promises an agent makes

An agent often promises something to someone: "I will send the file by Friday", "I will deploy once the review is in". A **promise** is a request the agent opens itself, so the promise stays on your list until it is kept. It is the same kind of record as your own requests, and it shows in the same list.

The agent records it with its `agentx_request` tool, action `promise`:

| Field | What it holds |
|---|---|
| `owedTo` | Who it is owed to: `owner` (you), the id of another agent, or the id of a person in [people](./people.md). |
| `text` | What was promised, in one sentence. |
| `due` | Optional. When it is due, as a date such as `2030-01-31T17:00:00Z`. |
| `closeWhen` | Optional. What proves it is kept: a check, see below. |
| `home` | Optional. Where the work lives, see [Where a request landed](#where-a-request-landed). |

For example: `{action:"promise", owedTo:"client-a", text:"Send the signed contract", due:"2030-01-31T17:00:00Z"}`.

When one agent hands work to another, the hand-off itself is already followed. A promise is only for work that goes on after the answer: the agent that says "I will do it later" opens a promise owed to the agent that asked.

One agent can hold up to 200 open promises.

### A promise closes with proof, and leaves a fact

An agent's `done` on a promise needs a **proof**. One of four kinds:

| Kind | What the agent gives |
|---|---|
| Link | A link as the `evidence`, or `proof: {kind:"link", url}`: the pull request, the deploy page, the sent message. |
| Test | `proof: {kind:"test", passed, failed:0, command}`: a test run where every test passed. |
| Output | `proof: {kind:"output", text}`: what the work produced, such as the version a host reports. |
| Check | `proof: {kind:"check", value}`: a check that ran and what it found. A promise with a `closeWhen` check gets this one by itself. |

A `done` without one is refused, and the promise stays open. Your own requests still close on a link or on the agent's word, as before.

When a promise closes with a proof, the daemon writes a checked fact to the wiki's fact ledger: what was promised, `done: yes`, the proof as its source, and when the proof was made as its check date. The fact stays trusted for `factTtlDays` (7 days by default), then shows as stale. So "is the login fix deployed?" has a dated answer:

```bash
agentx wiki facts list
```

The request shows the fact's id, and `agentx wiki facts show <id>` shows the fact.

The same record follows the other things someone owes:

- **Plan steps.** A blocked step is told through the same check, in the plan's own words.
- **Follow-up waits.** When handed-on work ends to wait for something with a due time, the request waits on it and is due then. If the wait runs out, the request comes back to you like any other past its due time.
- **Decision cards** (off by default). With `promises.cards: true`, a card an agent raises outside a request is a promise you owe. It closes when you decide the card, with your answer as a fact, or is dropped when the card expires.

### Promises caught in a reply

Agents often end a turn with "I'll tell you when it is live" and never open a promise for it. With `requests.catchPromises.enabled: true`, the daemon reads the reply at the end of each of your turns, with one short model call, and decides between three things:

| The reply | What happens |
|---|---|
| **A firm promise**: the agent itself will do a named thing later, with no condition left on you ("I'll send the report at 18:00", "I'll tell you once it is live") | A promise of that agent, owed to you, due when the reply said. On a request that is already open, the request gets that due time instead. |
| **A question you must answer** before the work can go on ("Which account should I use?", "Say yes and I'll publish it") | The request waits on you, with the question. When you write to that agent again in the same chat, the wait ends. |
| **Anything else**: a report of finished work, an offer ("Want me to…?"), something another agent will do | Nothing changes. |

A word match is not enough: about half of all replies contain "I'll" or "will", and most of them are offers or conditions. So the model decides, and a promise also needs the reply's own sentence that makes it, in the first person and the future, with no "if". The word check only skips replies with no future and no question, without a call.

It is on by default wherever requests are on (`requests.enabled: true`). Without it, a reply that asks you a question leaves its request in progress, and the settle step can later close it as done. It spends one short model call on most of your turns; `dailyCap` (300 by default) bounds the calls a day. On one node, a day of real use took about 80 calls. To turn it off, or back on:

```bash
agentx requests settings --catch off
agentx requests settings --catch on
```

To see how well the model reads replies on your own data, label a set of real replies and run `pnpm bench:catch <labelled.jsonl>`. See [bench/README.md](https://github.com/anis-marrouchi/agentx/blob/main/bench/README.md).

### Due times an agent writes: the due-time check

An agent can write a due time in a reply or in a note on an issue, for example "Due 12:00, set by me", and record nothing for it. Then nothing wakes the agent when the time comes, and you find out by asking. The due-time check closes that gap. It uses a *decision seat* named `due-time`: a small typed question that a separate decision service answers with yes or no (see [Jev](/architecture/jev#what-is-a-decision-seat)).

At the end of each agent run, the seat reads the run's final reply and the notes the agent posted during the run. It answers two questions: does the text set a due time that this agent owes, and who owes it. What happens next depends on the seat's mode:

| Mode | What happens |
|---|---|
| `off` (the default) | Nothing. |
| `shadow` | One row is recorded for each finished run, with what the check would have done. Nothing else changes. |
| `active` | When the seat says yes and the agent recorded nothing with a time in that run, the agent is asked once, in the same session, to record it. |

In `active` mode, these count as a record made in the run: a promise or a request with a due time, a job state with a time (`continue` or `waiting … until`), a plan step told to wait until a time, or a schedule the agent made. The question asks the agent to open a promise with `agentx_request` (`due` and `closeWhen`), or to answer `Due: none`. If it does neither, the run's request moves to **needs attention** with a reason starting `Set a due time and recorded none`, and you are told once. A run with no open request gets a promise of its own, raised the same way.

The seat only answers yes or no. AgentX does not read a time out of the agent's text: the time comes from the record the agent makes.

To turn it on:

1. Set up the decision service by following [Enable observation before changing behavior](/architecture/jev#enable-observation-before-changing-behavior).
2. Add the seat in shadow mode. Merge this into `agentx.json`; it isn't a complete file:
   ```json
   {
     "decisions": {
       "enabled": true,
       "seats": { "due-time": { "mode": "shadow" } }
     }
   }
   ```
3. **Terminal:** restart AgentX:
   ```bash
   agentx daemon restart
   ```
4. Leave it in shadow mode for three days.
5. **Terminal:** read what it recorded:
   ```bash
   agentx decisions stats --since 3d
   agentx decisions calls --seat due-time --since 3d
   ```
6. When its answers match what the agents really wrote, change `"mode": "shadow"` to `"mode": "active"` and restart AgentX again.

Two more things now happen without the seat, wherever requests are on:

- **A due time an agent accepts wakes it.** When an agent accepts your request with a due time (`agentx_request` with `action: "accept"` and `due`), AgentX starts a run of that agent at that time, as it already does for a promise.
- **A promise that falls due is pushed the same minute.** The requests check wakes the agent that owes it, even when no wake-up was set for it, and tells whoever waits on it: you get **Promise not kept**, and an agent that waits on it reads a `[Promise due]` line at the start of its next run. It no longer waits for a day of silence first.

#### Turn one of these wake-ups off

Each of the three wake-ups that came with the due-time check has its own switch. All three are on by default. You can turn one off without going back to an older version.

| Setting in `agentx.json`, under `requests` | Default | When it is `false` |
|---|---|---|
| `promises.duePush` | `true` | A promise that falls due is not pushed: its agent is not woken by the requests check and whoever waits on it is not told. The promise comes back to you as **needs attention** once it is past its due time with nothing done on it since, or after the usual quiet time. A wake-up the promise already had still runs. |
| `promises.acceptWake` | `true` | A due time an agent accepts on your request is stored and shown, but no run is started at that time. |
| `ownerCheck.wakeOnPlanMismatch` | `true` | When the [owner-words check](#when-someone-else-closes-your-request-the-owner-words-check) reopens a request that a plan closed, you are told and no agent is woken. |
| `ownerCheck.wakeOnMismatch` | `true` | When the [owner-words check](#when-someone-else-closes-your-request-the-owner-words-check) reopens a request an agent, a check or a settle closed, you are told and no agent is woken. |

To turn one off:

1. Open `agentx.json` and find the `requests` block.
2. Add the setting. This example turns off the push for promises that fall due and keeps the other two:
   ```json
   "requests": {
     "enabled": true,
     "promises": { "duePush": false }
   }
   ```
3. **Terminal:** restart AgentX:
   ```bash
   agentx daemon restart
   ```

To turn it on again, set it to `true` or remove the line, then restart AgentX.

### Due times the daemon gives: the queue

An agent that picks its own due time ("I deliver at noon") is guessing. It cannot see the other work waiting for it, the work other agents and you will hand it, how many runs this computer can hold at once, or how long its work really takes. With this setting, the agent no longer picks the time. It says how long the work takes and how urgent it is, and AgentX answers with the due time.

Three words used below:

- **The queue:** every piece of open work on this computer that an agent still has to do. It is the same list as [Jobs](/dashboard/jobs). Work that waits on someone else, or is blocked, is not in it.
- **Priority:** `critical`, `high`, `normal` (the default) or `low`. Critical work goes first; then work you asked to make room for; then high, normal and low. Same priority: the older work first. Only your own requests can be critical: see [Who may set critical](#who-may-set-critical).
- **Correction factor:** how long an agent's work really took against the minutes it said, read from its own finished work of the last 30 days. Only work whose runs AgentX kept counts, and the time is the time those runs took: the hours between asking and closing hold nights and waits, so they are not used. A factor of 1.5 means its work takes half again as long as it says. With fewer than 3 such pieces of work, the factor is 1.

How the due time is worked out:

1. The agent sends `estimateMinutes` and `priority` with `promise` or `accept`, and no `due`.
2. AgentX multiplies the estimate by the agent's correction factor. With no estimate, it uses the agent's usual time for that kind of `work`, or 30 minutes.
3. AgentX puts every piece of open work in priority order, and runs it on this computer's capacity: how many runs it holds at once, and how many runs each agent holds at once (its `maxConcurrent`). Work running now goes first and counts only what is left of its estimate (never under 5 minutes). Work that waits for a wake later on starts no earlier than that wake. Open work nobody touched for longer than `requests.staleAfterHours` (24 hours by default), with no wake ahead of it, is left out. An estimate counts at most a week (10080 minutes).
4. The due time is when this work would end. The agent's reply says the time and what it came from: how many jobs of its own are ahead, their minutes, the priority, the estimate and the factor.

When you name the time yourself, your time comes first:

- The agent sends your time as `due`, with `dueSource: {kind: "requester", text: "<your words>"}`. A time set by an outside fact, such as a posting slot or a meeting, uses `kind: "fact"`.
- **It fits the queue:** it replaces the time AgentX would have given.
- **It does not fit:** nothing is accepted yet. The agent gets an answer at once with the earliest time that holds with nothing moved, and what would have to move to meet yours, for example `"Draft the report" moves from 10:00 to 10:30`. The agent asks you which you want. If you choose to move the other work, the agent sends your time again with `makeRoom: true`. If you take the later time, it sends that time.

When work goes ahead of other work (a critical job, or room you asked for), the due times AgentX gave behind it move later, by the time that work costs them. A move of less than 15 minutes is not made. Each person or agent waiting on moved work is told with the old time, the new time and the reason, at most once an hour for the same work: a second move within the hour is told in one later message, from the first old time to the latest. A wake armed for the old time moves with it, and its note gives the new time. A time you named, or one set by an outside fact, is never moved this way.

#### Who may set critical

Critical work goes ahead of every agent's work and moves their due times, so only you can make work critical. An agent keeps `priority: "critical"` only when it accepts a request you made: a message you sent it, recorded as one of your requests. An agent's own promise, or its accept of its own promise, cannot be critical:

- **`shadow`:** the agent gets the same reply as before. AgentX counts the work as `high`, and its row says `critical asked, lowered to high: not the owner's request`. The report counts it under `own critical`.
- **`on`:** the call is refused with `Not recorded: priority critical is only for the owner's requests…`. The agent sends it again with `priority: "high"`, and nobody else's due time moves.
- **`off`:** nothing changes.

There are three modes. Start with `shadow`:

| `requests.dueTimes.mode` | What happens |
|---|---|
| `off` (the default) | Nothing changes. |
| `shadow` | Nothing changes for the agents: they get the same replies as with `off`, and nothing is written but one row per promise or accept. That row holds the due time AgentX would have given next to the one the agent wrote, and whether `on` would have refused it, including fields the agent got wrong (an unknown `priority`, a `dueSource` that is not `{kind, text}`, an estimate over a week) and a `critical` it asked for on its own work. |
| `on` | A promise or accept with no `due` gets the time from the queue. A `due` with no `dueSource` is refused with: `Not recorded: you wrote a due time with no source. Register the work instead…`. A time you named that does not fit is answered at once, as above. An agent's own `critical` is refused (see [Who may set critical](#who-may-set-critical)). |

To turn it on:

1. Open `agentx.json` and find the `requests` block.
2. Add the setting in shadow mode. Merge this in; it isn't a complete file:
   ```json
   "requests": {
     "enabled": true,
     "dueTimes": { "mode": "shadow" }
   }
   ```
3. **Terminal:** restart AgentX:
   ```bash
   agentx daemon restart
   ```
4. Leave it in shadow mode for three days.
5. **Terminal:** read the report:
   ```bash
   agentx requests contract --since 3d
   ```
   The **Due times** table has one line per agent: its correction factor, how many promises and accepts were recorded, the middle difference in minutes between the time the agent wrote and the time AgentX would have given (`agent − daemon`), and how many calls the refusal would have stopped (`no source`, `does not fit`, `wrong fields`, and `own critical`: calls that asked for critical on work you did not ask for).
6. When the times AgentX gives look right, change `"mode": "shadow"` to `"mode": "on"` and restart AgentX again.

**Browser:** while the mode is `shadow` or `on`, the Hub's **Jobs** page shows a **Queue** block above the list: one line per agent, with its open jobs, their minutes of work, when the next one ends, when its queue is clear, and its correction factor when it is not 1.

Other settings, under `requests.dueTimes`:

| Setting | Default | What it does |
|---|---|---|
| `capacity` | `0` | Runs this computer holds at once. `0`: the admission queue's `maxSessions` when it is set, else 2. |
| `defaultEstimateMinutes` | `30` | Minutes counted for work with no estimate and no usual time. |
| `factorDays` | `30` | Days of finished work the correction factor is read from. |
| `factorMinRows` | `3` | Fewer finished pieces of work with an estimate than this: the factor is 1. |

What it does not do yet, to weigh before you switch to `on`:

- A step report on a plan (`action: "step"`) is not placed in the queue; a plan gets its due time once, at its accept.
- The budget an agent has left is not counted.
- Work that closes early does not bring the due times behind it forward.
- Work waiting on someone else is left out of the queue, not placed at the time it is expected back.
- A move told later (the once-an-hour rule) goes out with the next promise or accept on this computer, not on a timer.
- Work that waits for a wake later on is placed after the work that is ready now, not between it.

## Close on evidence, not on a claim

A request or a promise can carry a **check**: what proves it is finished. The agent gives it as `closeWhen`, with `promise`, `accept` or `wait`. Then:

- The daemon runs the check every 10 minutes. When the check finds the evidence, the request closes as done by itself, with the check's own words as the proof.
- When the agent says `done`, the daemon runs the check first. If the check finds the work is not finished, the agent's done is refused. If the check cannot tell (the address is down, the forge refuses to answer), the request stays open and is marked **unverified**. Saying `done` again does not count as progress: the request still shows as stalled once it has been quiet too long.
- A request without a check closes on the agent's word, as before.
- You can always close it yourself, with a reason. See [Close a request](#close-a-request).

The checks:

| Kind | Fields | Finished when |
|---|---|---|
| `url` | `url`, `contains` (optional) | The address answers with success, and holds the text when `contains` is given. |
| `issue` | `provider` (`github` or `gitlab`), `ref`, `state` (optional), `notePattern` (optional) | The issue or merge request is in that state (default `closed`; a merged one counts as closed), or one of its comments contains the text `notePattern` (plain text, upper or lower case does not matter). Only comments written after the request was opened count, so a word that is already on the issue does not close it at once. `notePattern` must be at least 8 characters and not only digits (a number like `1959` is refused): use words the closing comment will hold, such as the request id. When a comment closes it, the evidence is that comment's link and its first 600 characters, so the owner-words check reads what was written. `ref` is `owner/repo#12`, `group/project!12` for a GitLab merge request, or the item's web address. |
| `git-ancestor` | `repo`, `commit`, `ref` (optional, default `HEAD`) | The commit is part of that branch in a local copy of the repository. `repo` is a name you set up in `requests.checkers.repos`; the agent never gives a folder. |
| `reply` | `channel`, `chatId`, `from` | The person `from` (an id from [people](./people.md)) wrote in that chat after the request was opened. |

For example: `closeWhen:{kind:"issue", provider:"github", ref:"example-org/app#12", state:"merged"}`.

The `issue` check reads through the GitHub and GitLab settings you already have (`channels.github`, `channels.gitlab`), or through `requests.checkers.github` and `requests.checkers.gitlab` when you set them. The `git-ancestor` check does not download anything: keep the local copy up to date yourself. For another computer, check the build it reports with a `url` check on its version address.

## When an issue's status is behind the work

An issue can say **Doing** or **Review** after its work has merged and gone live, or say **Done** before it is live. AgentX can catch this. Every 30 minutes it reads the merge requests merged in the last 7 days on the projects you list under `requests.statusDrift.projects`. It finds the issue each one closes, and compares that issue's status label with what happened:

| Drift | Means |
|---|---|
| merged, not in Review | The change merged, the issue still says To Do or Doing. |
| live, not Done | The change runs on every place listed under the project's `live`, and the issue is not Done. |
| Done, not live | The issue says Done (or is closed), and a change it names does not run there yet. |

A merge request closes an issue when its title or description says so with a closing word (`Closes #12`, `Fixes group/app#3`), or when its branch starts with the issue number (`12-fix-login`). A plain mention (`Part of #12`, `Refs #12`) is not a close, even when the branch carries that number. A step of a larger issue does not finish it. An issue reopened after the merge is not "live, not Done" because of that merge. Only a merge made after the reopen counts.

Each drift is told to you once, in one notice per check. By default nothing is written: the issue keeps its labels. With `write` on and the project in `writeProjects`, an issue whose work is live gets its Done label and a comment that quotes the merge and the running commit. That comment is marked as a status, so the GitHub channel never hands it to an agent or a cloud session. It is never closed. List only your own projects. A label change on a client's project can send the client an email.

To check by hand, run `agentx requests drift --project group/app`. It prints the drifts and changes nothing. Add `--live self` to compare with this computer's build, or a health address whose JSON holds `commit`.

## See what is stalled

A request is **stalled** when it is past its due time, or, without a due time, when nothing has happened for a day (`--stale-hours`). One that needs attention is stalled too. Stalled requests are grouped by what they wait on:

| Group | Means |
|---|---|
| Waiting on you | It waits for your answer, or for your decision because nothing is retrying it. |
| Waiting on an agent | The agent that has it, the agent of the current step of its plan, or the agent it is owed to. |
| Waiting on an outside person | A promise owed to a person who is not you. |

To see them:

1. **Terminal:** run `agentx requests --stalled`. Each group is listed with its requests and why each one is stalled. Add `--json` for a script.
2. **Browser:** on the [Hub](../dashboard/hub.md#filter), under **Status**, choose **Blocked**. Each post says **Waits on** with who it waits on (you, an agent or an outside person), for how long, and why. In the list, **Waits on** is a column.

An opened post also lists who a promise is owed to (**Promised to**), when it is due (**Due**), and what check closes it (**Closes when**), with what the check last said. A check that could not tell, or was not met, is shown in amber, with the reason.

A promise past its due time comes back to you once, like a request that needs attention, with the title **Promise not kept** and the group it waits on. This happens at the first requests check after the due time, and the agent that owes it is woken by the same check (see [Due times an agent writes](#due-times-an-agent-writes-the-due-time-check)).

## QA sign-off

Some work should be checked by a second agent before it counts, for example a QA agent that tests a change. A request can carry that check's result, called a **QA verdict**. There are three verdicts:

| Verdict | What it means |
|---|---|
| `block` | It must not ship as it is. The note says what is wrong. |
| `risk` | It can ship, but with a risk the note names. |
| `pass` | Signed off. |

It works in two parts:

1. The agent doing the work marks the request as needing QA. It passes `needsQa: true` with `accept`, `wait`, `promise` or `describe`, for example `{action:"accept", work:"code", estimateMinutes:30, needsQa:true}`.
2. The QA agent records its verdict with its own `agentx_request` tool, action `qa`, and the request's id: `{action:"qa", id:"req-…", verdict:"block", note:"The export fails on an empty list."}`. A `block` or `risk` needs a note. A `pass` does not.

Any agent on the computer can give a verdict, on an open request or on one that is already done. The verdict is kept with who gave it and when. Recording it does not tell anyone and does not count as progress on the work.

A request is **awaiting QA** while it is marked as needing QA and has no verdict since it was marked. After a fix for a `block`, the agent marks it again with `needsQa: true`, and the request waits for a new verdict. The earlier verdicts are kept and `agentx requests show <id>` lists them all. `needsQa: false` removes the mark.

Where you see it:

- On the request's post on the [Hub](../dashboard/hub.md#see-what-waits-on-qa): **Awaiting QA sign-off**, or **QA: BLOCK by …** with the time and the note. **Awaiting QA only** in its filters lists the ones still waiting.

  ![A post on the Hub with QA: BLOCK, who gave it, when and why](/screenshots/wall/qa.png)
- In the terminal: `agentx requests show <id>`, and `agentx requests --qa awaiting` for every request still waiting on QA, open or done. `--qa block`, `--qa risk` and `--qa pass` list the requests whose latest verdict is that one.
- From a script: `GET /requests?qa=awaiting` (see [Read the list from a script](#read-the-list-from-a-script)).

## Group requests under a goal

A **goal** is the larger aim a request serves, such as "Relaunch the shop" or "Monthly newsletter". Naming one lets you see, for each goal, how far along it is and what it cost so far. Goals are optional: a request without one works as before.

An agent names the goal when it takes the request on. It passes `goal` with `accept`: an `id` (a short name made of letters, digits and dashes) and a `title` in a few plain words. For example: `{action:"accept", work:"code", estimateMinutes:30, goal:{id:"shop-relaunch", title:"Relaunch the shop"}}`. A title alone also works; the id is made from it (`"Relaunch the shop"` becomes `relaunch-the-shop`). A title with no Latin letters or digits, such as one in Arabic, gets an id like `goal-3f9a0c12be`; the same title always gets the same id. Requests that give the same id share the goal. Only `accept` takes a goal; a later `accept` with another goal moves the request to it.

A plan made with `accept` and `steps` has the goal of its request. Each step's agent, and an agent you hand the request to, is told the goal's title when it is given the work, so it knows why the task exists.

To see a goal in the dashboard:

1. **Browser:** on the Hub, open a post that serves the goal.
2. **Browser:** select the goal's title next to **Goal**. The line above the posts shows the goal's title, a bar, how many of its requests are done, how many are open, and what they cost. The posts below are its requests, with the state of each.

![The Hub showing one goal: its progress bar, counts and cost above its posts](/screenshots/wall/goal.png)

How the numbers are counted:

| Number | What it counts |
|---|---|
| done | Requests of the goal closed as done. |
| open | Requests of the goal still open. |
| dropped | Requests declined or dropped. They count neither for nor against how far along it is. |
| % done | done ÷ (open + done). |
| cost | The cost of the runs of the goal's requests: your turns, the agent's resumed runs and pick-ups, and every plan step, including steps another agent runs. Each run counts as it reported its cost. Work an agent hands to another agent outside a plan (a delegation) is not counted yet, so for that kind of work the cost is a lower bound. Runs on an engine that reports no cost add nothing; the line then says how many runs had no cost. |

A closed request is kept for `retentionDays` (90 days by default). After that it leaves its goal's numbers too.

See [Follow one goal](../dashboard/hub.md#follow-one-goal). Agents can read the same list with `{action:"goals"}`. From a script, `GET /requests/goals` on the daemon gives it as JSON.

### A goal's own record

A goal is also a record of its own, so it can end, and so crons can point at it. The first `accept` that names a goal makes its record, with that agent as its owner. An agent can also make one before any request names it, and say what done means:

```
{action:"goal", goalAction:"create", goal:{id:"zero-issues", title:"AgentX has no open issues"},
 doneWhen:"0 open issues on anis-marrouchi/agentx",
 check:{kind:"count", provider:"github", project:"anis-marrouchi/agentx", what:"issues", max:0}}
```

A record has a state: **active**, **done** or **dropped**.

- With a `check`, the daemon runs it at the pace of the loop checks (every 10 minutes by default) and closes the goal as done when it is met. `check` is any `closeWhen` (`url`, `issue`, `git-ancestor`, `reply`), a `count`, as on a plan step, or a `number`: the newest reading of a [tracked number](./numbers.md#close-a-goal-on-a-number) crossing a threshold.
- Its owner closes it by hand with `{action:"goal", goalAction:"close", id:"zero-issues", evidence:"<link>"}`, or gives it up with `goalAction:"drop"` and a `reason`. Only the owner closes or drops it.
- `{action:"goal", id:"zero-issues"}` shows the record and its requests. `{action:"goals"}` gives each goal's state next to its counts.

A closed goal stays closed. Requests can still name it, but a new aim needs a new id.

Crons can serve a goal: see `crons.<id>.goal` in [Automation settings](../reference/config-automation.md). Once the goal is closed the cron stops running.

## Where a request landed

When an agent takes a request on, waits on you, or closes it as done, it can say where the work lives: its **home**. One of:

| Kind | Link |
|---|---|
| `issue` | the GitLab or GitHub issue URL |
| `idea` | the idea file, e.g. `ideas/home-tv.md` |
| `approval` | the decision card id |
| `erp` | the ERP record |
| `card` | the Desk card id |

The agent passes it with `agentx_request`, e.g. `{action:"accept", home:{kind:"issue", link:"https://…/issues/394"}}`. The request shows its latest home. Every `issue`, `idea`, `approval` and `erp` home is also kept as a link of the request, so a request that moved from an idea to an issue keeps both, and `agentx requests show <id>` lists them. Two requests can share a home; the link then stays with the first one, and the second keeps it as its home.

### What did I ask today

Run `agentx requests today`. It lists every request made since 00:00 Tunis time, one row each: the time, its first words, its state, the agent that owns it, and where it landed (issue, idea, approval, ERP record, Desk card, plan, or the evidence it closed with). Requests with nowhere to land are in red, at the top. A declined or dropped request is never red. `--json` gives the same list for the Desk and for voice.

### How many requests get closed: the flow rate

The flow rate says how many of the requests you asked in a day are closed. A request counts as closed when it is done, declined or dropped. Declined and dropped requests always carry a reason, and the reasons are listed beside the rate, so you can see whether a drop was right.

1. **Terminal:** run `agentx requests flow`.

It prints today's figure first, then one line per day for the last 7 days:

```text
Today (2030-03-02, Africa/Tunis): 17 of 38 closed, 45%.
  13 done, 4 dropped, 9 moving, 7 waiting on the owner, 5 stuck.
  Dropped because:
    3 × a retry of an earlier request
    1 × asked twice

Day         asked  done  dropped  moving  waiting  stuck  rate
2030-02-24     30    28        2       0        0      0  100%
…
```

| Word | Meaning |
|---|---|
| asked | Requests made that day. |
| done | Closed as done. |
| dropped | Declined or dropped, each with its reason. |
| moving | In progress, or waiting on another agent. |
| waiting | Waiting on you. |
| stuck | Needs attention. |
| rate | (done + dropped) ÷ asked. |

A request is counted on the day it was asked, and the counts are worked out again every time, so a request closed today moves the day it was asked. When some were [resent once](#resend-once-after-a-limit-or-a-restart), the figure also says how many, and how many of those are done.

- `--days 14` shows 14 days (up to 90).
- `--json` gives the same numbers for a script.
- Agents read it with `agentx_request` and `{action:"flow"}`, so you can ask an agent "what is our rate today?".
- The day starts at 00:00 in `requests.flow.timeZone` (default `Africa/Tunis`). Change it with `agentx requests settings --flow-zone Europe/Paris`.

### Read the list from a script

`GET /requests` on the daemon (loopback, or a mesh token) lists requests. Without filters it gives the open ones, oldest first, at most 100. Filters, all optional:

| Filter | What it does |
|---|---|
| `state=needs_attention,waiting_owner` | Only these states. Also `open`, `closed` and `all`. |
| `closed=1` | Open and closed alike, like `state=all`. |
| `since=<epoch ms>` | Made since then, open or closed, each with its links. |
| `closedSince=<epoch ms>` | Closed since then, whenever it was made. |
| `qa=awaiting` | Marked as needing QA, with no verdict yet. Also `qa=block`, `qa=risk` or `qa=pass`: the latest verdict is that one. Open and closed alike, unless `state` is given. See [QA sign-off](#qa-sign-off). |
| `links=1` | Each request with its links: runs, delegations, cards and homes. |
| `limit=<n>` | 1 to 500. Default 100. |
| `offset=<n>` | Page from the oldest; the reply gives `nextOffset` while there is more. |

Every reply says `total`, the number of requests that match, and `truncated: true` when it shows fewer. Without `offset`, a `since` list past its limit keeps the newest; any other list keeps the oldest.

`GET /requests/flow?days=7` gives the [flow rate](#how-many-requests-get-closed-the-flow-rate): `zone`, `days` (oldest first, each with `day`, `asked`, `done`, `dropped`, `moving`, `waiting`, `stuck`, `rate`, `dropReasons`, `resent` and `resentDone`), and `today`. `days` is 1 to 90; without it, `requests.flow.days` (default 7).

`GET /requests/goals` lists every goal a request names, most recently active first (at most 50): its `title`, the counts `open`, `done` and `dropped`, `progress` (0 to 1), `costUsd`, `runs`, `unpriced` (runs that reported no cost), and its newest requests (at most 50), each with its own `costUsd`. Its `records` are the goal records: `id`, `title`, `ownerAgent`, `state`, `doneWhen`, `check`, `evidence`, `lastCheck` and `lastCheckAt`. See [Group requests under a goal](#group-requests-under-a-goal).

`GET /requests/goals/<id>` gives one goal: its `goal` record (or null) and its `summary` (or null). `POST /requests/goals` makes, closes or drops a record (`action` `create`, `close` or `drop`), from a running turn of the agent it names, like the other writes.

## Measure what agents tell you

Agents often hand work to each other. The second agent may hand it on again. What they make, and where the work stopped, can stay inside those agent-to-agent chats, which you never see. AgentX can measure how much of it reaches you. It reads what it has already recorded, changes nothing and tells nobody.

To see it:

1. **Terminal:** go to the install folder, the one that holds `agentx.json`.
2. **Terminal:** run `agentx requests contract`. It reads the last 7 days.
3. Read the **Five numbers** block:

| Number | What it counts | Aim |
|---|---|---|
| Chain coverage | Turns in agent-to-agent chats that can be traced back to something you asked. Today, only the first agent asked is traced. The note says how many would be traced if every agent passed your request on. | 95 % or more |
| Delivery reach | Answers in your request's chain that name a link or a file, and that you were told about with a link within 10 minutes. | 90 % or more |
| Openable proof | Requests closed as done whose proof is a link you can open, not a file on the agent's computer, and not nothing. | 90 % or more |
| Quiet breaches | Open requests where nothing you can see changed for 2 hours. | 0 |
| Status pulls | Your own messages that ask where something stands ("what is … doing", "any update"). It is a word match, so the real number can be higher. | Going down |

Below them, **Per agent** lists each agent that talked to other agents. A line in amber marks an agent with 20 or more such turns that never told you anything.

To see what AgentX would write once these are fixed:

1. **Terminal:** run `agentx requests contract --dry-run`.
2. Read the three lists at the end:
   - **Step 1**: agent-to-agent chats that would be linked to your request.
   - **Step 2**: links and files that would be put on your request. A file is marked `path → served link`: it would become a link you can open.
   - **Step 3**: the status line each quiet request would get. It says when the agent last worked on it, what it waits on, and its last output. `would push` means it has been quiet long enough (6 hours by default) to be sent to your phone too.

| Flag | Default | What it does |
|---|---|---|
| `--since <span>` | `7d` | How far back to read, as `90m`, `36h` or `7d`. Up to `90d`. |
| `--agent <id>` | — | Only this agent's turns and requests. |
| `--deliver-within <minutes>` | `10` | How soon you must be told for an output to count as delivered. |
| `--rhythm <hours>` | `2` | How long an open request can stay unchanged before it counts as quiet. |
| `--push-after <hours>` | `6` | How long a quiet request waits before its status line would also be pushed. |
| `--dry-run` | — | Add the three lists above. |
| `--limit <n>` | `20` | How many rows each list shows. |
| `--json` | — | The same numbers for a script. |

## Requests of several steps

When a request takes two or more steps (build, deploy, check it is live, tell the client), the agent can write it as a plan. The daemon then follows each step, nudges a step that goes quiet, sends a message you approved once, and tells you at the end. See [Follow a request of several steps](./tracked-plans.md).

## Change the settings

| Command | What it does |
|---|---|
| `agentx requests settings` | Shows the settings. |
| `agentx requests settings --enabled off` | Stops recording. Open requests stay on the list. |
| `agentx requests settings --channels voice,app` | Records only on these channels. `all` goes back to every channel. A name that is not a channel a person writes on (a typo, say) is refused. |
| `agentx requests settings --from none` | Clears the list of who counts as you. |
| `agentx requests settings --stale-hours 48` | Hours without activity before a request comes back to you. Default 24. |
| `agentx requests settings --retention-days 30` | Days a closed request is kept. Default 90. |
| `agentx requests settings --headlines off` | Stops AgentX from writing a headline for a request its agent did not describe. Such a request is then titled with the start of your words. `on` turns it back on. Default on. |
| `agentx requests settings --settle off` | A quiet request whose handed-on work all came back done comes back to you instead of being closed. `on` turns closing back on. Default on. See [When handed-on work came back](#when-handed-on-work-came-back-and-nobody-closed-it). |
| `agentx requests settings --checks url,issue` | The checks agents may use to close a request. Default all four: `url`, `issue`, `git-ancestor`, `reply`. `none` turns them all off; a request whose check is off is then unverified. |
| `agentx requests settings --check-every 30` | Minutes between two runs of a request's check. Default 10. |
| `agentx requests settings --auto-resend off` | Stops sending a request stopped by a usage limit or a restart back to its agent once. `on` turns it back on. Default on. See [Resend once](#resend-once-after-a-limit-or-a-restart). |
| `agentx requests settings --resend-after 10` | Minutes after it stopped before such a request is resent. Default 5. |
| `agentx requests settings --resend-hold-hours 6` | Hours your notice waits for the resend before you are told anyway. Default 12. |
| `agentx requests settings --flow-zone Europe/Paris` | The time zone whose day the [flow rate](#how-many-requests-get-closed-the-flow-rate) counts by. Default `Africa/Tunis`. |

In the dashboard, the same settings are on the Hub, in **Settings** › **Requests**. The box **Write a headline when the agent gave none** is the `--headlines` switch:

1. **Browser:** on the Hub, select **Settings** in the nav, then **Requests**.
2. **Browser:** tick or untick **Write a headline when the agent gave none**.
3. **Browser:** select **Save**.

![Settings, the Requests section: open requests, plans and loop checks, with one Save](/screenshots/wall/settings-requests.png)

The engine and model used for the headline are set only in `agentx.json`, under `requests.headlines`.

The folders for the `git-ancestor` check are set only in `agentx.json`, as `requests.checkers.repos`: `{ "app": "/srv/app" }`.

The same settings are the `requests` block in `agentx.json`: see [Configuration: automation](../reference/config-automation.md#requests).

## Check it worked

1. **Terminal:** run `agentx requests settings`. The first line says `Requests on`.
2. Ask an agent, by voice or in the app, for something it must hand to another agent.
3. **Terminal:** run `agentx requests`. The request is listed as `waiting on another agent`, then `in progress` once the answer is back.
4. **Terminal:** run `agentx requests done <id> --evidence <link>`, then `agentx requests`. It is gone from the list.
5. **Terminal:** run `curl -s "http://127.0.0.1:18800/requests?since=$(( $(date +%s) * 1000 - 86400000 ))"`. The request is there, state `done`, with its `home` when the agent gave one.
6. Ask an agent to promise something with a check, for example: "promise me you will close issue example-org/app#12, and close it when the issue is closed".
7. **Terminal:** run `agentx requests show <id>`. It shows `Promised to owner` and `Closes when github example-org/app#12 is closed`.
8. Close the issue. Within 10 minutes, `agentx requests` no longer lists the promise, and `agentx requests show <id>` gives the check's words as the evidence.
9. **Terminal:** run `agentx requests --stalled`. It prints the stalled requests by group, or `nothing is stalled`.
10. **Terminal:** run `agentx requests today`. Each request you made since midnight is listed; the ones with no home are red, at the top.
11. **Terminal:** run `curl -s "http://127.0.0.1:18800/requests?state=needs_attention&links=1"`. Only the requests that need attention come back, each with its links.
12. Ask an agent, by voice, for something long and loosely worded. Within a few minutes, its post on the Hub is titled with a few plain words and shows **Needed from you**, and your words are behind the headline. `agentx requests show <id>` shows the same `headline`.
13. **Terminal:** run `agentx requests settings`. The line `Headlines` says `on: written when the agent gave none`, or `off` after `--headlines off`.
14. **Terminal:** in the same output, the line `Handed work came back` says `closed when quiet with its link; asks for one without`. A day after an agent hands work on and gets a done answer with a link, without closing the request, the daemon log has a `settled` line for it, and `agentx requests show <id>` shows it done, with the link as its evidence. Without a link, the log has a `not settled: handed work came back with no proof` line instead, and the request stays open.
15. Ask an agent to make a change and mark it as needing QA, then ask a second agent to check it and give its verdict.
16. **Terminal:** run `agentx requests --qa awaiting` before the verdict. The request is listed with `Awaiting QA`. After the verdict, run `agentx requests show <id>`. It shows `QA: PASS by <agent>, <time>` (or `BLOCK` or `RISK` with the note).
17. Ask an agent for some work and tell it the goal, for example: "this is for the shop relaunch goal".
18. **Browser:** on the Hub, open the request's post. **Goal** shows the goal's title. Select it: the line above the posts shows `0 of 1 done`.
19. **Terminal:** run `curl -s http://127.0.0.1:18800/requests/goals`. The goal is there, with its `open` and `done` counts and its `costUsd`.
20. **Terminal:** run `agentx requests contract --since 1d --dry-run`. It prints **Five numbers**, the three dry-run lists, and ends with `Read only: nothing was told or written.`
21. **Terminal:** run `agentx requests flow`. The first line gives today's date, the time zone, and how many of today's requests are closed. The table below it has one line per day.
22. **Terminal:** with the owner-words check on, ask an agent for something specific, then ask it to decline the request for an unrelated reason. Within two minutes, `agentx requests` lists it again as needing attention, with a reason starting `Closed without doing what you asked`.
23. **Terminal:** run `agentx requests settings`. The line `Resend once` says `on: after a usage limit resets or a restart, 5 minute(s) on; …`. After an agent stops on its usage limit, the daemon log has a `resent once` line for the request once the limit resets, and you are told nothing unless it stops again.
24. **Terminal:** with `requests.closeProof.mode` set to `"warn"`, ask an agent for three separate things on one issue, and give the request a check on the issue's state. Close the issue with no notes on it. The request closes, and `agentx improve signals` lists one `close_proof_missing` signal that names the three items.
25. **Terminal:** with the owner-words check on and the request above reopened, wait 30 minutes. The daemon log has one `owner-words check reopened it` line for the request and no second `closed by its check` line.
26. **Terminal:** with the `due-time` seat in shadow mode, let an agent finish a few runs, then run `agentx decisions stats --since 1d`. The `due-time` seat is listed in `shadow` mode with one call for each finished run.
27. **Terminal:** with the `due-time` seat in `active` mode, ask an agent to answer "I will post the review by 15:00" and record nothing. The daemon log has a `[due-time]` line ending in `asking once`, then one of `recorded when asked`, `said there is none when asked` or `nothing recorded when asked`.
28. **Terminal:** ask an agent to promise you something due in five minutes. Six minutes later, the daemon log has a `fell due` line for the promise that says the agent was woken, and you receive **Promise not kept** unless the agent kept it first.
29. **Terminal:** with the owner-words check on, let a plan of steps finish on a request it does not fulfil. Within two minutes, the daemon log has the line `its plan closed without doing what was asked; <agent> woken`.
30. **Terminal:** with `requests.promises.duePush` set to `false` and AgentX restarted, ask an agent to promise you something due in five minutes. Six minutes later, the daemon log has no `fell due` line for the promise.
31. **Terminal:** with `requests.dueTimes.mode` set to `"shadow"` and AgentX restarted, ask an agent to promise you something with a due time. The daemon log has a `[due-times] shadow` line for the promise that says `would give <time>`.
32. **Terminal:** run `agentx requests contract --since 1d`. It prints a **Due times** table with a line for that agent.
33. **Browser:** open the Hub's **Jobs** page. A **Queue** block shows one line for each agent with open work.
34. **Terminal:** with the mode set to `"on"`, ask an agent to accept a request with an estimate and no due time. Its reply gives a line starting `Due time given by the daemon:`, and `agentx requests show <id>` shows that due time.
35. **Terminal:** with the mode set to `"on"`, ask an agent to promise something of its own with `priority: "critical"`. The call is refused with `Not recorded: priority critical is only for the owner's requests`, and `agentx requests list` shows no new promise.

## If something is wrong

- **The flow rate counts a day differently from your clock:** the day starts at 00:00 in `requests.flow.timeZone`. Set yours with `agentx requests settings --flow-zone <zone>`, for example `Europe/Paris`.
- **`days must be a whole number from 1 to 90`:** pass `--days` (or `?days=`) between 1 and 90. Closed requests are deleted after `retentionDays`, so older days would be wrong anyway.
- **A request stopped by a usage limit was never resent:** the limit has not reset yet, or it was already resent once, or it is a promise or part of a tracked plan. `agentx requests show <id>` says why it stopped. After 12 hours you are told anyway.
- **You were told about a limit or a restart failure at once:** auto-resend is off (`agentx requests settings`), the agent is not on this computer, the request had already been resent once, or AgentX chose not to pick the work up again after the restart. The reason in brackets after `not picked up again` says which.

- **A request reopened with `Closed without doing what you asked`, but the close was right:** the owner-words check read it as a mismatch. Close it yourself (`agentx requests done <id> --reason "…"`); your own closes are never checked. If it happens often, set a stronger `requests.ownerCheck.model`.
- **A request with several items stays open with `proof_missing`:** `requests.closeProof.mode` is `"block"`. Ask the agent to give a link for each item it lists, or close the request yourself.
- **A request shows its check as `held`:** the owner-words check found that result did not match your words. Reply with what is missing, and the agent gives the proof links, or close it yourself.
- **The `due-time` seat records nothing:** check that `decisions.enabled` is `true`, that the seat is spelled `due-time` under `decisions.seats`, and that AgentX was restarted. Run `agentx decisions backends` to see that the decision service answers. A run that failed, or ended with an empty reply, is not read.
- **An agent is asked `[Due time]` when it set no due time:** the seat read the reply wrongly. The agent answers `Due: none` and nothing else happens. If it happens often, set the seat back to `shadow` and review its rows with `agentx decisions calls --seat due-time`.
- **A request needs attention with `Set a due time and recorded none`:** the agent wrote a due time, was asked to record it, and did not. Reply on the request with the time you expect, or hand it back to the agent.
- **A promise fell due and its agent was not woken:** the log line says `not woken`. A run of that agent is already on it, the agent is not on this computer, or the job reached its wake-up limit (`requests.jobs.wake.maxWakes`). You are told in every case.
- **A promise fell due and nothing happened that minute:** check `requests.promises.duePush` in `agentx.json`. With `false`, the push is off and the promise comes back to you later as **needs attention**. Remove the line or set it to `true`, then restart AgentX.
- **An agent accepted a due time and was not woken at that time:** check `requests.promises.acceptWake` in `agentx.json`. With `false`, the due time is only stored.
- **A plan's close was reopened and its agent was not woken:** check `requests.ownerCheck.wakeOnPlanMismatch` in `agentx.json`. With `false`, only you are told.
- **No `[due-times]` line in the daemon log, and no Due times rows:** check that `requests.dueTimes.mode` is `"shadow"` or `"on"` in `agentx.json`, that `requests.enabled` is `true`, and that AgentX was restarted. Only `promise` and `accept` are recorded.
- **An agent's promise is refused with `Not recorded: you wrote a due time with no source`:** the mode is `"on"` and the agent wrote its own time. It sends `estimateMinutes` and `priority` instead, or your words as `dueSource`. To go back to recording only, set the mode to `"shadow"` and restart AgentX.
- **An agent's call is refused with `priority critical is only for the owner's requests`:** the mode is `"on"` and the agent asked for critical on its own promise. It sends `priority: "high"` instead. If you asked for the work, send it to the agent as a message: your request can be accepted as critical.
- **The report counts `own critical` for an agent:** in shadow mode it asked for critical on its own work and was counted as high. Once the mode is `"on"`, those calls are refused.
- **An accept is refused with `does not fit the queue`:** the time you named cannot be met with the work already waiting. The message gives the earliest time and what would have to move. Tell the agent which you want.
- **Every due time is far away:** many open requests are counted with the default 30 minutes, or recently touched work that is finished is still open. Close the ones that are finished, or lower `requests.dueTimes.defaultEstimateMinutes`. A computer that holds more runs at once can set `requests.dueTimes.capacity`.
- **The correction factor stays at ×1:** the agent has fewer than `factorMinRows` finished pieces of work with an estimate and kept runs in the last `factorDays` days. It counts once the agent gives `estimateMinutes` on work it runs. A promise kept without a run of its own does not count.
- **No Queue block on the Jobs page:** the mode is `"off"`, or no agent has open work. The dashboard reads `agentx.json` again after the file changes.
- **The owner-words check never reopens anything:** check that `requests.ownerCheck.enabled` is `true` in `agentx.json` and that AgentX was restarted. Search the daemon log for `owner-words check`: a `call failed` line means the provider or model could not be reached.
- **A request with an `issue` check and a `notePattern` stays open although the comment is there:** only comments written after the request was opened count. A comment from before does not close it. Post a new comment with the text, or close the request yourself. A request opened before this rule still counts every comment.
- **A request was closed that was not finished:** its handed-on work came back done and nothing happened on it for a day, so it was settled. Ask the agent again, or run `agentx requests settings --settle off` if you want such requests to come back to you instead.

- **`no agentx.json here`:** you are not in the install folder, the one that holds `agentx.json`. A folder inside it does not count. Go to that folder and run the command again.
- **The list says `requests are off`:** run `agentx requests settings --enabled on`.
- **A message you sent on Telegram or GitHub is not recorded:** your id on that channel is not in `from`. Add it with `--from`, as `channel:id`.
- **A request you only got an answer to is not listed:** that is expected. A request is kept only when work goes on after the answer or goes wrong.
- **A request came back as `No activity for 24 h`:** nobody closed it. Close it with `done` or `drop`, or ask the agent to carry on.
- **No Goals list in the dashboard:** no request names a goal yet. It appears once an agent accepts a request with `goal`.
- **`only accept takes a goal`:** the agent passed `goal` with another action. It gives the goal when it accepts the request.
- **`goal.id must be letters, digits, dashes, dots or colons`:** the id has spaces or other signs. Give a short id such as `shop-relaunch`, or only the title.
- **A goal's cost shows `$0.00` with runs without a cost:** the agents run on an engine that does not report what a run cost. The counts and progress are still right.
- **`home.kind must be one of …`:** the agent gave a home kind that does not exist. Use issue, idea, approval, erp or card. A declined request takes no home.
- **`a finished request needs --evidence <link>`:** add the link to the proof. From the terminal, and for agents, a request cannot be closed as done without it.
- **A message from the phone app is not recorded:** the dashboard must run from the install folder, the one that holds `agentx.json`, so it can read `.agentx/operator.key`. Start it there. A message sent through the phone app to an agent on another computer is recorded there when the computer the phone is paired with checks its own key and vouches for you to the other one. That needs three things: both computers run 0.83.1 or later, the other computer lists the first one in `mesh.peers` with the same `token` the first one sends, and the request reaches it from another machine. A token that sits only in `MESH_TOKEN`, two different tokens, or a proxy on the same machine in front of the daemon means it is not recorded.
- **You handed a request to another agent and no answer came in the chat:** that is expected. The chat where you asked belongs to the first agent. Open the request's card in the dashboard and read **Last answer from …**.
- **An agent's done is refused with `Not closed: its check says it is not finished`:** that is the check working. The request closes by itself once the evidence is there. If the check is wrong, close the request yourself with `agentx requests done <id> --reason "…"`.
- **A request is marked `unverified`:** its check could not tell. `agentx requests show <id>` says why. Common causes: the address is down, the GitHub or GitLab token is missing or cannot see the issue, the local copy of the repository does not have the commit yet (update it), or the person in a `reply` check is not in `people`. Fix the cause and wait for the next check, or close it yourself with `--reason`.
- **`no repos are set up for this check on this node`:** add the folder under `requests.checkers.repos` in `agentx.json`.
- **`the … check is turned off on this node`:** add the kind back with `agentx requests settings --checks`.
- **A card is still titled with your own words:** the agent did not describe the request and no headline could be written. The daemon log has a line `[requests] <id>: headline not written: …` with the reason. A common cause is that the engine set in `requests.headlines.provider` is not signed in on this computer. Each request is tried once, and not again after a restart; the agent can still describe it. To see the start of your words as the title on purpose, run `agentx requests settings --headlines off`.
- **`--headlines takes on or off`:** write `on` or `off`, nothing else.
- **An agent's describe is refused with `headline is only a reference`:** the headline was only an issue number, an id or a link. Say what the request is in words, and put the link in the request's `home` instead.
- **A QA verdict is refused with `a block verdict needs a note`:** a `block` or `risk` needs a sentence that says what is wrong. Add `note`.
- **A QA verdict is refused with `qa needs id`:** the QA agent's turn is not the request's own, so it must name the request. `agentx requests` or the agent's `list` shows the ids.
- **A request stays in `--qa awaiting` after a verdict:** it was marked as needing QA again after that verdict, so a new one is awaited. `agentx requests show <id>` lists every verdict with its time.
- **`agentx requests contract` shows `–` for a number:** nothing in the time you asked for counts toward it. For example, no request was closed as done. Try a longer `--since`.
- **Chain coverage stays low with `--dry-run`:** the agent that started the hop runs on another computer, or its turn ended before the hop started. Run the command on that computer too.
- **`--since takes a span such as 90m, 36h or 7d`:** write a number and one of `m`, `h` or `d`, with nothing else, up to `90d`.
- **An agent says it has no `agentx_request` tool:** the tool server is added when the daemon starts with requests on. Restart the daemon. If the agent's workspace has a `.mcp.json` you wrote yourself, add the server there: `agentx serve --stdio --cwd <install folder>`.
