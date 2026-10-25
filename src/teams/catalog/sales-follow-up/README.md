# Sales: leads, brief and follow-ups

**Result:** Every Monday morning you get a ready-to-send follow-up for each lead that has gone quiet, and nothing is sent until you approve it.

**First result:** the next weekday at 08:30, the daily brief with a source link on every line. The first follow-up drafts arrive on Monday at 09:00.

Each weekday morning you also get a short brief: new leads, quiet leads and what changed on your competitors' pages, with a source link on every line. Every Monday it finds new leads that match the customers you describe, and every fact about them links to the page it came from.

## Who is in the team

| Agent | What it does |
|---|---|
| `sales` | Keeps your list of leads in `leads.md` and the people who asked not to be contacted in `opt-outs.md`, researches new leads, watches the competitor pages in `competitors.md`, and drafts short follow-ups for you to approve. |

## What runs on its own

| Schedule | When | What you get |
|---|---|---|
| `sales-competitor-watch` | Weekdays, 07:30 | Nothing sent: it checks the pages in `competitors.md` and keeps what changed for the brief. |
| `sales-weekly-research` | Monday, 08:00 | Up to 10 new leads that match `targets.md`, every fact with its source link. |
| `sales-daily-brief` | Weekdays, 08:30 | New leads, quiet leads and competitor changes, each line with its source. |
| `sales-monday-follow-ups` | Monday, 09:00 | How many leads went quiet, and one draft message for each. |

Every schedule runs read-only: the agent cannot send a message to a lead. People in `opt-outs.md` are left out of every list and draft.

## Install it

1. Run `agentx team add sales-follow-up` in the folder that holds your `agentx.json`.
2. Run `agentx connect telegram --agent sales` and follow the steps to pair your bot.

Then tell `@sales` about your leads in Telegram, for example: `new lead: Sam at Example Ltd, sent a quote on Tuesday`. Write the customers you look for in `targets.md` and the competitor pages in `competitors.md`, in the agent's folder. See `docs/jobs/sales.md`.
