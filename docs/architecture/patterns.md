# The owner interface and its patterns

Status: **a map, not a feature.** Nothing on this page is a setting. It names the parts AgentX uses for work that concerns a person (usually the owner, the person who runs this install), and the recurring shapes that work takes. The plan to bring the code in line with it is [#1137](https://github.com/anis-marrouchi/agentx/issues/1137).

Classic apps have a well-known split: a *model* holds the data, a *view* shows it, a *controller* decides what happens. Work around a person has its own split. This page names it, so a new feature can say which part it belongs to instead of inventing a fifth place to keep a due date.

## The four parts

| Part | Role | What it owns |
|---|---|---|
| **Promise** | model of work | who owes what to whom, by when, and the proof that closes it |
| **Fact** | model of truth | what is true, where that came from, when it was checked, and when it goes stale |
| **Reach** | controller | where the person is, which channel to use, whether the message landed, and what happens if it did not |
| **Desk** | view | one list of what concerns the person, shown on any surface (phone, dashboard, computer), shaped by settings and not by code |

The parts are meant to talk over the event bus (`src/events/bus.ts`): one part publishes that something changed, the others listen. Today the bus carries only message, task and session events, and none of the four parts publish on it. Step 1 of #1137 adds a "request changed" and a "card changed" event.

Today the four parts exist in pieces, spread across several stores. [#1137](https://github.com/anis-marrouchi/agentx/issues/1137) lists what is where and the order in which they are joined.

## Patterns

A *pattern* is a recurring shape of agent work with a name. Each entry below says:

- **Problem**: what goes wrong without it.
- **Shape**: the parts it is made of.
- **Lives in**: where AgentX does it today. A path is checked by a test, so it cannot go stale silently. A pattern that is not built yet names the step of #1137 that builds it.
- **Do it well**: the practice to follow when you touch it.

### Promise

- **Problem**: "done" is said without proof, and nobody knows who is waiting.
- **Shape**: an owner, who it is owed to, a due time, and the proof that closes it.
- **Lives in**: `src/requests/store.ts` (the `promise`, `owed_to`, `due_at` and `close_when` columns), `src/requests/tool.ts` (the `promise` action agents call).
- **Do it well**: record a promise when you make it, not when you finish. Give it a `closeWhen` check wherever one exists, so the daemon closes it and not your memory.

### Fact

- **Problem**: an old truth is repeated with confidence.
- **Shape**: a claim, its source, when it was checked and by whom, and a volatility class that sets how fast it goes stale.
- **Lives in**: `src/wiki/facts/ledger.ts`.
- **Do it well**: past its time limit, check a fact at its source before stating it, and record the check. If you cannot check it, say it is unverified.

### Home

- **Problem**: the same thing is tracked in three places, and the three disagree.
- **Shape**: one record per thing. Everything else points at that record.
- **Lives in**: `src/requests/store.ts` and `src/approvals/cards.ts` today. Step 4 of #1137 folds the other stores that hold a due date into these two.
- **Do it well**: before adding a table with a due date or a status, check whether a request or a card already is the home.

### Listener

- **Problem**: what a party says on a channel is heard as pings and never recorded.
- **Shape**: a channel and the parties to watch on it, turned into records.
- **Lives in**: `src/channels/inbound/pipeline.ts` (every inbound message passes its stages), `src/requests/tracker.ts` (turns a person's turn into a request).
- **Do it well**: write what was heard to a record (a request, a card, a fact) before alerting anyone, so the alert can point at it.

### Party

- **Problem**: clients are handled as names inside messages.
- **Shape**: a person with a role (`owner`, `member`, `client`, `guest`).
- **Lives in**: `src/people/people.ts`.
- **Do it well**: refer to people by their person record, not by a name in free text.

### Reach

- **Problem**: news is shouted on every channel at once, or sent to a channel that stopped working.
- **Shape**: where the person was last seen, then one channel, then a wait, then the next channel.
- **Lives in**: `src/notify/index.ts` sends today. Presence, "seen" and the next-channel rule are steps 2a and 2b of #1137.
- **Do it well**: send to one place. Urgent items may move to the next channel when unseen; everything else waits for the digest.

### Told once

- **Problem**: the same news arrives on four surfaces.
- **Shape**: one record of what the person was told, keyed by item, across all channels.
- **Lives in**: `src/notify/told.ts` (`ToldLedger`, `OwnerGate`), used by the daemon's `tellOwner()` in `src/daemon/index.ts`.
- **Do it well**: tell the owner through the notify path (`agentx notify`, or the daemon's own notices), never by calling a channel directly, so a repeat is caught.

### Hold

- **Problem**: someone who is focused or on a call gets interrupted.
- **Shape**: non-urgent messages wait until the hold ends.
- **Lives in**: `src/notify/focus.ts`, `src/notify/hold.ts`.
- **Do it well**: mark only true emergencies urgent. A hold that everyone bypasses is no hold.

### Digest

- **Problem**: reminders and nags arrive one by one as pushes.
- **Shape**: low-value notices are folded into one message at a set hour.
- **Lives in**: `src/notify/told.ts` (the `digest` outcome), `src/approvals/sweep.ts` (sends it).
- **Do it well**: a nag ("not finished", "disk low") goes to the digest. Only news the person must act on now is pushed.

### Approval with expiry

- **Problem**: a yes from last week is used for today's action.
- **Shape**: a yes scoped to one action, with an expiry and a default that applies if nobody answers.
- **Lives in**: `src/approvals/cards.ts` (`expires`, `if_silent`), `src/approvals/sweep.ts` (applies the default).
- **Do it well**: one question per card, with a default you would accept if the person says nothing.

### Verdict

- **Problem**: a judgment is given as free text that nobody can audit.
- **Shape**: a typed answer with a probability, recorded so it can be checked later.
- **Lives in**: `src/decisions/seat.ts`, `src/decisions/store.ts`.
- **Do it well**: when the same judgment is made many times with known options, ask a decision seat instead of reasoning in a reply.

### Chaser

- **Problem**: things go quiet and nobody notices.
- **Shape**: after a stall time, a nudge; then an escalation; a fixed number of times, then stop.
- **Lives in**: `src/requests/sweep.ts`, `src/requests/plan-sweep.ts`, `src/watchers/due.ts`.
- **Do it well**: every chaser has a limit. After the last nudge it tells the owner once and stops.

### Evidence watcher

- **Problem**: saying "done" closes nothing, or closes things that are not done.
- **Shape**: an item closes only when a check passes: a page, an issue state, a commit on a branch, a reply, a test.
- **Lives in**: `src/requests/checkers/index.ts`, `src/watchers/evidence.ts`.
- **Do it well**: prefer a check the daemon can run over a link a person has to open.

### Handoff

- **Problem**: what a session knew is lost when it ends.
- **Shape**: a short memo: the objective, the state, the next action, and what was checked versus assumed.
- **Lives in**: `src/agents/rotation-memo.ts`, `src/agents/rotation-memo-store.ts`.
- **Do it well**: write the memo before the session ends, and mark which statements you checked.

### Delegation result

- **Problem**: an answer goes to the wrong person, or to nobody.
- **Shape**: the answer returns to the agent that asked, on the thread where the person asked.
- **Lives in**: `src/a2a/delegation.ts`.
- **Do it well**: delegate with a callback and end your turn. Do not hold the person's turn open while another agent works.

### Plan gate

- **Problem**: big work starts without a plan.
- **Shape**: an estimate. Work of a set kind, or over a set number of minutes, needs a plan with steps and a proof per step.
- **Lives in**: `src/requests/daemon-api.ts` (refuses the accept), `src/requests/plan-store.ts` (keeps the steps).
- **Do it well**: give each step a proof someone else can check, not "done".

## Adding or changing a pattern

1. Add a `###` entry under **Patterns**, with the four lines **Problem**, **Shape**, **Lives in** and **Do it well**.
2. In **Lives in**, put each code path in backticks, starting with `src/`. If it is not built yet, name the issue step that builds it.
3. Run the check below.

## Check it worked

In a terminal, from the repo root:

1. Run `pnpm vitest run test/docs-patterns.test.ts`.
2. It passes when every pattern has its four lines and every path in backticks exists.

## If something is wrong

- **A path is reported missing**: the code moved or was renamed. Update the path on this page in the same pull request that moved it.
- **A pattern is reported incomplete**: one of the four lines is missing or empty. Add it.
