# Solo founder ops

**Run a one-person company from Telegram.** An `@ops` agent triages inbound work, keeps tasks current, and delivers the Monday report; a `@books` agent drafts invoices and payment reminders. Both draft-for-approval — nothing external is sent without you.

```
You:    what's on my plate this week?
@ops:   3 open tasks. The ACME proposal stalled 4 days — draft nudge attached.
        @books flags 2 invoices due Friday.
```

## The shape

| Agent | Job | Guardrail |
| --- | --- | --- |
| `@ops` | Triage, tasks, weekly report | Asks before sending anything external |
| `@books` | Invoices, payment follow-ups | Drafts reminders; never sends money-related messages |

Two crons do the recurring work: the Monday 9:00 status report and a Tue/Thu overdue-invoice sweep — both land in your Telegram, failure alerts included.

## Start

Ready-to-run config: [`examples/solo-founder/`](https://github.com/anis-marrouchi/agentx/tree/master/examples/solo-founder)

```bash
cp examples/solo-founder/agentx.json agentx.json
echo "TG_BOT_TOKEN=..." >> .env
mkdir -p workspaces/ops workspaces/books
agentx daemon start
```

## Grow

- Customer-facing WhatsApp intake → [journey ch. 4](../journey/04-cross-channel.md)
- Compounding memory so context survives → [shared wiki](../journey/06-shared-wiki.md)
- A second machine for heavier jobs → [mesh federation](../journey/08-mesh-federation.md)
