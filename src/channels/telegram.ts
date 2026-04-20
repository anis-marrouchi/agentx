import type { ChannelAdapter, IncomingMessage, OutgoingMessage, ChannelMeta } from "./types"
import { markdownToTelegramHtml } from "./telegram-format"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { resolve, dirname } from "path"

// --- Telegram Bot API adapter (long-polling, no dependencies) ---

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from: { id: number; first_name: string; last_name?: string; username?: string; is_bot?: boolean }
    chat: { id: number; type: string; title?: string }
    text?: string
    caption?: string
    date: number
    reply_to_message?: { message_id: number; text?: string; caption?: string; from?: { first_name: string } }
    photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>
    voice?: { file_id: string; duration: number; mime_type?: string }
    audio?: { file_id: string; duration: number; mime_type?: string; title?: string }
    video?: { file_id: string; duration: number; mime_type?: string }
    document?: { file_id: string; file_name?: string; mime_type?: string }
    sticker?: { file_id: string; emoji?: string }
  }
  my_chat_member?: {
    chat: { id: number; type: string; title?: string }
    from: { id: number; first_name: string }
    new_chat_member: {
      user: { id: number; username?: string; is_bot?: boolean }
      status: string // "member" | "administrator" | "left" | "kicked" | "creator"
    }
  }
}

interface TelegramAccountConfig {
  token: string
  agentBinding: string
  allowFrom?: string[]
}

// --- Persistent group membership store ---
// Tracks which bots are in which groups, persisted to .agentx/telegram/groups.json
// Updated via my_chat_member events and one-time API seed per group.

interface GroupMembership {
  /** groupId → { accountId → { username, status, updatedAt } } */
  [groupId: string]: {
    name?: string
    bots: {
      [accountId: string]: {
        username: string
        agentId: string
        status: string // "member" | "administrator" | "left" | "kicked"
        updatedAt: string
      }
    }
  }
}

class TelegramGroupStore {
  private data: GroupMembership = {}
  private filePath: string
  private dirty = false

  constructor(dataDir: string) {
    this.filePath = resolve(dataDir, ".agentx/telegram/groups.json")
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        this.data = JSON.parse(readFileSync(this.filePath, "utf-8"))
      }
    } catch {
      this.data = {}
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2))
      this.dirty = false
    } catch {
      // best-effort
    }
  }

  /** Record a bot's membership status in a group. */
  setBotStatus(groupId: string, groupName: string | undefined, accountId: string, agentId: string, username: string, status: string): void {
    if (!this.data[groupId]) {
      this.data[groupId] = { name: groupName, bots: {} }
    }
    if (groupName) this.data[groupId].name = groupName
    this.data[groupId].bots[accountId] = {
      username,
      agentId,
      status,
      updatedAt: new Date().toISOString(),
    }
    this.dirty = true
    this.save()
  }

  /** Get all active bots in a group. */
  getGroupBots(groupId: string): Array<{ accountId: string; agentId: string; username: string }> {
    const group = this.data[groupId]
    if (!group) return []
    return Object.entries(group.bots)
      .filter(([, info]) => info.status !== "left" && info.status !== "kicked")
      .map(([accountId, info]) => ({
        accountId,
        agentId: info.agentId,
        username: info.username,
      }))
  }

  /** Check if we have data for a group. */
  hasGroup(groupId: string): boolean {
    return !!this.data[groupId]
  }
}

/**
 * Persist long-poll `offset` per account to disk so a daemon restart doesn't
 * re-fetch updates Telegram still holds in its 24h retention window. Without
 * this, a crash loop (e.g. restart-counter cascade) causes the same message
 * to be handled N times — seen on 2026-04-15 when clawd spun through 20
 * systemd restarts while a zombie daemon held the pidfile, resulting in 6×
 * duplicate replies from the queued incoming messages.
 */
class TelegramOffsetStore {
  private offsets: Record<string, number> = {}
  private filePath: string
  private dirty = false
  private saveTimer?: ReturnType<typeof setTimeout>

