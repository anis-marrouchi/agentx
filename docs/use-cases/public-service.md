# Public service intake

**A citizen-facing intake bot with the audit trail public bodies need.** A free public tier answers procedure questions on WhatsApp in the citizen's language (Arabic, French, English); an internal caseworker agent classifies requests and prepares case files for human officers. Every dispatch lands in the append-only intent ledger.

## Why this shape

- **Public tier ≠ privileged tier.** The intake agent reads procedure docs and collects structured summaries — it holds no case data and no internal channel. A prompt-injected citizen message has nothing privileged to reach.
- **Auditable by construction.** When a case is contested, `agentx ledger replay` reconstructs exactly what was dispatched, when, and why — the compliance story most chatbot deployments can't tell.
- **Humans decide.** The caseworker agent prepares and queues; officers approve. Uncertainty routes to human review, not to a guess.
- **Self-hosted.** Citizen conversations stay on infrastructure the institution controls — no third-party SaaS processing.

This is the free/paid split in practice: the public intake tier costs little and serves everyone; the internal ops tier is where budget and value concentrate.

## Start

Ready-to-run config: [`examples/civic/`](https://github.com/anis-marrouchi/agentx/tree/master/examples/civic)

```bash
cp examples/civic/agentx.json agentx.json
echo "TG_INTERNAL_BOT_TOKEN=..." >> .env
mkdir -p workspaces/{intake,caseworker}
agentx daemon start        # pair WhatsApp from the dashboard QR
```

Drop the service's procedure docs into `workspaces/intake/references/`.

## Grow

- Formal multi-step applications with citizen forms → [BPM — grant application](../journey/12-bpm-grant-application.md)
- FAQ wiki that compounds from real questions → [shared wiki](../journey/06-shared-wiki.md)
