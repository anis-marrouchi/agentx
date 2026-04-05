import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "./types"

// --- WhatsApp adapter (placeholder — requires baileys or WA Business API) ---
// This is a scaffold. Real implementation depends on chosen WhatsApp library.

export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = "whatsapp"
  private sessionDir: string
  private agentBinding?: string
  private handler?: (msg: IncomingMessage) => Promise<void>
  private log: (...args: unknown[]) => void

  constructor(
    config: { sessionDir: string; agentBinding?: string },
    log: (...args: unknown[]) => void = console.error.bind(console, "[whatsapp]"),
  ) {
    this.sessionDir = config.sessionDir
    this.agentBinding = config.agentBinding
    this.log = log
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    this.log("WhatsApp adapter is a placeholder.")
    this.log("To enable, install @whiskeysockets/baileys and implement the connection logic.")
    this.log(`Session dir: ${this.sessionDir}`)
    this.log(`Agent binding: ${this.agentBinding || "(none)"}`)

    // TODO: Implement with Baileys:
    // 1. const { default: makeWASocket, useMultiFileAuthState } = await import("@whiskeysockets/baileys")
    // 2. const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir)
    // 3. const sock = makeWASocket({ auth: state })
    // 4. sock.ev.on("messages.upsert", ...) -> convert to IncomingMessage -> this.handler(msg)
    // 5. On first run, print QR code for pairing
  }

  async stop(): Promise<void> {
    // Close WhatsApp socket
  }

  async send(msg: OutgoingMessage): Promise<void> {
    this.log(`[send] Would send to ${msg.chatId}: ${msg.text.slice(0, 100)}...`)
    // TODO: sock.sendMessage(msg.chatId, { text: msg.text })
  }
}
