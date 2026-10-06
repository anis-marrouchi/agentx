# Configuration: channels

The `channels` section of `agentx.json` turns on the apps your agents talk through: Telegram, WhatsApp, GitLab, GitHub, phone app notifications (push), ntfy and browser calls (WebRTC). This page lists every field. For the other sections, see the [Configuration reference](./config.md); for what each channel does, see [Channels](./channels.md).

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

Set up with `agentx connect whatsapp`, which pairs a phone by QR code. Step by step: [Answer customers on WhatsApp](../jobs/answer-whatsapp.md).

| Key | Type | Default | What it does |
|---|---|---|---|
| `channels.whatsapp.enabled` | boolean | `false` | Turns the WhatsApp channel on. |
| `channels.whatsapp.sessionDir` | string | `".agentx/whatsapp-sessions"` | Folder that keeps the paired session. Delete it to pair again. |
| `channels.whatsapp.defaultAgent` | string | — | Agent that answers when no route matches. |
| `channels.whatsapp.allowFrom` | list of strings | — | Phone numbers allowed to message the agent (partial match). Add your own number to talk to the agent from your own chat. Empty or unset, the agent answers every chat and group. |
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

## WhatsApp triage

Watched WhatsApp chats, read by an agent that sorts each message and drafts replies for your approval. Messages come from `wacli sync --webhook` to `POST /webhook/wacli`, not from the WhatsApp channel above; the two are independent. Set up with [Watch a WhatsApp chat](../jobs/watch-whatsapp.md), the **WhatsApp triage** block in **Settings › Webhooks**, or `agentx whatsapp triage`.

| Key | Type | Default | What it does |
|---|---|---|---|
| `whatsappTriage.enabled` | boolean | `false` | Turns triage on. Off, the webhook answers `404`. |
| `whatsappTriage.secretEnv` | string | `"WACLI_WEBHOOK_SECRET"` | Environment variable holding the secret given to `wacli sync --webhook-secret`. Unset, every message is refused (`503`). |
| `whatsappTriage.batchSeconds` | number (0–600) | `20` | Messages from one chat within this many seconds go to the agent as one task. |
| `whatsappTriage.timezone` | string | this computer's | Time zone for quiet hours, for example `Europe/Paris`. |
| `whatsappTriage.allowAutoAck` | boolean | `false` | Second switch for rules with `autoAck`. Both must be on. |
| `whatsappTriage.describeMedia` | boolean | `true` | Download pictures for the agent to look at, and transcribe voice notes when speech to text is set up (`voice.stt`). |
| `whatsappTriage.wacli.bin` | string | `"wacli"` | The wacli program, or its full path. |
| `whatsappTriage.wacli.account` | string | — | `wacli --account` name, when several accounts are paired. |
| `whatsappTriage.wacli.store` | string | — | `wacli --store` folder. |
| `whatsappTriage.rules` | list | `[]` | Watch rules. The first enabled match wins. A message no rule matches is dropped and not stored. |
| `id` | string | required | Short name: lowercase letters, digits, `-` and `_`. |
| `enabled` | boolean | `true` | Turns the rule on or off. |
| `chats` | list of strings | `[]` | Chats to watch: a contact's JID (`15550001111@s.whatsapp.net`), a group's JID (`…@g.us`), or a phone number. |
| `senders` | list of strings | `[]` | Only messages from these people, in any chat the rule covers. A rule needs at least one chat or sender. |
| `agent` | string | required | Agent on this computer that triages the messages. |
| `prompt` | string (≤4000) | — | Extra instructions: who the contact is, where issues go, how to reply. |
| `quietHours.start`, `quietHours.end` | `"HH:MM"` | — | No notifications in this window. It may cross midnight. Triage and drafts still happen. |
| `autoAck` | boolean | `false` | Send the agent's reply to messages it marks `ack` without asking. Needs `allowAutoAck` too. |

Every other reply waits in **Approvals** as a `whatsapp:` item and is sent only when you say yes.

