import type { WatchRule } from "./config"
import type { WaMessage } from "./message"

// --- Which watch rule, if any, covers a message ---

/**
 * One spelling per person or group, so a rule can say "+1 555 123 4567"
 * and still match "15551234567@s.whatsapp.net". A device suffix
 * ("…:12@s.whatsapp.net") is dropped.
 */
export function normalizeJid(value: string): string {
  const v = value.trim().toLowerCase()
  const at = v.indexOf("@")
  if (at < 0) {
    const digits = v.replace(/[\s()+.-]/g, "")
    return /^\d+$/.test(digits) ? `${digits}@s.whatsapp.net` : v
  }
  const user = v.slice(0, at).split(":")[0]
  return `${user}${v.slice(at)}`
}

/** The first enabled rule covering this message, or null. */
export function matchRule(msg: WaMessage, rules: readonly WatchRule[]): WatchRule | null {
  const chat = normalizeJid(msg.chat)
  const sender = normalizeJid(msg.sender)
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (rule.chats.length === 0 && rule.senders.length === 0) continue
    if (rule.chats.length && !rule.chats.some((c) => normalizeJid(c) === chat)) continue
    if (rule.senders.length && !rule.senders.some((s) => normalizeJid(s) === sender)) continue
    return rule
  }
  return null
}

/** Minutes since midnight in the given time zone. */
function minutesIn(now: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) })
    .formatToParts(now)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return get("hour") * 60 + get("minute")
}

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** True inside the rule's quiet hours. A window may cross midnight. */
export function inQuietHours(quiet: WatchRule["quietHours"], now: Date, timeZone?: string): boolean {
  if (!quiet) return false
  const start = toMinutes(quiet.start)
  const end = toMinutes(quiet.end)
  if (start === end) return false
  const m = minutesIn(now, timeZone)
  return start < end ? m >= start && m < end : m >= start || m < end
}
