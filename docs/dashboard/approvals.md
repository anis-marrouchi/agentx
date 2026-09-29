# Approvals — every decision waiting for you, in one place

Agents sometimes need your yes or no before they go ahead: publishing a draft, merging a change, running a new schedule. **Approvals** is one list of everything waiting for you, most urgent first. You can answer from the dashboard (it works on a phone) or from the terminal.

The list brings together four kinds of request:

| Kind | What it is | Yes does | No does |
|---|---|---|---|
| **Card** | A question an agent asked you directly (a *decision card*, explained below) | Tells the agent yes | Tells the agent no |
| **Schedule** | A schedule an agent asked to create or remove ([schedules from chat](../automations/schedules-from-chat.md)) | Turns it on, or removes it | Drops the request, or keeps the schedule |
| **Memory fact** | Something an agent learned from an outside source ([review what agents learn](../jobs/agent-memory.md)) | Lets the agent use it | Keeps it out for good |
| **Wiki lesson** | A lesson proposed for the shared wiki | Writes the article | Declines it |

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

### WhatsApp replies

A card titled **WhatsApp reply to …** holds a reply an agent drafted for a watched WhatsApp chat (see [Triage WhatsApp messages](../jobs/whatsapp-triage.md)). The exact text is shown on the card. **Yes** sends it through wacli within a minute, once; **No** sends nothing. When it expires, nothing is sent, whatever the card says. The chats themselves are set up under **WhatsApp triage: watched chats** at the bottom of the page.

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

To see only one kind, click **Cards**, **Schedules**, **Memory** or **Wiki** at the top. With several machines connected, choose the machine in the top bar's machine menu to see its list.

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
  "digest": { "enabled": true, "time": "09:00" }
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

## For agents: raise a card

Agents raise cards with the `agentx_approval` tool. They don't need anything set up. To try the inbox yourself, raise a card from the terminal:

1. **Terminal:** raise a card as one of your agents (use a real agent id from `agentx agent list`):
   ```sh
   agentx approvals request --agent helper --title "Send the newsletter" \
     --ask "Send the newsletter on Monday?" --recommend "Yes: the draft is reviewed" \
     --if-silent discard --expires 2d
   ```

The daemon also accepts cards over its local API, `POST /approvals` with the fields `title`, `ask`, `recommend`, `if_silent`, `expires` and `source`, plus `raised_by` (the agent id). `GET /approvals` lists what is waiting. Answering is refused on that API on purpose.

## Check it worked

1. **Terminal:** raise a test card with `agentx approvals request` as shown above.
2. **Browser:** open **Approvals**. The card is in the list with **Expires in 2 days, then: discard**.
3. **Browser:** click **No**. The page says the agent will be told no, and the card leaves the list.
4. **Browser:** within a minute, the **Activity** tab shows a short run for that agent on the `approvals` channel. That is the agent reading your answer.
5. **Terminal:** `agentx approvals list` says `nothing waiting`.

## If something is wrong

- **The Approvals tab shows nothing, but `agentx schedule list` shows a request:** the dashboard reads the folder it was started in. Start `agentx board serve` from the same folder as the daemon.
- **"Couldn't read …" above the list:** one of the sources couldn't be read, so the list may be incomplete. The message says which one; the other kinds still work.
- **`unauthorized` when you click a button:** the dashboard has a login token (`dashboard.token`). Open the dashboard through its usual address so the page carries it.
- **An agent gets "Decisions are made by the operator only":** that is expected. Agents can raise cards; only you can answer.
- **An agent gets "already has 25 cards waiting":** it has too many open questions. Answer or let some expire first.
- **No daily message:** check that `digest.enabled` is on, that the time has passed today, and that `notifications.destination` or `digest.destination` is set. Nothing is sent on days when nothing is waiting.
- **The agent never heard the result:** check `notifyAgent` is on, and that the agent still exists on this machine. The daemon log line starting `[approvals]` says what happened.