```json
"whatsappTriage": {
  "enabled": true,
  "rules": [
    {
      "id": "test-contact",
      "agent": "helper",
      "chats": ["+1 555 000 1111"],
      "prompt": "Open bug reports in the tracker project example/app.",
      "quietHours": { "start": "22:00", "end": "07:00" }
    }
  ]
}
```

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
| `channels.github.cloudSessions` | boolean | `false` | Lets agents with `cloudSessions.enabled` send this channel's issue and pull request tasks to Claude cloud sessions. Both must be on. See [Send coding tasks to Claude cloud sessions](/jobs/cloud-sessions). |
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
| `channels.github.issueActions` | list of strings | `["opened", "reopened", "assigned"]` | Issue changes that start a run. Anything else, such as `labeled`, `edited` or `closed`, starts nothing. |
| `channels.github.pullRequestActions` | list of strings | `["opened", "reopened", "ready_for_review"]` | Pull request changes that start a run. |
| `channels.github.ignoreOwnChanges` | boolean | `true` | A label, assignment, close or edit made by an account AgentX posts with starts no run. This covers the GitHub App, the token owners, the `githubUsernames` above and accounts of other computers on the mesh. Opening or reopening an issue always counts. |
| `channels.github.debounceSeconds` | number (0–3600) | `30` | Several changes to one issue or pull request within this many seconds start one run. The run sees the latest state and lists every change. Each new change restarts the wait. `0` starts a run for every change. |

### Which changes start a run

GitHub sends a separate message for each change to an issue: opened, labeled, assigned, closed. Without limits, one new issue could start the agent three or four times. AgentX filters these messages in three steps:

1. **Project rule.** If the repository has a project rule with an `actions` list under `github.issues` or `github.pull_request`, that list decides which changes count. Its other filters, such as required labels, still apply.
2. **Channel list.** Without such a list, `issueActions` or `pullRequestActions` decides. A rule that only sets labels does not let `closed` through. To run on `closed`, add it to a rule's `actions` list or to the channel list.
3. **AgentX's own changes.** A label or assignment that AgentX made itself, for example when it files an issue for an agent, starts nothing while `ignoreOwnChanges` is on.

Changes that pass all three steps wait `debounceSeconds` before the agent starts, so a burst becomes one run.

```json
"github": {
  "enabled": true,
  "routes": [{ "repo": "example/app", "agent": "helper" }],
  "issueActions": ["opened", "reopened", "assigned"],
  "ignoreOwnChanges": true,
  "debounceSeconds": 30
}
```

An agent never answers its own comment. On a mesh, each computer tells its peers which GitHub accounts it posts with, so the computer that receives the webhook also knows a comment that another computer posted for an agent. This needs no setting; both computers must run a version that has it.

## push

Sends notifications to the AgentX [phone app](../dashboard/mobile-alerts.md). It only sends; it does not receive messages. One computer hosts the phone app and sends; every other computer sets `relayTo` and passes its notifications to that one over the mesh.

| Field | Type | Default | What it does |
|---|---|---|---|
| `channels.push.enabled` | boolean | `false` | Turns phone app notifications on. |
| `channels.push.subject` | string | — | Contact the push services can reach you at: `mailto:you@example.com` or an `https://` address. Required on the computer that hosts the phone app. |
| `channels.push.keysFile` | string | `".agentx/push-keys.json"` | Where `agentx app push-keys` saves the key pair, relative to the folder AgentX runs in (the one that holds `agentx.json`). |
| `channels.push.relayTo` | string | — | Mesh peer that hosts the phone app. Set it on every other computer; leave it out on the host. A phone paired with a computer that sets it turns notifications on through that computer, and the host sends them. That needs a `token` of its own for the host in this computer's `mesh.peers`, with the same `token` for this computer in the host's: `MESH_TOKEN` alone is refused. |
| `channels.push.ttlSeconds` | number | `86400` | How long the push service keeps trying a phone that is offline. |
| `channels.push.keepRecent` | number | `50` | How many recent notifications the app's **Alerts** tab keeps. |
| `channels.push.allowedHosts` | list of strings | `["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"]` | Push services a phone may turn notifications on with. Each entry also covers its subdomains. The defaults cover Chrome and Android, Firefox, Safari and iPhone, and Edge. AgentX refuses any other address, because it sends to whatever address the phone gives. |

A message's chat ID picks the phones: `default` sends to every phone that turned notifications on, and a device id from `agentx app devices` (it starts with `tok_`) sends to that phone only. On the host, a phone paired with another computer has the id `<computer>:tok_…`, where `<computer>` is the name the host gives that computer in `mesh.peers`.

## app

The phone app beyond pairing and notifications: the AgentX Android app and place reminders. How to set them up, step by step: [Place reminders](../dashboard/mobile-places.md).

