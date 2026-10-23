# Patterns for working around a person

AgentX should work around a person the way a good assistant does: it remembers what it promised, it does not say the same thing twice, and it closes what is finished without being asked. This page names the shapes that keep coming back in the code, so that new features reuse them instead of inventing a new one each time.

Each pattern has the same five parts:

- **Intent:** what it is for, in one sentence.
- **Forces:** the pressures that make it hard.
- **Building block:** the file in AgentX that does it today.
- **Use it well:** what a good use looks like.
- **Anti-patterns:** the mistakes it is there to prevent.

## Model, views and controllers

In classic software, MVC (model, view, controller) splits a program into the data it keeps, the screens that show that data, and the code that changes it. AgentX uses the same split for the work it does around a person.

| Part | In AgentX | What it is |
|---|---|---|
| **Model** | one durable record per need or promise | Who owes what to whom, by when, and the proof that closes it. When it closes, it leaves a dated fact behind. |
| **Views** | the Desk, notifications, the phone app | Ways of showing the open records. A ping only points at a record; it is never the record itself. A closed record leaves every view by itself. |
| **Controllers** | agents, listeners, chasers | They open, move and close records. Listeners hear the people on their channels. Chasers make sure nothing goes quiet. |

The rule that follows: change the record, never only the view. A notification that is not tied to a record cannot be marked seen, cannot be closed and is sent again.

## Promise

- **Intent:** one record for every piece of work someone is owed, kept open until it is closed with proof.
- **Forces:** agents forget what they said in a past turn; a chat reply is lost once it scrolls away; the person cannot hold every promise in their head.
- **Building block:** the request store, `src/requests/store.ts`. A request from the person and a promise an agent makes (`addPromise`) are the same kind of row, with `owedTo`, `dueAt` and `closeWhen`. Agents open, move and close them with the `agentx_request` tool, `src/requests/tool.ts`.
- **Use it well:** say who it is owed to and when it is due. Give it a check that proves it is finished (see Verdict), or a link when it is done.
- **Anti-patterns:** a promise that lives only in a chat message; a second list of to-dos beside the request store; closing a promise with "done" and nothing to show for it.

## Fact

- **Intent:** what a closed record leaves behind: a dated, sourced answer to "is X true?".
- **Forces:** a statement that was true last week may be false now; a model's summary is not a check.
- **Building block:** the wiki fact ledger, `src/wiki/facts/ledger.ts`. Each fact has where it came from, when it was last checked and how long it stays true. Claims from session summaries wait as proposals, `src/wiki/facts/fact-proposals.ts`, until a person confirms them.
- **Use it well:** write the source and the time of the check with the value. Let a fact expire rather than keep it forever.
- **Anti-patterns:** storing a claim as memory with no source; overwriting a checked value with an unchecked one.

## Verdict

- **Intent:** decide from evidence, not from a claim, whether a record is finished.
- **Forces:** agents say "done" too early; some proof (a closed issue, a merged commit) can be checked by a machine, some cannot.
- **Building block:** the checkers in `src/requests/checkers/index.ts` (`url`, `issue`, `git-ancestor`, `reply`) answer met, not met or cannot tell. Task watchers apply evidence rules (test, output, link) in `src/watchers/evidence.ts`.
- **Use it well:** "cannot tell" is its own answer: mark the record unverified and say why. Never round it up to done.
- **Anti-patterns:** treating a timeout as a pass; letting the agent that did the work be the only judge of it.

## Approval

- **Intent:** ask the person one clear question, with a recommended answer and what happens if they say nothing.
- **Forces:** the person is busy; a question in chat is easy to miss; nothing may wait forever.
- **Building block:** decision cards, `src/approvals/cards.ts`, listed with every other pending decision in one inbox, `src/approvals/inbox.ts`. A card past its expiry gets its `if_silent` answer applied by `src/approvals/sweep.ts`.
- **Use it well:** one question per card, a short headline, and an honest `if_silent`. A card raised for a request moves that request to "waiting on you".
- **Anti-patterns:** asking in chat instead of on a card; a card that approves itself; a card with no expiry.

## Chaser

