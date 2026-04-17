# Public agents

By default, every agent is **private** — it only answers on the channels it's bound to (Telegram, WhatsApp, etc.) and on cron schedules. Flipping an agent to `access: "public"` opts it in to a token-gated HTTP endpoint so external apps can message it.

## Marking an agent public

**Dashboard:** `/admin` → Agents tab → click "Make public" on the agent's row.

**CLI:** there's no dedicated subcommand yet — edit `agentx.json`:

```json
{
  "agents": {
    "support": {
      "name": "Support",
      "workspace": "./agents/support",
      "tier": "claude-code",
      "mentions": ["@support"],
      "access": "public"
    }
  }
}
```

Then `curl -X POST http://127.0.0.1:18800/reload` (or restart the daemon).

## Calling the public endpoint

```
POST /api/public/agents/<agent-id>/messages
Authorization: Bearer <agx_live_token>
Content-Type: application/json

{
  "message": "What is the refund policy?",
  "context": {
    "sender": "optional-user-label",
    "chatId": "optional-thread-id"
  }
}
```

The caller's token must:

1. Be valid, active, and not expired.
2. Carry either `agent:<agent-id>` or `agent:*`.

The response is whatever the agent returned — same shape as the daemon's `POST /task`. For long-running work, the call blocks until the agent finishes (tasks rarely exceed a few minutes). Callers that need streaming should subscribe to `/api/task/stream` with a matching dashboard scope.

## Error responses

| Status | Meaning |
|---|---|
| 400 | Missing `message`, or invalid JSON |
| 401 | No token, or invalid / revoked token |
| 403 | Token valid but missing the required scope, or the agent is `private` |
| 404 | Agent id not found in config |
| 502 | Upstream daemon unreachable |

## Design notes

- The endpoint lives on the **dashboard server** (port 4202 by default), not the daemon. Dashboard stays the single public-facing surface; the daemon stays on loopback.
- Public agents go through exactly the same runtime as Telegram / WhatsApp messages — same system prompt, same session history, same memory. The only difference is the channel label (`public-api`) used for attribution.
- An agent's public exposure is independent of its model choice, tier, or channels — you can have an agent that answers Telegram, runs on a cron, AND serves an external API, all at once.

## When NOT to use this

- For human users — send them to Telegram / WhatsApp / Discord instead. Public-api is for programmatic callers.
- As a replacement for internal mesh traffic — mesh peers use the `mesh:peer` scope (still rolling out).
