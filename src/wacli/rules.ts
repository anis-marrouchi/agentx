import { localClock } from "@/approvals/sweep"

// --- Which WhatsApp messages are watched ---
//
// wacli posts every live message; only those a rule names are kept. A
// message no rule matches is dropped before anything is stored. Pure
// functions, unit tested.

/** A wacli message webhook body (openclaw/wacli docs/sync.md). Only the
 *  fields read here; the rest is ignored. */
export interface WacliMessage {
  Chat: string
  ID: string
  SenderJID?: string
  Timestamp?: string
  FromMe?: boolean
  Text?: string
  PushName?: string
  ChatName?: string
  Media?: { Type?: string; Caption?: string; Filename?: string; MimeType?: string; FileLength?: number } | null
  ReplyToDisplay?: string
  ReactionToID?: string
  Revoked?: boolean
}

export interface WacliRule {
  id: string
  chat?: string
  sender?: string
  group?: string
  agent: string
  prompt?: string
  quietHours?: { start: string; end: string; timezone?: string }
  autoAck: boolean
  enabled: boolean
}

/**
 * The message, or null for anything that isn't a new incoming message:
 * receipts and presence (they carry EventType), the owner's own messages,
 * reactions and deletions.
 */
export function parseWacliMessage(raw: unknown): WacliMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  if (m.EventType !== undefined && m.EventType !== "message") return null
  if (typeof m.Chat !== "string" || !m.Chat || typeof m.ID !== "string" || !m.ID) return null
  if (m.FromMe === true || m.Revoked === true || (typeof m.ReactionToID === "string" && m.ReactionToID)) return null
  return m as unknown as WacliMessage
}

/** "user@server" without a device part ("15551234567:3@…" → "15551234567@…"). */
export function bareJid(jid: string | undefined): string {
  const v = (jid ?? "").trim().toLowerCase()
  const at = v.indexOf("@")
  if (at < 0) return v
  return v.slice(0, at).replace(/[.:].*$/, "") + v.slice(at)
}

/** A phone number as people write it ("+216 12 345 678") becomes a JID;
 *  a JID is kept. */
export function normalizeJid(value: string): string {
  const v = value.trim()
  if (v.includes("@")) return bareJid(v)
  const digits = v.replace(/\D/g, "")
  return digits.length >= 6 ? `${digits}@s.whatsapp.net` : v.toLowerCase()
}

export function isGroupJid(jid: string): boolean {
  return bareJid(jid).endsWith("@g.us")
}

/** Who wrote it. In a direct chat wacli may leave SenderJID empty. */
export function senderOf(msg: WacliMessage): string {
  return bareJid(msg.SenderJID) || (isGroupJid(msg.Chat) ? "" : bareJid(msg.Chat))
}

export function ruleMatches(rule: WacliRule, msg: WacliMessage): boolean {
  if (!rule.enabled || !(rule.chat || rule.sender || rule.group)) return false
  if (rule.chat && bareJid(msg.Chat) !== normalizeJid(rule.chat)) return false
  if (rule.sender && senderOf(msg) !== normalizeJid(rule.sender)) return false
  if (rule.group) {
    if (!isGroupJid(msg.Chat)) return false
    const g = rule.group.trim()
    const byJid = g.includes("@") && bareJid(msg.Chat) === bareJid(g)
    const byName = !!msg.ChatName && msg.ChatName.trim().toLowerCase() === g.toLowerCase()
    if (!byJid && !byName) return false
  }
  return true
}

/** The first enabled rule that matches, in config order. */
export function matchRule(rules: readonly WacliRule[], msg: WacliMessage): WacliRule | null {
  return rules.find((r) => ruleMatches(r, msg)) ?? null
}

/** True inside [start, end); a window past midnight ("22:00"–"07:00") wraps. */
export function inQuietHours(q: WacliRule["quietHours"], now: number): boolean {
  if (!q) return false
  const toMin = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m }
  const start = toMin(q.start)
  const end = toMin(q.end)
  if (start === end) return false
  const { minutes } = localClock(now, q.timezone)
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}
