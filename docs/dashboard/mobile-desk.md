# Desk on your phone

The **Desk** tab of the [phone app](./mobile-app.md) is one board for everything you are involved in: what waits for your answer, what your agents are working on, what has gone quiet, and what ended. You answer from the board, with a tap or in your own words.

The board keeps no list of its own. Every time it is read, each card is placed from the state of the thing it stands for: a decision in [Approvals](./approvals.md), or a request you made to an agent ([Open requests](../jobs/open-requests.md)). A card therefore never says work is running after the work ended, and there is nothing for anyone to update by hand. The tab refreshes on its own every 15 seconds while it is open.

![The Desk tab with two cards waiting for an answer](/screenshots/mobile-app/desk.png)

## Before you start

- Install and pair the [phone app](./mobile-app.md).
- Requests appear on the board when open requests are turned on. See [Open requests](../jobs/open-requests.md). Without them, the board still shows every decision waiting for you.

## Read the board

The line under the title counts what waits for you and since when, what is with agents, and what has no news. Below it are four columns. One is on screen at a time.

1. **Phone:** open the app and tap **Desk**.
2. **Phone:** tap a column to show its cards.

| Column | A card is here when |
|---|---|
| **Your turn** | The next step is yours: a decision is waiting, an agent asked you a question, or a request failed or stopped and needs your word. |
| **With agents** | A request is open and there is proof of work: a task for it is running right now (**Working now**), or something happened under it in the last 3 hours (**Active**). |
| **No news** | A request is open, no task for it is running, and nothing happened under it for 3 hours. |
| **Done** | A request or a decision ended in the last 7 days. The card says how: done with its proof, declined, dropped, answered, or closed because no answer came in time. |

![The With agents column: one request with a task running now, one that changed two hours ago](/screenshots/mobile-app/desk-with-agents.png)

A request with no news for longer than the limit in your request settings (24 hours unless you changed it) is raised to you once and moves to **Your turn**.

## Answer a card

Each answer is a button as wide as the card. Under **Yes** and **No**, the card says in words what the answer does.

1. **Phone:** on **Desk**, under **Your turn**, tap **What is known** on a card to read what the agent checked.
2. **Phone:** tap an answer: one of the choices the card offers, **Yes** or **No**.
3. **Phone:** read what will happen. When the card comes with a suggested message, you can edit it.
4. **Phone:** tap **Choose**, **Yes** or **No** to confirm. Tap **Cancel** to change nothing.

![Confirming the choice "Send Monday", with the message the agent will get](/screenshots/mobile-app/desk-answer-sheet.png)

The answer is recorded where the decision lives, and the agent that asked is told. A card that someone already answered elsewhere is refused with "nothing waiting", and leaves the board at the next refresh.

**Later** answers nothing: the card is hidden for a day (or the time set in your approval settings) and then shown again. A card with a time limit still decides itself on time.

## Write an answer

When an agent asked you a question in a request, or a request needs your word, you answer in your own words.

1. **Phone:** on the card, tap **Write an answer**.
2. **Phone:** type your answer.
3. **Phone:** tap **Send**.

![Writing an answer to an agent's question](/screenshots/mobile-app/desk-write-sheet.png)

The agent that has the request gets your words within a minute and goes on with it. The card moves to **With agents**.

On a card under **With agents** or **No news** the same button is called **Write to the agent**. Use it to add something or to ask where the work stands.

## What the board shows

- **Decisions** from every computer the dashboard can see, the same list as **Needs you** under [Activity](./mobile-fleet.md).
- **Requests** of the computer that runs the dashboard. Requests kept on another computer show only when they need your word.
- Short excerpts only: a title of at most 120 characters and at most 280 characters of what is known.

The Desk is for the owner. It is served only to a paired phone, never to members, guests or agents.

## Check it worked

1. **Phone:** tap **Desk**. The number under **Your turn** matches `agentx approvals list` on the computer that runs the dashboard, plus the requests where an agent asked you a question.
2. **Terminal:** on that computer, list the open requests:
   ```sh
   agentx requests list
   ```
   Each one is on the board, under **Your turn**, **With agents** or **No news**.
3. **Phone:** answer a card. It leaves **Your turn** at once and shows under **Done** with your answer.

## If something is wrong

- **"With agents" and "No news" are always empty** — open requests are off, so nothing is tracked. Turn them on as described in [Open requests](../jobs/open-requests.md).
- **"Requests are off, so nothing would tell the agent"** when you send an answer — the same cause. Turn open requests on, then send it again.
- **"What waits on … could not be read"** — the dashboard cannot reach that computer, so its decisions are missing from **Your turn**. The rest of the board is still right. Start AgentX there, or check the mesh with `agentx mesh list`.
- **"… failed: nothing waiting for …"** — the card was answered somewhere else, or its time ran out. Tap **Refresh**.
- **A card has no "Write an answer" button** — it belongs to another computer. Answer it with **Yes** or **No**, or open that computer's dashboard.
- **The tab stays on "Loading what waits for you…"** — the phone lost its connection. The yellow bar says so; the tab fills in when the phone reconnects.
