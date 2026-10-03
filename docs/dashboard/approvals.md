# Approvals — every decision waiting for you, in one place

Agents sometimes need your yes or no before they go ahead: publishing a draft, merging a change, running a new schedule. **Approvals** is one list of everything waiting for you, most urgent first. You can answer from the dashboard (it works on a phone) or from the terminal.

The list brings together six kinds of item:

| Kind | What it is | Yes does | No does |
|---|---|---|---|
| **Card** | A question an agent asked you directly (a *decision card*, explained below) | Tells the agent yes | Tells the agent no |
| **Schedule** | A schedule an agent asked to create or remove ([schedules from chat](../automations/schedules-from-chat.md)) | Turns it on, or removes it | Drops the request, or keeps the schedule |
| **Memory fact** | Something an agent learned from an outside source ([review what agents learn](../jobs/agent-memory.md)) | Lets the agent use it | Keeps it out for good |
| **Wiki lesson** | A lesson proposed for the shared wiki | Writes the article | Declines it |
| **WhatsApp reply** | A reply an agent drafted for a watched WhatsApp chat ([watch a WhatsApp chat](../jobs/watch-whatsapp.md)) | Sends it through wacli | Drops the draft; nothing is sent |
| **Request** | Something you asked an agent for that failed, ran out of time, was cut off or went quiet ([keep track of what you asked for](../jobs/open-requests.md)) | Hands it back to the agent | Drops the request |

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
4. **Browser:** when the Mac popup is on, a card also has **Show on Mac**. Click it to bring the card back on the Mac after you closed it or its wait ran out. It shows within a minute.

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

## Answer from a card on your Mac

With the popup switched on, your Mac shows a waiting card by itself: a soft chime, one short spoken line, and a small card at the top right of the screen. It follows your light or dark mode.

![The Mac card: who is asking, the question, three meeting times with the recommended one picked, and the suggested message](/screenshots/approvals/mac-card.png)

The card shows who is asking, the background (**context**), the question, the ready-made answers, and the suggested message. When the agent's recommendation starts with one of the answers, that answer carries a dot and is already picked when the card opens, with the agent's reason under the answers. A recommendation that starts any other way picks nothing and is shown whole.

1. Click an answer, or press its number (**1** to **5**). The message below fills in with your pick.
2. Read the message and change the wording if you like. **Edited** shows next to it once you have, with **Reset** to put the suggested message back. If you pick another answer after editing, your edits stay and only the pick in the text changes.
3. Click **Send**, or press **⌘↩**. The agent that asked is told your pick and the exact message, and it does the sending.

Nothing is sent until you click **Send**. **Not now** (or **Esc**), or leaving the card alone, keeps the card waiting in Approvals, where you can still answer it later. A card without a message shows **Yes** (or **Choose**, when it offers answers), **No** and **Not now**.

The card is a plain web page shown by macOS itself. There is no app to install. The page can't load anything from the network, so it uses the Geist typeface when your Mac has it installed and the system typeface otherwise. Drag the card by its header (the top strip with the sender's name) to move it. Click the small arrow at the right of the header to shrink the card to its title, and again to show it all. A card taller than your screen scrolls in the middle, and its buttons stay in view. The card stays on screen when you click another app, until you answer it, click **Not now**, or its wait (`popup.timeoutSeconds`) runs out. If the window can't open, you get the plain macOS dialogs instead: pick an answer and click **Next**, then **Send**. Set `popup.style` to `"dialog"` to always use the dialogs.

The popup behaves like your other notifications:

