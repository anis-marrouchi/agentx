import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "./types"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { resolve, join } from "path"
import { randomUUID } from "crypto"

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
  private sentMessageIds: Set<string> = new Set()  // Track our own replies to prevent loops
  private log: (...args: unknown[]) => void

  constructor(
    config: {
      sessionDir: string
      defaultAgent?: string
      allowFrom?: string[]
      routes?: WhatsAppRoute[]
    },
    log: (...args: unknown[]) => void = console.error.bind(console, "[whatsapp]"),
  ) {
    this.sessionDir = resolve(config.sessionDir)
    this.defaultAgent = config.defaultAgent
    this.allowFrom = config.allowFrom
    this.routes = config.routes || []
    this.log = log
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

    // Close existing socket before creating a new one (prevents multiple connections)
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

    // Debug: log all events to diagnose message reception
    this.sock.ev.on("messaging-history.set", (data: any) => {
      this.log(`WA history sync: ${data.messages?.length || 0} messages, ${data.isLatest ? "latest" : "partial"}`)
    })

    // Handle connection updates
    this.sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.log("Scan QR code with WhatsApp to connect:")
        // Render QR as text in terminal
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

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const reason = lastDisconnect?.error?.output?.payload?.message || ""
        this.log(`WhatsApp connection closed (status: ${statusCode}, reason: ${reason})`)

        if (statusCode === DisconnectReason?.loggedOut || statusCode === 401) {
          this.log("Logged out. Delete session dir and restart to re-scan QR.")
        } else if (statusCode === 440 || statusCode === 408) {
          // 440 = conflict:replaced (another session took over)
          // 408 = connection timed out (QR not scanned)
          this.reconnectAttempts = (this.reconnectAttempts || 0) + 1

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
        // Only reset reconnect counter if connection stays open for > 30s
        // (prevents reset on brief connect → immediate 440 conflict cycles)
        const openTime = Date.now()
        setTimeout(() => {
          if (this.sock && Date.now() - openTime > 25_000) {
            this.reconnectAttempts = 0
          }
        }, 30_000)
        this.log("WhatsApp connected")
      }
    })

    // Handle incoming messages
    this.sock.ev.on("messages.upsert", async (m: any) => {
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
      const sent = await this.sock.sendMessage(jid, { text: msg.text })
      const sentId = sent?.key?.id || ""
      // Track to prevent loop (our own reply echoed back as fromMe)
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
}
