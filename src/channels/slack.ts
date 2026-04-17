import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "./types"

// --- Slack adapter (Socket Mode) ---
//
// Two optional deps — both peer-installed via `npm i @slack/socket-mode @slack/web-api`
// when the operator enables this channel. Kept optional so agentx-cli stays
// lean for installs that never touch Slack.
//
// Prerequisites on the Slack side:
//   - Create a Slack app at https://api.slack.com/apps
//   - Enable Socket Mode; generate an app-level token with `connections:write`
//     (starts with xapp-). Put it in .env as SLACK_APP_TOKEN.
//   - Install the bot to the workspace, grab the bot token (starts with xoxb-).
//     Put it in .env as SLACK_BOT_TOKEN.
//   - Scopes needed: chat:write, channels:history, groups:history,
//     im:history, mpim:history, reactions:write, app_mentions:read, users:read.
//   - Subscribe to events: app_mention, message.channels, message.im,
//     message.mpim, message.groups.
//
// Routing: DMs always route (no mention required). In channels/groups, the
// bot has to be @-mentioned — same policy as Discord, matches our "mention-
// required in groups" default.

export class SlackAdapter implements ChannelAdapter {
  readonly name = "slack"
  private botToken: string
  private appToken: string
  private agentBinding?: string
  private handler?: (msg: IncomingMessage) => Promise<void>
  private socket: any = null
  private web: any = null
  private botUserId?: string
  private log: (...args: unknown[]) => void

  constructor(
    config: { botToken: string; appToken: string; agentBinding?: string },
    log: (...args: unknown[]) => void = console.error.bind(console, "[slack]"),
  ) {
    this.botToken = config.botToken
    this.appToken = config.appToken
    this.agentBinding = config.agentBinding
    this.log = log
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    let SocketModeMod: any
    let WebApiMod: any
    try {
      // @ts-ignore — optional deps
      SocketModeMod = await import("@slack/socket-mode")
      // @ts-ignore
      WebApiMod = await import("@slack/web-api")
    } catch {
      this.log("Slack requires @slack/socket-mode and @slack/web-api. Install with:")
      this.log("  npm install @slack/socket-mode @slack/web-api")
      return
    }

    const { SocketModeClient } = SocketModeMod
    const { WebClient } = WebApiMod

    this.web = new WebClient(this.botToken)

    // Resolve our own bot user id once so we can detect mentions + skip self-posts.
    try {
      const authResult = await this.web.auth.test()
      this.botUserId = authResult.user_id
      this.log(`Slack connected as @${authResult.user} (${this.botUserId}) in team ${authResult.team}`)
    } catch (e: any) {
      this.log(`Slack auth.test failed: ${e.message}`)
      return
    }

    this.socket = new SocketModeClient({ appToken: this.appToken })

    // Socket Mode emits generic "message" and "app_mention" events. We handle
    // both so direct mentions still fire even if the workspace dropped the
    // message-channels subscription.
    const handle = async (payload: any, ack: () => Promise<void>) => {
      try { await ack() } catch { /* */ }
      if (!this.handler) return
      const event = payload.event
      if (!event || typeof event.text !== "string") return
      // Skip our own bot posts and any message that carries a bot_id (prevents
      // bot-on-bot cascades within a workspace).
      if (event.bot_id || event.user === this.botUserId || event.subtype === "bot_message") return

      const isDM = event.channel_type === "im"
      const isMentioned = this.botUserId && event.text.includes(`<@${this.botUserId}>`)
      if (!isDM && !isMentioned) return

      // Strip our bot mention from the text so the agent receives a clean prompt.
      let text = event.text
      if (this.botUserId) {
        text = text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim()
      }
      if (!text) return

      // Resolve the sender's display name (best-effort; fall back to the raw id).
      let senderName = event.user || "slack-user"
      try {
        const info = await this.web.users.info({ user: event.user })
        senderName = info?.user?.profile?.display_name || info?.user?.real_name || senderName
      } catch { /* */ }

      const incoming: IncomingMessage = {
        id: event.client_msg_id || event.ts,
        channel: "slack",
        accountId: "default",
        sender: {
          id: event.user,
          name: senderName,
          username: senderName,
        },
        group: !isDM ? { id: event.channel, name: event.channel } : undefined,
        text,
        replyTo: event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : undefined,
        timestamp: event.ts ? new Date(parseFloat(event.ts) * 1000) : new Date(),
        raw: event,
      }
      try { await this.handler(incoming) }
      catch (e: any) { this.log(`Error handling message: ${e.message}`) }
    }

    this.socket.on("app_mention", handle)
    this.socket.on("message", handle)
    this.socket.on("error", (e: any) => this.log(`Slack socket error: ${e?.message || e}`))

    try {
      await this.socket.start()
    } catch (e: any) {
      this.log(`Slack socket start failed: ${e.message}`)
    }
  }

  async stop(): Promise<void> {
    if (this.socket) {
      try { await this.socket.disconnect() } catch { /* */ }
      this.socket = null
    }
    this.web = null
  }

  async send(msg: OutgoingMessage): Promise<string> {
    if (!this.web) return ""
    try {
      const r = await this.web.chat.postMessage({
        channel: msg.chatId,
        text: msg.text,
        thread_ts: msg.replyTo,
        // Slack's mrkdwn is closest to our default. Plain keeps literal braces
        // and code fences without escaping.
        mrkdwn: msg.parseMode !== "plain",
      })
      return r.ts as string
    } catch (e: any) {
      this.log(`Send error: ${e.message}`)
      return ""
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    if (!this.web) return false
    try {
      await this.web.chat.update({ channel: chatId, ts: messageId, text })
      return true
    } catch (e: any) {
      this.log(`Edit error: ${e.message}`)
      return false
    }
  }

  async react(chatId: string, messageId: string, emoji: string = "eyes"): Promise<void> {
    if (!this.web) return
    try {
      const name = emoji.replace(/^:|:$/g, "")
      await this.web.reactions.add({ channel: chatId, timestamp: messageId, name })
    } catch { /* best-effort — the reaction emoji might already be set */ }
  }
}