- **Focus is respected.** While a Focus mode (Do Not Disturb) or the widget's hold is on, nothing pops up. The card appears within a minute after Focus ends.
- **One at a time,** oldest first. Each new card pops up once, and again at each [check-in](#check-ins-a-few-times-a-day).
- **Cards you put off with Later** pop up when they come back. Cards older than a day don't pop up by themselves, so switching the popup on doesn't replay a backlog. Check-ins bring them back.

To switch it on:

1. **Terminal:** turn the popup on:
   ```sh
   agentx approvals settings --popup on
   ```
2. **Terminal:** optionally choose the sound, the voice and the colours, or silence the spoken line:
   ```sh
   agentx approvals settings --popup-sound Glass --popup-voice Samantha --popup-theme dark
   agentx approvals settings --popup-speak off
   ```
   `--popup-sound chime` is the card's own soft chime (the default). Any name from `/System/Library/Sounds` also works, and `none` is silence. `say -v '?'` lists the voices on your Mac.
3. **Terminal:** run `agentx approvals settings` to see what is set.

To see the card without raising one:

1. **Terminal:** run `agentx approvals popup --sample`. It shows the sample above; your click is printed and nothing is recorded.

To show one real card now:

1. **Terminal:** run `agentx approvals popup <key>`, using a key from `agentx approvals list`.

You can also answer a card with choices from the terminal: `agentx approvals approve <key> --choice 2`, and add `--text "…"` to change the message. On the dashboard, a card with choices lists them under **Choices**. Answer it on the Mac or in the terminal, because **Yes** alone doesn't say which one you picked.

## Requests that are not finished

When [open requests](../jobs/open-requests.md) are on, a request you gave an agent that failed, ran out of time, was cut off or went quiet shows in the inbox as a **Request**:

- **Yes** hands it back to the agent. Within a minute the agent gets the request again, in your words, and works on it.
- **No** drops the request. A note you add is kept as the reason.
- **Later** puts it off, like any other item.

Under the inbox, **Open requests** lists everything you asked for that is not finished, oldest first, whatever its state, one card each: a short summary, the agent that has it, why it is not finished, your own words and the agent's last answer. On the card you reply, hand it to an agent, press **Done** or **Drop**: see [decide on a request](../jobs/open-requests.md#decide-on-a-request). **Settings: open requests** below the list turns the feature on and sets who counts as you, the channels, the quiet time and how long closed requests are kept.

## Check-ins: a few times a day

Check-ins go through what is open for you on a schedule, and put each item that needs you on a Mac card. They are off until you switch them on, and they need the popup on too.

At each check-in the daemon:

1. **Brings back waiting cards.** Every card still waiting shows once more, oldest first, one at a time.
2. **Looks at your open reminders** in Apple Reminders. A normal check-in takes the ones due in the next 24 hours or overdue. The daily check-in takes every open one, dated or not.
3. **Asks the agent that owns each reminder to write its card.** The owner is the agent named in the reminder's `agentx:` line (reminders agents create through the mac-pim skill have one). For other reminders, it is the agent you choose with `checkin.agent`. The agent does the homework, such as finding free times in your calendar, and writes the context, the question, two to four answers and a suggested message. It may also say the reminder doesn't need you. It sends nothing. That rule is an instruction in its prompt, not a lock: while it writes the card the agent has its usual tools, the same trust as the [reminders poller](../automations/reminders.md).
4. **Your click goes back to that agent.** It is told your pick, the exact message and the reminder, does what you chose, and ticks the reminder off.

A reminder has one card at a time. If you answer it or the agent says it doesn't need you, and the reminder is still open, it comes back at the next daily check-in.

If writing the card fails, the next check-in tries once more. After a second failure the reminder waits for the next daily check-in. A busy agent is not a failure: the check-in waits for it to be free, up to 25 minutes. A background that runs past 600 characters is cut at the end of a sentence and ends with "…". When a check-in ends with failures and no card, you get one notification that names the reminders and the reason for each.

Each check-in asks at most five agents (`checkin.maxAsksPerPass`), whatever they answer, so a long list of reminders is spread over several check-ins. Reminders that the [reminders poller](../automations/reminders.md) has already handed to an agent are left to that agent.

The default times are 09:00 for the daily check-in, then 11:00, 14:00 and 17:00. If the Mac was asleep or the daemon was off, a missed time is not replayed: the next one runs as usual, and the daily check-in runs once the Mac is back.

To switch check-ins on:

1. **Terminal:** switch the popup and check-ins on, and choose the agent for reminders no agent owns:
   ```sh
   agentx approvals settings --popup on --checkin on --checkin-agent secretary-agent
   ```
2. **Terminal:** optionally change the times and the lists:
   ```sh
   agentx approvals settings --checkin-daily 08:30 --checkin-times 10:00,12:30,15:00,18:00
   agentx approvals settings --checkin-lists "Reminders,Work"
   ```
3. **Terminal:** run a check-in now to see it work. `--daily` takes every open reminder:
   ```sh
   agentx approvals checkin --daily
   ```
   The agents need a minute or two to write the cards. `agentx approvals list` shows them as they arrive, and the Mac card opens for each.

The first time, macOS asks whether AgentX may use Reminders. Click **OK**. The daemon reads Reminders with `remindctl` (`brew install steipete/tap/remindctl`), the same tool as the mac-pim skill.

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
  "popup": { "enabled": false, "style": "card", "theme": "system", "speak": true, "sound": "chime", "volume": 0.4, "timeoutSeconds": 600 },
  "checkin": {
    "enabled": false, "dailyAt": "09:00", "times": ["11:00", "14:00", "17:00"], "lists": ["Reminders"],
    "dueWithinHours": 24, "maxAsksPerPass": 5, "composeTimeoutSeconds": 300
  }
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
| `popup.enabled` | Show waiting cards on this Mac | `--popup on\|off` |
| `popup.style` | `"card"`: the web card. `"dialog"`: plain macOS dialogs | `--popup-style` |
| `popup.theme` | `"system"`, `"light"` or `"dark"` | `--popup-theme` |
| `popup.speak` | Speak one short line when it opens. The line waits while you hold the talk key in AgentX Voice, and plays after. Of several request cards within ten minutes, only the first speaks | `--popup-speak on\|off` |
| `popup.voice` | macOS voice for that line. Unset: the system voice | `--popup-voice` |
| `popup.sound` | `"chime"`, a system sound such as `Glass`, or `""` for none | `--popup-sound` |
| `popup.volume` | Sound volume, 0 to 1 | — |
| `popup.timeoutSeconds` | How long the popup waits before it closes; the card stays waiting | `--popup-timeout` |
| `checkin.enabled` | Run check-ins | `--checkin on\|off` |
| `checkin.dailyAt` | The daily check-in, 24-hour `HH:MM` | `--checkin-daily` |
| `checkin.times` | The other check-ins | `--checkin-times 11:00,14:00` |
| `checkin.timezone` | Time zone for the times. Unset: this machine's | — |
| `checkin.lists` | Your Reminders lists to look at | `--checkin-lists` |
| `checkin.agent` | The agent that writes cards for reminders no agent owns. Unset: those reminders are skipped | `--checkin-agent` |
| `checkin.dueWithinHours` | A normal check-in takes reminders due within this many hours | — |
| `checkin.maxAsksPerPass` | Most agents one check-in asks to write a card, whatever they answer | — |
| `checkin.composeTimeoutSeconds` | How long an agent may take to write one card, counted from the start of its turn. The turn is stopped at the limit | — |

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
| `context` | A few lines of background shown above the question, such as what the other person wrote (up to 600 characters) |

For example, with two choices and a message:

```sh
agentx approvals request --agent helper --title "New meeting date" \
  --ask "Which time should I offer?" --recommend "Thursday: you are free all afternoon" \
  --if-silent discard --choice "Thursday 14:00" --choice "Friday 10:00" \
  --draft "Hello, would {choice} suit you for our meeting?" --say "A client needs a new meeting date" \
  --context "The client asked to move Tuesday's meeting"
```

When you answer yes, the agent's result message includes **Chosen:** and the approved message. The agent sends exactly that text.

The daemon also accepts cards over its local API, `POST /approvals` with the fields `title`, `ask`, `recommend`, `if_silent`, `expires`, `source`, `choices`, `draft`, `say` and `context`, plus `raised_by` (the agent id). `GET /approvals` lists what is waiting. `POST /approvals/checkin` starts a check-in. Answering is refused on that API on purpose.

## Check it worked

1. **Terminal:** raise a test card with `agentx approvals request` as shown above.
2. **Browser:** open **Approvals**. The card is in the list with **Expires in 2 days, then: discard**.
3. **Browser:** click **No**. The page says the agent will be told no, and the card leaves the list.
4. **Browser:** within a minute, the **Activity** tab shows a short run for that agent on the `approvals` channel. That is the agent reading your answer.
5. **Terminal:** `agentx approvals list` says `nothing waiting`.

For the popup (Mac):

1. **Terminal:** run `agentx approvals settings --popup on`.
2. **Terminal:** raise the meeting card from [For agents: raise a card](#for-agents-raise-a-card).
3. **Mac:** within a minute you hear the chime and the spoken line, and the card opens at the top right of the screen. Click a time. The message fills in with it. Click **Send**.
4. **Terminal:** `agentx approvals list` no longer shows the card, and the agent's run on the `approvals` channel starts with your pick.

For check-ins (Mac):

1. **Mac:** in Reminders, add a reminder due today to your `Reminders` list, such as "Reply to the client about the meeting".
2. **Terminal:** run `agentx approvals checkin`.
3. **Terminal:** within a few minutes, `agentx approvals list` shows a card from your `checkin.agent` for that reminder, and the Mac card opens for it.
4. **Terminal:** the daemon log has a line starting `[checkin] check pass:` with the number of cards raised.

## If something is wrong

- **The Approvals tab shows nothing, but `agentx schedule list` shows a request:** the dashboard reads the folder it was started in. Start `agentx board serve` from the same folder as the daemon.
- **"Couldn't read …" above the list:** one of the sources couldn't be read, so the list may be incomplete. The message says which one; the other kinds still work.
- **`unauthorized` when you click a button:** the dashboard has a login token (`dashboard.token`). Open the dashboard through its usual address so the page carries it.
- **An agent gets "Decisions are made by the operator only":** that is expected. Agents can raise cards; only you can answer.
- **An agent gets "already has 25 cards waiting":** it has too many open questions. Answer or let some expire first.
- **No daily message:** check that `digest.enabled` is on, that the time has passed today, and that `notifications.destination` or `digest.destination` is set. Nothing is sent on days when nothing is waiting.
- **No popup appears:** check that `agentx approvals settings` shows **Mac popup on**, that no Focus mode or widget hold is on, and that the card is less than a day old. Each card pops up once; use `agentx approvals popup <key>`, or **Show on Mac** on the Approvals tab, to show it again. The daemon log has a line starting `[approvals] popup`.
- **A card went away and you don't know why:** the daemon log says how each popup ended. `left waiting: not now` means **Not now** or **Esc**, `timed out` means the wait ran out, and `closed` means the window was closed. The card is still in Approvals in all three cases.
- **The card window never opens, but the plain dialogs do:** the web window couldn't start, so AgentX fell back to the dialogs. Run `agentx approvals popup --sample` in a terminal to see the error. To keep the dialogs, set `--popup-style dialog`.
- **Check-ins raise no cards:** check that `agentx approvals settings` shows **Check-ins on**, that `remindctl show today` lists your reminders, and that `checkin.agent` names an agent from `agentx agent list`. The daemon log lines starting `[checkin]` say what happened to each reminder: "no agent owns it", "couldn't compose a card", or the pass totals.
- **A reminder you already answered comes back:** the agent didn't tick it off. It comes back at the next daily check-in while it stays open. Tick it off in Reminders, or tell the agent.
- **No sound or voice:** check the Mac's volume, that `--popup-sound` names a sound in `/System/Library/Sounds`, and that the voice appears in `say -v '?'`.
- **"This card offers choices: pick one":** you clicked **Yes** on the dashboard for a card with choices. Answer it in the popup, or with `agentx approvals approve <key> --choice <n>`.
- **The agent never heard the result:** check `notifyAgent` is on, and that the agent still exists on this machine. The daemon log line starting `[approvals]` says what happened.
