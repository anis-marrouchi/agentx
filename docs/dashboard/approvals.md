# Approvals — every decision waiting for you, in one place

Agents sometimes need your yes or no before they go ahead: publishing a draft, merging a change, running a new schedule. **Approvals** is one list of everything waiting for you, most urgent first. You can answer from the dashboard (it works on a phone) or from the terminal.

The list brings together five kinds of request:

| Kind | What it is | Yes does | No does |
|---|---|---|---|
| **Card** | A question an agent asked you directly (a *decision card*, explained below) | Tells the agent yes | Tells the agent no |
| **Schedule** | A schedule an agent asked to create or remove ([schedules from chat](../automations/schedules-from-chat.md)) | Turns it on, or removes it | Drops the request, or keeps the schedule |
| **Memory fact** | Something an agent learned from an outside source ([review what agents learn](../jobs/agent-memory.md)) | Lets the agent use it | Keeps it out for good |
| **Wiki lesson** | A lesson proposed for the shared wiki | Writes the article | Declines it |
| **WhatsApp reply** | A reply an agent drafted for a watched WhatsApp chat ([watch a WhatsApp chat](../jobs/watch-whatsapp.md)) | Sends it through wacli | Drops the draft; nothing is sent |

Answering here is the same as answering with the older commands (`agentx schedule approve`, `agentx memory facts approve`, `agentx wiki proposals approve`). They keep working, and both ways stay in step.

## What a decision card says

An agent that needs you raises a card instead of asking in chat. Every card has:

| Field | Meaning |
|---|---|
| Title | What it is, in one line |
| Question | The yes/no question |
| Recommends | What the agent advises, and why, in one line |
| Expires | When the card decides itself if nobody answers. Every card has one |
| Then | What happens at that point: `discard`, `keep`, `pause` or `approve` |
| Source | A link to the draft, merge request or issue |
| From | The agent that asked |

When you answer, or when a card expires, the agent that asked gets a message with the result and can carry on.

Only you can answer. Agents can raise cards and read the list, but nothing they can reach approves anything.

## Answer from the dashboard

1. **Browser:** open the dashboard and click the **Approvals** tab (or go to `/approvals`).
2. **Browser:** read the card. Click **Details** to see the excerpt, the source link and exactly what yes and no will do.
3. **Browser:** click **Yes**, **No** or **Later**. **Later** hides the item for a day; a card still expires on time.

![The Approvals tab with two decision cards and a schedule request](/screenshots/approvals/inbox.png)

**Details** shows the source link and what each answer does:

![A card with its details open](/screenshots/approvals/details.png)

On a phone the buttons fill the width of the card:

<img src="/screenshots/approvals/phone.png" alt="The Approvals tab on a phone" width="320">

*Fictional demo data. No real agents, people or messages.*

To see only one kind, click **Cards**, **Schedules**, **Memory**, **Wiki** or **WhatsApp** at the top. With several machines connected, choose the machine in the top bar's machine menu to see its list.

## Answer from the terminal

1. **Terminal:** list what is waiting:
   ```sh
   agentx approvals list
   ```
   Each item starts with a key such as `card:2026-01-05-send-the-newsletter-ab12` or `schedule:friday-summary`.
2. **Terminal:** answer one, using its key:
   ```sh
   agentx approvals approve card:2026-01-05-send-the-newsletter-ab12
   ```
   Use `reject` for no, or `later` to put it off. Add `--note "text"` to pass a note to the agent with your answer.

## Answer from a popup on your Mac

An agent can offer you ready-made answers on a card, for example three free times for a meeting, together with a suggested message. With the popup switched on, your Mac shows the card by itself as soon as it arrives: a soft sound, one short spoken line, then a small window.

1. Pick one of the choices and click **Next**.
2. Read the suggested message. It already contains your pick. Change the wording if you like.
3. Click **Send**. The agent that asked is told your pick and the exact message, and it does the sending.

Nothing is sent until you click **Send**. **Cancel**, **Not now**, or leaving the window alone keeps the card waiting in Approvals, where you can still answer it later. A card without choices shows its question with **Yes**, **No** and **Not now**.

