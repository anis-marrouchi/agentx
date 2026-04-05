// --- Channel adapter interface ---

export interface IncomingMessage {
  id: string
  channel: string       // "telegram", "whatsapp"
  accountId: string     // which bot account received it
  sender: {
    id: string
    name: string
    username?: string
  }
  group?: {
    id: string
    name: string
  }
  text: string
  replyTo?: string      // message ID being replied to
  timestamp: Date
  raw?: unknown         // original platform message
}

export interface OutgoingMessage {
  channel: string
  chatId: string
  text: string
  replyTo?: string
  parseMode?: "markdown" | "html" | "plain"
}

export interface ChannelAdapter {
  readonly name: string

  /** Start polling or webhook listener */
  start(): Promise<void>

  /** Stop the adapter gracefully */
  stop(): Promise<void>

  /** Send a message back to a chat */
  send(msg: OutgoingMessage): Promise<string | void>

  /** Edit an existing message (returns false if not supported) */
  editMessage?(chatId: string, messageId: string, text: string, parseMode?: string): Promise<boolean>

  /** Send typing/action indicator */
  sendTyping?(chatId: string): Promise<void>

  /** React to a message with an emoji (e.g., 👀 for seen) */
  react?(chatId: string, messageId: string, emoji?: string): Promise<void>

  /** Register handler for incoming messages */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void
}
