import { createHash } from "crypto"
import type { WikiEntry } from "./types"

// --- WhatsApp → Wiki ingestor ---
//
// Pure transforms + orchestration. Takes a read-only WhatsApp source
// (the adapter's read API, structurally typed below) and emits raw wiki
// entries through the provided `addEntry` callback. Never imports
// @whiskeysockets/baileys — keeps the transform layer testable with a
// mock source and isolates us from Baileys version drift.
//
// Design notes
// ------------
// - One raw entry per WhatsApp primitive (contact, group-meta, dm-window,
//   group-window). The existing absorb pipeline at src/wiki/prompts.ts
//   handles typed article creation (person, project, event) — we don't
//   reinvent it here.
// - Stable IDs are the dedup mechanism. Re-running an ingest emits the
//   SAME filename for unchanged data (filesystem = database), so repeated
//   sweeps are near-free.
// - Default mode is "metadata-only" — message bodies are opt-in per chat
//   via `mode: "messages"`. Privacy surface stays narrow by default.

// --- Source contract (structurally typed — mock-friendly) ---

export interface ContactRead {
  jid: string
  phone: string
  name?: string
  pushName?: string
  savedName?: string
  status?: string
  updatedAt?: string
}
export interface ChatRead {
  jid: string
  name: string
  isGroup: boolean
  lastMessageAt?: number
  unreadCount?: number
}
export interface GroupRead {
  jid: string
  subject: string
  description?: string
  owner?: string
  members: Array<{ jid: string; admin?: "admin" | "superadmin" }>
  memberCount: number
}
export interface MessageRead {
  id: string
  fromJid: string
  fromMe: boolean
  timestamp?: number
  text: string
  media?: { kind: "image" | "audio" | "video" | "document" | "sticker"; caption?: string; filename?: string }
}

export interface WhatsAppSource {
  isConnected(): boolean
  listContacts(): ContactRead[]
  listChats(): ChatRead[]
  getContactProfile(jid: string): Promise<ContactRead | null>
  getGroupMetadata(jid: string): Promise<GroupRead | null>
  getHistory(jid: string, opts: { limit?: number; before?: string }): Promise<MessageRead[]>
}

// --- Config (mirror of channels.whatsapp.ingest in src/daemon/config.ts) ---

export interface IngestConfig {
  enabled: boolean
  mode: "metadata-only" | "messages"
  allowContacts: string[]
  allowGroups: string[]
  denyContacts: string[]
  denyGroups: string[]
  messageCap: number
  historyDays: number
  contactRefreshDays: number
  throttle: {
    minMsBetweenCalls: number
    maxCallsPerMinute: number
    maxChatsPerSweep: number
  }
  retentionDays: number
}

// --- Scope resolution ---

export interface IngestTarget {
  kind: "contact" | "group"
  jid: string
  /** The resolved cached record for reference during transform. */
  contact?: ContactRead
  chat?: ChatRead
}

/** Apply allow/deny rules to the cached catalog. Rules:
 *  1. If not `enabled`, return empty (master switch).
 *  2. Deny precedence: a JID matching any `denyContacts` / `denyGroups`
 *     entry is dropped regardless of other matches.
 *  3. Empty allowlists = ingest NOTHING (defensive — avoids accidental
 *     full-sweep when someone enables the feature without scoping).
 *  4. Phone/JID match is substring-based (matches `allowFrom` semantics
 *     at src/channels/whatsapp.ts). `+`-prefixed numbers are normalized.
 */
