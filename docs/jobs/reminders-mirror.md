# See waiting decisions in Reminders and Calendar

When an agent needs your answer, it raises a decision card. Requests can also wait on you. The **Reminders mirror** puts each of these in Apple Reminders as well, with a due time. It then shows in Calendar, and the Mac alerts you when it falls due, the same way your own reminders do.

You still answer on the Desk, the Approvals page or with `agentx approvals`. A reminder cannot hold choices or a draft, so it only tells you that something is waiting and links to where you answer.

It is off by default and works on a Mac.

## What it does

Every minute, on the machine that holds your cards:

- Each card waiting for you, and each request waiting on you, gets one reminder in the list **AgentX Desk**, due 5 minutes after it was raised. It is due no later than the card expires, and it is high priority when the card expires within a day.
- The reminder's notes hold the question, the choices, what the agent recommends, the address where you answer, and a last line such as `agentx: card=<id>`.
- When you answer the card, or it expires or is closed, or the request stops waiting on you, AgentX ticks the reminder off.
- **Ticking off a reminder is not an answer.** If you tick it off or delete it while the card is still waiting, the card stays on the Desk, and AgentX does not add that reminder again.
- While the mirror runs, cards no longer pop up as the floating card on the Mac, so you are not alerted twice. **Show on Mac** on the Approvals page still shows one. A card whose reminder could not be added still pops up. If the mirror stops (you turn it off, or Reminders can't be read), the popup comes back within 5 minutes.
- Check-ins and [due reminders](/automations/reminders) skip these reminders, so a mirrored reminder never turns back into a card or into a task for an agent.
- If a reminder can't be added three times in a row, AgentX stops trying for that card. It is still on the Desk. You get one notification about it, at most once a day.
- If AgentX is not allowed to use Reminders, or the permission prompt is never answered (the daemon runs in the background, so the prompt can go unseen), the cards pop up on the Mac as before. The daemon log says so, with a line such as `[mirror] 2 card(s) could not be added to Reminders; the Mac popup shows them instead`.

If your agents run on several machines, cards already go to your own machine (`approvals.forwardTo`), and the mirror runs there.

## Before you start

- A Mac running the AgentX daemon, holding your cards.
- `remindctl` installed. **Terminal:**
  ```sh
  brew install steipete/tap/remindctl
  ```
- To see the reminders in Calendar: macOS 14 or later. **Calendar:** in the sidebar, turn on **Scheduled Reminders**.

## 1. Turn it on

1. **Terminal:** in the folder with `agentx.json`, run:
   ```sh
   agentx config set native.mirror.enabled true
   ```
2. Optional. To use another list, run `agentx config set native.mirror.list "My list"`. The list must not also be one of `reminders.lists` or `approvals.checkin.lists`, and AgentX refuses the setting if it is. The list is created when it doesn't exist.

The daemon picks up the change within a minute, without a restart.

To turn it off, set `native.mirror.enabled` to `false`. Reminders already in the list stay there; delete them or the list in Reminders. All settings are in the [configuration reference](/reference/config-automation#native).

## 2. Allow access to Reminders

The first time the daemon adds a reminder, macOS asks whether it may. Only the Mac's owner can answer.

1. **Mac:** when the prompt appears, click **Allow**.
2. If you missed it: open **System Settings › Privacy & Security › Reminders** and turn on the program running the daemon (for example `node` or your terminal).
3. **Terminal:** `remindctl status` prints `Reminders access: Full access`.

## Check it worked

1. **Terminal:** run `agentx doctor`. Under **Native** you see `Reminders mirror: 0 open in "AgentX Desk"`, or a higher number.
2. Raise a test card. **Terminal:**
   ```sh
   agentx approvals request --agent <agent-id> --title "Mirror test" \
     --ask "Is the mirror working?" --recommend "Yes" --if-silent discard
   ```
3. Wait up to a minute. **Reminders:** the list **AgentX Desk** has **Mirror test**, due in about 5 minutes.
4. Answer the card on the Approvals page. Within a minute the reminder is ticked off.

## Count what the mirror covered

To check that every card got its reminder, for example over a week, count them per day.

1. **Terminal:** in the folder with `agentx.json`, run:
   ```sh
   agentx approvals mirror-report --start 2030-03-01T08:00:00Z --days 7
   ```
   Leave out `--start` and `--days` for the last 24 hours.
2. Read one line per day, for example:
   ```text
   day 0 (2030-03-01 08:00 UTC to 2030-03-02 08:00 UTC): cards raised 3 / Reminders created 5 (3 cards, 2 requests) / missed 0
   ```
   - **cards raised:** cards that arrived on this machine that day.
   - **Reminders created:** reminders AgentX added that day, for cards and for requests.
   - **missed:** cards that never got a reminder. Each one is listed below the line with the reason.
   - **closed within 5 min:** cards answered or closed before the mirror could reach them. They are not counted as missed.

Reminders added by version 0.181.1 or earlier have no creation time, so they are not in **Reminders created**. They still count as covered for their cards.

## If something is wrong

- **`agentx doctor` says `this machine has no task app`:** this is not a Mac, or `native.adapter` is `"none"`. Turn the mirror on on the Mac that holds your cards.
- **`agentx doctor` shows a last error such as `access`:** the daemon is not allowed to use Reminders. Follow step 2, then wait a minute.
- **The config is refused with `is also in reminders.lists`:** pick a list that agents and check-ins don't read.
- **A card has no reminder:** check the daemon log for lines starting with `[mirror]`. A reminder you ticked off is not added again; the log says so once.
- **Reminders don't show in Calendar:** turn on **Scheduled Reminders** in Calendar, on macOS 14 or later.
- **`mirror-report` lists a card as missed:** the reason says why. `could not be added` means Reminders refused it (see step 2). `no pass reached it` means the daemon was not running, or the mirror was off, while the card waited.
- **You still get the floating card:** the card was raised before the mirror was on, or its reminder could not be added. Cards with an open reminder don't pop.
