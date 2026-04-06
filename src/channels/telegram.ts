import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "./types"
import { markdownToTelegramHtml } from "./telegram-format"

// --- Telegram Bot API adapter (long-polling, no dependencies) ---

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from: { id: number; first_name: string; last_name?: string; username?: string }
    chat: { id: number; type: string; title?: string }
    text?: string
    date: number
    reply_to_message?: { message_id: number }
  }
}

interface TelegramAccountConfig {
  token: string
  agentBinding: string
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram"
  private accounts: Map<string, TelegramAccountConfig>
  private offsets: Map<string, number> = new Map()
  private handler?: (msg: IncomingMessage) => Promise<void>
  private polling = false
  private log: (...args: unknown[]) => void

  constructor(
    accounts: Record<string, TelegramAccountConfig>,
    log: (...args: unknown[]) => void = console.error.bind(console, "[telegram]"),
  ) {
    this.accounts = new Map(Object.entries(accounts))
    this.log = log
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    this.polling = true

    const entries = Array.from(this.accounts.entries())
    this.log(`${entries.length} Telegram account(s) to start`)

    for (let i = 0; i < entries.length; i++) {
      const [accountId, config] = entries[i]
      this.log(`Starting polling for account "${accountId}" (${i + 1}/${entries.length})`)
      try {
        const me = await this.apiCall(config.token, "getMe")
        this.log(`Bot @${me.result?.username} ready (account: ${accountId})`)
        this.pollLoop(accountId, config)
      } catch (e: any) {
        this.log(`Failed to verify bot for account "${accountId}": ${e.message}`)
      }
      // Small delay between account starts to avoid Telegram rate limits
      if (i < entries.length - 1) {
        await new Promise((r) => setTimeout(r, 300))
      }
    }

    this.log(`All ${entries.length} Telegram account(s) started`)
  }

  async stop(): Promise<void> {
    this.polling = false
  }

  /**
   * Get token for a specific account ID. Used by router to send from correct bot.
   */
  getTokenForAccount(accountId: string): string | undefined {
    return this.accounts.get(accountId)?.token
  }

  /**
   * Get the default (first) account token as fallback.
   */
  private getDefaultToken(): string | undefined {
    const [, config] = Array.from(this.accounts.entries())[0]
    return config?.token
  }

  /**
   * Resolve which token to use: prefer accountId, fall back to chatAccountMap, then default.
   */
  private resolveToken(chatId: string, accountId?: string): string | undefined {
    if (accountId) {
      const token = this.getTokenForAccount(accountId)
      if (token) return token
    }
    return this.chatAccountMap.get(chatId)
      ? this.getTokenForAccount(this.chatAccountMap.get(chatId)!)
      : this.getDefaultToken()
  }

  /** Track which account a chat was last seen on (for DMs) */
  private chatAccountMap: Map<string, string> = new Map()

  /**
   * Send a message. Returns the sent message ID.
   * Pass accountId to send from a specific bot account.
   */
  async send(msg: OutgoingMessage & { accountId?: string }): Promise<string> {
    const token = this.resolveToken(msg.chatId, msg.accountId)
    if (!token) {
      this.log("No telegram token found for sending")
      return ""
    }

    const maxLen = 4096
    const text = msg.text.length > maxLen ? msg.text.slice(0, maxLen - 3) + "..." : msg.text

    // Convert markdown to Telegram MarkdownV2
    const formatted = msg.parseMode === "markdown" || msg.parseMode === undefined
      ? markdownToTelegramHtml(text)
      : text

    const params: Record<string, unknown> = {
      chat_id: msg.chatId,
      text: formatted,
      parse_mode: "HTML",
    }

    if (msg.replyTo) {
      params.reply_to_message_id = parseInt(msg.replyTo, 10)
    }

    if (msg.parseMode === "html") {
      params.parse_mode = "HTML"
      params.text = text
    } else if (msg.parseMode === "plain") {
      delete params.parse_mode
      params.text = text
    }

    try {
      const result = await this.apiCall(token, "sendMessage", params)
      return String(result.result?.message_id || "")
    } catch (e: any) {
      // Retry without formatting if MarkdownV2 fails
      if (params.parse_mode) {
        delete params.parse_mode
        params.text = text
        const result = await this.apiCall(token, "sendMessage", params)
        return String(result.result?.message_id || "")
      }
      throw e
    }
  }

