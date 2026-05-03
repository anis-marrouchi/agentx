import { existsSync, readFileSync } from "fs"
import { resolve } from "path"

// --- Contact directory ---
//
// Resolves human contacts by name → channel address (Telegram chat id, GitLab
// username, WhatsApp jid). Backs the agentx_send_contact MCP tool.
//
// Source of truth: .agentx/contacts.json. Operator-edited; hot-reloadable via
// the daemon's /reload endpoint. Sibling of .agentx/sessions and .agentx/wiki.
//
// Resolution order: exact id → exact alias → fuzzy substring (longest match,
// requires explicit confirmation from the caller). On collision with a
// registered agent (same name resolves to both an agent and a contact), the
// caller gets `kind: "ambiguous"` and refuses to send — the agent must ask
// the user which target was meant.

export interface Contact {
  /** Stable id (slug). Used as the primary key. */
  id: string
  /** Display name shown in confirmation dialogs. */
  name: string
  /** Aliases the caller can use to look up this contact (case-insensitive). */
  aliases?: string[]
  /** Channel-specific addresses. Key = channel name (telegram | whatsapp |
   *  gitlab | github | discord); value = the channel-native id (chatId for
   *  Telegram, jid for WhatsApp, username for GitLab/GitHub, etc.). */
  channels: Record<string, string>
}

export type ResolveResult =
  | { kind: "exact"; contact: Contact }
  | { kind: "alias"; contact: Contact }
  | { kind: "fuzzy"; contact: Contact; confidence: number }
  | { kind: "ambiguous"; candidates: Contact[] }
  | { kind: "miss"; query: string }

const CONTACTS_RELPATH = ".agentx/contacts.json"

export class ContactDirectory {
  private contacts: Contact[] = []
  private filePath: string
  private log: (...args: unknown[]) => void

  constructor(
    baseDir: string = process.cwd(),
    log: (...args: unknown[]) => void = () => {},
  ) {
    this.filePath = resolve(baseDir, CONTACTS_RELPATH)
    this.log = log
    this.reload()
  }

  /** Re-read .agentx/contacts.json. Safe to call on /reload. Silently keeps
   *  the prior list if the file is missing or invalid (so a typo in the
   *  contacts file doesn't take routing offline). */
  reload(): { count: number; error?: string } {
    if (!existsSync(this.filePath)) {
      this.contacts = []
      return { count: 0 }
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8")
      const parsed = JSON.parse(raw) as { contacts?: Contact[] }
      const list = Array.isArray(parsed.contacts) ? parsed.contacts : []
      // Validate each entry — drop malformed ones rather than throw.
      const valid = list.filter((c) => {
        if (!c || typeof c.id !== "string" || !c.id) return false
        if (typeof c.name !== "string" || !c.name) return false
        if (!c.channels || typeof c.channels !== "object") return false
        return true
      })
      this.contacts = valid
      return { count: valid.length }
    } catch (e: any) {
      this.log(`[contacts] reload failed: ${e.message}`)
      return { count: this.contacts.length, error: e.message }
    }
  }

  /** Number of loaded contacts. */
  size(): number {
    return this.contacts.length
  }

  /** Snapshot of the loaded contacts (for debugging / health endpoints). */
  list(): Contact[] {
    return this.contacts.slice()
  }

  /** Look up by id (exact, case-sensitive). */
  getById(id: string): Contact | undefined {
    return this.contacts.find((c) => c.id === id)
  }

  /** Resolve a free-form name. Order: exact id → exact alias → fuzzy
   *  substring (longest match wins). Multiple equally-long fuzzy hits return
   *  `ambiguous`. Caller is expected to refuse fuzzy matches without explicit
   *  user confirmation — the silent wrong-recipient bug is exactly what S2 is
   *  meant to prevent. */
  resolve(query: string): ResolveResult {
    const q = (query || "").trim()
    if (!q) return { kind: "miss", query: q }

    const ql = q.toLowerCase()

    // 1. Exact id
    for (const c of this.contacts) {
      if (c.id.toLowerCase() === ql) return { kind: "exact", contact: c }
    }
    // 2. Exact alias (or display name)
    for (const c of this.contacts) {
      if (c.name.toLowerCase() === ql) return { kind: "alias", contact: c }
      for (const a of c.aliases ?? []) {
        if (a.toLowerCase() === ql) return { kind: "alias", contact: c }
      }
    }
    // 3. Fuzzy substring — longest-match heuristic mirroring registry.findByMention.
    //    Score = matched-substring length (higher is better). Tie → ambiguous.
    let bestScore = 0
    let bestContacts: Contact[] = []
    for (const c of this.contacts) {
      const candidates = [c.id, c.name, ...(c.aliases ?? [])]
      let myBest = 0
      for (const cand of candidates) {
        const cl = cand.toLowerCase()
        if (ql.includes(cl) || cl.includes(ql)) {
          // Use the shorter overlap to reward precision: a 3-letter query
          // shouldn't pretend to match a 30-letter name perfectly.
          const overlap = Math.min(cl.length, ql.length)
          if (overlap > myBest) myBest = overlap
        }
      }
      if (myBest > bestScore) {
        bestScore = myBest
        bestContacts = [c]
      } else if (myBest > 0 && myBest === bestScore) {
        bestContacts.push(c)
      }
    }

    if (bestContacts.length === 0) return { kind: "miss", query: q }
    if (bestContacts.length > 1) return { kind: "ambiguous", candidates: bestContacts }
    return { kind: "fuzzy", contact: bestContacts[0], confidence: bestScore / Math.max(ql.length, 1) }
  }

  /** Pick a channel address for a contact. If `preferred` is given and
   *  exists, use it; otherwise return the first channel the contact has.
   *  Returns undefined when the contact has no channels at all. */
  pickChannel(
    contact: Contact,
    preferred?: string,
  ): { channel: string; address: string } | undefined {
    if (preferred && contact.channels[preferred]) {
      return { channel: preferred, address: contact.channels[preferred] }
    }
    const entries = Object.entries(contact.channels)
    if (entries.length === 0) return undefined
    const [channel, address] = entries[0]
    return { channel, address }
  }
}
