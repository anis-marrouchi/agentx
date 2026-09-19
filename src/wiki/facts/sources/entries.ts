import type { FactRecord } from "../types"
import { countryFromPhone } from "./wacli"

// Identifiers the entries already carry.
//
// Every other source in this directory asks an outside system who
// someone is. This one asks the batch, because since senders are
// stamped at capture the platform's own identifier travels with the
// message: a WhatsApp JID is the number, a GitLab sender is the handle.
//
// That makes it the best source available, not a fallback. It needs no
// tool installed, no token, and no network — it works on a server with
// none of the CLIs — and it cannot mismatch, because there is no name
// resolution step to get wrong. `wacli` answers "who is called Alex
// Rivera"; this answers "who sent this message", and only the second
// question has one right answer.

export interface SenderStampedEntry {
  source?: string
  meta?: Record<string, unknown> | undefined
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined

/** "whatsapp@clawd-server" and "gitlab" both normalise to their platform. */
export function platformOf(source?: string): string {
  return String(source ?? "").split("@")[0].split(":")[0].toLowerCase()
}

/**
 * Turn stamped sender metadata into fact records.
 *
 * Deliberately conservative about what counts as a contact value. A
 * Telegram numeric user id identifies an account but cannot be dialled,
 * messaged by a human, or pasted anywhere useful, so it is recorded as
 * an account id and never as a way to reach someone — writing it into
 * an article's contact line would satisfy the grader while helping
 * nobody, which is the exact failure this whole layer exists to undo.
 */
export function recordsFromEntries(entries: SenderStampedEntry[]): FactRecord[] {
  const byName = new Map<string, FactRecord>()

  for (const e of entries) {
    const name = str(e.meta?.sender)
    if (!name) continue
    const id = str(e.meta?.senderId)
    const username = str(e.meta?.senderUsername)
    const platform = platformOf(e.source)

    const fields: Record<string, string> = {}

    if (id && /@s\.whatsapp\.net$/.test(id)) {
      const digits = id.split("@")[0].replace(/\D/g, "")
      if (digits) {
        fields.phone = `+${digits}`
        fields.whatsapp = id
        const country = countryFromPhone(digits)
        if (country) fields.country = country
      }
    } else if (platform === "whatsapp" && id && /^\d{6,}$/.test(id)) {
      fields.phone = `+${id}`
      fields.whatsapp = `${id}@s.whatsapp.net`
      const country = countryFromPhone(id)
      if (country) fields.country = country
    }

    if (username) {
      const handle = username.startsWith("@") ? username : `@${username}`
      if (platform === "gitlab") fields.gitlab = handle
      else if (platform === "github") fields.github = handle
      else if (platform === "telegram") fields.telegram = handle
      else fields.handle = handle
    }

    // An account id is provenance, not a contact value.
    if (id && !fields.phone && !username) fields[`${platform || "platform"}Id`] = id

    if (Object.keys(fields).length === 0) continue

    const key = name.toLowerCase()
    const existing = byName.get(key)
    if (!existing) {
      byName.set(key, { name, source: "entries", fields })
      continue
    }
    // Same person across several entries — union the identifiers rather
    // than letting the last message win.
    for (const [k, v] of Object.entries(fields)) existing.fields[k] ??= v
  }

  return Array.from(byName.values())
}