  /**
   * Edit an existing message (for streaming updates).
   */
  async editMessage(chatId: string, messageId: string, text: string, parseMode?: string, accountId?: string): Promise<boolean> {
    const token = this.resolveToken(chatId, accountId)
    if (!token) return false

    const maxLen = 4096
    const trimmed = text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text

    const formatted = parseMode !== "html" && parseMode !== "plain"
      ? markdownToTelegramHtml(trimmed)
      : trimmed

    const params: Record<string, unknown> = {
      chat_id: chatId,
      message_id: parseInt(messageId, 10),
      text: formatted,
      parse_mode: "HTML",
    }

    if (parseMode === "html") {
      params.parse_mode = "HTML"
      params.text = trimmed
    } else if (parseMode === "plain") {
      delete params.parse_mode
      params.text = trimmed
    }

    try {
      await this.apiCall(token, "editMessageText", params)
      return true
    } catch (e: any) {
      if (e.message?.includes("message is not modified")) return true
      if (params.parse_mode) {
        delete params.parse_mode
        params.text = trimmed
        try {
          await this.apiCall(token, "editMessageText", params)
          return true
        } catch { return false }
      }
      return false
    }
  }

  /**
   * React to a message with an emoji.
   */
  async react(chatId: string, messageId: string, emoji: string = "👀", accountId?: string): Promise<void> {
    const token = this.resolveToken(chatId, accountId)
    if (!token) return

    try {
      await this.apiCall(token, "setMessageReaction", {
        chat_id: chatId,
        message_id: parseInt(messageId, 10),
        reaction: [{ type: "emoji", emoji }],
      })
    } catch {
      // Best-effort
    }
  }

  /**
   * Send typing indicator.
   */
  async sendTyping(chatId: string, accountId?: string): Promise<void> {
    const token = this.resolveToken(chatId, accountId)
    if (!token) return

    try {
      await this.apiCall(token, "sendChatAction", {
        chat_id: chatId,
        action: "typing",
      })
    } catch {
      // Best-effort
    }
  }

  // --- Internal ---

  private async pollLoop(accountId: string, config: TelegramAccountConfig): Promise<void> {
    while (this.polling) {
      try {
        const offset = this.offsets.get(accountId) || 0
        const data = await this.apiCall(config.token, "getUpdates", {
          offset: offset || undefined,
          timeout: 30,
          allowed_updates: ["message"],
        })

        const updates: TelegramUpdate[] = data.result || []

        for (const update of updates) {
          this.offsets.set(accountId, update.update_id + 1)

          if (update.message?.text && this.handler) {
            const msg = update.message
            const incoming: IncomingMessage = {
              id: String(msg.message_id),
              channel: "telegram",
              accountId,
              sender: {
                id: String(msg.from.id),
                name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "),
                username: msg.from.username,
              },
              group: msg.chat.type !== "private"
                ? { id: String(msg.chat.id), name: msg.chat.title || "" }
                : undefined,
              text: msg.text!,
              replyTo: msg.reply_to_message
                ? String(msg.reply_to_message.message_id)
                : undefined,
              timestamp: new Date(msg.date * 1000),
              raw: update,
            }

            // Track chat→account mapping for DM replies
            this.chatAccountMap.set(String(msg.chat.id), accountId)

            this.handler(incoming).catch((e) => {
              this.log(`Error handling message: ${e.message}`)
            })
          }
        }
      } catch (e: any) {
        this.log(`Poll error (${accountId}): ${e.message}`)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }

  private async apiCall(
    token: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<any> {
    const url = `https://api.telegram.org/bot${token}/${method}`
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params ? JSON.stringify(params) : undefined,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Telegram API error: ${res.status} ${text}`)
    }

    return res.json()
  }
}