| Field | Type | Default | What it does |
|---|---|---|---|
| `app.android.packageName` | string | `"dev.agentx.phone"` | The Android app's package name (its `agentxApplicationId` when it was built). |
| `app.android.certFingerprints` | list of strings | `[]` | SHA-256 fingerprints of the keys that signed the Android app, as `AB:CD:…` (32 pairs). With at least one, this computer answers `/.well-known/assetlinks.json` and Chrome shows the app without an address bar. Empty: that address answers 404 and Chrome shows a slim address bar. |
| `app.places.enabled` | boolean | `true` | Turns place reminders on. Off: the phone app and the Places page say so, and phones' reports are refused. |
| `app.places.file` | string | `".agentx/places.json"` | Where places and their reminders are kept, relative to the folder that holds `agentx.json`. |
| `app.places.defaultRadiusMeters` | number | `150` | Size of a new place when none is given, in metres. |
| `app.places.minRadiusMeters` | number | `100` | Smallest place allowed. Android rarely notices smaller circles reliably. |
| `app.places.maxRadiusMeters` | number | `5000` | Largest place allowed. |
| `app.places.maxPlaces` | number (1 to 100) | `50` | Most places you can save. Android lets one app watch at most 100. |
| `app.places.maxRulesPerPlace` | number (1 to 50) | `10` | Most reminders on one place. |
| `app.places.cooldownMinutes` | number (0 to 1440) | `10` | A reminder set to fire every time fires at most once in this many minutes, so a phone at the edge of a place doesn't buzz again and again. |
| `app.places.maxEventAgeMinutes` | number (1 to 1440) | `30` | A crossing the phone could only report later, for lack of signal, is dropped once it is older than this. |
| `app.places.syncMinutes` | number (15 to 1440) | `60` | How often the Android app checks for added or removed places. Android runs background checks at most every 15 minutes. |

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
| `channels.webrtc.camera.width` | number (160–3840) | `1280` | Picture width the phone app asks for when it [shares its camera](../dashboard/mobile-camera.md). The phone uses the nearest size its camera supports. |
| `channels.webrtc.camera.height` | number (120–2160) | `720` | Picture height the phone asks for. |
| `channels.webrtc.camera.frameRate` | number (1–60) | `15` | Frames per second the phone asks for. |
| `channels.webrtc.camera.maxSeconds` | number (10–7200) | `600` | The phone stops sharing its camera after this many seconds. |
| `channels.webrtc.camera.voiceInput` | boolean | `true` | Ask a [watching agent](../dashboard/mobile-camera.md#let-an-agent-look) by voice with **Talk**. The microphone is on only while you talk and is never part of the share. `false` shows only the text box. |
| `channels.webrtc.camera.speakAnswers` | boolean | `true` | Read a watching agent's answers aloud on the phone, in the agent's ElevenLabs voice or the phone's own. Each phone can turn it off with **Answers aloud**. |
| `channels.webrtc.camera.bot.frameIntervalSeconds` | number (0–3600) | `0` | When an [agent watches the camera](../dashboard/mobile-camera.md#let-an-agent-look), how often it gets a picture by itself, in seconds. `0` means only when you tap **Look now** or the agent asks for one. Each picture the agent gets by itself is a turn of the agent, so keep this high or at `0`. |
| `channels.webrtc.camera.bot.maxSessionMinutes` | number (1–240) | `10` | An agent's watch ends after this many minutes, whatever the phone does. |
| `channels.webrtc.camera.bot.maxFrameEdge` | number (160–3840) | `1024` | Pictures are shrunk so their longer side is at most this many pixels before the agent sees them. |
| `channels.webrtc.camera.bot.keepFrames` | boolean | `false` | Keep the picture files in the agent's workspace (`.agentx/camera/`) after the share ends. Off: every picture is deleted when the share ends. |
| `channels.webrtc.camera.bot.streamFrameSeconds` | number (2–60) | `5` | While **Keep watching** is on, the agent gets a picture this often, in seconds. Each picture is a turn of the agent. |
| `channels.webrtc.camera.bot.streamMaxSeconds` | number (10–600) | `60` | **Keep watching** stops by itself after this many seconds. With 5-second pictures, 60 seconds is about 12 turns and 600 seconds about 120. |

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
- **A GitHub issue starts no run:** the daemon log says why, with a line such as `skipped: action="labeled" not in channels.github.issueActions`. Add the change to `issueActions` or to the project rule's `actions` list.
- **A GitHub issue still starts several runs:** the changes came further apart than `debounceSeconds`. Raise it.
- **GitLab says the webhook failed:** check that `channels.gitlab.webhookPort` is reachable from GitLab and that the secret matches `channels.gitlab.webhookSecret`.
- **A value is empty at runtime:** a `${…}` reference points at a variable missing from `.env`. Add it and restart the daemon.
