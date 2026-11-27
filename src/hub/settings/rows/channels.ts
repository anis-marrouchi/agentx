// Settings › Channels and WhatsApp: the rows the pane draws, the one source search reads
// (panes.ts, condition 1).
import type { SettingsRowDef } from "../panes"

// Connections › Channels (#2101 ST3a). A tab is a fold of the shell, as in
// Jobs: `open` names the tab (ch-tab-*), then the Advanced fold inside it.
export const CHANNELS_ROWS = [
  { id: "ch-telegram", label: "Telegram", help: "Turning it off stops every bot", words: "connector bot on off", open: "ch-tab-telegram" },
  { id: "tg-accounts", label: "Telegram accounts", help: "Each answers as one agent; its token stays in .env", words: "bot token agent add account", open: "ch-tab-telegram" },
  { id: "ch-email", label: "Email", help: "Only mail that arrives after the daemon starts reading is answered", words: "connector imap smtp on off", open: "ch-tab-email" },
  { id: "em-boxes", label: "Mailboxes", help: "The addresses your agents read and answer", words: "email add mailbox password who may write", open: "ch-tab-email" },
  { id: "ch-slack", label: "Slack", help: "Socket Mode: no public address needed", words: "connector on off", open: "ch-tab-slack" },
  { id: "sl-bot", label: "Slack bot token", help: "The .env variable that holds the xoxb- token", words: "xoxb secret", open: "ch-tab-slack" },
  { id: "sl-app", label: "Slack app token", help: "The .env variable that holds the xapp- token", words: "xapp socket mode secret", open: "ch-tab-slack" },
  { id: "sl-agent", label: "Slack default agent", help: "Who answers in Slack", words: "slack agent binding", open: "ch-tab-slack" },
  { id: "sl-scopes", label: "Slack app scopes", help: "What the Slack app must be allowed", words: "chat:write app_mentions history connections:write", open: "ch-tab-slack,sl-adv" },
  { id: "ch-discord", label: "Discord", help: "Answers when @-mentioned in channels, and always in direct messages", words: "bot connect on off", open: "ch-tab-discord" },
  { id: "dc-token", label: "Discord bot token", help: "The .env variable that holds the bot token", words: "secret", open: "ch-tab-discord" },
  { id: "dc-agent", label: "Discord default agent", help: "Who answers in Discord", words: "discord agent binding", open: "ch-tab-discord" },
  { id: "ch-gitlab", label: "GitLab", help: "Issues and merge requests reach agents through a webhook", words: "webhook connector on off", open: "ch-tab-gitlab" },
  { id: "gl-token", label: "GitLab admin token", help: "The .env variable that holds a token with api scope", words: "api scope secret", open: "ch-tab-gitlab" },
  { id: "gl-host", label: "GitLab host", help: "For a self-hosted GitLab", words: "advanced self-hosted url", open: "ch-tab-gitlab,gl-adv" },
  { id: "gl-port", label: "GitLab webhook port", help: "Where the daemon listens for GitLab's calls", words: "advanced listen port", open: "ch-tab-gitlab,gl-adv" },
  { id: "ch-github", label: "GitHub", help: "The webhooks GitHub calls, from Jobs › Webhooks", words: "webhooks github address", open: "ch-tab-github" },
  { id: "ch-calls", label: "Calls", help: "Voice calls with an agent that are live now", words: "webrtc active call voice", open: "ch-tab-calls" },
  { id: "calls-recent", label: "Recent calls", help: "Finished calls this daemon remembers", words: "webrtc history transcript", open: "ch-tab-calls" },
  { id: "ch-whatsapp", label: "WhatsApp", help: "Pairing, watched chats and the sweep have their own pane", words: "pairing qr" },
] as const satisfies readonly SettingsRowDef[]

// Connections › WhatsApp (#2101 ST3a): pairing, watched chats, the sweep.
export const WHATSAPP_ROWS = [
  { id: "wa-pair", label: "Pairing", help: "The daemon signs in to WhatsApp as a linked device", words: "whatsapp qr code linked device scan connected" },
  { id: "wa-session", label: "Session folder", help: "Where the linked device's session is kept", words: "whatsapp baileys routes" },
  { id: "wa-routes", label: "Routes and allow-lists", help: "Under channels.whatsapp in agentx.json", words: "whatsapp phone numbers allow list" },
  { id: "wt-on", label: "Watched chats on", help: "Needs wacli sync --webhook running", words: "triage wacli watch" },
  { id: "wt-url", label: "Address for wacli", help: "wacli posts each message here", words: "webhook url triage" },
  { id: "wt-secret", label: "Watched chats secret", help: "Every message is refused until it is set", words: "wacli webhook secret env" },
  { id: "wa-rules", label: "Watch rules", help: "Each sends some chats to one agent, which drafts replies", words: "triage rule chats senders quiet hours" },
  { id: "wa-add-rule", label: "Add watch rule", help: "A name, an agent and the chats it watches", words: "new triage rule" },
  { id: "wa-chats", label: "Chats and contacts", help: "What WhatsApp shows this daemon, the first 100 of each", words: "whatsapp list groups phone" },
  { id: "wa-sweep", label: "Agent whose wiki gets them", help: "Same as agentx whatsapp ingest-all", words: "sweep ingest wiki" },
  { id: "wa-dry", label: "Dry run", help: "Count what would be written, write nothing", words: "sweep ingest" },
  { id: "wa-force", label: "Sweep even when ingest is off", help: "Ignores channels.whatsapp.ingest.enabled for this sweep", words: "advanced ingest force", open: "wa-adv" },
] as const satisfies readonly SettingsRowDef[]