The popup behaves like your other notifications:

- **Focus is respected.** While a Focus mode (Do Not Disturb) or the widget's hold is on, nothing pops up. The card appears within a minute after Focus ends.
- **One at a time,** oldest first. Each card pops up once.
- **Cards you put off with Later** pop up when they come back. Cards older than a day don't pop up, so switching the popup on doesn't replay a backlog.

To switch it on:

1. **Terminal:** turn the popup on:
   ```sh
   agentx approvals settings --popup on
   ```
2. **Terminal:** optionally choose the sound and voice, or silence the spoken line:
   ```sh
   agentx approvals settings --popup-sound Glass --popup-voice Samantha
   agentx approvals settings --popup-speak off
   ```
   `say -v '?'` lists the voices on your Mac. Use `--popup-sound none` for no sound.
3. **Terminal:** run `agentx approvals settings` to see what is set.

To show one card in the popup yourself, for example to try it:

1. **Terminal:** run `agentx approvals popup <key>`, using a key from `agentx approvals list`.

You can also answer a card with choices from the terminal: `agentx approvals approve <key> --choice 2`, and add `--text "…"` to change the message. On the dashboard, a card with choices lists them under **Choices**. Answer it in the popup or in the terminal, because **Yes** alone doesn't say which one you picked.

## Get one reminder a day

Once a day AgentX sends you one message: how many decisions are waiting, and the most urgent one. It never sends one message per card. It goes to the same place as your other notifications (`notifications.destination`, see [Get notified](../jobs/notifications.md)) unless you choose another.

To change the time, or where it goes:

1. **Browser:** on the Approvals page, open **Settings: expiry, later, daily digest** at the bottom.
2. **Browser:** change **Digest time**, or type a destination such as `telegram:123456` in **Digest goes to**.
3. **Browser:** click **Save settings**.

Or in the terminal:

1. **Terminal:** set the time and destination:
   ```sh
   agentx approvals settings --digest-time 08:30 --digest-to telegram:123456
   ```
2. **Terminal:** run `agentx approvals settings` with no options to see what is set.

## Settings

These live under `approvals` in `agentx.json`. Every value shown is the default:

```json
"approvals": {
  "defaultExpiryDays": 3,
  "maxExpiryDays": 30,
  "laterHours": 24,
  "notifyAgent": true,
  "digest": { "enabled": true, "time": "09:00" },
  "popup": { "enabled": false, "speak": true, "sound": "Glass", "volume": 0.4, "timeoutSeconds": 600 }
}
```

| Setting | What it does | Terminal option |
|---|---|---|
| `defaultExpiryDays` | Days a card gets when the agent doesn't say | `--expiry-days` |
| `maxExpiryDays` | The longest any card may wait | `--max-expiry-days` |
| `laterHours` | How long **Later** hides an item | `--later-hours` |
| `notifyAgent` | Tell the agent the result | `--notify-agent on\|off` |
| `digest.enabled` | Send the daily message | `--digest on\|off` |
| `digest.time` | When, as 24-hour `HH:MM` | `--digest-time` |
| `digest.timezone` | Time zone for `time`, such as `Europe/Paris`. Unset: this machine's | `--digest-timezone` |
| `digest.destination` | Where it goes: `{ "channel": "…", "chatId": "…" }`. Unset: `notifications.destination` | `--digest-to channel:chatId` |
| `popup.enabled` | Show new cards in a popup on this Mac | `--popup on\|off` |
| `popup.speak` | Speak one short line when it opens | `--popup-speak on\|off` |
| `popup.voice` | macOS voice for that line. Unset: the system voice | `--popup-voice` |
| `popup.sound` | System sound, such as `Glass`. `""` for none | `--popup-sound` |
| `popup.volume` | Sound volume, 0 to 1 | — |
| `popup.timeoutSeconds` | How long the popup waits before it closes; the card stays waiting | `--popup-timeout` |

## For agents: raise a card

