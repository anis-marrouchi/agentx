# Review what your agents learn

Agents get better over time because AgentX lets them remember. There are three kinds of memory, and each has a place where you stay in control:

- **Facts:** after every reply, AgentX notes useful facts from the conversation ("deploys happen on Tuesdays") and reminds the agent of them later.
- **Memories:** notes an agent writes for itself on purpose, such as a rule you gave it.
- **Lessons:** every night, AgentX suggests which memories are worth sharing with *all* agents, as articles in the shared wiki (a knowledge base every agent reads).

This page shows how to review each one. Everything here happens in a **terminal** on the machine that runs AgentX, in the folder that holds `agentx.json`.

## What AgentX never keeps

- **Passwords, tokens and keys.** If a conversation contains one, it isn't saved as a fact, even when someone asks.
- **Facts from public channels without your approval.** Anyone can write to a public web chat, so facts from there wait for you before any agent sees them. Facts from your own tools, your team's chats, GitLab and GitHub are used straight away.

## One rule for facts: check it or say it's unverified

Every agent follows the same rule before it tells you something as a fact, or acts on it:

- **Fresh and checked:** it uses the fact.
- **Out of date:** it checks the fact again at the source, such as the service's website, its API (the address programs use to talk to it) or a command, and records what it found.
- **Can't be checked:** it tells you the fact is unverified and asks you. It never states it as true.

### Which facts go out of date

AgentX sorts each fact by how quickly it can change:

- **Changes on its own:** a bill or a credit balance, an account (for example suspended, blocked or expired), an outage (something is down) and a deploy (which version is live). These are trusted for 2 days after they were last checked.
- **Lasting:** names, decisions, rules and places, such as "the deploy folder is /var/www/site". These don't expire.

When an agent is reminded of a fact that changes on its own and is more than 2 days old, the fact is marked `UNVERIFIED`, with a note telling the agent to check it or ask you.

### Where the checked facts are kept

The shared wiki (the knowledge base every agent reads) keeps a list of checked facts. Each one records:

- **what it says**, for example "vendor account · billing status: active";
- **where it was checked** (a website, a command, or "owner said");
- **when** it was checked, and **by whom** (an agent or a person);
- **how quickly it changes**, which sets how long it stays trusted.

An agent's own notes don't copy these facts. When a note says the same thing as a checked fact, the agent is shown the checked fact, with where and when it was checked, instead of the note.

### Summaries of long conversations

When a long conversation is restarted, the agent writes a short summary of it to carry on from. AgentX keeps the parts about the work in progress, and deletes them after 7 days. Any claim in the summary about an outside service (a bill, an account, an outage or a deploy) is not kept as a fact. It's sent to you as a **fact proposal**, with where it came from, and it's marked `UNVERIFIED` when the conversation carries on.

### When two facts disagree

A new value only replaces a checked fact when it was checked more recently, or when you confirm it. Otherwise the old value stays, and AgentX adds a question for you to `agentx wiki questions`. Earlier values are kept with the fact, so nothing is lost.

Held facts and proposed lessons also appear in the dashboard's **Approvals** tab and in `agentx approvals list`, next to everything else waiting for you. See [Approvals](../dashboard/approvals.md).

## 1. Approve or reject facts from public channels

1. See which facts are waiting:
   ```sh
   agentx memory facts held
   ```
   Each one shows its agent, an ID, where it came from, and the fact itself.
2. Let one be used:
   ```sh
   agentx memory facts approve <id> --agent <agent>
   ```
   Or keep it out for good:
   ```sh
   agentx memory facts reject <id> --agent <agent>
   ```
3. For an overview of every agent's facts by source, run `agentx memory facts summary`.

## 2. Remove passwords stored before this protection

Older versions of AgentX could store a password or token as a fact. Those are no longer shown to agents, but they may still be on disk.

1. Count them:
   ```sh
   agentx memory facts scrub
   ```
2. Delete them:
   ```sh
   agentx memory facts scrub --apply
   ```

## 3. Check the facts proposed from summaries

Do this in a **terminal**.

1. See the claims waiting for you:
   ```sh
   agentx wiki facts proposals list
   ```
   Each one shows the claim, the agent that made it, and where it came from.
2. Check the claim yourself at its source, for example on the service's website.
3. If it's true, record it:
   ```sh
   agentx wiki facts proposals approve <id>
   ```
   If AgentX couldn't read the claim, or the value has changed, give the details, for example `--subject "vendor account" --attribute "billing status" --value "active" --source "vendor dashboard"`.
4. If it's wrong or you can't tell, drop it:
   ```sh
   agentx wiki facts proposals reject <id> --reason "account is active"
   ```

## 4. Answer a disagreement between facts

1. In a **terminal**, list the open questions:
   ```sh
   agentx wiki questions
   ```
   A disagreement reads like "the wiki says "active" (…), but an agent reports "past due" (…). Which is true?"