- **Intent:** make sure no open record goes quiet without someone hearing about it.
- **Forces:** agents do not come back on their own; telling the person too often is as bad as never telling them.
- **Building block:** the requests check, `src/requests/sweep.ts`, runs every minute. It settles a request whose handed work all came back done (`settleHandedBack`), raises a quiet or overdue one once, and hands one back to its agent when the person says so. The plan check, `src/requests/plan-sweep.ts`, nudges quiet plan steps. Check-ins, `src/approvals/checkin.ts`, bring open items back a few times a day.
- **Use it well:** close what the evidence shows is finished before raising anything. Tell once, then only list.
- **Anti-patterns:** a reminder every hour; a chaser that closes on age alone; raising a record whose work is already done.

## Hold

- **Intent:** keep a message back while the person cannot take it, and deliver it later; never drop it.
- **Forces:** Focus, calls and sleep; a message that waits too long is useless; an urgent one must still go.
- **Building block:** the Focus reader, `src/notify/focus.ts`, and the call hold, `src/notify/hold.ts`. The told-the-owner record, `src/notify/told.ts`, sends nags to the daily digest instead of at once.
- **Use it well:** a hold always ends (it has an `until`). Urgent items skip it on purpose, not by accident.
- **Anti-patterns:** a hold that swallows messages forever; each feature with its own quiet hours.

## Listener

- **Intent:** hear a person on the channel they use, and turn what they say into a record when it needs one.
- **Forces:** many channels (chat apps, forges, voice, the phone app); anyone can pick a display name; most messages need only an answer.
- **Building block:** the routing pipeline, `src/channels/inbound/pipeline.ts`, picks the agent for each message. The request tracker, `src/requests/tracker.ts`, notes each turn from the owner and keeps it only when work goes on after the answer.
- **Use it well:** match people by their platform id, never by a name. Throw away a candidate that the answer finished.
- **Anti-patterns:** a record for every message; trusting a channel name a caller wrote.

## Party

- **Intent:** one identity per person, whatever channel they write on.
- **Forces:** the same person is a login on a forge, a number on a chat app and the voice on this computer.
- **Building block:** people, `src/people/people.ts`. Each person has channel ids written `channel:id`; a turn is stamped with the person's id, which travels with the work across agents and machines.
- **Use it well:** owe a record to a person id, not to a chat. An unknown sender stays unknown.
- **Anti-patterns:** guessing who someone is from a name; one record per channel for the same person.

## Home

- **Intent:** say where the work lives: the issue, merge request or idea it belongs to.
- **Forces:** two runs on the same issue overwrite each other; a link and a short reference can name the same thing.
- **Building block:** a request's `home`, in `src/requests/store.ts`, and the comparable form of an issue or merge request in `src/a2a/home.ts`.
- **Use it well:** give a home when the work is accepted, so others can find it and avoid starting it twice.
- **Anti-patterns:** a headline that is only an issue number; work with no home that nobody can find later.

## Reach

- **Intent:** know what the person was told, on which channel, and whether it landed.
- **Forces:** the same news on three channels is noise; "sent" is not "seen".
- **Building block:** the told-the-owner record, `src/notify/told.ts`: one gate and one row per message to the owner, with repeats dropped and nags kept for the digest. Seeing it and answering it are the next step of this work.
- **Use it well:** key every notice by the record it is about, so it is told once across channels.
- **Anti-patterns:** sending straight to a channel and around the gate; a notice with no record behind it.

## Handoff

- **Intent:** pass part of the work to another agent without losing track of it.
- **Forces:** the asking agent must not wait on the other's turn; a restart can lose the work in flight; the answer must come back to the chat it was asked in.
- **Building block:** delegation with a callback, `src/a2a/delegation.ts`. The request tracker keeps how each handoff ended on its link (`done`, `waiting`, `error`, `timeout`, `lost`), with the first link in the answer as its proof.
- **Use it well:** link every handoff to the record it serves. When all of them come back done, the record can settle on that proof.
- **Anti-patterns:** a handoff no record knows about; a lost handoff nobody is told of.

## Check it worked

1. **Browser:** open the documentation site and go to **Architecture** › **Patterns for working around a person**. This page is listed there.
2. **Terminal:** from the repository root, run `pnpm docs:check`. It ends without an error.
3. **Terminal:** for each building block named above, open the file. Each one exists in the repository.

## If something is wrong

- **A file named here no longer exists:** the code moved. Find where the pattern lives now and update its **Building block** line in the same change that moved it.
- **A new feature does not fit any pattern:** check first whether it is one of these under another name. If it really is new, add an entry with the same five parts.
- **`pnpm docs:check` fails on this page:** the error names the line. A common cause is a missing sidebar entry in `docs/.vitepress/config.ts`.