Agents raise cards with the `agentx_approval` tool. They don't need anything set up. To try the inbox yourself, raise a card from the terminal:

1. **Terminal:** raise a card as one of your agents (use a real agent id from `agentx agent list`):
   ```sh
   agentx approvals request --agent helper --title "Send the newsletter" \
     --ask "Send the newsletter on Monday?" --recommend "Yes: the draft is reviewed" \
     --if-silent discard --expires 2d
   ```

A card can also offer ready-made answers. The popup and `agentx approvals approve --choice` use them:

| Field | Meaning |
|---|---|
| `choices` | Up to 5 short answers to pick from, such as three free times |
| `draft` | A suggested message you can edit. `{choice}` is replaced by your pick |
| `say` | The short line the popup speaks. Default: the title |

For example, with two choices and a message:

```sh
agentx approvals request --agent helper --title "New meeting date" \
  --ask "Which time should I offer?" --recommend "Thursday: you are free all afternoon" \
  --if-silent discard --choice "Thursday 14:00" --choice "Friday 10:00" \
  --draft "Hello, would {choice} suit you for our meeting?" --say "A client needs a new meeting date"
```

When you answer yes, the agent's result message includes **Chosen:** and the approved message. The agent sends exactly that text.

The daemon also accepts cards over its local API, `POST /approvals` with the fields `title`, `ask`, `recommend`, `if_silent`, `expires`, `source`, `choices`, `draft` and `say`, plus `raised_by` (the agent id). `GET /approvals` lists what is waiting. Answering is refused on that API on purpose.

## Check it worked

1. **Terminal:** raise a test card with `agentx approvals request` as shown above.
2. **Browser:** open **Approvals**. The card is in the list with **Expires in 2 days, then: discard**.
3. **Browser:** click **No**. The page says the agent will be told no, and the card leaves the list.
4. **Browser:** within a minute, the **Activity** tab shows a short run for that agent on the `approvals` channel. That is the agent reading your answer.
5. **Terminal:** `agentx approvals list` says `nothing waiting`.

For the popup (Mac):

1. **Terminal:** run `agentx approvals settings --popup on`.
2. **Terminal:** raise the meeting card from [For agents: raise a card](#for-agents-raise-a-card).
3. **Mac:** within a minute you hear a sound and the spoken line, and the list of times appears. Pick one, click **Next**, then **Send**.
4. **Terminal:** `agentx approvals list` no longer shows the card, and the agent's run on the `approvals` channel starts with your pick.

## If something is wrong

- **The Approvals tab shows nothing, but `agentx schedule list` shows a request:** the dashboard reads the folder it was started in. Start `agentx board serve` from the same folder as the daemon.
- **"Couldn't read …" above the list:** one of the sources couldn't be read, so the list may be incomplete. The message says which one; the other kinds still work.
- **`unauthorized` when you click a button:** the dashboard has a login token (`dashboard.token`). Open the dashboard through its usual address so the page carries it.
- **An agent gets "Decisions are made by the operator only":** that is expected. Agents can raise cards; only you can answer.
- **An agent gets "already has 25 cards waiting":** it has too many open questions. Answer or let some expire first.
- **No daily message:** check that `digest.enabled` is on, that the time has passed today, and that `notifications.destination` or `digest.destination` is set. Nothing is sent on days when nothing is waiting.
- **No popup appears:** check that `agentx approvals settings` shows **Mac popup on**, that no Focus mode or widget hold is on, and that the card is less than a day old. Each card pops up once; use `agentx approvals popup <key>` to show it again. The daemon log has a line starting `[approvals] popup`.
- **No sound or voice:** check the Mac's volume, that `--popup-sound` names a sound in `/System/Library/Sounds`, and that the voice appears in `say -v '?'`.
- **"This card offers choices: pick one":** you clicked **Yes** on the dashboard for a card with choices. Answer it in the popup, or with `agentx approvals approve <key> --choice <n>`.
- **The agent never heard the result:** check `notifyAgent` is on, and that the agent still exists on this machine. The daemon log line starting `[approvals]` says what happened.
