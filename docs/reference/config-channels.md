# Configuration: channels

The `channels` section of `agentx.json` turns on the apps your agents talk through: Telegram, WhatsApp, GitLab, GitHub, ntfy and browser calls (WebRTC). This page lists every field. For the other sections, see the [Configuration reference](./config.md); for what each channel does, see [Channels](./channels.md).

Every channel is off until you set its `enabled` to `true`. Put secrets in `.env` and point to them with `${VARIABLE}` references.

## Telegram

Set up with `agentx connect telegram` ([connect Telegram](/connect-telegram)). One bot per account; each account is bound to one agent.

| Key | Type | Default | What it does |
|---|---|---|---|
| `channels.telegram.enabled` | boolean | `false` | Turns the Telegram channel on. |
| `channels.telegram.accounts` | map of accounts | `{}` | One entry per bot, keyed by an account name you choose. |
| `token` | string | required | The bot token from BotFather. Use a `${…}` reference. |
| `agentBinding` | string | required | The agent that answers this bot's messages. |
| `allowFrom` | list of strings | — | Who may message this bot: user ids, chat ids (negative numbers) or `@username`. Replaces `channels.telegram.policy.allowFrom` for this account. |
| `pollInbound` | boolean | `true` | When `false`, the bot only sends (notifications, replies) and does not read new messages. Use it when the bound agent lives on another machine, so two daemons don't read the same bot. |
| `channels.telegram.policy.dm` | `"pair"` \| `"block"` | `"pair"` | Direct-message policy. Written by setup; who may write is decided by `allowFrom`. |
| `channels.telegram.policy.group` | `"mention-required"` \| `"all"` | `"mention-required"` | In groups, `mention-required` answers only messages that `@`-mention an agent. |
| `channels.telegram.policy.allowFrom` | list of strings | — | Allowlist used by every account without its own `allowFrom`. If neither is set, all messages are ignored. |

```json
"telegram": {
  "enabled": true,
  "accounts": {
    "helper": { "token": "${TELEGRAM_BOT_TOKEN}", "agentBinding": "helper", "allowFrom": ["@your_username"] }
  }
}
```

## WhatsApp

Set up with `agentx connect whatsapp`, which pairs a phone by QR code.

| Key | Type | Default | What it does |
|---|---|---|---|
| `channels.whatsapp.enabled` | boolean | `false` | Turns the WhatsApp channel on. |
| `channels.whatsapp.sessionDir` | string | `".agentx/whatsapp-sessions"` | Folder that keeps the paired session. Delete it to pair again. |
| `channels.whatsapp.defaultAgent` | string | — | Agent that answers when no route matches. |
| `channels.whatsapp.allowFrom` | list of strings | — | Phone numbers allowed to message the agent (partial match). Add your own number to talk to the agent from your own chat. |
| `channels.whatsapp.routes` | list | `[]` | Send a contact or group to a specific agent. The first match wins. |
| `contact` | string | — | Phone number to match (with or without `+`). |
| `group` | string | — | Group name or id to match (case-insensitive, partial). |
| `agent` | string | required | Agent that answers matching messages. |

### Ingest

Ingest reads contact and group details (and, if you choose, recent messages) into the wiki. Nothing is read unless it is enabled and on an allow list.

| Key | Type | Default | What it does |
|---|---|---|---|
| `channels.whatsapp.ingest.enabled` | boolean | `false` | Turns ingest on. |
| `channels.whatsapp.ingest.mode` | `"metadata-only"` \| `"messages"` | `"metadata-only"` | `messages` also reads the latest messages of each allowed chat. |
| `channels.whatsapp.ingest.allowContacts` | list of strings | `[]` | Phone numbers or ids to read (partial match). |
| `channels.whatsapp.ingest.allowGroups` | list of strings | `[]` | Groups to read. |
| `channels.whatsapp.ingest.denyContacts` | list of strings | `[]` | Contacts never read, even if allowed. |
| `channels.whatsapp.ingest.denyGroups` | list of strings | `[]` | Groups never read, even if allowed. |
| `channels.whatsapp.ingest.messageCap` | number (1–500) | `50` | Most messages read per chat in `messages` mode. |
| `channels.whatsapp.ingest.historyDays` | number (1–365) | `30` | Oldest message age, in days, that is read. |
| `channels.whatsapp.ingest.contactRefreshDays` | number (1–90) | `7` | Days before an unchanged contact is written again. |
| `channels.whatsapp.ingest.throttle.minMsBetweenCalls` | number (≥100) | `1500` | Pause between reads, in milliseconds, so the account isn't flagged. |
| `channels.whatsapp.ingest.throttle.maxCallsPerMinute` | number (≥1) | `20` | Most reads per minute. |
| `channels.whatsapp.ingest.throttle.maxChatsPerSweep` | number (≥1) | `25` | Most chats read in one pass. |
| `channels.whatsapp.ingest.retentionDays` | number (≥0) | `0` | Delete stored raw entries older than this many days. `0` keeps them. |