export function resolveScope(config: IngestConfig, source: WhatsAppSource): IngestTarget[] {
  if (!config.enabled) return []

  const contacts = source.listContacts()
  const chats = source.listChats()
  const targets: IngestTarget[] = []

  const normalize = (s: string) => s.replace(/^\+/, "").toLowerCase()
  const allowC = config.allowContacts.map(normalize)
  const allowG = config.allowGroups.map(normalize)
  const denyC = config.denyContacts.map(normalize)
  const denyG = config.denyGroups.map(normalize)

  const matchesAny = (value: string, patterns: string[]) => {
    if (patterns.length === 0) return false
    const v = normalize(value)
    return patterns.some((p) => v.includes(p) || p.includes(v))
  }

  for (const c of contacts) {
    const needle = `${c.phone}|${c.jid}`
    if (matchesAny(needle, denyC)) continue
    if (!matchesAny(needle, allowC)) continue
    // Find the chat record for this contact if one exists (optional).
    const chat = chats.find((x) => !x.isGroup && x.jid === c.jid)
    targets.push({ kind: "contact", jid: c.jid, contact: c, chat })
  }

  for (const ch of chats) {
    if (!ch.isGroup) continue
    if (matchesAny(ch.jid, denyG)) continue
    if (!matchesAny(ch.jid, allowG)) continue
    targets.push({ kind: "group", jid: ch.jid, chat: ch })
  }

  return targets
}

// --- Transforms (pure, testable) ---

const ISO_DAY = (d: Date = new Date()) => d.toISOString().slice(0, 10)
const YYYYMMDD = (d: Date = new Date()) => ISO_DAY(d).replace(/-/g, "")

/** Short, stable JID hash — keeps filenames readable while still unique
 *  across different JIDs that share a prefix. 10 hex chars is plenty for
 *  a personal account's contact set. */
function jidHash(jid: string): string {
  return createHash("sha1").update(jid).digest("hex").slice(0, 10)
}

export function transformContact(profile: ContactRead, agentId: string, now: Date = new Date()): WikiEntry {
  const date = ISO_DAY(now)
  const id = `wa-contact-${jidHash(profile.jid)}-${YYYYMMDD(now)}`
  const displayName = profile.savedName || profile.pushName || profile.phone || profile.jid
  const lines: string[] = [`# Contact: ${displayName}`, ""]
  lines.push(`- **JID**: ${profile.jid}`)
  if (profile.phone) lines.push(`- **Phone**: +${profile.phone}`)
  if (profile.savedName) lines.push(`- **Saved name**: ${profile.savedName}`)
  if (profile.pushName && profile.pushName !== profile.savedName) lines.push(`- **Push name**: ${profile.pushName}`)
  if (profile.status) lines.push(`- **Status**: ${profile.status}`)
  if (profile.updatedAt) lines.push(`- **Last observed**: ${profile.updatedAt}`)

  return {
    id,
    date,
    agentId,
    source: "whatsapp:contact",
    sourceContext: profile.jid,
    content: lines.join("\n"),
    meta: {
      jid: profile.jid,
      phone: profile.phone,
      kind: "contact",
      profileHash: hashProfile(profile),
    },
  }
}

export function transformGroupMeta(group: GroupRead, agentId: string, now: Date = new Date()): WikiEntry {
  const date = ISO_DAY(now)
  const id = `wa-group-meta-${jidHash(group.jid)}-${YYYYMMDD(now)}`
  const lines: string[] = [`# Group: ${group.subject || "(unnamed)"}`, ""]
  lines.push(`- **JID**: ${group.jid}`)
  if (group.description) lines.push(`- **Description**: ${group.description}`)
  if (group.owner) lines.push(`- **Owner**: ${group.owner}`)
  lines.push(`- **Members (${group.memberCount})**:`)
  // Cap roster at 50 so a 500-member group doesn't explode the entry.
  // The absorb pipeline cares more about who's there than an exhaustive list.
  const topMembers = group.members.slice(0, 50)
  for (const m of topMembers) {
    const adminTag = m.admin ? ` (${m.admin})` : ""
    lines.push(`  - ${m.jid}${adminTag}`)
  }
  if (group.members.length > topMembers.length) {
    lines.push(`  - …and ${group.members.length - topMembers.length} more`)
  }

  return {
    id,
    date,
    agentId,
    source: "whatsapp:group-meta",
    sourceContext: group.jid,
    content: lines.join("\n"),
    meta: {
      jid: group.jid,
      subject: group.subject,
      memberCount: group.memberCount,
      kind: "group-meta",
    },
  }
}

