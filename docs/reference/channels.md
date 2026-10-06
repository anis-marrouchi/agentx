# Channels

A channel receives a message from another tool and routes it to an agent, then carries the reply back. Most channels are set up in the dashboard under **Settings › Channels**; the rest are set in `agentx.json` (see the [configuration reference](./config.md)).

| Channel | What it does | Where to set it up |
|---|---|---|
| Telegram | Chats with a bot, in private messages or in groups when the bot is tagged | **Settings › Channels › Telegram**, the setup wizard, or `agentx connect telegram`. See [Connect Telegram](../connect-telegram.md) |
| WhatsApp | Answers from a WhatsApp account that AgentX pairs with by QR code. See [Answer customers on WhatsApp](../jobs/answer-whatsapp.md) | **Settings › Channels › WhatsApp**, or `agentx connect whatsapp` |
| GitLab | Reacts to issues, merge requests and comments sent by a GitLab webhook | **Settings › Channels › GitLab**. See [Watch GitLab](../jobs/watch-gitlab.md) |
| GitHub | Reacts to GitHub webhook events, such as pull requests | **Settings › Channels › GitHub** |
| Webhooks | Starts workflows from other services (for example Sentry, Stripe, Vercel, or your own) | **Settings › Webhooks**, or `agentx webhook add`. `agentx webhook sources` lists the known sources |
| push | Sends notifications to the AgentX [phone app](../dashboard/mobile-alerts.md). Outbound only | `channels.push`, or `agentx notifications push` |
| ntfy | Sends push notifications to your phone through the ntfy app. Outbound only | `channels.ntfy`, or `agentx notifications ntfy`. See [Get notified](../jobs/notifications.md) |
| Calls (WebRTC) | Voice calls with an agent in the browser, at `/call` on the daemon | **Settings › Channels › Calls (WebRTC)**, or `channels.webrtc` |

**Telegram ignores everyone until you allow them.** A new Telegram bot drops every message unless the sender is on an allow list: `channels.telegram.policy.allowFrom` for all bots, or `allowFrom` on one bot's account. Each entry is a Telegram user ID, a chat ID, or an `@username`. A dropped message shows in `agentx daemon logs` as `not in allowlist`.

**WhatsApp answers everyone until you limit it.** The opposite of Telegram: with `channels.whatsapp.allowFrom` empty or unset, the agent replies to every chat and group on the paired number. Pair a separate number and fill the list first; see [Answer customers on WhatsApp](../jobs/answer-whatsapp.md#_1-before-you-pair).

**Slack and Discord are not supported as live channel adapters in this build.** Do not paste their tokens into a stale prompt or example. A connection record alone does not make an adapter run.

**Agents can attach files to answers in the phone app and the web chat.** The agent saves the file in its workspace and ends its answer with one line per file, `<agentx-artifact>{"filename":"charts/orders.png","mime":"image/png"}</agentx-artifact>`. The line is removed from the answer. The [phone app](../dashboard/mobile-chat.md#pictures-and-files-in-an-answer) shows the file under the answer; the daemon's web chat (`POST /chat`) returns it in `artifacts`. Agents in the phone app learn this at the start of each conversation.

Keep channel credentials private. The dashboard stores only the *name* of the environment variable that holds a token; the token itself goes in the `.env` file next to `agentx.json`.

## Check it worked

1. **Browser:** open **Settings › Channels**. Each channel you set up shows **live**.
2. **Terminal:** run `agentx channel list` to see each channel and the agent it is bound to.
3. Send a test message on the channel. It appears in [Activity](../dashboard/activity.md), with the agent's reply.

## If something is wrong

- **A channel shows off or not set up:** open it in **Settings › Channels** and check it is enabled and bound to an agent.
- **Telegram stays silent:** check the allow list above, then look for `not in allowlist` in `agentx daemon logs`.
- **A webhook event never arrives:** first check that the other tool sent it (its webhook delivery log), then open `/admin/health` on the dashboard and [Activity](../dashboard/activity.md).
- **Still stuck:** run `agentx doctor` and follow [It's not answering](../help/its-not-answering.md).
