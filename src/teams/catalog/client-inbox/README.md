# Client inbox on WhatsApp

**Result:** Every client message on WhatsApp gets a polite answer within minutes, and each evening you get the short list of what still needs you.

## Who is in the team

| Agent | What it does |
|---|---|
| `inbox` | Answers clients on WhatsApp from your business notes. Hands you prices, refunds, complaints and dates it cannot decide. |

## What runs on its own

| Schedule | When | What you get |
|---|---|---|
| `inbox-evening-summary` | Monday to Friday, 18:00 | The clients still waiting on you, and how many questions were answered. |

## Install it

1. Run `agentx team add client-inbox` in the folder that holds your `agentx.json`.
2. Run `agentx connect whatsapp --agent inbox` and scan the code with the WhatsApp phone app.

Write your opening hours, services and prices in the agent's workspace (`agents/inbox/CLAUDE.md`, or `AGENTS.md` on other runtimes) so it can answer from them.
