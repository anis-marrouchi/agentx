# Client inbox on WhatsApp

**Result:** Every client message on WhatsApp gets a polite answer within minutes, and each evening you get the short list of what still needs you.

**First result:** the first client message after you connect WhatsApp is answered within minutes. The first evening summary arrives at 18:00 on the next weekday.

## Who is in the team

| Agent | What it does |
|---|---|
| `inbox` | Answers clients on WhatsApp, and by email if you connect a mailbox, from your business notes. Hands you prices, refunds, complaints and dates it cannot decide. |

## What runs on its own

| Schedule | When | What you get |
|---|---|---|
| `inbox-evening-summary` | Monday to Friday, 18:00 | The clients still waiting on you, and how many questions were answered. |

## Install it

1. Run `agentx team add client-inbox` in the folder that holds your `agentx.json`.
2. Run `agentx connect whatsapp --agent inbox` and scan the code with the WhatsApp phone app.
3. Optional: run `agentx connect email --agent inbox` to answer email too. Each email reply waits in Approvals until you send it.

Write your opening hours, services and prices in the agent's workspace (`agents/inbox/CLAUDE.md`, or `AGENTS.md` on other runtimes) so it can answer from them.