## GitLab

AgentX receives GitLab webhooks and answers `@`-mentions in issues and merge requests ([watch GitLab](/jobs/watch-gitlab)).

| Key | Type | Default | What it does |
|---|---|---|---|
| `channels.gitlab.enabled` | boolean | `false` | Turns the GitLab channel on. |
| `channels.gitlab.webhookPort` | number | `18810` | Separate port that receives GitLab webhooks. |
| `channels.gitlab.webhookSecret` | string | — | Secret GitLab sends in its `X-Gitlab-Token` header; requests without it are refused. |
| `channels.gitlab.host` | string | `"https://gitlab.com"` | Address of your GitLab server. |
| `channels.gitlab.token` | string | — | Access token used to post comments. |
| `channels.gitlab.autoReplyLegacy` | boolean | `true` | When `true`, the agent's answer is posted as a comment automatically. When `false`, the agent must post its reply itself. An agent's `gitlabAutoReply` overrides this. |
| `channels.gitlab.routes` | list | `[]` | Which agent handles which project. |
| `project` | string | required | Project path, such as `group/project`, or `*` for all other projects. |
| `agent` | string | required | Agent for that project. |
| `channels.gitlab.agentMappings` | list | `[]` | Links GitLab users to agents, so a mention of that user reaches the agent. |
| `agentId` | string | required | The agent. |
| `gitlabUsernames` | list of strings | `[]` | GitLab usernames that stand for this agent. |
| `keywords` | list of strings | `[]` | Accepted for older configs. Routing uses `@`-mentions only. |
| `token` | string | — | This agent's own GitLab token, so it comments as itself. |
| `node` | string | — | Mesh node the agent lives on, when it runs on another machine. |

```json
"gitlab": {
  "enabled": true,
  "host": "https://gitlab.example.com",
  "token": "${GITLAB_TOKEN}",
  "webhookSecret": "${GITLAB_WEBHOOK_SECRET}",
  "routes": [{ "project": "*", "agent": "helper" }]
}
```

## GitHub

| Key | Type | Default | What it does |
|---|---|---|---|
| `channels.github.enabled` | boolean | `false` | Turns the GitHub channel on. |
| `channels.github.autoReplyLegacy` | boolean | `true` | Same as the GitLab setting: post the answer automatically, or let the agent post it. |
| `channels.github.token` | string | — | Personal access token used to post comments. |
| `channels.github.tokenFile` | string | — | File holding the token (first line is read at start). |
| `channels.github.appId` | number | — | GitHub App id, when you use a GitHub App instead of a token. |
| `channels.github.clientId` | string | — | GitHub App client id (preferred over `appId`). |
| `channels.github.privateKeyFile` | string | — | Path to the GitHub App private key file. |
| `channels.github.webhookSecret` | string | — | Secret used to check the `X-Hub-Signature-256` header of each webhook. |
| `channels.github.routes` | list | `[]` | Which agent handles which repository. |
| `repo` | string | required | `owner/repo`, or `*` for all other repositories. |
| `agent` | string | required | Agent for that repository. |
| `channels.github.agentMappings` | list | `[]` | Links GitHub users to agents. |
| `agentId` | string | required | The agent. |
| `githubUsernames` | list of strings | `[]` | GitHub usernames that stand for this agent. |
| `token` | string | — | This agent's own token. |
| `tokenFile` | string | — | File holding this agent's token. |
| `node` | string | — | Mesh node the agent lives on. |

## ntfy

ntfy sends push notifications to your phone. It only sends; it does not receive messages.

