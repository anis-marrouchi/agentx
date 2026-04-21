import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { resolve, dirname } from "path"

// --- WhatsApp passive cache ---
//
// Baileys emits `contacts.update`, `chats.upsert`, `groups.update`,
// `messaging-history.set` whenever the socket observes changes. Previously
// we ignored those events — meaning the only WhatsApp data the system
// knew about came from messages that happened to trigger an agent reply.
//
// This cache subscribes passively to those events and keeps a small
// snapshot of contacts / chats / groups. The wiki ingestor (src/wiki/
// ingest-whatsapp.ts) reads from here instead of hitting Baileys live,
// which keeps ingest fast and avoids adding to the personal-account
// ban-risk surface. The cache is best-effort — entries appear when the
// socket sees them, and stay until the daemon restarts (or are hydrated
// from disk).
//
// Shape decisions:
// - JID is the canonical key everywhere. "Phone" is derived from the
//   JID's user segment for display.
// - We never store message bodies here. Messages are pulled on demand
//   by the ingestor when an allowlist opts into `mode: "messages"`,
//   and they're dropped after the ingestor hands the raw entry to the
//   wiki. Caching message bodies would duplicate WhatsApp's own store
//   and explode the cache file size.

export interface ContactRecord {
  jid: string
  /** Digits extracted from the JID's user segment. May be empty for LIDs. */
  phone: string
  /** The contact's own "push name" (what they set on their device). */
  pushName?: string
  /** Saved name from WhatsApp address book (if the linked device has it). */
  savedName?: string
  /** Status / about text. Rarely populated from events alone; usually needs a live fetch. */
  status?: string
  /** Last time we got any update for this contact. ISO8601. */
  updatedAt: string
}

export interface ChatRecord {
  jid: string
  /** Best display name we have for the chat. Falls back to phone if missing. */
  name?: string
  /** Derived from the JID — group chats end with @g.us. */
  isGroup: boolean
  /** Last conversation timestamp we observed, as unix seconds. */
  lastMessageAt?: number
  unreadCount?: number
  updatedAt: string
}

export interface GroupMember {
  jid: string
  admin?: "admin" | "superadmin"
}

export interface GroupRecord {
  jid: string
  subject: string
  description?: string
  owner?: string
  members: GroupMember[]
  updatedAt: string
}

interface CacheSnapshot {
  version: 1
  contacts: ContactRecord[]
  chats: ChatRecord[]
  groups: GroupRecord[]
}

export class WhatsAppCache {
  private contacts: Map<string, ContactRecord> = new Map()
  private chats: Map<string, ChatRecord> = new Map()
  private groups: Map<string, GroupRecord> = new Map()
  private cachePath: string

  constructor(sessionDir: string) {
    this.cachePath = resolve(sessionDir, "cache.json")
    this.load()
  }

  // --- Read API (what the ingestor consumes) ---

  listContacts(): ContactRecord[] {
    return Array.from(this.contacts.values())
  }

  listChats(): ChatRecord[] {
    return Array.from(this.chats.values())
  }

  listGroups(): GroupRecord[] {
    return Array.from(this.groups.values())
  }

  getContact(jid: string): ContactRecord | undefined {
    return this.contacts.get(jid)
  }

  getChat(jid: string): ChatRecord | undefined {
    return this.chats.get(jid)
  }

  getGroup(jid: string): GroupRecord | undefined {
    return this.groups.get(jid)
  }

  // --- Event handlers (wired from WhatsAppAdapter) ---

  applyContactsUpdate(updates: Array<Record<string, unknown>>): void {
    const now = new Date().toISOString()
    for (const u of updates) {
      const jid = typeof u.id === "string" ? u.id : ""
      if (!jid) continue
      const prev = this.contacts.get(jid) ?? {
        jid,
        phone: extractPhone(jid),
        updatedAt: now,
      }
      const next: ContactRecord = {
        ...prev,
        pushName: firstString(u.notify, u.pushName, prev.pushName),
        savedName: firstString(u.name, u.verifiedName, prev.savedName),
        status: firstString(u.status, prev.status),
        updatedAt: now,
      }
      this.contacts.set(jid, next)
    }
  }

