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
agentx daemon start          # then pair WhatsApp: dashboard → Channels → QR
```

Put the service's procedure docs (required documents, fees, office hours) in `workspaces/intake/references/`.

## Grow it

- Formal multi-step applications as workflows with citizen-facing forms ([BPM — grant application](../../docs/journey/12-bpm-grant-application.md))
- Compounding FAQ wiki from real questions ([shared wiki](../../docs/journey/06-shared-wiki.md))
