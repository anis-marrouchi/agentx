import { createHmac, timingSafeEqual } from "crypto"

// --- What wacli posts, and how we check it came from wacli ---
//
// `wacli sync --webhook URL --webhook-secret S` posts one JSON object per
// stored message and signs the exact body: X-Wacli-Signature:
// sha256=<hex HMAC-SHA256>. Receipts and presence carry an EventType;
// messages don't.

export const SIGNATURE_HEADER = "x-wacli-signature"

/** True only for a signature made with this secret over these bytes. */
export function verifyWacliSignature(raw: Buffer, header: string | string[] | undefined, secret: string): boolean {
  if (!secret) return false
  const sig = Array.isArray(header) ? header[0] : header
  if (!sig) return false
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex")
  const a = Buffer.from(expected)
  const b = Buffer.from(sig.trim().toLowerCase())
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface WaMedia {
  type: string
  mime?: string
  filename?: string
  caption?: string
}

export interface WaMessage {
  /** WhatsApp's message id. */
  id: string
  /** Chat JID: the contact for a direct chat, the group for a group. */
  chat: string
  /** Who wrote it. Same as chat in a direct chat. */
  sender: string
  senderName?: string
  chatName?: string
  /** ISO time, UTC. */
  at: string
  text: string
  media?: WaMedia
}

const str = (v: unknown): string => (typeof v === "string" ? v : "")

/**
 * The message in a wacli payload, or null for anything that isn't a new
 * incoming message: receipts, presence, our own sends, reactions, edits
 * and revokes.
 */
export function parseWacliMessage(body: unknown): WaMessage | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  if (b.EventType && b.EventType !== "message") return null
  if (b.FromMe === true || b.Revoked === true || b.Edited === true) return null
  if (str(b.ReactionToID)) return null
  const id = str(b.ID).trim()
  const chat = str(b.Chat).trim()
  if (!id || !chat) return null
  const m = b.Media && typeof b.Media === "object" ? (b.Media as Record<string, unknown>) : null
  const media: WaMedia | undefined = m && str(m.Type)
    ? {
        type: str(m.Type),
        ...(str(m.MimeType) ? { mime: str(m.MimeType) } : {}),
        ...(str(m.Filename) ? { filename: str(m.Filename) } : {}),
        ...(str(m.Caption) ? { caption: str(m.Caption) } : {}),
      }
    : undefined
  const text = str(b.Text)
  if (!text.trim() && !media) return null
  return {
    id,
    chat,
    sender: str(b.SenderJID).trim() || chat,
    ...(str(b.PushName) ? { senderName: str(b.PushName) } : {}),
    ...(str(b.ChatName) ? { chatName: str(b.ChatName) } : {}),
    at: str(b.Timestamp) || new Date().toISOString(),
    text,
    ...(media ? { media } : {}),
  }
}
