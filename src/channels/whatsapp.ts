import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "./types"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { resolve, join } from "path"
import { randomUUID } from "crypto"
import { WhatsAppCache, type ContactRecord, type ChatRecord, type GroupRecord } from "./whatsapp-cache"

/** Shapes returned by the adapter's read API — used by the wiki ingestor.
 *  These are stable contracts so the ingestor can mock the adapter without
 *  pulling in Baileys types. */
export interface ContactSummary {
  jid: string
  phone: string
  name?: string         // best display name (savedName → pushName → phone)
  pushName?: string
  savedName?: string
  status?: string
  updatedAt?: string
}
export interface ChatSummary {
  jid: string
  name: string          // "best we have" — never undefined so CLI output is useful
  isGroup: boolean
  lastMessageAt?: number
  unreadCount?: number
}
export interface GroupInfo {
  jid: string
  subject: string
  description?: string
  owner?: string
  members: Array<{ jid: string; admin?: "admin" | "superadmin" }>
  memberCount: number
}
export interface HistoryMessage {
  id: string
  fromJid: string       // sender JID (for groups) or chat JID (for DMs)
  fromMe: boolean
  timestamp?: number    // unix seconds
  text: string          // empty string when the message was media-only with no caption
  media?: { kind: "image" | "audio" | "video" | "document" | "sticker"; caption?: string; filename?: string }
}

// --- WhatsApp adapter using Baileys (WhatsApp Web multi-device) ---
// Baileys is an optional dependency. If not installed, adapter logs a warning.
//
// First run: displays QR code in terminal for pairing.
// Subsequent runs: reconnects automatically using saved session.

export interface WhatsAppRoute {
  contact?: string   // phone number or partial match
  group?: string     // group name or JID partial match
  agent: string      // agent ID to route to
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = "whatsapp"
  private sessionDir: string
  private defaultAgent?: string
  private allowFrom?: string[]
  private routes: WhatsAppRoute[]
  private handler?: (msg: IncomingMessage) => Promise<void>
  private sock: any = null
  private reconnectAttempts = 0
  /** Generation counter — incremented on each start() to ignore stale socket events */
  private generation = 0
  private sentMessageIds: Set<string> = new Set()  // Track our own replies to prevent loops
  private log: (...args: unknown[]) => void

  /** Passive snapshot of contacts/chats/groups populated from Baileys events.
   *  Consumed by the wiki ingestor. Persisted to {sessionDir}/cache.json on stop. */
  private cache: WhatsAppCache

  /** Token-bucket throttle for live Baileys reads. Configurable via
   *  channels.whatsapp.ingest.throttle. Defaults keep the read surface
   *  below what personal-account rate limits tend to trigger. */
  private throttleMinMs = 1500
  private throttleMaxPerMinute = 20
  private lastReadAt = 0
  private readsInWindow: number[] = []

  /** Fires whenever the underlying WhatsApp socket emits a new QR or clears it.
   *  Passing null means the session is now connected. */
  private onQR?: (qr: string | null) => void
  /** Fires whenever the connection state changes (connecting / open / close). */
  private onStatus?: (status: "connecting" | "open" | "close", detail?: string) => void

  constructor(
    config: {
      sessionDir: string
      defaultAgent?: string
      allowFrom?: string[]
      routes?: WhatsAppRoute[]
      onQR?: (qr: string | null) => void
      onStatus?: (status: "connecting" | "open" | "close", detail?: string) => void
      /** Throttle settings for live Baileys reads. Falls back to safe defaults. */
      throttle?: { minMsBetweenCalls?: number; maxCallsPerMinute?: number }
    },
    log: (...args: unknown[]) => void = console.error.bind(console, "[whatsapp]"),
  ) {
    this.sessionDir = resolve(config.sessionDir)
    this.defaultAgent = config.defaultAgent
    this.allowFrom = config.allowFrom
    this.routes = config.routes || []
    this.onQR = config.onQR
    this.onStatus = config.onStatus
    this.log = log
    this.cache = new WhatsAppCache(this.sessionDir)
    if (config.throttle?.minMsBetweenCalls) this.throttleMinMs = config.throttle.minMsBetweenCalls
    if (config.throttle?.maxCallsPerMinute) this.throttleMaxPerMinute = config.throttle.maxCallsPerMinute
  }

