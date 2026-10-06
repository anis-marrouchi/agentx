# Solo founder ops

Run a one-person company from Telegram: an **@ops** agent for triage, tasks, and the weekly report, and a **@books** agent for invoices and payment reminders — both draft-for-approval, never send-on-their-own.

## Run it

```bash
cp examples/solo-founder/agentx.json agentx.json
echo "TG_BOT_TOKEN=..." >> .env          # from @BotFather
echo "TG_CHAT_ID=..." >> .env            # your chat with the bot, where scheduled reports go
mkdir -p workspaces/ops workspaces/books
# edit agentx.json: replace @REPLACE-WITH-YOUR-USERNAME with your Telegram username
agentx daemon start
```

Before `agentx daemon start`, put your own Telegram username in `agentx.json`: replace `@REPLACE-WITH-YOUR-USERNAME` under `channels.telegram.policy.allowFrom` with yours (for example `@jane_doe`). The bot ignores every message from anyone not on that list ([Connect Telegram](../../docs/connect-telegram.md#4-allow-people-to-talk-to-the-bot)).

DM your bot, then try:

- `what's on my plate this week?`
- `@books draft an invoice for ACME, 3 days of consulting`
- The Monday 9:00 cron posts the weekly report to your chat (`TG_CHAT_ID`) without being asked. That's its `notify` destination in `agentx.json`; without one, the report only lands in the run history.

## Grow it

- Add WhatsApp for customer-facing intake ([watch a WhatsApp chat](../../docs/jobs/watch-whatsapp.md))
- Give @ops a wiki so context compounds ([approve lessons for the shared wiki](../../docs/jobs/agent-memory.md#7-approve-the-lessons-proposed-for-the-shared-wiki))