| Key | Type | Default | What it does |
|---|---|---|---|
| `channels.ntfy.enabled` | boolean | `false` | Turns ntfy on. |
| `channels.ntfy.server` | string | `"https://ntfy.sh"` | ntfy server; change it if you host your own. |
| `channels.ntfy.topic` | string | — | Default topic. Anyone who knows it can read it, so treat it as a secret. |
| `channels.ntfy.token` | string | — | Access token for protected topics. |
| `channels.ntfy.defaultPriority` | number (1–5) | `3` | Priority when a message sets none. |
| `channels.ntfy.defaultTitle` | string | — | Title when a message sets none (otherwise `AgentX`). |

## Browser calls (WebRTC)

WebRTC lets people call an agent from a browser.

| Key | Type | Default | What it does |
|---|---|---|---|
| `channels.webrtc.enabled` | boolean | `false` | Turns calls on. |
| `channels.webrtc.stunServers` | list of strings | `["stun:stun.l.google.com:19302"]` | Servers that help two devices find each other across networks. |
| `channels.webrtc.turnServers` | list | `[]` | Relay servers, needed when both sides are behind strict firewalls. |
| `urls` | string | required | Relay address. |
| `username` | string | — | Relay user name. |
| `credential` | string | — | Relay password. |
| `channels.webrtc.allowedCallers` | list of strings | `[]` | Mesh peers allowed to start a call. Empty allows all peers. |
| `channels.webrtc.ringNotify` | list | `[]` | Where to send "someone is calling" messages. Empty sends none. |
| `channel` | string | required | Channel to notify, such as `telegram`. |
| `chatId` | string | required | Chat to notify. |
| `accountId` | string | — | Which account of that channel sends it. |
| `channels.webrtc.callUrlBase` | string | — | Address used in the join link. Defaults to `http://` plus `node.bind`; set it when people reach the daemon by another name. |

### Call bot

The call bot joins a call, writes down what is said and posts it to a chat. It does not speak.

| Key | Type | Default | What it does |
|---|---|---|---|
| `channels.webrtc.bot.enabled` | boolean | `false` | Turns the call bot on. |
| `channels.webrtc.bot.defaultAgentId` | string | — | Agent the transcript is credited to. |
| `channels.webrtc.bot.whisperBackend` | `"auto"` \| `"mlx"` \| `"openai"` | `"auto"` | Speech-to-text engine. `auto` tries local MLX Whisper, then OpenAI. |
| `channels.webrtc.bot.whisperModel` | string | — | Speech-to-text model name. |
| `channels.webrtc.bot.whisperLanguage` | string | `"auto"` | Spoken language, or `auto` to detect it. |
| `channels.webrtc.bot.mlxBinary` | string | — | Full path to `mlx_whisper` if the daemon can't find it. |
| `channels.webrtc.bot.transcriptChannel.channel` | string | required | Channel that receives the transcript. |
| `channels.webrtc.bot.transcriptChannel.chatId` | string | required | Chat that receives the transcript. |
| `channels.webrtc.bot.transcriptChannel.accountId` | string | — | Which account of that channel sends it. |
| `channels.webrtc.bot.maxCallMinutes` | number (1–240) | `30` | The bot leaves after this many minutes. |

<!-- No screenshot needed: field reference, with the web flow shown in Settings. -->

## Check it worked

1. **Terminal:** in the folder with `agentx.json`, run `agentx config check`. It prints `✓ Config valid`.
2. **Terminal:** run `agentx config get channels.telegram.enabled` (or the field you changed). It prints the new value.
3. **Terminal:** restart the daemon, then send the agent a test message on that channel. It answers.

## If something is wrong

- **`config check` names a field:** fix that field. A `required` field in the tables above is missing.
- **Telegram ignores every message:** neither the account's `allowFrom` nor `channels.telegram.policy.allowFrom` is set, or your id isn't in it.
- **Telegram logs `409 Conflict`:** two daemons read the same bot. Set `pollInbound` to `false` on the machine that shouldn't read it.
- **GitLab says the webhook failed:** check that `channels.gitlab.webhookPort` is reachable from GitLab and that the secret matches `channels.gitlab.webhookSecret`.
- **A value is empty at runtime:** a `${…}` reference points at a variable missing from `.env`. Add it and restart the daemon.