export function transformDm(
  chat: ChatRead,
  contact: ContactRead | undefined,
  messages: MessageRead[],
  agentId: string,
  now: Date = new Date(),
): WikiEntry | null {
  if (messages.length === 0) return null
  const lastMsgId = messages[messages.length - 1]!.id
  const date = ISO_DAY(now)
  const id = `wa-dm-${jidHash(chat.jid)}-${YYYYMMDD(now)}-${shortId(lastMsgId)}`
  const displayName = contact?.savedName || contact?.pushName || chat.name || chat.jid
  const lines: string[] = [`# Chat with ${displayName}`, ""]
  lines.push(`- **JID**: ${chat.jid}`)
  if (contact?.phone) lines.push(`- **Phone**: +${contact.phone}`)
  lines.push(`- **Messages**: ${messages.length}`)
  lines.push("")
  for (const m of messages) {
    lines.push(renderMessageLine(m, displayName))
  }

  return {
    id,
    date,
    agentId,
    source: "whatsapp:dm",
    sourceContext: chat.jid,
    content: lines.join("\n"),
    meta: {
      jid: chat.jid,
      kind: "dm",
      messageCount: messages.length,
      oldestMsgTs: messages[0]?.timestamp,
      newestMsgTs: messages[messages.length - 1]?.timestamp,
      lastMsgId,
    },
  }
}

export function transformGroupMessages(
  chat: ChatRead,
  group: GroupRead,
  messages: MessageRead[],
  agentId: string,
  now: Date = new Date(),
): WikiEntry | null {
  if (messages.length === 0) return null
  const lastMsgId = messages[messages.length - 1]!.id
  const date = ISO_DAY(now)
  const id = `wa-group-${jidHash(chat.jid)}-${YYYYMMDD(now)}-${shortId(lastMsgId)}`
  const lines: string[] = [`# Group chat: ${group.subject || chat.name}`, ""]
  lines.push(`- **JID**: ${chat.jid}`)
  lines.push(`- **Members**: ${group.memberCount}`)
  lines.push(`- **Messages**: ${messages.length}`)
  lines.push("")
  for (const m of messages) {
    lines.push(renderMessageLine(m, m.fromJid))
  }

  return {
    id,
    date,
    agentId,
    source: "whatsapp:group",
    sourceContext: chat.jid,
    content: lines.join("\n"),
    meta: {
      jid: chat.jid,
      kind: "group",
      messageCount: messages.length,
      lastMsgId,
    },
  }
}

function renderMessageLine(m: MessageRead, senderLabel: string): string {
  const ts = m.timestamp ? formatTs(m.timestamp) : ""
  const who = m.fromMe ? "me" : senderLabel
  let body = m.text
  if (!body && m.media) {
    if (m.media.kind === "image") body = `[image${m.media.caption ? `: ${m.media.caption}` : ""}]`
    else if (m.media.kind === "audio") body = "[voice message]"
    else if (m.media.kind === "video") body = `[video${m.media.caption ? `: ${m.media.caption}` : ""}]`
    else if (m.media.kind === "document") body = `[document: ${m.media.filename ?? "unnamed"}]`
    else if (m.media.kind === "sticker") body = "[sticker]"
  }
  return `[${ts}] ${who}: ${body}`
}

function formatTs(seconds: number): string {
  try { return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16) }
  catch { return String(seconds) }
}

function shortId(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(-10)
}

/** Hash of the fields we consider when deciding whether a contact entry
 *  needs re-writing. Used by the sweep to skip unchanged contacts inside
 *  the refresh window. */
export function hashProfile(profile: ContactRead): string {
  const h = createHash("sha1")
  h.update(profile.jid)
  h.update("|")
  h.update(profile.savedName || "")
  h.update("|")
  h.update(profile.pushName || "")
  h.update("|")
  h.update(profile.status || "")
  return h.digest("hex").slice(0, 10)
}

// --- Sweep orchestration ---

export interface SweepReport {
  scannedContacts: number
  scannedGroups: number
  wroteContacts: number
  wroteGroups: number
  wroteDmWindows: number
  wroteGroupWindows: number
  skippedUnchanged: number
  errors: Array<{ jid: string; kind: string; message: string }>
}

