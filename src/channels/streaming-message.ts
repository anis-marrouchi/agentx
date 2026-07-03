import { splitMessageText } from "./message-chunks"

// --- Rolling multi-message streaming preview ---
//
// A channel reply is streamed by editing a live message as text accumulates.
// Telegram caps a message at ~4096 chars, so once the reply grows past one
// chunk the preview must ROLL into additional messages instead of freezing
// (or, as the old code did, silently truncating to the first chunk).
//
// This owns the id bookkeeping for TEXT only: the accumulated text is
// append-only, so every chunk except the last is stable once a later chunk
// exists — we only edit the growing tail and create new messages as
// boundaries are crossed. `lastSent` mirrors what each message currently
// displays so we never re-edit unchanged content (Telegram rejects an
// unchanged edit as "message is not modified" anyway). Rich extras
// (buttons/poll/media) are attached by the caller against `lastId`.

export interface StreamingMessageDeps {
  /** Create a new message, returns its id (or "" on failure). */
  send: (text: string) => Promise<string>
  /** Edit an existing message. Returns false if the edit failed. */
  edit: (messageId: string, text: string) => Promise<boolean>
  /** Chunk target — text is split at this many chars. */
  maxChars: number
}

export class StreamingMessage {
  private messageIds: string[] = []
  private lastSent: string[] = []

  constructor(private deps: StreamingMessageDeps) {}

  /** Whether any preview message has been created yet. */
  get started(): boolean {
    return this.messageIds.length > 0
  }

  /** The first (anchor / replied-to) message id. */
  get primaryId(): string | undefined {
    return this.messageIds[0]
  }

  /** The last message id — where rich extras (buttons) should attach and
   *  after which a poll/media follow-up should be posted. */
  get lastId(): string | undefined {
    return this.messageIds[this.messageIds.length - 1]
  }

  /** Reconcile the live preview to `fullText`. Safe to call repeatedly with a
   *  growing string; only the changed tail is edited, new chunks are sent. */
  async update(fullText: string): Promise<void> {
    const chunks = fullText ? splitMessageText(fullText, this.deps.maxChars) : []
    if (chunks.length === 0) return

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      if (i < this.messageIds.length) {
        if (this.lastSent[i] !== chunk) {
          const ok = await this.deps.edit(this.messageIds[i], chunk)
          if (ok) this.lastSent[i] = chunk
        }
      } else {
        const id = await this.deps.send(chunk)
        this.messageIds.push(id)
        this.lastSent.push(chunk)
      }
    }
  }
}
