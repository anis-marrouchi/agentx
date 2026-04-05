import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "./types"
import { existsSync, mkdirSync } from "fs"
import { resolve } from "path"

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

    try {
      const baileys = await import("@whiskeysockets/baileys")
      makeWASocket = baileys.default || baileys.makeWASocket
      useMultiFileAuthState = baileys.useMultiFileAuthState
      DisconnectReason = baileys.DisconnectReason
    } catch {
      this.log("WhatsApp requires @whiskeysockets/baileys. Install with:")
      this.log("  npm install @whiskeysockets/baileys")
      return
    }

    mkdirSync(this.sessionDir, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir)

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: { level: "silent", child: () => ({ level: "silent" }) } as any,
    })

    // Save credentials on update
    this.sock.ev.on("creds.update", saveCreds)

    // Handle connection updates
    this.sock.ev.on("connection.update", (update: any) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.log("Scan QR code with WhatsApp to connect")
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason?.loggedOut

        if (shouldReconnect) {
          this.log("Connection closed, reconnecting...")
          this.start()
        } else {
          this.log("Logged out. Delete session dir and re-scan QR.")
        }
      }

      if (connection === "open") {
        this.log("WhatsApp connected")
      }
    })

    // Handle incoming messages
    this.sock.ev.on("messages.upsert", async (m: any) => {
      if (!this.handler) return

      for (const msg of m.messages || []) {
        // Skip status broadcasts and own messages
        if (msg.key.remoteJid === "status@broadcast") continue
        if (msg.key.fromMe) continue

        // Extract text content
        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || msg.message?.videoMessage?.caption
          || ""

        if (!text) continue

        const jid = msg.key.remoteJid || ""
        const isGroup = jid.endsWith("@g.us")
        const senderJid = isGroup ? (msg.key.participant || "") : jid
        const senderPhone = senderJid.replace(/@.*$/, "")

        // Allowlist check
        if (this.allowFrom?.length) {
          const allowed = this.allowFrom.some(p =>
            senderPhone.includes(p.replace(/\+/g, ""))
          )
          if (!allowed) continue
        }

        const senderName = msg.pushName || senderPhone

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

        const incoming: IncomingMessage = {
          id: msg.key.id || String(Date.now()),
          channel: "whatsapp",
          accountId: "default",
          sender: {
            id: senderPhone,
            name: senderName,
            username: senderPhone,
          },
          group: isGroup ? {
            id: jid,
            name: groupName || jid,
          } : undefined,
          text,
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
      return sent?.key?.id || ""
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
