# Communication matrix

AgentX supports every communication path: **human-to-agent (H2A)**, **agent-to-human (A2H)**, **agent-to-agent (A2A)**, **cross-channel**, and **cross-mesh**.

## Matrix

| Path | Telegram | WhatsApp | Discord | GitLab | HTTP API |
|---|:---:|:---:|:---:|:---:|:---:|
| **H2A** (human → agent) | mention / DM | route | mention / DM | `@username` | `POST /task` |
| **A2H reply** (agent → human, same thread) | streaming edits | text chunks | text | per-agent token | JSON |
| **A2H initiate** (agent → human, proactive) | `POST /send` | `POST /send` | `POST /send` | `POST /send` | — |
| **A2A delegation** (agent → agent) | per-account bot chain | shared number + name prefix | shared + name prefix | `@mention` webhook | — |
| **Cross-channel** (receive on X, send on Y) | `POST /send` | `POST /send` | `POST /send` | `POST /send` | — |
| **Cross-mesh** (delegate to remote node) | mesh task | mesh task | mesh task | mesh task | `POST /mesh/task` |

## `POST /send` — proactive outbound

Agents can initiate messages on any channel, not just reply:

```bash
curl -X POST http://localhost:19900/send \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "telegram",
    "chatId": "-1001234567890",
    "text": "Deploy complete ✓",
    "agentId": "devops",
    "accountId": "default"
  }'
```

This enables **H2A2H chains**: a human asks an agent on GitLab to notify someone on WhatsApp. The agent calls `/send` to deliver across channels.

## `POST /task` — HTTP entry point for H2A

```bash
curl -X POST http://localhost:19900/task \
  -H "Content-Type: application/json" \
  -d '{"agent":"support","message":"What is our refund policy?"}'
```

Response is a streamed SSE feed of the agent's reply. Also available via `agentx daemon send <agent> <message>`.

## `POST /mesh/task` — cross-node delegation

```bash
curl -X POST http://localhost:18800/mesh/task \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MESH_TOKEN" \
  -d '{"peer":"clawd-server","agent":"devops","message":"Check disk free"}'
```

See [Journey 8 — Mesh federation](/journey/08-mesh-federation) for the full setup.

## GitLab — first-class agent identity

| Concern | Behavior |
|---|---|
| Per-agent identity | Each agent owns a GitLab user + PAT. Agents comment as themselves. |
| Deterministic `@mention` routing | Agent usernames are resolved from tokens at startup via the GitLab API. No manual mapping. |
| Bot-to-bot handoff | QA `@mentions` devops; devops picks it up automatically. |
| Eye reaction | Agents react with 👀 using their own token (never the global one). |
| Cascade prevention | Hidden `<!-- agentx:agentId -->` signature + sent-note dedup + bot-user detection. |
| Human mention filtering | Notes mentioning a non-agent user are ignored. |
| Image attachments | Screenshots in comments are downloaded and passed to the agent. |

## Channel-specific notes

- **Telegram** — multi-account bots, streaming edits with typing indicator, block-stream chunks at ~60 chars.
- **WhatsApp** — Baileys integration, QR pairing first run, per-contact/group routing, shared-number A2A with name prefix.
- **Discord** — mention-based routing, DM support.
- **Webhooks** — generic `POST /webhook/:agentId[/:source]` for Stripe, Sentry, GitHub, etc.
- **Voice / `/ask`** — short-form prompt endpoint tuned for Siri-style integrations (`POST /ask`).
