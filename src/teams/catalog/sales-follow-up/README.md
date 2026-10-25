# Weekly sales follow-up

**Result:** Every Monday morning you get a ready-to-send follow-up for each lead that has gone quiet, and nothing is sent until you approve it.

## Who is in the team

| Agent | What it does |
|---|---|
| `sales` | Keeps your list of leads in `leads.md`, notices who has gone quiet, and drafts short follow-ups for you to approve. |

## What runs on its own

| Schedule | When | What you get |
|---|---|---|
| `sales-monday-follow-ups` | Monday, 09:00 | How many leads went quiet, and one draft message for each. |

## Install it

1. Run `agentx team add sales-follow-up` in the folder that holds your `agentx.json`.
2. Run `agentx connect telegram --agent sales` and follow the steps to pair your bot.

Then tell `@sales` about your leads in Telegram, for example: `new lead: Sam at Example Ltd, sent a quote on Tuesday`.