2. Check which value is true at the source.
3. Give the true value:
   ```sh
   agentx wiki answer <id> "active"
   ```
   Your answer replaces the fact, and the older value is kept with it.

`agentx wiki lint` also lists disagreements that are still open.

## 5. Record a fact you checked

Agents do this themselves after they check something. You can do it too, in a **terminal**:

1. Record the fact and where you checked it:
   ```sh
   agentx wiki facts set --subject "vendor account" --attribute "billing status" \
     --value "active" --source "vendor dashboard" --checked-at now --by operator
   ```
2. `--checked-at` says when you checked. Without it, a new value can't replace a different one that's already recorded.
3. If the wiki already holds a more recent value, or one a person confirmed, AgentX doesn't replace it and adds a question instead. To replace it anyway, because you know it's right, add `--confirm`.
4. See every checked fact, or only the ones past their time limit:
   ```sh
   agentx wiki facts list
   agentx wiki facts list --stale
   ```
   `agentx wiki facts show <id>` prints one fact with its earlier values.

## 6. Mark old unchecked facts as unverified (one time)

Facts saved before this version don't say where they came from. This one-time step marks those about bills, accounts, outages and deploys (for example "past due", "blocked", "down" or a credit balance) as unverified, so agents check them before using them.

1. In a **terminal**, see which facts would be marked:
   ```sh
   agentx memory facts flag-unsourced
   ```
2. Stop the daemon, so no agent saves a fact while the files are rewritten:
   ```sh
   agentx daemon stop
   ```
3. Mark them:
   ```sh
   agentx memory facts flag-unsourced --apply
   ```
   A copy of each changed file is saved first, in `.agentx/memory/_backup/`. Running it again changes nothing.
4. Start the daemon again:
   ```sh
   agentx daemon start --detach
   ```

## 7. Approve the lessons proposed for the shared wiki

Every night, `agentx wiki promote --commit` reads what agents have learned and suggests lessons for the shared wiki. Nothing is written to the wiki until you approve it.

1. See the suggestions:
   ```sh
   agentx wiki proposals list
   ```
   Each one says whether it's a new article or a change to an existing one, and which agents back it.
2. Read one, with the evidence behind it:
   ```sh
   agentx wiki proposals show <id>
   ```
   The evidence lists the memories it came from, who wrote each one and when, and, for problems that keep coming up, in how many separate sessions they appeared.
3. Add it to the wiki:
   ```sh
   agentx wiki proposals approve <id>
   ```
   If someone changed that article after the suggestion was made, AgentX stops so you don't overwrite their change. Read the article, then approve with `--force` if the suggestion should still win.
4. Or turn it down, with a note for later:
   ```sh
   agentx wiki proposals reject <id> --reason "too specific to one client"
   ```
   A rejected suggestion isn't offered again unless the memories behind it change.

To preview what tonight's run would look at, without asking the judge or writing anything, run `agentx wiki promote`.

### Turn failures that keep happening into lessons

Agents don't write down what went wrong, so a tool that fails in session after session never becomes a lesson on its own. With `--failures`, the nightly run also reads failed and timed-out tasks from the last 7 days (or the `--since` window). It groups them by what they have in common: the agent, the tool that failed, and the kind of error. A failure that happened in at least 3 separate sessions (conversations) is offered as a lesson; a failure seen only once is ignored.

1. In a terminal, preview what it would find:
   ```sh
   agentx wiki promote --failures
   ```
   It prints how many failed tasks it read and how many failures came up in 3 or more sessions.
2. To ask for more (or fewer) sessions before a failure counts, add `--min-sessions`:
   ```sh
   agentx wiki promote --failures --min-sessions 5
   ```
   The lowest value is 2: a failure inside one session is never treated as a pattern.
3. Add `--failures` to the nightly `wiki promote --commit` job (`agentx schedule list` shows it).
4. Review the lessons like any other, with `agentx wiki proposals show <id>`. For a failure, the evidence shows the failing tool, the kind of error, how many sessions and tasks hit it, and some example task ids. Open one with `agentx trace show <task-id>`. In the **Approvals** tab these lessons start with "Recurring failure".

While a failure lesson waits for your review, the same failure isn't suggested a second time. A failure lesson you rejected isn't offered again until the failure reaches 4 sessions, then 8, then 16, and so on.

## 8. Undo a change to an agent's memory

Every time a memory is changed or deleted, the previous version is kept (the last 20 of each). Use the daemon's web address, on port 18800 by default:

1. List the saved versions of a memory:
   ```sh
   curl -s 'http://localhost:18800/api/memory/no-mock-db/versions?agent=ops-agent'
   ```
2. Put one back, using its `id` from the list:
   ```sh
   curl -s -X POST 'http://localhost:18800/api/memory/no-mock-db/restore?agent=ops-agent' \
     -H 'Content-Type: application/json' -d '{"version":"<id>"}'
   ```
   This works for deleted memories too. The version you replace is kept, so a restore can be undone the same way.

