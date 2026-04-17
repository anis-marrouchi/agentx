# Slack channel

AgentX connects to Slack via **Socket Mode** — no inbound webhook URL, no
ngrok, just two tokens. The bot reacts to `@mentions` in channels and replies
to DMs; mentions of other agents in the reply cascade through the normal
bot-to-bot delegation chain (same behaviour as Telegram / Discord / WhatsApp).

## Prerequisites

On the Slack side, create an app at [api.slack.com/apps](https://api.slack.com/apps):

1. **Socket Mode** → enable. Generate an **app-level token** with the
   `connections:write` scope. It starts with `xapp-…`.
2. **OAuth & Permissions** → add the following **bot** scopes:
   - `chat:write`
   - `app_mentions:read`
   - `channels:history`, `groups:history`, `im:history`, `mpim:history`
   - `reactions:write`
   - `users:read`
3. **Event Subscriptions** → subscribe the bot to:
   - `app_mention`
   - `message.channels`, `message.groups`, `message.im`, `message.mpim`
4. **Install to workspace** → copy the **bot token** (`xoxb-…`).

## Install the optional deps

Kept out of the default install to keep the CLI lean for users who don't
touch Slack:

```bash
npm install @slack/socket-mode @slack/web-api
```

(Or add both to your project's `package.json` if you've vendored AgentX.)

## Configure

Two paths — pick one.

**Dashboard (recommended):** `/admin` → Channels tab → **Slack** section →
paste the env-var names for the two tokens, optionally pick a default agent,
hit **Connect**. Then put the actual token values in `.env`.

**agentx.json directly:**

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "botToken": "${SLACK_BOT_TOKEN}",
      "appToken": "${SLACK_APP_TOKEN}",
      "agentBinding": "support"
    }
  }
}
```

```bash
# .env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

Restart the daemon. The startup log reports `Slack: enabled` once it connects.

## Routing rules

- **DMs** to the bot always route to the bound agent.
- **Channels / groups / mpim** only route when the bot is `@`-mentioned.
- Messages from other bots (`bot_id` or `subtype=bot_message`) are ignored —
  prevents bot-on-bot loops within a workspace.
- Responses are posted with `mrkdwn: true` by default (Slack's markdown).
  Pass `parseMode: "plain"` on the outgoing message to disable it.

## Replies threading

When a user messages the bot inside an existing thread, the reply lands in
the same thread. When the trigger is a top-level channel message, the reply
is posted at the channel root.

## Known limitations

- No slash-command support yet (the runtime is one-message-in → one-message-out).
- No file upload handling — attachments on incoming messages are dropped.
- Socket Mode means the daemon must be online to receive messages; if the
  daemon restarts, messages sent during the gap are lost. For business-
  critical workflows you'll want a webhook/EventBridge bridge (not shipped).