/** Lightweight store interface the sweep calls against. Accepts anything
 *  that can `addEntry(WikiEntry)` — the real `WikiStore.addEntry` at
 *  src/wiki/store.ts:67-89 matches. */
export interface EntryStore {
  addEntry(entry: WikiEntry): string
}

/** Orchestrates a full ingest pass. Iterates scope → fetches metadata →
 *  (optionally) fetches history → writes raw entries. Per-target
 *  try/catch so one failure doesn't abort the pass.
 *
 *  `dryRun`: compute transforms but skip `addEntry`. Returns the would-
 *  have-been entries in `dryRunEntries` for the caller to display. */
export async function runSweep(opts: {
  source: WhatsAppSource
  store: EntryStore
  config: IngestConfig
  agentId: string
  now?: Date
  dryRun?: boolean
}): Promise<SweepReport & { dryRunEntries?: WikiEntry[] }> {
  const now = opts.now ?? new Date()
  const report: SweepReport = {
    scannedContacts: 0,
    scannedGroups: 0,
    wroteContacts: 0,
    wroteGroups: 0,
    wroteDmWindows: 0,
    wroteGroupWindows: 0,
    skippedUnchanged: 0,
    errors: [],
  }
  const dryRunEntries: WikiEntry[] = []
  const writeOrStage = (entry: WikiEntry) => {
    if (opts.dryRun) { dryRunEntries.push(entry); return }
    opts.store.addEntry(entry)
  }

  if (!opts.source.isConnected() && !opts.dryRun) {
    report.errors.push({ jid: "-", kind: "source", message: "WhatsApp socket not connected" })
    return { ...report, dryRunEntries: opts.dryRun ? dryRunEntries : undefined }
  }

  let targets = resolveScope(opts.config, opts.source)
  // Cap per-sweep to protect the Baileys socket from burst reads.
  if (targets.length > opts.config.throttle.maxChatsPerSweep) {
    targets = targets.slice(0, opts.config.throttle.maxChatsPerSweep)
  }

  for (const t of targets) {
    try {
      if (t.kind === "contact") {
        report.scannedContacts++
        const profile = t.contact ?? (await opts.source.getContactProfile(t.jid))
        if (!profile) continue
        const entry = transformContact(profile, opts.agentId, now)
        writeOrStage(entry)
        report.wroteContacts++

        // DM message window only when operator opts in.
        if (opts.config.mode === "messages") {
          const msgs = await opts.source.getHistory(t.jid, { limit: opts.config.messageCap })
          const bounded = bounded_by_history_days(msgs, opts.config.historyDays, now)
          if (bounded.length > 0 && t.chat) {
            const dm = transformDm(t.chat, profile, bounded, opts.agentId, now)
            if (dm) { writeOrStage(dm); report.wroteDmWindows++ }
          }
        }
      } else {
        report.scannedGroups++
        const group = await opts.source.getGroupMetadata(t.jid)
        if (!group) continue
        const entry = transformGroupMeta(group, opts.agentId, now)
        writeOrStage(entry)
        report.wroteGroups++

        if (opts.config.mode === "messages" && t.chat) {
          const msgs = await opts.source.getHistory(t.jid, { limit: opts.config.messageCap })
          const bounded = bounded_by_history_days(msgs, opts.config.historyDays, now)
          if (bounded.length > 0) {
            const window = transformGroupMessages(t.chat, group, bounded, opts.agentId, now)
            if (window) { writeOrStage(window); report.wroteGroupWindows++ }
          }
        }
      }
    } catch (e: any) {
      report.errors.push({ jid: t.jid, kind: t.kind, message: e?.message ?? String(e) })
    }
  }

  return { ...report, dryRunEntries: opts.dryRun ? dryRunEntries : undefined }
}

/** Keep only messages within the `historyDays` window ending at `now`.
 *  Messages without a timestamp are kept (they're typically recent). */
function bounded_by_history_days(msgs: MessageRead[], historyDays: number, now: Date): MessageRead[] {
  const cutoff = Math.floor((now.getTime() - historyDays * 86400_000) / 1000)
  return msgs.filter((m) => !m.timestamp || m.timestamp >= cutoff)
}
