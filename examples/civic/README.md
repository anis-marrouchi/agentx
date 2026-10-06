# Public service intake

A two-tier civic pattern: a **free, public-facing WhatsApp intake bot** answering procedure questions in the citizen's language, and an **internal caseworker agent** that classifies requests and prepares case files for human officers — with the intent ledger as the audit trail public bodies need.

Why this shape:

- **Public tier ≠ privileged tier.** The citizen-facing agent only reads procedure docs and collects summaries; the internal agent holds no public channel. A prompt-injected citizen message can't reach case data.
- **Auditable by construction.** Every dispatch is in the append-only ledger — `agentx ledger replay` reconstructs any decision when a case is contested.
- **Humans decide.** The caseworker agent prepares and queues; officers approve.

## Run it

```bash
cp examples/civic/agentx.json agentx.json
echo "TG_INTERNAL_BOT_TOKEN=..." >> .env
mkdir -p workspaces/{intake,caseworker}
# edit agentx.json: replace @REPLACE-WITH-YOUR-USERNAME with your Telegram username
agentx daemon start          # then pair WhatsApp: dashboard → Channels → QR
```

Before `agentx daemon start`, put your own Telegram username in `agentx.json`: replace `@REPLACE-WITH-YOUR-USERNAME` under `channels.telegram.policy.allowFrom` with yours (for example `@jane_doe`). The internal bot ignores every message from anyone not on that list ([Connect Telegram](../../docs/connect-telegram.md#4-allow-people-to-talk-to-the-bot)).

**Use a dedicated WhatsApp number for the intake bot.** This example sets `"allowFrom": ["*"]` so the bot answers any member of the public, which means it answers every chat on the paired number. Never pair a personal or staff number. WhatsApp can also ban a number it thinks is automated. Read [Before you pair WhatsApp](../../docs/reference/channels.md#before-you-pair-whatsapp) first.

Put the service's procedure docs (required documents, fees, office hours) in `workspaces/intake/references/`.

## Grow it

- Formal multi-step applications as workflows with citizen-facing forms ([workflows](../../docs/dashboard/workflows.md))
- Compounding FAQ wiki from real questions ([approve lessons for the shared wiki](../../docs/jobs/agent-memory.md#7-approve-the-lessons-proposed-for-the-shared-wiki))