  /** Read-only access for the wiki ingestor. Exposed so the ingestor can
   *  iterate the passive snapshot without reaching into adapter internals. */
  getCache(): WhatsAppCache { return this.cache }

  /** True once the socket has connected at least once and emitted the
   *  authenticated user. The ingestor checks this before attempting any
   *  live read — a torn-down session will otherwise throw a cryptic error. */
  isConnected(): boolean {
    return !!this.sock && !!this.sock.user
  }

  /**
   * Resolve which agent handles a message based on routes.
   */
  resolveAgent(senderPhone: string, groupName?: string, groupJid?: string): string | undefined {
    for (const route of this.routes) {
      // Match by contact phone number
      if (route.contact) {
        const normalized = route.contact.replace(/\+/g, "")
        if (senderPhone.includes(normalized) || normalized.includes(senderPhone)) {
          return route.agent
        }
      }
      // Match by group name or JID
      if (route.group && (groupName || groupJid)) {
        const pattern = route.group.toLowerCase()
        if (
          groupName?.toLowerCase().includes(pattern) ||
          groupJid?.toLowerCase().includes(pattern)
        ) {
          return route.agent
        }
      }
    }
    return this.defaultAgent
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    // Dynamic import — Baileys is optional
    let makeWASocket: any
    let useMultiFileAuthState: any
    let DisconnectReason: any

    let baileys: any
    try {
      baileys = await import("@whiskeysockets/baileys")
      makeWASocket = baileys.default || baileys.makeWASocket
      useMultiFileAuthState = baileys.useMultiFileAuthState
      DisconnectReason = baileys.DisconnectReason
    } catch {
      this.log("WhatsApp requires @whiskeysockets/baileys. Install with:")
      this.log("  npm install @whiskeysockets/baileys")
      return
    }

    mkdirSync(this.sessionDir, { recursive: true })

    // Increment generation — stale socket events from previous start() calls
    // will see a mismatched generation and be ignored
    const myGeneration = ++this.generation

    // Close existing socket before creating a new one
    if (this.sock) {
      try { this.sock.end(undefined) } catch {}
      this.sock = null
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir)

    // Fetch latest WhatsApp Web version (critical for avoiding 405 errors)
    let version: [number, number, number] | undefined
    try {
      const { version: v } = await baileys.fetchLatestBaileysVersion()
      version = v
      this.log(`WhatsApp Web version: ${v.join(".")}`)
    } catch {
      this.log("Could not fetch WA version, using default")
    }

    // Silent logger with proper method stubs (Baileys v7 requires all methods)
    const silentLogger = {
      level: "silent",
      trace: () => {}, debug: () => {}, info: () => {},
      warn: () => {}, fatal: () => {},
      error: (...args: any[]) => this.log("WA error:", ...args),
      child: () => silentLogger,
    } as any

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: baileys.makeCacheableSignalKeyStore
          ? baileys.makeCacheableSignalKeyStore(state.keys, silentLogger)
          : state.keys,
      },
      ...(version ? { version } : {}),
      logger: silentLogger,
      printQRInTerminal: false,
      browser: ["agentx", "server", "1.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    })

    // Save credentials on update
    this.sock.ev.on("creds.update", saveCreds)

    // Debug + cache hydration: history-set carries chats+contacts we can
    // seed the cache with (message bodies are intentionally ignored —
    // see whatsapp-cache.ts for why).
    this.sock.ev.on("messaging-history.set", (data: any) => {
      this.log(`WA history sync: ${data.messages?.length || 0} messages, ${data.isLatest ? "latest" : "partial"}`)
      try { this.cache.applyHistorySet(data) } catch (e: any) { this.log(`cache history-set error: ${e.message}`) }
    })

    // Passive cache maintenance. These four events arrive for free whenever
    // Baileys observes updates; previously ignored. The wiki ingestor
    // reads from this cache instead of hitting Baileys live, which keeps
    // ingest latency low and avoids adding to the personal-account
    // ban-risk surface.
    this.sock.ev.on("contacts.update", (updates: any) => {
      try { this.cache.applyContactsUpdate(updates) } catch (e: any) { this.log(`cache contacts.update error: ${e.message}`) }
    })
    this.sock.ev.on("contacts.upsert", (contacts: any) => {
      try { this.cache.applyContactsUpdate(contacts) } catch (e: any) { this.log(`cache contacts.upsert error: ${e.message}`) }
    })
    this.sock.ev.on("chats.upsert", (chats: any) => {
      try { this.cache.applyChatsUpsert(chats) } catch (e: any) { this.log(`cache chats.upsert error: ${e.message}`) }
    })
    this.sock.ev.on("chats.update", (updates: any) => {
      try { this.cache.applyChatsUpsert(updates) } catch (e: any) { this.log(`cache chats.update error: ${e.message}`) }
    })
    this.sock.ev.on("groups.update", (updates: any) => {
      try { this.cache.applyGroupsUpdate(updates) } catch (e: any) { this.log(`cache groups.update error: ${e.message}`) }
    })

    // Handle connection updates (ignore events from stale sockets via generation check)
    this.sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update
      if (myGeneration !== this.generation) return // stale socket event

      if (qr) {
        this.log("Scan QR code with WhatsApp to connect:")
        // Publish the raw QR so the admin dashboard can render it in-browser.
        try { this.onQR?.(qr) } catch { /* consumer crashed — don't block the socket */ }
        // Render QR as text in terminal too (keeps SSH-only setups working).
        try {
          // @ts-ignore - no type declarations for qrcode-terminal
          const { default: qrcode } = await import("qrcode-terminal") as any
          qrcode.generate(qr, { small: true })
        } catch {
          // If qrcode-terminal not available, log raw QR string
          this.log(`QR: ${qr}`)
          this.log("Install qrcode-terminal for visual QR: npm install qrcode-terminal")
        }
      }
      if (connection) {
        try { this.onStatus?.(connection, lastDisconnect?.error?.message) } catch { /* */ }
      }
      if (connection === "open") {
        // Clear the cached QR once the pairing succeeds so the dashboard stops
        // showing a scannable code the user already consumed.
        try { this.onQR?.(null) } catch { /* */ }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const reason = lastDisconnect?.error?.output?.payload?.message || ""
        this.log(`WhatsApp connection closed (status: ${statusCode}, reason: ${reason})`)

        if (statusCode === DisconnectReason?.loggedOut || statusCode === 401) {
          this.log("Logged out. Delete session dir and restart to re-scan QR.")
        } else if (statusCode === 440 || statusCode === 408) {
          // 440 = conflict:replaced (another session took over)
          // 408 = connection timed out (QR not scanned)
          this.reconnectAttempts++

          if (this.reconnectAttempts >= 5) {
            this.log(`WhatsApp: giving up after ${this.reconnectAttempts} conflict attempts. Another session is active for this number — close it or re-scan QR.`)
            return // Stop reconnecting
          }

          const delay = Math.min(10_000 * Math.pow(2, this.reconnectAttempts - 1), 120_000)
          this.log(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/5)...`)
          setTimeout(() => this.start(), delay)
        } else if (statusCode === 515) {
          // Stream error — restart after delay
          this.log("Stream error, reconnecting in 5s...")
          setTimeout(() => this.start(), 5000)
        } else if (statusCode !== undefined) {
          this.log("Reconnecting in 3s...")
          setTimeout(() => this.start(), 3000)
        }
        // If statusCode is undefined, don't reconnect (likely startup failure)
      }

      if (connection === "open") {
        // Don't reset reconnectAttempts here — it gets reset on first
        // successful message send/receive (proving connection is stable)
        this.log("WhatsApp connected")
      }
    })

    // Handle incoming messages
    this.sock.ev.on("messages.upsert", async (m: any) => {
      // Connection is confirmed stable — reset reconnect backoff
      if (this.reconnectAttempts > 0) {
        this.log(`WhatsApp connection stable, resetting reconnect counter (was ${this.reconnectAttempts})`)
        this.reconnectAttempts = 0
      }

      this.log(`WA messages.upsert: ${m.messages?.length || 0} messages, type: ${m.type}`)

      if (!this.handler) return

      for (const msg of m.messages || []) {
        const jidShort = (msg.key.remoteJid || "").replace(/@.*/, "").slice(-6)
        const hasText = !!(msg.message?.conversation || msg.message?.extendedTextMessage?.text)
        this.log(`WA msg: from=${jidShort} fromMe=${msg.key.fromMe} hasText=${hasText} type=${Object.keys(msg.message || {}).join(",")}`)

        // Skip status broadcasts
        if (msg.key.remoteJid === "status@broadcast") continue

        // Skip messages we sent as replies (prevents loops)
        if (msg.key.id && this.sentMessageIds.has(msg.key.id)) {
          this.sentMessageIds.delete(msg.key.id)
          continue
        }

        // For fromMe: only process self-chat (messaging yourself = talking to agent)
        // OpenClaw pattern: if your own number is in allowFrom, self-chat is enabled.
        // WhatsApp uses LID format for self-chat remoteJid.
        if (msg.key.fromMe) {
          const me = this.sock?.user
          const remoteJid = msg.key.remoteJid || ""
          // Self-chat: remoteJid matches our JID or LID
          const myJid = me?.id?.replace(/:.*/, "") || ""     // 21624309128
          const myLid = me?.lid?.replace(/:.*/, "") || ""     // 214997540012179
          const chatUser = remoteJid.replace(/:.*/, "").replace(/@.*/, "")
          const isSelfChat = (chatUser === myJid) || (chatUser === myLid)
          if (!isSelfChat) continue
        }

        // Extract text content + detect media
        let text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || msg.message?.videoMessage?.caption
          || ""

        // Detect media type
        const msgContent = msg.message || {}
        const hasImage = !!msgContent.imageMessage
        const hasAudio = !!msgContent.audioMessage
        const hasVideo = !!msgContent.videoMessage
        const hasDocument = !!msgContent.documentMessage
        const hasSticker = !!msgContent.stickerMessage
        const hasMedia = hasImage || hasAudio || hasVideo || hasDocument || hasSticker

        // Add media placeholder to text if no caption
        if (hasMedia && !text) {
          if (hasImage) text = "[Image attached — please describe what you see]"
          else if (hasAudio) text = "[Voice message attached — please transcribe and respond]"
          else if (hasVideo) text = "[Video attached]"
          else if (hasDocument) text = `[Document: ${msgContent.documentMessage?.fileName || "file"}]`
          else if (hasSticker) text = "[Sticker]"
        }

        if (!text) continue

        const jid = msg.key.remoteJid || ""
        const isGroup = jid.endsWith("@g.us")

        // For DMs: remoteJid is the conversation partner
        // For groups: participant is the sender
        const chatPhone = jid.replace(/@.*$/, "")
        const senderJid = isGroup ? (msg.key.participant || "") : jid
        const senderPhone = senderJid.replace(/@.*$/, "")

        // Allowlist check — match against chat (conversation partner) not just sender
        // This allows the owner (fromMe) to talk to their agent via any contact
        if (this.allowFrom?.length && !msg.key.fromMe) {
          const allowed = this.allowFrom.some(p => {
            const normalized = p.replace(/\+/g, "")
            return senderPhone.includes(normalized) || chatPhone.includes(normalized)
          })
          if (!allowed) continue
        }

        const senderName = msg.key.fromMe ? "me" : (msg.pushName || senderPhone)

        // Get group name if available
        let groupName: string | undefined
        if (isGroup && this.sock) {
          try {
            const metadata = await this.sock.groupMetadata(jid)
            groupName = metadata.subject
          } catch { /* group metadata unavailable */ }
        }

        // Route to agent based on contact/group rules
        const resolvedAgent = this.resolveAgent(senderPhone, groupName, isGroup ? jid : undefined)
        if (!resolvedAgent) {
          this.log(`No route for ${isGroup ? `group ${groupName || jid}` : senderPhone}, skipping`)
          continue
        }

        // Download and save media if present
        let mediaInfo: IncomingMessage["media"] | undefined
        if (hasMedia && this.sock) {
          try {
            const baileys = await import("@whiskeysockets/baileys")
            const buffer = await baileys.downloadMediaMessage(msg, "buffer", {}, {
              reuploadRequest: this.sock.updateMediaMessage,
              logger: this.sock.logger,
            })
            if (buffer) {
              const mime = msgContent.imageMessage?.mimetype
                || msgContent.audioMessage?.mimetype || "audio/ogg"
                || msgContent.videoMessage?.mimetype || "video/mp4"
                || msgContent.documentMessage?.mimetype
                || msgContent.stickerMessage?.mimetype || "image/webp"
                || "application/octet-stream"
              const ext = mime.split("/")[1]?.split(";")[0] || "bin"
              const mediaDir = resolve(this.sessionDir, "../media/inbound")
              mkdirSync(mediaDir, { recursive: true })
              const fileName = msgContent.documentMessage?.fileName || `${randomUUID()}.${ext}`
              const filePath = join(mediaDir, fileName)
              writeFileSync(filePath, buffer)
              mediaInfo = { path: filePath, type: mime, fileName }
              this.log(`WA media saved: ${mime} -> ${filePath}`)
            }
          } catch (e: any) {
            this.log(`WA media download failed: ${e.message}`)
          }
        }

        const incoming: IncomingMessage = {
          id: msg.key.id || String(Date.now()),
          channel: "whatsapp",
          accountId: "default",
          sender: {
            id: msg.key.fromMe
              ? (this.sock?.user?.id?.replace(/:.*/, "") || senderPhone) + "@s.whatsapp.net"
              : senderPhone,
            name: senderName,
            username: senderPhone,
          },
          group: isGroup ? {
            id: jid,
            name: groupName || jid,
          } : undefined,
          text,
          media: mediaInfo,
          replyTo: msg.message?.extendedTextMessage?.contextInfo?.stanzaId,
          timestamp: new Date((msg.messageTimestamp || 0) * 1000),
          raw: msg,
          resolvedAgent,
        }

        this.handler(incoming).catch((e: any) => {
          this.log(`Error handling message: ${e.message}`)
        })
      }
    })
  }

  async stop(): Promise<void> {
    // Snapshot the passive cache before tearing down the socket — Baileys
    // events stop firing once `sock.end()` runs, so anything we haven't
    // persisted is lost on restart otherwise.
    try { this.cache.save() } catch (e: any) { this.log(`cache save error: ${e.message}`) }
    if (this.sock) {
      this.sock.end()
      this.sock = null
    }
  }

  async send(msg: OutgoingMessage): Promise<string> {
    if (!this.sock) {
      this.log("WhatsApp not connected")
      return ""
    }

    const jid = msg.chatId.includes("@")
      ? msg.chatId
      : `${msg.chatId}@s.whatsapp.net`

    try {
      let content: Record<string, unknown>

      if (msg.poll) {
        content = {
          poll: {
            name: msg.poll.name,
            values: msg.poll.values,
            selectableCount: msg.poll.selectableCount ?? 1,
          },
        }
      } else if (msg.media) {
        const mediaPayload: Record<string, unknown> = {
          mimetype: msg.media.mimetype,
        }
        if (msg.media.caption) mediaPayload.caption = msg.media.caption
        if (msg.media.fileName) mediaPayload.fileName = msg.media.fileName

        const source = { url: msg.media.url }
        switch (msg.media.type) {
          case "image":
            content = { image: source, ...mediaPayload }
            break
          case "video":
            content = { video: source, ...mediaPayload }
            break
          case "audio":
            content = { audio: source, ptt: false, ...mediaPayload }
            break
          case "document":
            content = { document: source, ...mediaPayload }
            break
          default:
            content = { document: source, ...mediaPayload }
        }
      } else {
        content = { text: msg.text }
      }

      const sent = await this.sock.sendMessage(jid, content)
      const sentId = sent?.key?.id || ""
      if (sentId) this.sentMessageIds.add(sentId)
      return sentId
    } catch (e: any) {
      this.log(`Send error: ${e.message}`)
      return ""
    }
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    if (!this.sock) return false
    const jid = chatId.includes("@") ? chatId : `${chatId}@s.whatsapp.net`
    try {
      await this.sock.sendMessage(jid, {
        text,
        edit: { remoteJid: jid, id: messageId, fromMe: true },
      })
      return true
    } catch { return false }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.sock) return
    const jid = chatId.includes("@") ? chatId : `${chatId}@s.whatsapp.net`
    try {
      await this.sock.sendPresenceUpdate("composing", jid)
    } catch { /* best-effort */ }
  }

  async react(chatId: string, messageId: string, emoji: string = "👀"): Promise<void> {
    if (!this.sock) return
    const jid = chatId.includes("@") ? chatId : `${chatId}@s.whatsapp.net`
    try {
      await this.sock.sendMessage(jid, {
        react: { text: emoji, key: { remoteJid: jid, id: messageId } },
      })
    } catch { /* best-effort */ }
  }

  // --- Read API (consumed by src/wiki/ingest-whatsapp.ts) ---
  //
  // All methods prefer the passive cache. Live Baileys calls happen only
  // for getHistory (there's no cached message body) and are routed through
  // `throttleGate()`. Callers never import Baileys.

  listContacts(): ContactSummary[] {
    return this.cache.listContacts().map(contactRecordToSummary)
  }

  listChats(): ChatSummary[] {
    return this.cache.listChats().map(chatRecordToSummary)
  }

  async getContactProfile(jid: string): Promise<ContactSummary | null> {
    const record = this.cache.getContact(jid)
    // Live enrichment is optional — we return whatever the cache has even
    // if the status field is empty. Keeps the ingestor's happy path fast
    // on bulk list-then-ingest workflows.
    return record ? contactRecordToSummary(record) : null
  }

  async getGroupMetadata(jid: string): Promise<GroupInfo | null> {
    // Cache hit? return immediately. Otherwise fall back to a live call
    // via the throttle — first-time lookups on freshly-added groups go
    // this path, and bulk sweeps respect the rate limit.
    const cached = this.cache.getGroup(jid)
    if (cached && cached.subject) return groupRecordToInfo(cached)
    if (!this.isConnected()) return cached ? groupRecordToInfo(cached) : null
    try {
      const live: any = await this.throttleGate(() => this.sock.groupMetadata(jid))
      // Hydrate the cache so subsequent sweeps hit in memory.
      this.cache.applyGroupsUpdate([{
        id: jid,
        subject: live?.subject,
        desc: live?.desc,
        owner: live?.owner,
        participants: live?.participants,
      }])
      const refreshed = this.cache.getGroup(jid)
      return refreshed ? groupRecordToInfo(refreshed) : null
    } catch (e: any) {
      this.log(`getGroupMetadata(${jid}) failed: ${e.message}`)
      return cached ? groupRecordToInfo(cached) : null
    }
  }

  /** Fetch up to `limit` recent messages for `jid`. This is the one read
   *  that always hits Baileys live — there's no cached message body and
   *  baileys doesn't persist history by default with the options we use.
   *  Throttled. */
  async getHistory(
    jid: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<HistoryMessage[]> {
    if (!this.isConnected()) return []
    const limit = Math.max(1, Math.min(500, opts.limit ?? 50))
    try {
      const messages = await this.throttleGate(async () => {
        // Baileys' `fetchMessagesFromWA` signature varies across versions.
        // Call the stable `loadMessages` if present, else `fetchMessagesFromWA`.
        const sock: any = this.sock
        if (typeof sock.loadMessages === "function") {
          return await sock.loadMessages(jid, limit, opts.before ? { before: { id: opts.before } } : undefined)
        }
        if (typeof sock.fetchMessagesFromWA === "function") {
          return await sock.fetchMessagesFromWA(jid, limit, opts.before ? { before: { id: opts.before } } : undefined)
        }
        return []
      })
      return (messages || []).map(mapBaileysMessage).filter(Boolean) as HistoryMessage[]
    } catch (e: any) {
      this.log(`getHistory(${jid}) failed: ${e.message}`)
      return []
    }
  }

  /** Token-bucket gate for live Baileys reads. Enforces
   *  `throttleMinMs` between calls and caps the per-minute call count.
   *  Returns a promise that resolves once it's safe to fire. */
  private async throttleGate<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now()
    // Remove calls older than the 60s window
    this.readsInWindow = this.readsInWindow.filter((t) => now - t < 60_000)
    // If we're over the per-minute cap, wait until the oldest call ages out
    if (this.readsInWindow.length >= this.throttleMaxPerMinute) {
      const wait = 60_000 - (now - this.readsInWindow[0]!) + 10
      await delay(wait)
    }
    // Enforce minimum spacing between calls
    const sinceLast = Date.now() - this.lastReadAt
    if (sinceLast < this.throttleMinMs) {
      await delay(this.throttleMinMs - sinceLast)
    }
    this.lastReadAt = Date.now()
    this.readsInWindow.push(this.lastReadAt)
    return fn()
  }
}

// --- Helpers: shape translators (keep the public API decoupled from cache schema) ---

function contactRecordToSummary(r: ContactRecord): ContactSummary {
  return {
    jid: r.jid,
    phone: r.phone,
    name: r.savedName || r.pushName || r.phone || r.jid,
    pushName: r.pushName,
    savedName: r.savedName,
    status: r.status,
    updatedAt: r.updatedAt,
  }
}

function chatRecordToSummary(r: ChatRecord): ChatSummary {
  return {
    jid: r.jid,
    name: r.name || r.jid.replace(/@.*$/, ""),
    isGroup: r.isGroup,
    lastMessageAt: r.lastMessageAt,
    unreadCount: r.unreadCount,
  }
}

function groupRecordToInfo(r: GroupRecord): GroupInfo {
  return {
    jid: r.jid,
    subject: r.subject || "",
    description: r.description,
    owner: r.owner,
    members: r.members.map((m) => ({ jid: m.jid, admin: m.admin })),
    memberCount: r.members.length,
  }
}

function mapBaileysMessage(raw: any): HistoryMessage | null {
  if (!raw || !raw.key) return null
  const msg = raw.message || {}
  const text =
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ""
  let media: HistoryMessage["media"] | undefined
  if (msg.imageMessage) media = { kind: "image", caption: msg.imageMessage.caption }
  else if (msg.audioMessage) media = { kind: "audio" }
  else if (msg.videoMessage) media = { kind: "video", caption: msg.videoMessage.caption }
  else if (msg.documentMessage) media = { kind: "document", filename: msg.documentMessage.fileName }
  else if (msg.stickerMessage) media = { kind: "sticker" }
  // Skip empty-text messages with no media — they're almost always
  // receipts, reactions, or protocol frames not useful to the wiki.
  if (!text && !media) return null
  const timestamp = typeof raw.messageTimestamp === "number"
    ? raw.messageTimestamp
    : (raw.messageTimestamp?.low ?? undefined)
  return {
    id: raw.key.id,
    fromJid: raw.key.fromMe
      ? (raw.key.remoteJid || "")
      : (raw.key.participant || raw.key.remoteJid || ""),
    fromMe: !!raw.key.fromMe,
    timestamp,
    text,
    media,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}
