# The owner interface and its patterns

![How work reaches you. An agent makes a Promise, proof closes it, and a Fact is written. The change goes on the event bus, Reach picks one channel where you were last seen, and you read one list, the Desk. Four links are not wired yet and are built in steps 1 to 4 of issue #1137.](/diagrams/owner-interface.svg)

A classic web app has a well-known shape called MVC: a *model* holds the data, a *view* shows it, and a *controller* decides what happens in between. AgentX has a similar shape for the work around one person, the *owner* (the person this install works for). This page names its four parts.

It also holds a small *pattern language*: a list of the shapes that keep coming back in agent work. Each pattern has a name, the problem it solves, its shape, where it lives in the code today, and how to do it well. Use the names when you write an issue, review a change or explain AgentX to someone.

## The four parts

| Part | Role | Owns |
|---|---|---|
| **Promise** | the model of work | who owes what to whom, by when, and the proof that closes it |
| **Fact** | the model of truth | what is true, its source, when it was checked, when it expires |
| **Reach** | the controller | where the person is, which channel to use, whether the message landed, and what happens if it did not |
| **Desk** | the view | one list of what concerns the person, shown on any surface, shaped by settings and not by code |

The wire between them is the *event bus*: one place in the daemon where a part announces a change and any other part can listen.

| Part | Lives in |
|---|---|
| Promise | `src/requests/store.ts` (the `promise`, `owed_to`, `due_at` and `close_when` fields) |
| Fact | `src/wiki/facts/ledger.ts` |
| Reach | `src/notify/` and `src/notify/told.ts` |
| Desk | `src/desk/board.ts` |
| The event bus | `src/events/bus.ts` |

### What is not wired yet

The parts exist, but four links between them are missing. Issue #1137 builds them in this order:

1. **One Desk.** Today the inbox, the Mac popup, the Reminders mirror and the Desk each ask "what is waiting for the owner?" in their own way. Step 1 gives them one shared query and makes requests and cards announce changes on the bus.
2. **Reach.** Today a message counts as delivered when sending it did not fail. Step 2 records where the owner was last seen, whether they saw the message, and which channels are down.
3. **Catch the promise.** Today a promise is recorded only when an agent asks for it. Step 3 reads "I'll do X by Thursday" from the agent's reply.
4. **One Promise, one Proof.** Today six stores hold a due date and four kinds of evidence close things. Step 4 merges them, and closing a promise writes a checked Fact.

## The patterns

Each entry follows the same shape. **Lives in** names the files where the pattern is built today, or the step of #1137 that builds it.

### Promise

- **Problem:** work is called "done" without proof, and nobody knows who is waiting for it.
- **Shape:** an owner, who it is owed to, a due time, and the proof that closes it.
- **Lives in:** `src/requests/store.ts`, `src/requests/loops.ts`
- **Best practice:** record the promise when it is made, not when it is late. Give every promise a due time and, where you can, a `close_when` check, so it closes itself.

### Fact

- **Problem:** an old truth is repeated with confidence.
- **Shape:** a claim, its source, when it was checked, and an expiry that depends on the kind of claim.
- **Lives in:** `src/wiki/facts/ledger.ts`
- **Best practice:** never store a claim without its source and the date it was checked. A newer checked result replaces an older one; see [Evidence authority](evidence-authority.md).

### Home

- **Problem:** the same thing is tracked in three places, and the three copies drift apart.
- **Shape:** one record per thing. Everything else points at that record.
- **Lives in:** `src/requests/store.ts`, `src/approvals/cards.ts` (step 4 of #1137 makes them one)
- **Best practice:** before you add a store, ask which existing record this thing already is. Add a link to it, not a copy of it.

### Listener

- **Problem:** messages on a channel are heard as pings but never become records.
- **Shape:** a channel plus the parties to watch, turned into records.
- **Lives in:** `src/channels/router.ts`, `src/whatsapp-triage/service.ts`
- **Best practice:** decide which parties a channel is for, and record what they say as requests or facts, not only as notifications.

### Party

- **Problem:** clients are handled as names inside messages.
- **Shape:** a person with a role (owner, member, client or guest), optionally linked to an organisation.
- **Lives in:** `src/people/people.ts`
- **Best practice:** stamp each turn with the person it came from, and decide what they may see from their role, not from the text.

### Reach

- **Problem:** the same news is shouted on every channel at once.
- **Shape:** the place the person was last seen, then one channel, then a wait, then the next channel.
- **Lives in:** `src/notify/index.ts`, `src/daemon/app-chat-active.ts` (step 2 of #1137 builds the rest)
- **Best practice:** send an urgent item to one channel and move on only if it was not seen. Let everything else wait for the digest.

### Told once

- **Problem:** the same news arrives on four surfaces.
- **Shape:** one record of what the owner was told, keyed by item, shared by every channel.
- **Lives in:** `src/notify/told.ts`
- **Best practice:** go through `tellOwner()` for anything meant for the owner. An item is told once; reminders about it go to the digest.

### Hold

- **Problem:** someone is interrupted while they are focused or on a call.
- **Shape:** anything that is not urgent waits until the hold ends.
- **Lives in:** `src/notify/focus.ts`, `src/notify/hold.ts`
- **Best practice:** hold, never drop. A hold has an end time, so a writer that crashed cannot hold forever.

### Digest

- **Problem:** reminders arrive as a stream of pushes.
- **Shape:** notices of low value are gathered and sent together at a set hour.
- **Lives in:** `src/notify/queue.ts`, `src/approvals/settings.ts`
- **Best practice:** one digest per destination. Say in each line why it waited.

### Approval with expiry

- **Problem:** a yes from last week is used today.
- **Shape:** a yes for one action only, with an expiry and a default for when nobody answers.
- **Lives in:** `src/approvals/cards.ts`, `src/approvals/sweep.ts`
- **Best practice:** every card says what it recommends and what happens if nobody answers by `expires` (its `if_silent`). Nothing waits forever.

### Verdict

- **Problem:** a judgment is written as free text that nobody can check later.
- **Shape:** a typed answer with a probability, recorded so it can be audited.
- **Lives in:** `src/decisions/seat.ts`, `src/decisions/store.ts`
- **Best practice:** ask a small, typed question at a fixed point in the code, and run a new seat in shadow first. See [Jev and typed decisions](jev.md).

### Chaser

- **Problem:** things go quiet and nobody notices.
- **Shape:** a stall time, then a nudge, then an escalation, a fixed number of times.
- **Lives in:** `src/requests/sweep.ts`, `src/requests/plan-sweep.ts`, `src/watchers/store.ts`
- **Best practice:** count the nudges and stop after the last one. Escalate to a person, not to another nudge.

### Evidence watcher

- **Problem:** "done" closes nothing.
- **Shape:** close only when a check passes: a URL, an issue, a git commit on a branch, a reply, or a test.
- **Lives in:** `src/requests/checkers/index.ts`, `src/watchers/evidence.ts`
- **Best practice:** when a check cannot run, leave the item open and mark it unverified. Do not close it on the agent's word.

### Handoff

- **Problem:** context is lost between sessions.
- **Shape:** a short memo: the objective, the current state, the next action, and what was checked versus assumed.
- **Lives in:** `src/agents/rotation-memo.ts`, `src/agents/agent-memory.ts`
- **Best practice:** write the memo before the session ends, from the session that knows. Keep it short enough to read in one turn.

### Delegation result

- **Problem:** an answer goes to the wrong person.
- **Shape:** the answer returns to whoever asked, on the thread they asked in.
- **Lives in:** `src/a2a/delegation.ts`
- **Best practice:** keep the asker's origin with the delegated task, and deliver the result there, even when the asker is busy.

### Plan gate

- **Problem:** big work starts without a plan.
- **Shape:** an estimate first. Work over a set number of minutes needs a plan with steps and proof.
- **Lives in:** `src/requests/plan-store.ts`, `src/requests/plans.ts`
- **Best practice:** give each step an owner and a done check, so the plan can be followed and checked without asking.

## Add or change a pattern

The list is open. To add, rename or merge a pattern:

1. Edit this page and keep the four lines: **Problem**, **Shape**, **Lives in**, **Best practice**, in that order under the pattern's name.
2. Put each **Lives in** path in backticks, relative to the repository root. If the pattern is not built yet, also name the issue step that builds it.
3. Run `pnpm vitest run test/docs-patterns.test.ts` in a terminal.

## Check it worked

1. **Terminal:** in the AgentX checkout, run `pnpm vitest run test/docs-patterns.test.ts`.
2. Every case passes. The test reads this page and checks that each pattern has its four lines and that every `src/` path it names exists.

## If something is wrong

- **The test names a missing path:** the file was moved or renamed. Update the **Lives in** line on this page in the same change as the move.
- **The test says a pattern has no Lives in path:** add the file that builds it, or the file closest to it plus the issue step that builds the rest.
- **A pattern here does not match how the code behaves:** the code is what runs. Fix the page, or open an issue that links this page and says which one should change.
