---
title: "4. Cross-channel — GitLab MR → WhatsApp ping"
---

# 4. Cross-channel — GitLab MR → WhatsApp ping

> **Difficulty:** intermediate · **Time:** ~30 minutes

A merge request gets opened on a repo your `qa` agent watches. The agent reviews the diff, and when it spots a breaking change, it pings the on-call engineer **on WhatsApp** — not on GitLab. Humans get alerted on the channel they actually watch; the audit trail stays on GitLab.

This is the "H2A2H chain" — Human-to-Agent-to-Human across two channels. Once you've wired it once, the same `POST /send` plumbing is reusable for every cross-channel handoff: GitHub → Slack, Telegram alert → Discord update, etc.

## What you'll build

Two channels in one config — GitLab inbound, WhatsApp outbound — plus a `qa` agent whose system prompt tells it to call `/send` for breaking-change verdicts.

## Setup

### 1. Wire the GitLab channel

The fastest path is the dashboard's [Admin → Channels → GitLab tab](/reference/dashboard/admin#channels). For CLI/JSON-first operators, the relevant block in `agentx.json`:

```json
"channels": {
  "gitlab": {
    "enabled": true,
    "host": "https://gitlab.example.com",
    "webhookPort": 18810,
    "webhookSecret": "${GITLAB_WEBHOOK_SECRET}",
    "token": "${GITLAB_TOKEN}",
    "routes": [
      { "project": "noqta/api", "agent": "qa" }
    ],
    "agentMappings": [
      { "agentId": "qa", "gitlabUsernames": ["qa-bot"], "token": "${GITLAB_QA_TOKEN}" }
    ]
  }
}
```

In GitLab, register the webhook on your project: `Settings → Webhooks → URL: https://your-host:18810/gitlab → secret: <GITLAB_WEBHOOK_SECRET> → events: Comments, Issues, Merge requests`.

### 2. Pair WhatsApp

WhatsApp uses Baileys with QR pairing. Run:

```bash
agentx daemon start
```

…and watch stdout for the QR code. Scan it from your phone (`WhatsApp → Settings → Linked Devices → Link a device`). Once paired, the daemon writes a session under `.agentx/whatsapp-sessions/`.

Add the channel to the config:

```json
"channels": {
  "whatsapp": {
    "enabled": true,
    "sessionDir": ".agentx/whatsapp-sessions",
    "defaultAgent": "qa",
    "allowFrom": ["+1555..."]
  }
}
```

### 3. Brief the agent

Edit the `qa` agent's `CLAUDE.md` so it knows to fire a WhatsApp ping when it finds breaking changes. The key snippet:

> When you find a breaking-change indicator (API removal, schema migration on a column with FK constraints, signature change on an exported function), call the daemon's `POST /send` with channel `whatsapp` and a short summary. The on-call engineer's number is in `services.oncall.allowedContacts`.

## Cross-channel `/send`

The agent's outbound is a JSON POST to the daemon:

```bash
curl -X POST http://127.0.0.1:18800/send \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "whatsapp",
    "chatId": "+15551234567@s.whatsapp.net",
    "from": "qa",
    "text": "Breaking change in MR !142: ApiV1.removeUser() signature changed. Tag @reviewer."
  }'
```

`from` is the agent id — it shows up as the sender on the destination channel and lets the router enforce per-agent send budgets. `chatId` formatting differs per channel:

| Channel | `chatId` shape |
|---|---|
| Telegram | numeric chat id (e.g. `-1001234567890`) |
| WhatsApp | JID (`<number>@s.whatsapp.net` for DMs, `<id>@g.us` for groups) |
| Discord | snowflake channel id |
| Slack | channel id (e.g. `C012ABCDEF`) |
| GitLab | `mr:<project>:<iid>` or `issue:<project>:<iid>` (`/send` posts a comment) |

For agents written in Claude Code, the easier path is the `agentx_send` MCP tool — see [Journey 10](/journey/10-mcp-server).

## Routing rules

The `routes[]` arrays decide which agent receives a given inbound. Order matters — the first matching route wins. For GitLab specifically, project paths support exact match plus `*` wildcard:

```json
"routes": [
  { "project": "noqta/critical", "agent": "qa-strict" },
  { "project": "noqta/*",        "agent": "qa" },
  { "project": "*",              "agent": "atlas" }
]
```

## Failure modes

The daemon logs every cross-channel send. Common breakages:

- **WhatsApp session expired.** The Baileys session dies after long idle periods. The daemon emits `whatsapp: session not connected, ping dropped` to logs and to the `notifications.destination` (if set). Re-pair via the dashboard.
- **GitLab webhook never fires.** The repo's webhook is on, but the secret doesn't match `${GITLAB_WEBHOOK_SECRET}`. GitLab silently 401s and the daemon never sees the event. Test in `Settings → Webhooks → Edit → Test`.
- **Cascade loop.** Agent A sends to channel X; channel X re-routes to agent A; agent A sends again. The router tags each `/send` with an `agentx-marker` header and refuses to dispatch markers it just emitted (see `src/channels/outbound-marker.ts`). If you build custom adapters, preserve the marker.

## Verifying

Open the [Live page](/reference/dashboard/live) and trigger a test MR:

1. Open an MR on the configured project.
2. Watch `qa`'s card light up; click it for the per-agent task list.
3. Look in the right rail for the inbound webhook task; click it to see input + output.
4. The output JSON contains the `/send` call the agent made — copy the `chatId` and verify it landed on your WhatsApp by scrolling that thread.

For a mesh deployment, the `/send` request can target a peer-bound channel: pass `peer: "<peer-name>"` and the local daemon routes through the mesh transport.

## Next

- [Journey 5 — Hooks and webhooks](/journey/05-hooks-webhooks): generic webhook receiver for non-GitLab platforms (Stripe, Sentry, GitHub).
- [Communication matrix](/reference/communication-matrix): every cross-channel path with payload shapes.
- [GitLab config schema](/reference/config-schema#channels-gitlab): per-agent token mapping, webhook security knobs, route wildcards.