  applyChatsUpsert(chats: Array<Record<string, unknown>>): void {
    const now = new Date().toISOString()
    for (const c of chats) {
      const jid = typeof c.id === "string" ? c.id : ""
      if (!jid) continue
      const record: ChatRecord = {
        jid,
        name: typeof c.name === "string" ? c.name : this.chats.get(jid)?.name,
        isGroup: jid.endsWith("@g.us"),
        lastMessageAt: toSeconds(c.conversationTimestamp) ?? this.chats.get(jid)?.lastMessageAt,
        unreadCount: typeof c.unreadCount === "number" ? c.unreadCount : this.chats.get(jid)?.unreadCount,
        updatedAt: now,
      }
      this.chats.set(jid, record)
    }
  }

  applyGroupsUpdate(updates: Array<Record<string, unknown>>): void {
    const now = new Date().toISOString()
    for (const g of updates) {
      const jid = typeof g.id === "string" ? g.id : ""
      if (!jid) continue
      const prev = this.groups.get(jid) ?? {
        jid,
        subject: "",
        members: [] as GroupMember[],
        updatedAt: now,
      }
      const members = Array.isArray(g.participants)
        ? (g.participants as Array<Record<string, unknown>>)
            .map((p) => ({
              jid: typeof p.id === "string" ? p.id : "",
              admin: typeof p.admin === "string" ? (p.admin as GroupMember["admin"]) : undefined,
            }))
            .filter((m) => m.jid)
        : prev.members
      const next: GroupRecord = {
        ...prev,
        subject: typeof g.subject === "string" ? g.subject : prev.subject,
        description: typeof g.desc === "string" ? g.desc : prev.description,
        owner: typeof g.owner === "string" ? g.owner : prev.owner,
        members,
        updatedAt: now,
      }
      this.groups.set(jid, next)
    }
  }

  applyHistorySet(data: Record<string, unknown>): void {
    if (Array.isArray(data.chats)) this.applyChatsUpsert(data.chats as Array<Record<string, unknown>>)
    if (Array.isArray(data.contacts)) this.applyContactsUpdate(data.contacts as Array<Record<string, unknown>>)
    // Messages inside history.set are intentionally ignored — message
    // bodies are not cached here (see file-level comment).
  }

  // --- Persistence ---

  /** Write snapshot to cache.json. Call on graceful shutdown and periodically. */
  save(): void {
    const snapshot: CacheSnapshot = {
      version: 1,
      contacts: this.listContacts(),
      chats: this.listChats(),
      groups: this.listGroups(),
    }
    const dir = dirname(this.cachePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.cachePath, JSON.stringify(snapshot, null, 2), "utf8")
  }

  private load(): void {
    if (!existsSync(this.cachePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.cachePath, "utf8")) as CacheSnapshot
      if (raw.version !== 1) return
      for (const c of raw.contacts ?? []) this.contacts.set(c.jid, c)
      for (const c of raw.chats ?? []) this.chats.set(c.jid, c)
      for (const g of raw.groups ?? []) this.groups.set(g.jid, g)
    } catch {
      // Corrupted cache — start empty. Not fatal; we'll rebuild from live events.
    }
  }
}

/** "+21624XXXXXXX@s.whatsapp.net" → "21624XXXXXXX". LIDs (`...@lid`) have
 *  no phone under WhatsApp's privacy model and return "". */
function extractPhone(jid: string): string {
  const user = jid.split("@")[0] ?? ""
  if (!user) return ""
  // LIDs are numeric too but their @-suffix is `@lid` — exclude.
  if (jid.endsWith("@lid")) return ""
  return user.replace(/[^0-9]/g, "")
}

/** First non-empty string among the inputs — used to prefer live-event
 *  fields over cached ones without losing the cached value when the
 *  event didn't re-send it. Narrows `unknown` from Baileys payloads
 *  to `string | undefined` so the call sites stay type-safe. */
function firstString(...values: Array<unknown>): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v
  }
  return undefined
}

/** Baileys emits timestamps as either numeric seconds or Long-like objects.
 *  Normalize to plain seconds. */
function toSeconds(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (v && typeof v === "object" && "low" in (v as any) && "high" in (v as any)) {
    const low = (v as any).low as number
    const high = (v as any).high as number
    return high * 0x100000000 + (low >>> 0)
  }
  return undefined
}
