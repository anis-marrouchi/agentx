import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "./types"

// --- Discord adapter using discord.js ---
// discord.js is an optional dependency.
// Bot needs MESSAGE_CONTENT intent enabled in Discord Developer Portal.

export class DiscordAdapter implements ChannelAdapter {
  readonly name = "discord"
  private token: string
  private agentBinding?: string
  private handler?: (msg: IncomingMessage) => Promise<void>
  private client: any = null
  private log: (...args: unknown[]) => void

  constructor(
    config: { token: string; agentBinding?: string },
    log: (...args: unknown[]) => void = console.error.bind(console, "[discord]"),
  ) {
    this.token = config.token
    this.agentBinding = config.agentBinding
    this.log = log
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    let Discord: any

    try {
      Discord = await import("discord.js")
    } catch {
      this.log("Discord requires discord.js. Install with:")
      this.log("  npm install discord.js")
      return
    }

    const { Client, GatewayIntentBits } = Discord

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    })

    this.client.on("ready", () => {
      this.log(`Discord connected as ${this.client.user?.tag}`)
    })

    this.client.on("messageCreate", async (msg: any) => {
      if (!this.handler) return
      if (msg.author.bot) return

      // Check if bot is mentioned or it's a DM
      const isMentioned = msg.mentions.users.has(this.client.user?.id)
      const isDM = !msg.guild

      if (!isMentioned && !isDM) return

      // Strip bot mention from text
      let text = msg.content
      if (this.client.user) {
        text = text.replace(new RegExp(`<@!?${this.client.user.id}>`, "g"), "").trim()
      }

      if (!text) return

      const incoming: IncomingMessage = {
        id: msg.id,
        channel: "discord",
        accountId: "default",
        sender: {
          id: msg.author.id,
          name: msg.author.displayName || msg.author.username,
          username: msg.author.username,
        },
        group: msg.guild ? {
          id: msg.channelId,
          name: msg.channel?.name || msg.channelId,
        } : undefined,
        text,
        replyTo: msg.reference?.messageId,
        timestamp: msg.createdAt,
        raw: msg,
      }

      this.handler(incoming).catch((e: any) => {
        this.log(`Error handling message: ${e.message}`)
      })
    })

    try {
      await this.client.login(this.token)
    } catch (e: any) {
      this.log(`Discord login failed: ${e.message}`)
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy()
      this.client = null
    }
  }

  async send(msg: OutgoingMessage): Promise<string> {
    if (!this.client) return ""
    try {
      const channel = await this.client.channels.fetch(msg.chatId)
      if (!channel?.isTextBased()) return ""

      const sent = await channel.send({
        content: msg.text,
        ...(msg.replyTo ? { reply: { messageReference: msg.replyTo } } : {}),
      })
      return sent.id
    } catch (e: any) {
      this.log(`Send error: ${e.message}`)
      return ""
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    if (!this.client) return false
    try {
      const channel = await this.client.channels.fetch(chatId)
      if (!channel?.isTextBased()) return false
      const message = await channel.messages.fetch(messageId)
      await message.edit(text)
      return true
    } catch { return false }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.client) return
    try {
      const channel = await this.client.channels.fetch(chatId)
      if (channel?.isTextBased()) await channel.sendTyping()
    } catch { /* best-effort */ }
  }

  async react(chatId: string, messageId: string, emoji: string = "👀"): Promise<void> {
    if (!this.client) return
    try {
      const channel = await this.client.channels.fetch(chatId)
      if (!channel?.isTextBased()) return
      const message = await channel.messages.fetch(messageId)
      await message.react(emoji)
    } catch { /* best-effort */ }
  }
}
