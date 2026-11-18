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

Each chat's record is also called its **situation**: what kind of talk it is (for now always a **conversation**) and its phase. You can see it, and change it, on the agent's page or in the terminal.

![The agent page's Activity tab, panel "Conversations now": three chats, each with a chip such as "Conversation · ending", the reason the phase changed, and End and Not this buttons.](/screenshots/agents/situation-chip.png)

**On the dashboard:**

1. **Browser:** open **Settings**, then **Agents**, then the agent.
2. **Browser:** click **Activity** in the left column.
3. Under **Conversations now**, each chat has a chip with its phase, for example **Conversation · ending**, and the reason the phase changed.
4. **Browser:** click **End** to end a talk now. Click **End** again in the box that opens to confirm. More thanks and goodbyes in that chat are now held, as after a goodbye.
5. **Browser:** or click **Not this** when a talk is not ending. It goes back to **during**, and thanks or goodbyes no longer end it, until the talk is ended another way (by you, the safety limit or the age limit).

Only you, the owner, can use these buttons. A person in the chat cannot end or reopen a talk by writing to it, and a real message still reaches your agent after you click **End**.

**In the terminal:**

1. **Terminal:** list the talks: `agentx situation list`. Add `--agent <id>` for one agent's chats.
2. Each row starts with a short id, for example `3f2a9c1b`.
3. **Terminal:** end a talk: `agentx situation end 3f2a9c1b`. Or keep it going: `agentx situation not-this 3f2a9c1b`.

**What your agent sees:** in **active** mode, your agent's prompt carries one line that names the phase, for example `[Situation] Conversation, phase: ending (...). If a goodbye is due, say one short goodbye, then stop; do not open a new topic.` A new session gets the line whatever the phase. A session that goes on gets it only while the talk is ending or ended, to keep each turn small. Shadow mode adds no line.

**For other tools:** each change of phase is published once as the event `situation:phase` (kind `situation`), with who made it: a rule or a person. Agents can subscribe to it like to any event.

## Commands

| Command | What it does |
|---|---|
| `agentx situation log` | Lists the newest gate log rows. `--limit <n>` sets how many (50 by default), `--dropped` shows only held messages, `--would-drop` only shadow-mode rows, `--json` prints JSON. |
| `agentx situation release <id>` | Sends a held message on to your agent, once, and opens the talk again. Only rows with outcome **dropped** can be released, and each only once. |
| `agentx situation list` | Lists each chat's talk and phase, newest change first. `--agent <id>`, `--phase during\|ending\|ended`, `--limit <n>`, `--json`. |
| `agentx situation end <id>` | Ends a talk by hand. `<id>` is the first column of `situation list`. |
| `agentx situation not-this <id>` | Says a talk is not ending: back to **during**, and thanks or goodbyes no longer end it. |
| `agentx situation clear <id>` | Forgets a chat's record. Its next message starts a new one. |

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

## If something is wrong

- **The log stays empty:** check that `situations.mode` is not `off` and that the chat is on Telegram, WhatsApp, Discord or Slack. Shadow and active modes only list messages after a talk has ended.
- **A real message was held:** release it with `agentx situation release <id>`, then set `situations.mode` back to `shadow` and report the text, so the phrase list can be fixed.
- **Your agent never ends the talk:** the talk only ends when your agent's reply goes out while the talk is **ending**. If your agent answered with nothing, the talk stays in **ending** and is treated as over after `situations.maxAge.endingMinutes`.
- **`agentx situation log --node <url>` answers HTTP 401:** reading the gate log from another machine needs the mesh token. Pass it with `--token`, or run the command on the machine itself.
- **An old held message is missing from the log:** rows older than 30 days are removed.
- **The Conversations panel says "not available" or is empty:** the panel asks the daemon on the same machine. Check that the daemon runs, and that the chat has had a message since the update. A chat appears under the agent that answered it.
- **End answers "this talk has already ended" or "changed meanwhile":** the phase moved while the page was open. Click **Refresh** and try again.
- **`agentx situation end` answers HTTP 401 with `--node`:** ending a talk on another machine needs the mesh token (`--token`).
- **Your agent's prompt has no `[Situation]` line:** the line is added only in **active** mode, and on a session that goes on only while the talk is ending or ended.
- **`release` answers "was already released" or "was not dropped":** the row was sent on before, or it is a shadow-mode row, which was never held.
