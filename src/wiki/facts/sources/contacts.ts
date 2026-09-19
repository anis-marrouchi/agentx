import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import type { EntityHint, FactRecord, FactSource } from "../types"
import { countryFromPhone } from "./wacli"

// The contact registry an operator maintains by hand.
//
// `.agentx/contacts.json` already existed and nothing in the wiki layer
// read it, which meant the one place a person had deliberately written
// down "this human is these accounts" was invisible to the pipeline
// asking that exact question.
//
// It ranks above every other source. wacli knows what WhatsApp knows,
// GitLab knows what GitLab knows, and the entries know who sent a
// message; this is the only source where someone decided that a name,
// an alias and a set of handles all refer to one person. Where it
// disagrees with a directory, the deliberate answer wins — and the
// disagreement is kept and rendered rather than resolved silently.
//
// It is also the only source that resolves aliases, which is what makes
// a single registry entry cover a given name, a "first.last" handle and
// the display name a phone happens to be saved under.

export interface ContactRecord {
  id?: string
  name?: string
  aliases?: string[]
  channels?: Record<string, string>
}

/** Channel key → the fact field it supplies. */
const CHANNEL_FIELDS: Record<string, string> = {
  whatsapp: "whatsapp",
  telegram: "telegram",
  gitlab: "gitlab",
  github: "github",
  email: "email",
  phone: "phone",
  slack: "slack",
  discord: "discord",
}

export function contactsPath(agentxDir = ".agentx"): string {
  return resolve(process.cwd(), agentxDir, "contacts.json")
}

export function loadContacts(path: string): ContactRecord[] {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { contacts?: unknown }
    return Array.isArray(parsed?.contacts) ? (parsed.contacts as ContactRecord[]) : []
  } catch {
    return []
  }
}

const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "").trim()

/** Every spelling this registry entry answers to. */
export function namesOf(c: ContactRecord): string[] {
  return [c.name, c.id, ...(c.aliases ?? [])]
    .filter((x): x is string => Boolean(x && x.trim()))
    .map(norm)
}

/**
 * Turn one registry entry's channels into fact fields.
 *
 * A WhatsApp JID is also a number and a country, so it expands rather
 * than being copied across verbatim — the same unpacking the entries
 * source does, because a reader wants the number, not the routing
 * address it happens to be embedded in.
 */
export function factsFrom(c: ContactRecord): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const [key, raw] of Object.entries(c.channels ?? {})) {
    const value = String(raw ?? "").trim()
    if (!value) continue
    const field = CHANNEL_FIELDS[key.toLowerCase()] ?? key.toLowerCase()

    if (field === "whatsapp") {
      const digits = value.split("@")[0].replace(/\D/g, "")
      fields.whatsapp = value.includes("@") ? value : `${digits}@s.whatsapp.net`
      if (digits) {
        fields.phone ??= `+${digits}`
        const country = countryFromPhone(digits)
        if (country) fields.country ??= country
      }
      continue
    }
    if (field === "phone") {
      const digits = value.replace(/\D/g, "")
      fields.phone = value.startsWith("+") ? value : `+${digits}`
      const country = countryFromPhone(digits)
      if (country) fields.country ??= country
      continue
    }
    // A bare numeric Telegram id is an account, not a way to reach
    // someone — same rule the entries source applies.
    if (field === "telegram" && /^\d+$/.test(value)) {
      fields.telegramId = value
      continue
    }
    fields[field] = field === "gitlab" || field === "github"
      ? (value.startsWith("@") ? value : `@${value}`)
      : value
  }
  return fields
}

export function createContactsSource(opts: { path?: string } = {}): FactSource {
  const path = opts.path ?? contactsPath()

  return {
    name: "contacts",
    provides: ["contact value", "handles", "country"],
    async available() {
      if (!existsSync(path)) {
        return {
          kind: "not-configured",
          hint: `no ${path} — add {"contacts":[{"name":"…","aliases":[],"channels":{"whatsapp":"…"}}]}`,
        }
      }
      return loadContacts(path).length > 0
        ? null
        : { kind: "not-configured", hint: `${path} has no contacts` }
    },
    async lookup(hints: EntityHint[]) {
      const contacts = loadContacts(path)
      if (contacts.length === 0) return []

      const index = new Map<string, ContactRecord>()
      for (const c of contacts) for (const n of namesOf(c)) if (n) index.set(n, c)

      const out: FactRecord[] = []
      const seen = new Set<ContactRecord>()
      for (const h of hints) {
        const c = index.get(norm(h.name))
        if (!c || seen.has(c)) continue
        seen.add(c)
        const fields = factsFrom(c)
        if (Object.keys(fields).length === 0) continue
        out.push({
          name: c.name ?? h.name,
          source: "contacts",
          fields,
          // Matched on an alias rather than the registry's own name.
          fuzzy: norm(c.name ?? "") !== norm(h.name),
        })
      }
      return out
    },
  }
}