  constructor(dataDir: string) {
    this.filePath = resolve(dataDir, ".agentx/telegram/offsets.json")
    try {
      if (existsSync(this.filePath)) {
        this.offsets = JSON.parse(readFileSync(this.filePath, "utf-8"))
      }
    } catch { this.offsets = {} }
  }

  get(accountId: string): number {
    return this.offsets[accountId] || 0
  }

  set(accountId: string, offset: number): void {
    if (this.offsets[accountId] === offset) return
    this.offsets[accountId] = offset
    this.dirty = true
    // Debounce disk writes — each poll can produce many offset updates.
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.flush(), 500)
    }
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    if (!this.dirty) return
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.offsets, null, 2))
      this.dirty = false
    } catch { /* best-effort */ }
  }
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram"
  private accounts: Map<string, TelegramAccountConfig>
  private offsetStore: TelegramOffsetStore
  private handler?: (msg: IncomingMessage) => Promise<void>
  private polling = false
  /** Per-account polling gate — flipped to false when an account is removed
   *  or its token changes, so its pollLoop observes the stop and exits without
   *  affecting siblings. Keyed by accountId. */
  private accountPolling = new Map<string, boolean>()
  private log: (...args: unknown[]) => void
  /** Global allowlist fallback. When a per-account allowFrom is unset,
   *  this list applies. When BOTH are unset, everything is rejected
   *  (closed by default). */
  private globalAllowFrom?: string[]

  constructor(
    accounts: Record<string, TelegramAccountConfig>,
    opts: { policy?: { allowFrom?: string[] } } = {},
    log: (...args: unknown[]) => void = console.error.bind(console, "[telegram]"),
  ) {
    this.accounts = new Map(Object.entries(accounts))
    this.globalAllowFrom = opts.policy?.allowFrom
    this.log = log
    this.groupStore = new TelegramGroupStore(process.cwd())
    this.offsetStore = new TelegramOffsetStore(process.cwd())
  }

  /** Effective sender allowlist for an account. Returns undefined when the
   *  account has no explicit config AND the global policy is unset — the
   *  caller treats undefined as "closed, drop everything". */
  private effectiveAllowFrom(accountId: string): string[] | undefined {
    const cfg = this.accounts.get(accountId)
    if (cfg?.allowFrom !== undefined) return cfg.allowFrom
    return this.globalAllowFrom
  }

  /** Accept a message only when at least one allowlist entry matches the
   *  sender's user id, the chat id, or the sender's @username. */
  private isAllowed(
    accountId: string,
    fromId: number | string | undefined,
    chatId: number | string | undefined,
    fromUsername?: string,
  ): boolean {
    const list = this.effectiveAllowFrom(accountId)
    if (!list || list.length === 0) return false
    const fromStr = fromId != null ? String(fromId) : ""
    const chatStr = chatId != null ? String(chatId) : ""
    const userLc = fromUsername?.toLowerCase()
    for (const entry of list) {
      if (!entry) continue
      if (entry === fromStr || entry === chatStr) return true
      if (entry.startsWith("@") && userLc && entry.slice(1).toLowerCase() === userLc) return true
    }
    return false
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
      await this.startAccount(accountId, config, { index: i + 1, of: entries.length })
      // Small delay between account starts to avoid Telegram rate limits
      if (i < entries.length - 1) {
        await new Promise((r) => setTimeout(r, 300))
      }
    }

    this.log(`All ${entries.length} Telegram account(s) started`)
  }

  /** Start a single account's poll loop. Used by both start() (boot) and
   *  reloadAccounts() (hot-add on /reload). Verifies the bot token, records
   *  the bot's identity, then spawns the long-poll loop. No-op if the account
   *  is already polling. */
  private async startAccount(
    accountId: string,
    config: TelegramAccountConfig,
    meta: { index?: number; of?: number } = {},
  ): Promise<void> {
    if (this.accountPolling.get(accountId)) {
      this.log(`Account "${accountId}" already polling — skipping duplicate start`)
      return
    }
    const prefix = meta.index != null && meta.of != null
      ? `(${meta.index}/${meta.of})`
      : "(hot-reload)"
    this.log(`Starting polling for account "${accountId}" ${prefix}`)
    try {
      // Drop any stale webhook/long-poll session from a previous run.
      // This prevents 409 conflicts when restarting.
      await this.apiCall(config.token, "deleteWebhook", { drop_pending_updates: false }).catch(() => {})

      const me = await this.apiCall(config.token, "getMe")
      const botUserId = me.result?.id
      const botUsername = me.result?.username
      this.log(`Bot @${botUsername} ready (account: ${accountId})`)
      if (botUserId) {
        this.botInfo.set(accountId, { userId: botUserId, username: botUsername || accountId })
      }
      this.accountPolling.set(accountId, true)
      this.pollLoop(accountId, config)
    } catch (e: any) {
      this.log(`Failed to verify bot for account "${accountId}": ${e.message}`)
    }
  }

  /** Stop a single account's poll loop without touching siblings. Flips the
   *  per-account gate and aborts the in-flight long-poll so Telegram releases
   *  the server-side session immediately (otherwise a new start with the same
   *  token hits 409 Conflict). */
  private async stopAccount(accountId: string): Promise<void> {
    this.accountPolling.set(accountId, false)
    const cfg = this.accounts.get(accountId)
    if (!cfg) return
    try {
      await this.apiCall(cfg.token, "getUpdates", { offset: -1, timeout: 0 })
    } catch {
      // Best-effort
    }
  }

  async stop(): Promise<void> {
    this.polling = false
    // Flush any debounced offset writes BEFORE we release the Telegram session
    // — otherwise a clean stop could drop the last in-memory offset update.
    this.offsetStore.flush()
    const aborts = Array.from(this.accounts.keys()).map((id) => this.stopAccount(id))
    await Promise.allSettled(aborts)
  }

  /** Hot-reload the account map in place. Diffs the new config against the
   *  current one: removed accounts get their pollers stopped, added accounts
   *  get started, and accounts whose token changed get restarted (allowFrom
   *  changes are effectively read-through via effectiveAllowFrom so they
   *  don't need a restart, but we do refresh the stored config). Returns the
   *  diff for the caller to log/surface.
   *
   *  Requires the adapter to be already started (polling=true). */
  async reloadAccounts(
    next: Record<string, TelegramAccountConfig>,
    policy?: { allowFrom?: string[] },
  ): Promise<{ added: string[]; removed: string[]; tokenChanged: string[] }> {
    if (!this.polling) {
      // Adapter hasn't been started — just swap the map, start() will use it.
      this.accounts = new Map(Object.entries(next))
      this.globalAllowFrom = policy?.allowFrom
      return { added: [], removed: [], tokenChanged: [] }
    }

    const oldIds = new Set(this.accounts.keys())
    const newIds = new Set(Object.keys(next))
    const added: string[] = []
    const removed: string[] = []
    const tokenChanged: string[] = []

    // Update the global allowlist unconditionally — it's read-through.
    this.globalAllowFrom = policy?.allowFrom

    // 1. Removed accounts — stop + drop from map.
    for (const id of oldIds) {
      if (newIds.has(id)) continue
      await this.stopAccount(id)
      this.accounts.delete(id)
      this.botInfo.delete(id)
      removed.push(id)
    }

    // 2. Retained accounts — swap config in place (for allowFrom etc.) and
    //    restart when the token changed, since pollLoop captures the token
    //    in its closure argument.
    for (const id of newIds) {
      if (!oldIds.has(id)) continue
      const oldCfg = this.accounts.get(id)!
      const newCfg = next[id]
      this.accounts.set(id, newCfg)
      if (oldCfg.token !== newCfg.token) {
        await this.stopAccount(id)
        await this.startAccount(id, newCfg)
        tokenChanged.push(id)
      }
    }

    // 3. Added accounts — write config then start polling.
    for (const id of newIds) {
      if (oldIds.has(id)) continue
      this.accounts.set(id, next[id])
      await this.startAccount(id, next[id])
      added.push(id)
    }

    return { added, removed, tokenChanged }
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
  // Bot user IDs and usernames resolved at startup (accountId → { userId, username })
  private botInfo: Map<string, { userId: number; username: string }> = new Map()
  // Persistent group membership store
  private groupStore: TelegramGroupStore

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
    let consecutiveErrors = 0

    while (this.polling && this.accountPolling.get(accountId) !== false) {
      try {
        const offset = this.offsetStore.get(accountId) || 0
        const data = await this.apiCall(config.token, "getUpdates", {
          offset: offset || undefined,
          timeout: 30,
          allowed_updates: ["message", "my_chat_member"],
        })

        const updates: TelegramUpdate[] = data.result || []

        for (const update of updates) {
          this.offsetStore.set(accountId, update.update_id + 1)

          if (update.message && this.handler) {
            const msg = update.message

            // Extract text from any message type
            let text = msg.text || msg.caption || ""
            let mediaInfo: IncomingMessage["media"] | undefined

            // Handle media messages
            const hasPhoto = msg.photo && msg.photo.length > 0
            const hasVoice = !!msg.voice
            const hasAudio = !!msg.audio
            const hasVideo = !!msg.video
            const hasDocument = !!msg.document
            const hasMedia = hasPhoto || hasVoice || hasAudio || hasVideo || hasDocument

            if (hasMedia) {
              // Download media file
              let fileId: string | undefined
              let mime = "application/octet-stream"

              if (hasPhoto) {
                fileId = msg.photo![msg.photo!.length - 1].file_id // largest photo
                mime = "image/jpeg"
                if (!text) text = "[Photo attached — please describe what you see]"
              } else if (hasVoice) {
                fileId = msg.voice!.file_id
                mime = msg.voice!.mime_type || "audio/ogg"
                if (!text) text = "[Voice message — please transcribe and respond]"
              } else if (hasAudio) {
                fileId = msg.audio!.file_id
                mime = msg.audio!.mime_type || "audio/mpeg"
                if (!text) text = `[Audio: ${msg.audio!.title || "audio file"}]`
              } else if (hasVideo) {
                fileId = msg.video!.file_id
                mime = msg.video!.mime_type || "video/mp4"
                if (!text) text = "[Video attached]"
              } else if (hasDocument) {
                fileId = msg.document!.file_id
                mime = msg.document!.mime_type || "application/octet-stream"
                if (!text) text = `[Document: ${msg.document!.file_name || "file"}]`
              }

              if (fileId) {
                try {
                  // Get file path from Telegram
                  const fileInfo = await this.apiCall(config.token, "getFile", { file_id: fileId })
                  const filePath = fileInfo.result?.file_path
                  if (filePath) {
                    // Download file
                    const fileUrl = `https://api.telegram.org/file/bot${config.token}/${filePath}`
                    const res = await fetch(fileUrl)
                    if (res.ok) {
                      const buffer = Buffer.from(await res.arrayBuffer())
                      const ext = mime.split("/")[1]?.split(";")[0] || "bin"
                      const { mkdirSync, writeFileSync } = await import("fs")
                      const { randomUUID } = await import("crypto")
                      const { resolve, join } = await import("path")
                      const mediaDir = resolve(process.cwd(), ".agentx/media/telegram")
                      mkdirSync(mediaDir, { recursive: true })
                      const fileName = msg.document?.file_name || `${randomUUID()}.${ext}`
                      const localPath = join(mediaDir, fileName)
                      writeFileSync(localPath, buffer)
                      mediaInfo = { path: localPath, type: mime, fileName }
                    }
                  }
                } catch (e: any) {
                  this.log(`Media download failed: ${e.message}`)
                }
              }
            }

            if (!text) continue

            // Sender allowlist gate — enforced BEFORE the router sees anything
            // so an unauthorized message burns zero tokens and leaves no trace
            // in the agent's session log.
            if (!this.isAllowed(accountId, msg.from?.id, msg.chat?.id, msg.from?.username)) {
              this.log(
                `[telegram/${accountId}] dropped message from ${msg.from?.id}${msg.from?.username ? ` (@${msg.from.username})` : ""} in chat ${msg.chat?.id} — not in allowlist`,
              )
              continue
            }

            // Build channel meta for groups (verified bot membership)
            const isGroup = msg.chat.type !== "private"
            const groupId = String(msg.chat.id)
            let channelMeta: ChannelMeta | undefined
            if (isGroup) {
              // Seed group membership on first encounter via API
              if (!this.groupStore.hasGroup(groupId)) {
                await this.seedGroupMembership(groupId, msg.chat.title)
              }
              channelMeta = await this.getChannelMeta(groupId)
            }

            const incoming: IncomingMessage = {
              id: String(msg.message_id),
              channel: "telegram",
              accountId,
              sender: {
                id: String(msg.from.id),
                name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "),
                username: msg.from.username,
                isBot: msg.from.is_bot === true,
              },
              group: isGroup
                ? { id: groupId, name: msg.chat.title || "" }
                : undefined,
              text,
              media: mediaInfo,
              replyTo: msg.reply_to_message
                ? String(msg.reply_to_message.message_id)
                : undefined,
              replyToText: msg.reply_to_message
                ? (msg.reply_to_message.text || msg.reply_to_message.caption || `[message from ${msg.reply_to_message.from?.first_name || "unknown"}]`)
                : undefined,
              timestamp: new Date(msg.date * 1000),
              raw: update,
              channelMeta,
            }

            // Track chat→account mapping for DM replies
            this.chatAccountMap.set(String(msg.chat.id), accountId)


            this.handler(incoming).catch((e) => {
              this.log(`Error handling message: ${e.message}`)
            })
          }

          // Handle bot membership changes (added/removed from group)
          if (update.my_chat_member) {
            const mcm = update.my_chat_member
            const chatId = String(mcm.chat.id)
            const chatTitle = mcm.chat.title
            const status = mcm.new_chat_member.status
            const botUsername = mcm.new_chat_member.user.username || accountId

            this.groupStore.setBotStatus(
              chatId,
              chatTitle,
              accountId,
              config.agentBinding,
              botUsername,
              status,
            )

            this.log(`Group membership: @${botUsername} is now "${status}" in "${chatTitle || chatId}"`)
          }
        }
        consecutiveErrors = 0
      } catch (e: any) {
        consecutiveErrors++
        const backoff = Math.min(5000 * Math.pow(2, consecutiveErrors - 1), 60000)
        this.log(`Poll error (${accountId}): ${e.message} [retry in ${backoff / 1000}s, errors: ${consecutiveErrors}]`)
        await new Promise((r) => setTimeout(r, backoff))
      }
    }
  }

  /**
   * Get verified context for a Telegram chat.
   * Reads from persistent group store (fed by my_chat_member events + API seed).
   */
  async getChannelMeta(chatId: string): Promise<ChannelMeta | undefined> {
    const bots = this.groupStore.getGroupBots(chatId)
    if (!bots.length) return undefined

    return {
      channel: "telegram",
      agents: bots.map(b => ({
        id: b.agentId,
        name: b.username,
        handle: `@${b.username}`,
      })),
      facts: [`${bots.length} bot(s) verified in this group`],
    }
  }

  /**
   * Seed group membership by querying the Telegram API for each bot.
   * Called once per group on first encounter, then maintained via my_chat_member events.
   */
  private async seedGroupMembership(groupId: string, groupTitle?: string): Promise<void> {
    this.log(`Seeding group membership for "${groupTitle || groupId}"`)

    for (const [accountId, config] of this.accounts) {
      const info = this.botInfo.get(accountId)
      if (!info) continue

      try {
        const res = await this.apiCall(config.token, "getChatMember", {
          chat_id: Number(groupId),
          user_id: info.userId,
        })
        const status = res.result?.status
        if (status) {
          this.groupStore.setBotStatus(
            groupId,
            groupTitle,
            accountId,
            config.agentBinding,
            info.username,
            status,
          )
        }
      } catch {
        // Bot not in group or API error — record as "left"
        this.groupStore.setBotStatus(
          groupId,
          groupTitle,
          accountId,
          config.agentBinding,
          info.username,
          "left",
        )
      }
    }

    this.log(`Seeded: ${this.groupStore.getGroupBots(groupId).length} bot(s) in "${groupTitle || groupId}"`)
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
