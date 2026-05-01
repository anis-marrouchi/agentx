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
  /** Phase 1 / 6 — when set, identifies the intent-ledger decision row
   *  this message corresponds to. The agent registry calls
   *  `ledger.recordResolution(...)` when the dispatched task completes,
   *  so Inv-ActiveTaskSafety's "decision in flight" check can clear.
   *  Set by the channel adapter (gitlab, router) right after
   *  recordGitLabTargetDispatch / recordRouterDispatch returns the
   *  decision row. Undefined when the dispatch was deduped/halted by
   *  the ledger (no resolution to write) or when the source is in
   *  mode=off. */
  intentRef?: {
    eventId: string
    decidedBy: string
  }
}

export interface OutgoingMessage {
  channel: string
  chatId: string
  text: string
  replyTo?: string
  parseMode?: "markdown" | "html" | "plain"
  agentId?: string  // used by GitLab to select per-agent token
  poll?: {
    name: string
    values: string[]
    selectableCount?: number
  }
  media?: {
    type: "image" | "document" | "audio" | "video"
    url: string
    caption?: string
    mimetype?: string
    fileName?: string
  }
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

  /** Fetch the most recent messages from the live channel for cold-start
   *  session seeding. Called once per (agent, channel, chatId, day) when a
   *  fresh session is created — never on warm cache hits. Bounded by
   *  maxMessages and maxChars (enforced by the caller). Channels return their
   *  own externalId so SessionStore can dedup against re-seeds. */
  seedHistory?(
    chatId: string,
    opts: { sinceISO?: string; maxMessages: number; maxChars: number },
  ): Promise<Array<SeededMessage>>
}

/** A message returned by seedHistory — flat, channel-agnostic. */
export interface SeededMessage {
  role: "user" | "agent"
  name: string
  content: string
  timestamp: string
  externalId?: string
  /** Optional channel-side account/bot identity that handled this message
   *  (e.g., Telegram accountId "noqta_cx_bot"). Captured by adapters that
   *  shadow-log outbound, so seeded history preserves the audit trail of
   *  which bot identity actually sent each line. Renderers may ignore it. */
  accountId?: string
}
