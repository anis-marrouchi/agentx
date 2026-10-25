# Posts in your voice

**Result:** Every Friday next week's posts are planned in your content calendar, every Monday they are drafted in your voice from your past posts, and nothing is published until you approve it.

## Who is in the team

| Agent | What it does |
|---|---|
| `content` | Learns your voice from your past posts in `voice/`, keeps the calendar in `calendar.md`, drafts each planned post for LinkedIn or X and holds it for your approval. |

## What runs on its own

| Schedule | When | What you get |
|---|---|---|
| `content-weekly-calendar` | Friday, 10:00 | Next week's planned posts, added to `calendar.md`. |
| `content-weekly-drafts` | Monday, 08:00 | One draft for each post planned this week, each naming the past posts it followed, waiting in your Approvals inbox. |

## Install it

1. Run `agentx team add content` in the folder that holds your `agentx.json`.
2. Put a few of your past posts in `agents/content/voice/`, one post per `.md` or `.txt` file.
3. Run `agentx connect telegram --agent content` and follow the steps to pair your bot.

Approve a draft with `agentx approvals approve content:<id>`. With a LinkedIn or X connector on the agent it is posted; without one it is saved in `agents/content/ready/`, ready to paste.

Full guide: `docs/jobs/content.md`.
