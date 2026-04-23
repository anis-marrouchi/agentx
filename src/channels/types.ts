// --- Channel adapter interface ---

/**
 * Verified channel context — facts the channel adapter knows for certain.
 * Prevents agents from hallucinating about their environment.
 */
export interface ChannelMeta {
  /** Channel name */
  channel: string
  /** Verified agents/bots present in this chat/group/project */
  agents?: Array<{ id: string; name: string; handle?: string }>
  /** Project path (GitLab) or group topic */
  project?: string
  /** Issue/MR context (GitLab) */
  issue?: { type: string; iid: string; title: string }
  /** Channel-specific facts (e.g., pipeline status, group description) */
  facts?: string[]
}

export interface IncomingMessage {
  id: string
  channel: string       // "telegram", "whatsapp"
  accountId: string     // which bot account received it
  sender: {
    id: string
    name: string
    username?: string
    /** True when the origin is another bot account (Telegram `from.is_bot`).
     *  Used by the router to apply strict @-mention-only routing — prevents
     *  cross-daemon cascades from bare-word matches in bot replies. */
    isBot?: boolean
  }
  group?: {
    id: string
    name: string
  }
  text: string
  replyTo?: string      // message ID being replied to
  replyToText?: string  // text of the message being replied to
  timestamp: Date
  media?: {              // attached media (image, audio, video, document)
    path: string         // local file path after download
    type: string         // MIME type
    fileName?: string    // original filename
  }
  raw?: unknown         // original platform message
  resolvedAgent?: string // pre-resolved agent ID (for route-based channels like WhatsApp)
  preferNode?: string    // if set, skip local routing and forward to this mesh peer
  channelMeta?: ChannelMeta // verified context from the channel adapter
  /** Correlator threaded by the workflow engine. When a workflow dispatches
   *  an agent, this carries the run id through the pipeline so post:response
   *  can re-enter the engine with `kind: agentResult` transitions. Opaque
   *  everywhere outside src/workflows/. */
  workflowRunId?: string
}

export interface OutgoingMessage {
  channel: string
  chatId: string
  text: string
  replyTo?: string
  parseMode?: "markdown" | "html" | "plain"
  agentId?: string  // used by GitLab to select per-agent token
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

  /** Get verified context for a chat (optional — channels implement what they can) */
  getChannelMeta?(chatId: string): Promise<ChannelMeta | undefined>
}