Each memory also records who wrote it: the agent and the task it was working on, or `unverified` when that couldn't be checked. An agent can only change its own memories.

## 9. See whether what agents learn helps

In this report, a *lesson* is anything the agent was reminded of for a task: a fact, a procedure (a step-by-step routine AgentX learned from repeated work) or the shared wiki's table of contents. Every task records which lessons reached the agent. Only their IDs are kept, never the text.

AgentX groups tasks that repeat, such as "send the weekly report", the same way it does when it learns procedures. For each lesson, it compares that task's runs from before the lesson was first used with the runs that got the lesson.

1. **Terminal:** run the report for the last 30 days:
   ```sh
   agentx trace lessons
   ```
   Each lesson shows two lines. `before` covers the runs without it and `after` covers the runs that got it. Each line gives the number of runs (`n`), how many succeeded, and the typical (median) tokens, turns and time. The `after` line shows the change, for example `tokens 9.1k (-26%)`.
2. **Terminal:** look further back, or at one agent:
   ```sh
   agentx trace lessons --since 90d --agent <agent>
   ```
3. **Terminal:** ask for more runs on each side before a lesson is shown (the default is 2):
   ```sh
   agentx trace lessons --min 5
   ```
4. **Terminal:** to use the numbers in a spreadsheet or script, add `--json`:
   ```sh
   agentx trace lessons --json
   ```
5. **Terminal:** to see which lessons one task got, run `agentx trace show <task-id>` and read the `lessons` line.

A few runs prove little. Treat a change as a hint until `n` is in the tens.

<!-- No screenshot: every step here is a terminal command. -->

## Check it worked

1. `agentx memory facts scrub` reports `0 fact(s) contain credentials`.
2. `agentx memory facts held` lists nothing you haven't decided on.
3. After you approve a lesson, `agentx wiki proposals list --all` shows it as `approved`, and the article is in the shared wiki under `.agentx/wiki/`.
4. After a restore, the memory's `versions` list includes the version you replaced.
5. `agentx trace show <task-id>` for a recent task prints a `lessons` line.
6. `agentx wiki promote --failures` prints a line with the number of failed tasks it read and the number of failures that recur.
7. `agentx wiki facts list` shows each fact with where, when and by whom it was checked.
8. `agentx memory facts flag-unsourced` reports `0 fact(s)` after you have run it with `--apply`.

## If something is wrong

- **`approve` says the article changed since this proposal:** someone edited it after the suggestion was made. Read both, then approve with `--force` or reject.
- **`approve` says the proposal is already approved or rejected:** it was decided earlier. Check `agentx wiki proposals list --all`.
- **`--failures` finds no recurring failures:** the same failure has to happen in several separate sessions. Retries inside one conversation count once. Lower `--min-sessions` or widen `--since` to look further.
- **No proposals ever appear:** check that the nightly `wiki promote --commit` job is switched on (`agentx schedule list`) and that agents have saved memories recently.
- **A fact you expected isn't used:** it may come from a public channel and be waiting in `agentx memory facts held`, or it contained a password or token and was never kept.
- **`restore` answers `no such version`:** list the versions again and copy the `id` exactly.
- **`agentx trace lessons` says no lesson has enough runs:** only tasks run since this version record their lessons, and a task has to repeat on both sides of a lesson. Wait for more runs, widen `--since`, or lower `--min`.
- **`agentx trace lessons` says `No db at`:** run it in the folder that holds `agentx.json`, or name that folder with `--cwd <folder>`. To read a database copied from another machine, add `--path <file>`.
- **A lesson you expected is missing from the report:** procedures and the wiki's table of contents are only given at the start of a fresh conversation, so runs that continue an earlier conversation don't count for them.
- **`agentx wiki facts set` says the value was not replaced:** the wiki holds a value checked more recently, or one a person confirmed, or you left out `--checked-at`. Answer the question it added with `agentx wiki answer`, or add `--confirm` if you know yours is right.
- **`approve` says it couldn't read a subject, attribute and value:** the claim wasn't a simple "X is Y" sentence. Approve it again with `--subject`, `--attribute` and `--value`.
- **An agent keeps calling a fact unverified:** the fact is past its time limit. Check it, then record it with `agentx wiki facts set --checked-at now`.
- **A command says the fact ledger is unreadable:** the file `.agentx/wiki/_facts.json` is damaged, so AgentX writes nothing to it rather than replace it. Fix the file, or move it aside to start an empty list; agents keep working without it.
- **You want the old memory back after `flag-unsourced --apply`:** copy the file from `.agentx/memory/_backup/` over the agent's file in `.agentx/memory/`.
- **Memory changes are refused with `403`:** the request named a task from another agent. Each agent can only change its own memories.
