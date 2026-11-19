# Stop goodbye loops

![Your agent and the other side talk. The other side says thanks and goodbye, your agent says goodbye once, and that ends the talk. After the end, more thanks are not passed to your agent; a person gets a thanks reaction; a real message opens the talk again.](/diagrams/goodbye-loop.svg)

When your agent talks in a chat with another automated party (another company's agent, a bot, an auto-responder), the end of the talk can turn into a loop: one side says "thank you, goodbye", the other answers "thank you, goodbye", and so on, every message costing a run.

The **courtesy gate** stops this. It keeps a small record for each chat and notes the phase of the talk:

- **during**: the talk is going on. Every message reaches your agent, as always.
- **ending**: the other side said thanks or goodbye. Your agent may answer once.
- **ended**: your agent's answer went out. More "thanks" and "goodbye" messages no longer start a run.

A message with real content (a question, a request such as "thanks, please send it", a photo, a longer text) always reaches your agent and opens the talk again. A short message the gate is unsure about always passes too: "ok", "yes", 👍, and a thanks with an approval word such as "perfect, thanks" or "parfait merci", because it may be the answer to a question your agent asked.

If your agent's goodbye itself asks something ("Goodbye! Shall I send the contract?"), the talk does not end, so the answer reaches your agent.

On Telegram, each bot's private chat with a person is its own talk. In a group, one talk covers every bot in the group, and a message that several of your bots receive is judged once.

It applies to Telegram, WhatsApp, Discord and Slack chats. It does not apply to agent-to-agent (A2A) calls inside your own mesh.

## How it works

1. A message arrives in a chat.
2. The gate reads its text. It knows thanks and goodbye phrases in English, French and Arabic (including Tunisian).
3. If the talk has ended and the message is only thanks or goodbye, the gate checks whether a running workflow is waiting for this chat. If one is, the workflow gets the message as before.
4. Otherwise, in **active** mode, the message is not passed to your agent. It is written in the **gate log** so you can find it and send it on later.
5. If the sender is a person, not a bot, the gate adds a thanks reaction (🙏 by default) to their message instead. No text is sent and no run starts.
6. In **shadow** mode, step 4 and step 5 do not happen: the message reaches your agent as always, and the gate log shows that it **would** have been held.

A safety limit also applies: when a bot sends many messages in a short time (6 in 10 minutes by default), the talk is ended even if the messages are not thanks. People are never held by this limit, and neither are hand-offs between your own agents (one agent @-mentioning another in the chat).

If the gate itself fails (for example the database is busy), the message goes through as if there were no gate, and the daemon log says `[situation] gate error`.

## Settings

All settings sit under `situations` in the daemon config. They are read for each message, so a change takes effect without a restart.

| Setting | Default | What it does |
|---|---|---|
| `situations.mode` | `shadow` | `shadow` only writes what it would hold in the gate log and changes nothing. `active` holds the messages. `off` turns the gate off. |
| `situations.courtesy.onPerson` | `react` | What a person's thanks gets after the talk ended: `react` adds a reaction, `drop` holds it with no reaction, `reply` lets it through to your agent. |
| `situations.courtesy.reaction` | `🙏` | The reaction used for `react`. |
| `situations.backstop.count` | `6` | How many messages from a bot, in the window below, end the talk. |
| `situations.backstop.windowMinutes` | `10` | The window for the count above, in minutes. |
| `situations.maxAge.duringHours` | `12` | A talk with no change for this long is treated as over. |
| `situations.maxAge.endingMinutes` | `60` | A talk left in **ending** this long (your agent never said goodbye) is treated as over. |
| `situations.closing.enabled` | `false` | `true` runs the closing steps of talks you gave closing steps (see [Closing steps](#closing-steps-after-a-talk-ends)). Other talks are not changed. |
| `situations.sources.<id>.enabled` | on | `false` switches one signal source off (see [Signals: who left, who is busy](#signals-who-left-who-is-busy)). |
| `situations.sources.<id>.agents` | all agents | A list of agent ids: the source is used only for these agents. For `whatsapp-groups` and `telegram-members`, a leave counts only in a talk one of these agents has answered in; in other talks it is ignored. |
| `situations.seat.maxFalseNoReply` | not set | The highest false "no reply" rate you accept from the decision seat, for example `0.02` (2 in 100). Not set: the seat never holds a message. See [Let a decision seat judge the unsure messages](#let-a-decision-seat-judge-the-unsure-messages). |
| `situations.seat.noReplyBelow` | `0.2` | The seat says "no reply needed" when its chance that the message needs a reply is at or under this. |
| `situations.seat.minLabeled` | `50` | How many labeled "no reply" answers the report needs before the seat may hold messages. |
| `decisions.seats.situation-phase.mode` | `off` | The seat's own mode: `off`, `shadow` (records only) or `active`. Not set: off, like every decision seat. |
| `decisions.seats.situation-phase.backend` | `decisions.defaultBackend` | Where the seat's answers come from. Name a hosted one, such as `jev`: the default may be the local one, which starts a model program on this machine for each answer. |
| `decisions.seats.situation-phase.explore` | `0.15` | When the seat is active, the share of its "no reply" answers let through anyway and written as **would drop**, so that its mistakes can still be found. |
| `situations.importance.enabled` | `false` | `true` works out each talk's importance (see [Importance](#importance)). |
| `situations.sources.<id>.consent` | `none` | `person`: the source is read only after the person it reads has said yes. A source marked sensitive always needs that yes, whatever this says. |

## Turn it on

The gate starts in **shadow** mode, so you can see what it would do before it does anything.

1. **Terminal:** keep shadow mode for about a week of normal traffic. If you turned it off, turn it back on: `agentx config set situations.mode shadow`.
2. **Terminal:** read what it would have held: `agentx situation log --would-drop`.
3. Check each row. Every one should be a "thanks" or "goodbye" that your agent did not need to answer.
4. **Terminal:** when you are happy with the rows, turn it on: `agentx config set situations.mode active`.

## Send a held message on

1. **Terminal:** list held messages: `agentx situation log --dropped`. Each row starts with a number, for example `#42`.
2. **Terminal:** send that message on: `agentx situation release 42`.
3. The message reaches your agent once, and the talk is open again (**during**).

## See each talk and end it by hand

Each chat's record is also called its **situation**: what kind of talk it is (a **conversation**, or a **meeting** once you give it closing steps) and its phase. You can see it, and change it, on the agent's page or in the terminal.

![The agent page's Activity tab, panel "Conversations now": three chats, each with a chip such as "Conversation · ending", the reason the phase changed, and End and Not this buttons.](/screenshots/agents/situation-chip.png)

**On the dashboard:**

1. **Browser:** open **Settings**, then **Agents**, then the agent.
2. **Browser:** click **Activity** in the left column.
3. Under **Conversations now**, each chat has a chip with its phase, for example **Conversation · ending**, and the reason the phase changed.
4. **Browser:** click **End** to end a talk now. Click **End** again in the box that opens to confirm. More thanks and goodbyes in that chat are now held, as after a goodbye.
5. **Browser:** or click **Not this** when a talk is not ending. It goes back to **during**, and thanks or goodbyes no longer end it, until the talk is ended another way (by you, the safety limit or the age limit).

Only you, the owner, can use these buttons. A person in the chat cannot end or reopen a talk by writing to it, and a real message still reaches your agent after you click **End**.

Like `agentx situation release`, ending or reopening a talk is open to any program on the same machine, without a token. That includes an agent that can run terminal commands there. From another machine it needs the mesh token.

**In the terminal:**

1. **Terminal:** list the talks: `agentx situation list`. Add `--agent <id>` for one agent's chats.
2. Each row starts with a short id, for example `3f2a9c1b`.
3. **Terminal:** end a talk: `agentx situation end 3f2a9c1b`. Or keep it going: `agentx situation not-this 3f2a9c1b`.

**What your agent sees:** in **active** mode, your agent's prompt carries one line that names the phase, for example `[Situation] Conversation, phase: ending (...). If a goodbye is due, say one short goodbye, then stop; do not open a new topic.` A new session gets the line whatever the phase. A session that goes on gets it only in the first 30 minutes after the talk moved to ending or ended, to keep each turn small. When you are busy (Focus or a call), the line adds "The owner is busy now; do not promise an immediate answer from them." It never says why you are busy, since the chat may be with a customer. Shadow mode adds no line.

**For other tools:** each change of phase is published once as the event `situation:phase` (kind `situation`), with who made it: a rule or a person. Agents can subscribe to it like to any event. Like other message events, the event names the channel and the chat id (on WhatsApp, a phone number). The reason the phase changed, which can name a sender, stays on this machine and is not sent to mesh peers.

## Signals: who left, who is busy

A **signal** is a small fact AgentX reads from somewhere else, such as "you are in Focus" or "a person left the group". Each place it reads from is a **signal source**. Every source answers in the same way, and when it cannot tell (the app is not running, the file is missing, the machine has no such feature), it answers **unknown** with the reason. Unknown counts as "nothing known": it never holds a message and never ends a talk.

| Source | What it tells | Where it works |
|---|---|---|
| `widget-hold` | You switched on the hold in AgentX Voice. | Every machine |
| `macos-focus` | macOS Focus or Do Not Disturb is on. | Mac only. On other machines it is not loaded, and its file is never read. |
| `call-hold` | You are on a call (an AgentX call, or another tool that writes the call file). | Every machine |
| `calls` | You are on a call with a given agent now; a call ended. | Every machine |
| `whatsapp-groups` | Someone left, or was removed from, a WhatsApp group. | Every machine with WhatsApp |
| `telegram-members` | Someone left a Telegram group. | Every machine with Telegram |

The first three are your **hold**: while one of them says you are busy, notices wait and are delivered when it ends. This works as before; only the Mac Focus check is now skipped on machines that are not Macs.

**When someone leaves a group:** if the talk in that group is **during** and nobody is left in the group except your own agents, the talk moves to **ending**. Your agent then says one short goodbye at most, as when the other side says goodbye. If other people are still in the group, nothing changes. If AgentX cannot count who is left (WhatsApp limits reads, Telegram refuses the count), nothing changes either.

On Telegram, AgentX now also asks for member changes (`chat_member`). Telegram sends those only to bots that are admins of the group. Your bot does not need to be an admin: without it, AgentX still sees the "left the group" message Telegram posts in the chat, and otherwise who is present stays unknown.

On Telegram, one of your own bots leaving a group is not a party leaving, and never moves a talk. A bot that is not yours (another company's agent) is a party: its leave counts. When several of your bots are in the group, the same leave is counted once, by one bot. If AgentX finds nobody left but cannot confirm that each of your bots it has on record is still in the group, the count is treated as unknown and nothing changes.

These facts stay on the machine that runs the chat. Mesh peers only see the phase change (the `situation:phase` event), never who left.

**See the sources on a machine:**

1. **Terminal:** run `agentx situation sources`.
2. Each loaded source shows what it answers now. A source that only reports events (a leave) shows "reports when it happens".
3. Sources that do not fit this machine are listed as **not loaded**, with the reason, for example `macos-focus  not loaded: needs darwin, this node is linux`.
4. From another machine (`--node`), each source shows only **known** or **unknown**. The answer itself and its reason (which can name the person you are on a call with, or your Focus mode) are shown only on the machine itself.

**Switch a source off:**

1. **Terminal:** `agentx config set situations.sources.whatsapp-groups.enabled false`.
2. Leaves in WhatsApp groups no longer move a talk. Turn it back on with `true`.

**Limit a source to some agents:**

1. **Terminal:** `agentx config set situations.sources.whatsapp-groups.agents '["helper"]'` (use your agent's id instead of `helper`).
2. A leave in a WhatsApp group now moves a talk only when the agent `helper` has answered in it. Talks of your other agents, and talks no agent has answered in yet, stay as they are.
3. **Terminal:** to use the source for all agents again, `agentx config set situations.sources.whatsapp-groups.agents '[]'`.

## Closing steps after a talk ends

Some talks need work after they end: after an interview or a client call, someone writes the notes, the follow-ups need an owner, and you want to hear how it went. **Closing steps** do this for a talk you mark.

When a talk with closing steps ends, AgentX runs the workflow **Situation close**:

1. **Note.** The talk's agent reads the talk's recent messages (at most the last 30, up to 6000 characters) and drafts one note. Its turn is **read only**: it cannot post, write files or send to any chat, so it cannot message the other side. The workflow then posts the note as one comment on the talk's **home**: the GitHub or GitLab issue, pull request or merge request you named.
2. **Follow-ups.** Each follow-up the agent lists becomes an **open promise** with an owner: the talk's agent, you, or an agent you allowed with `--agents`. A follow-up the agent gave to anyone else (the other side, or an agent you did not allow) is kept by the talk's agent, with the named owner in its words, for example "Send the portfolio (named owner: candidate)". A follow-up gets a due time only if a person gave one. One set of promises per end: a re-run opens none. If this node kept no messages of the talk, no promise is opened (the agent had nothing to read), and your message says "No follow-ups". Open promises show with your other requests (`agentx requests list`).
3. **Your message.** You get one message, for example "About the job interview with a candidate: the talk ended (closed). Note: (link). 2 follow-ups, owners named: …". It goes through your hold: while you are in Focus or on a call, it waits.
4. **Message to the other side (optional).** If you gave a closing message, you are asked first, on a card, every time. Nothing reaches the other side without your yes.

Two more rules keep it safe:

- **Talk opened again.** If a real message opens the talk again before the close is done, nothing more from that close is sent (not your message, not the message to the other side). The note and promises already made stay. When the talk ends again, a new close runs.
- **Talk left idle.** The workflow **Situation expiry** waits for the phase's maximum age (`situations.maxAge`), then ends the talk as **stale**. A stale talk gets its note and promises, but no message to you and nothing to the other side.

If another organisation's agent says the talk is over, your agent only goes quiet. No closing steps run on its word alone.

Both workflows are in your workflow folder and show on the **Workflows** page with their runs, like any other workflow. They are added once, the first time they are needed. You can edit them, for example to change what the note asks for; AgentX never overwrites them, even when your edit does not load. A workflow that does not load, or that you deleted, is not written again: no run of it starts, and the daemon log says so once. Only the situation record starts these two workflows: a run started by hand or by an agent is refused.

**What it does not cover yet:** the agent sees only the messages this node kept for the chat: its recent **group** messages. A private one-to-one chat (a typical interview) gives no excerpt today, so its note says no messages were kept and no promises are opened; add the follow-ups yourself. A talk held mostly elsewhere, or older than the last 30 messages, gives the agent a partial excerpt, and the note may miss things. A talk that ended while the daemon was down gets its close at the next start only if it ended in the last 24 hours.

A talk without closing steps is not changed: no workflow runs for it.

**Turn closing steps on:**

1. **Terminal:** `agentx config set situations.closing.enabled true`. Until it is on, step 3 answers that closing steps are off.
2. **Terminal:** find the talk: `agentx situation list`. Each row starts with a short id, for example `3f2a9c1b`.
3. **Terminal:** give it closing steps: `agentx situation closing 3f2a9c1b --purpose "the job interview with a candidate" --home https://git.example.com/team/hiring/-/issues/7`. The home must be a GitHub or GitLab issue, pull request or merge request. **Choose a private one:** the note is written from a private talk, and on an issue of a public repository everyone can read it.
4. To let another agent own some follow-ups, add `--agents helper-agent`.
5. To also thank the other side after the talk, add `--message "Thank you for your time today."`. On WhatsApp, also add `--chat` with the chat id ending in `@g.us`.
6. **Terminal:** for a talk that has not started yet, use `--channel whatsapp --chat <chat id>` instead of the short id.

**For your own workflows:** each change of phase also fires the hook event `on:situation`. A workflow with a `trigger.hook` step on `on:situation` runs on each change; `filter: { phase: [ended] }` limits it to talks that ended. The hook context has the situation id, channel, chat id, the kind of talk (`template`), `from`, `to` (also as `phase`), `endReason` and who made the change (`setBy`).

## Let a decision seat judge the unsure messages

The word list knows thanks and goodbye phrases. Some short messages it cannot place: "ok", 👍, "thanks John", "perfect, thanks". These always pass, because they may answer a question your agent asked. After a talk has ended, most of them still need no answer.

A **decision seat** is a small, cheap model that answers one fixed question with a probability (see [Typed decisions](/architecture/jev)). The seat `situation-phase` is asked about these unsure messages only, and only once a talk is **ending** or **ended**. It answers three things at once: where the talk is now, whether the message **needs a reply**, and how much the talk matters.

It is **off** until you switch it on. Then it works in three steps, and it never holds a message until you have seen how often it is wrong:

1. **Shadow.** The seat is asked about each unsure message whose answer could change something, but the message still reaches your agent at once. When the seat says no reply is needed, the gate log gets a **would drop** row with the seat's call id.
2. **Labels and report.** You read those rows and say, for each, whether the message did need a reply. The **calibration report** then states the **false "no reply" rate**: of the messages the seat said need no reply, how many did.
3. **Active, below your limit.** You set the highest false "no reply" rate you accept, and switch the seat to active. The gate then holds an unsure message the seat says needs no reply, as it holds a "thanks" (a person gets the reaction). It does this only while the report is under your limit, with enough labels.

To be safe, the limit is compared with the **upper end** of the rate's 95% range, not the rate itself: four good labels prove little. Even with no mistakes at all, 50 labels still give an upper end of 7.1%, and about 190 labels are needed to get under 2%. If no limit is set, the seat never holds anything, even when switched to active.

Only answers from the backend and model the seat uses now count. If you switch the backend, or the model behind it changes, the report starts again from zero and the seat stops holding messages until it has enough new labels.

Once the seat is active, the messages it holds no longer reach your agent, so the only new examples of its "no reply" answers are the share it lets through (`explore`, 15% by default) and the held messages you release. Keep reading the would-drop rows and the held messages.

What the seat is sent: the message text, the channel, whether the chat is a group, the phase and why the talk ended (closed, stale, ...), and only the **kind** of sender (person, bot or agent). No name, number or other id of the sender is sent. With `decisions.redactState` on, the message is not stored with the answer either.

If the seat fails (its service is down, out of credits, or slower than 1.5 seconds), the message passes, as without the seat. A held message can be sent on with `agentx situation release`, and that also records that it needed a reply.

**Switch it on (shadow):**

1. **Terminal:** make sure typed decisions are on: `agentx config set decisions.enabled true`.
2. **Terminal:** name the seat with a hosted backend, in shadow. In the daemon config this is `"decisions": { "seats": { "situation-phase": { "mode": "shadow", "backend": "jev" } } }`. From the terminal: `agentx config set decisions.seats.situation-phase.backend jev`, then `agentx config set decisions.seats.situation-phase.mode shadow`.
3. **Terminal:** restart the daemon so the seat's settings are loaded: `agentx daemon restart`.

**Label and read the report:**

1. **Terminal:** list what the seat would have held: `agentx situation log --would-drop`. A row the seat wrote says `seat: no reply needed` and shows its seat call id.
2. **Terminal:** for each row, record whether the message needed a reply: `agentx decisions label <seat call id> needsReply yes` (it did) or `... needsReply no` (it did not).
3. **Terminal:** read the report: `agentx situation seat`. It prints the false "no reply" rate, its upper bound, your limit and "Ready for active: yes" or "no", with the reason.

**Switch it to active:**

1. **Terminal:** set your limit, for example 2 in 100: `agentx config set situations.seat.maxFalseNoReply 0.02`.
2. **Terminal:** `agentx config set decisions.seats.situation-phase.mode active`.
3. **Terminal:** `agentx daemon restart` (seat modes are read at start; the limit is read for each message).
4. **Terminal:** `agentx situation seat`. It shows `Seat situation-phase: active (holds messages)` when the report is under your limit. Otherwise it shows why not, and keeps only recording.

**Switch it off:**

1. **Terminal:** `agentx config set decisions.seats.situation-phase.mode off`.
2. **Terminal:** `agentx daemon restart`.

## Importance

Each talk can carry an **importance**: low, normal or high, with the reason. AgentX works it out from what it already knows:

- **high**: you (the owner) or a client from your `people` list is in the talk, or an open promise on this chat is due within a day or overdue.
- **normal**: an open promise on this chat with no near due time, or a known person from your `people` list.
- **low**: a bot or agent, with no open promise on this chat.
- When nothing is known, the talk keeps its importance (a new talk starts at normal). An active decision seat (see above) can fill it in then.

You see it in `agentx situation list`. When it is high, your agent's `[Situation]` line adds, for example, "This talk matters: a client is in the talk." It never names the person. Importance holds and sends nothing on its own.

It is off by default. **Terminal:** `agentx config set situations.importance.enabled true`.

## Commands

| Command | What it does |
|---|---|
| `agentx situation log` | Lists the newest gate log rows. `--limit <n>` sets how many (50 by default), `--dropped` shows only held messages, `--would-drop` only shadow-mode rows, `--json` prints JSON. |
| `agentx situation release <id>` | Sends a held message on to your agent, once, and opens the talk again. Only rows with outcome **dropped** can be released, and each only once. |
| `agentx situation list` | Lists each chat's talk and phase, newest change first. `--agent <id>`, `--phase during\|ending\|ended`, `--limit <n>`, `--json`. |
| `agentx situation end <id>` | Ends a talk by hand. `<id>` is the first column of `situation list`. |
| `agentx situation not-this <id>` | Says a talk is not ending: back to **during**, and thanks or goodbyes no longer end it. |
| `agentx situation clear <id>` | Forgets a chat's record. Its next message starts a new one. |
| `agentx situation closing <id>` | Gives a talk closing steps: `--purpose`, `--home` (a GitHub or GitLab issue, pull request or merge request), and optionally `--agent`, `--agents`, `--message`. `--clear` removes them. See [Closing steps](#closing-steps-after-a-talk-ends). |
| `agentx situation seat` | Shows the decision seat `situation-phase`: its mode, whether it holds messages now, and its calibration report with the false "no reply" rate. `--json` prints JSON. |
| `agentx situation sources` | Lists the signal sources on this machine, what each answers now, and those not loaded here with the reason. `--json` prints JSON. |

All these commands take `--node <url>` and `--token <token>` to reach another machine, like other daemon commands. The gate log holds the text of chat messages, so from another machine both commands need the mesh token (`--token`); on the same machine no token is needed.

The gate log and each chat's record are kept for 30 days. A held message is stored for release with its text cut to the first 4,000 characters if it is longer.

## Check it worked

1. **Terminal:** run `agentx daemon logs` and look for the line `Courtesy gate: shadow` (or `active`) after a start.
2. In a test chat, send your agent a question, then "Thank you, goodbye!", and let it answer.
3. Send "Thanks again, bye!".
4. **Terminal:** run `agentx situation log`. The last message is listed, as **would drop** in shadow mode or **dropped** in active mode.

To check ending a talk by hand:

1. In a test chat, send your agent a question and let it answer.
2. **Browser:** on the agent's page, open **Activity**. The chat shows **Conversation · during**.
3. **Browser:** click **End**, then confirm. The chip shows **Conversation · ended (person)**.
4. In the test chat, send "Thanks, bye!". In active mode your agent does not answer, and `agentx situation log` lists the message as **dropped**.

To check the signal sources:

1. **Terminal:** run `agentx daemon logs` and look for the line `Signal sources:` after a start. On a machine that is not a Mac it ends with `(not loaded: macos-focus)`.
2. **Terminal:** run `agentx situation sources`. `widget-hold` and `call-hold` answer `false` when you are not busy.
3. Make a WhatsApp test group with your agent's number and one test phone. Send a question there and let your agent answer.
4. On the test phone, leave the group.
5. **Terminal:** run `agentx situation list`. The group's talk shows **ending**, with the reason "the last other party left (whatsapp-groups)".

To check the decision seat:

1. **Terminal:** `agentx situation seat`. It shows `Seat situation-phase: shadow` (or `active`) and the report lines.
2. In a test chat, end a talk (a question, then "Thank you, goodbye!", and your agent's goodbye).
3. Send "ok". Your agent answers as before.
4. **Terminal:** `agentx situation log --would-drop`. If the seat said no reply was needed, the message is listed with `seat: no reply needed` and a seat call id.

To check closing steps:

1. **Terminal:** `agentx config set situations.closing.enabled true`.
2. In a test chat, send your agent a question and let it answer.
3. **Terminal:** `agentx situation list`, then `agentx situation closing <id> --purpose "a test talk" --home <a test issue link>`.
4. **Browser:** open the **Workflows** page. **Situation expiry** has one run waiting.
5. **Terminal:** `agentx situation end <id>`.
6. **Browser:** on the **Workflows** page, **Situation close** has one run. When it is done, the test issue has one note from your agent.
7. You got one message that starts with "About a test talk". **Terminal:** `agentx requests list` lists the follow-ups as open promises, each with an owner.

## If something is wrong

- **The log stays empty:** check that `situations.mode` is not `off` and that the chat is on Telegram, WhatsApp, Discord or Slack. Shadow and active modes only list messages after a talk has ended.
- **A real message was held:** release it with `agentx situation release <id>`, then set `situations.mode` back to `shadow` and report the text, so the phrase list can be fixed.
- **Your agent never ends the talk:** the talk only ends when your agent's reply goes out while the talk is **ending**. If your agent answered with nothing, the talk stays in **ending** and is treated as over after `situations.maxAge.endingMinutes`.
- **`agentx situation log --node <url>` answers HTTP 401:** reading the gate log from another machine needs the mesh token. Pass it with `--token`, or run the command on the machine itself.
- **An old held message is missing from the log:** rows older than 30 days are removed.
- **The Conversations panel says "not available" or is empty:** the panel asks the daemon on the same machine. Check that the daemon runs, and that the chat has had a message since the update. A chat appears under the agent that answered it.
- **The panel says "situations need the daemon on the same machine as the dashboard":** `dashboard.daemonUrl` points to another machine. Set it to the daemon on this machine (for example `http://127.0.0.1:18800`), or use `agentx situation` commands with `--node` and `--token` instead.
- **End answers "this talk has already ended" or "changed meanwhile":** the phase moved while the page was open. Click **Refresh** and try again.
- **`agentx situation end` answers HTTP 401 with `--node`:** ending a talk on another machine needs the mesh token (`--token`).
- **Your agent's prompt has no `[Situation]` line:** the line is added only in **active** mode, and on a session that goes on only while the talk is ending or ended.
- **`release` answers "was already released" or "was not dropped":** the row was sent on before, or it is a shadow-mode row, which was never held.
- **A person left the group but the talk stayed in during:** someone else is still in the group, the count could not be read (the daemon log says `group read after a leave failed` or `member count after a leave failed`), or the talk was not in **during**. Also check that `situations.sources.whatsapp-groups.enabled` (or `telegram-members`) is not `false`, and that `situations.mode` is not `off`.
- **Telegram leaves are never seen:** the bot sees the "left the group" message only when Telegram posts one in the chat. To get every member change, make the bot an admin of the group.
- **`agentx situation sources` shows `macos-focus` as unknown on a Mac:** the daemon may not read the Focus file. Give the app that runs AgentX **Full Disk Access** in System Settings. Until then, Focus does not hold your notices.
- **A talk with closing steps ended but no Situation close run started:** check `situations.closing.enabled` is `true` and `situations.mode` is not `off`. A talk ended by another organisation's agent runs no closing steps. The daemon log says why with a line starting `[situation]`, for example `no agent to write the closing note` when the chat has no agent yet (give one with `--agent`), or `situation-close does not load` / `was deleted` when the workflow file was changed or removed (fix or restore `situation-close.yaml` in the workflow folder).
- **You got no message after a close:** the talk ended as **stale** (no message on purpose), it was opened again before the message went out, or you are in Focus or on a call (the message waits for the hold to end).
- **`agentx situation closing` answers HTTP 409 "closing steps are off":** turn them on with `agentx config set situations.closing.enabled true` (and `situations.mode` must not be `off`).
- **`agentx situation closing` answers "home must be a GitHub or GitLab issue":** the note is posted as a comment, so the home must be an issue, pull request or merge request link. A GitLab link must be on this node's GitLab.
- **`agentx situation closing` answers "a closing message on WhatsApp needs chatId":** add `--chat` with the chat id as WhatsApp names it, ending in `@g.us` for a group.
- **`agentx situation seat` says `off`:** the seat is off until you name it (see [Switch it on](#let-a-decision-seat-judge-the-unsure-messages)), or typed decisions are off (`decisions.enabled`).
- **The report shows 0 answers after a change:** you switched the backend, or the model behind it changed. Only answers from the current one count; label new rows.
- **The seat is active but holds nothing:** `agentx situation seat` says why: no limit set, too few labels, or the upper bound is over your limit. Label more rows, or check the limit.
- **The seat writes no would-drop rows:** it is asked only about short messages the word list is unsure of, after a talk is ending or ended. If its service is down or out of credits, no answer comes and nothing is written; the daemon log shows `[decisions] seat "situation-phase" ... failed`.
- **The seat held a message that needed a reply:** send it on with `agentx situation release <id>`. That labels the seat's answer as wrong. If it happens again, lower `situations.seat.maxFalseNoReply` or switch the seat back to shadow.
- **`agentx situation list` shows no importance:** turn it on with `agentx config set situations.importance.enabled true`. A talk gets it at its next message.
- **`agentx situation sources --node <url>` answers HTTP 401:** the list says whether you are busy and with whom, so from another machine it needs the mesh token (`--token`).
