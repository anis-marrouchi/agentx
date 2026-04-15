import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { resolve } from "path"
import { ellipsize } from "@/utils/ellipsize"

// --- Persistent group conversation log ---
// Stores recent messages per group chat in .agentx/groups/{chatId}.jsonl
// Survives daemon restarts. Trimmed to max entries on write.

export interface GroupLogEntry {
  sender: string
  text: string
  timestamp: number
}

const MAX_ENTRIES = 30
const MAX_CONTEXT_CHARS = 6000
const MAX_ENTRY_CHARS = 1500
/** Drop identical (sender,text) re-sends that arrive within this window.
 *  Protects the log from users who mash Enter N times or from clients that
 *  mirror the same message across bots. Observed cost: 6× Seif spam blew the
 *  prompt budget on the next agent's first turn. */
const REPEAT_WINDOW_MS = 60_000

/** Bucket a timestamp into a stable 15-min window so the rendered history
 *  header only changes every quarter-hour. Stamping every line with HH:MM
 *  invalidates the cache on every new message; bucketing preserves it. */
function bucketLabel(ts: number): string {
  const d = new Date(ts)
  const hh = d.getUTCHours().toString().padStart(2, "0")
  const mm = Math.floor(d.getUTCMinutes() / 15) * 15
  return `${hh}:${mm.toString().padStart(2, "0")}`
}

export class GroupLog {
  private dir: string
  private cache: Map<string, GroupLogEntry[]> = new Map()

  constructor(baseDir: string = resolve(process.cwd(), ".agentx/groups")) {
    this.dir = baseDir
    mkdirSync(this.dir, { recursive: true })
  }

  /**
   * Log a message in a group conversation.
   */
  add(chatId: string, sender: string, text: string): void {
    const log = this.load(chatId)
    const now = Date.now()
    const ellipsized = ellipsize(text, MAX_ENTRY_CHARS)

    // On-insert dedup: if the most recent entry has the same sender+text and
    // arrived within REPEAT_WINDOW_MS, skip. Don't walk further back — spam
    // is usually contiguous, and a legitimate "say it again" later is still
    // useful signal for the agent.
    const last = log[log.length - 1]
    if (last && last.sender === sender && last.text === ellipsized && now - last.timestamp < REPEAT_WINDOW_MS) {
      return
    }

    log.push({ sender, text: ellipsized, timestamp: now })

    // Trim
    while (log.length > MAX_ENTRIES) log.shift()

    this.cache.set(chatId, log)
    this.save(chatId, log)
  }

  /**
   * Build conversation context string for an agent.
   * Returns recent messages so the agent knows what was discussed.
   */
  buildContext(chatId: string): string {
    const log = this.load(chatId)
    if (log.length <= 1) return ""

    const lines: string[] = ["[Recent group conversation]"]
    let chars = 0

    // Walk backwards from most recent, skip the very last (it's the current
    // message). Coalesce runs of identical (sender,text) into one line with a
    // repeat count — protects the prompt from any spam that predates on-insert
    // dedup (historical log entries) and keeps the context compact.
    // Bucket headers only appear when the 15-min window changes, so the
    // rendered history is byte-stable within the bucket (cache-friendly).
    let pending: { line: string; repeat: number; bucket: string } | null = null
    const buffered: string[] = []
    let lastBucket = ""
    const flushPending = (): boolean => {
      if (!pending) return true
      const out = pending.repeat > 1 ? `${pending.line}  [×${pending.repeat}]` : pending.line
      if (chars + out.length > MAX_CONTEXT_CHARS) return false
      buffered.push(out)
      chars += out.length
      // Emit a bucket header when the window changes (we're walking back in
      // time — so the "new bucket" is older than the previous one).
      if (pending.bucket !== lastBucket) {
        const hdr = `— ${pending.bucket} —`
        if (chars + hdr.length > MAX_CONTEXT_CHARS) { pending = null; return false }
        buffered.push(hdr)
        chars += hdr.length
        lastBucket = pending.bucket
      }
      pending = null
      return true
    }

    for (let i = log.length - 2; i >= 0; i--) {
      const entry = log[i]
      const line = `${entry.sender}: ${entry.text}`
      const bucket = bucketLabel(entry.timestamp)
      if (pending && pending.line === line && pending.bucket === bucket) {
        pending.repeat++
        continue
      }
      if (!flushPending()) break
      pending = { line, repeat: 1, bucket }
    }
    flushPending()
    // Splice buffered entries (in reverse — they're back-to-front) under the
    // opening header in oldest-first order.
    for (let i = buffered.length - 1; i >= 0; i--) lines.splice(1, 0, buffered[i])

    if (lines.length <= 1) return ""
    lines.push("[End of conversation — respond to the latest message]")
    return lines.join("\n")
  }

  /**
   * Get raw log entries for a group.
   */
  getEntries(chatId: string): GroupLogEntry[] {
    return [...this.load(chatId)]
  }

  // --- Persistence ---

  private filePath(chatId: string): string {
    const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, "_")
    return resolve(this.dir, `${safe}.json`)
  }

  private load(chatId: string): GroupLogEntry[] {
    // Check cache first
    if (this.cache.has(chatId)) return this.cache.get(chatId)!

    // Load from disk
    const path = this.filePath(chatId)
    if (!existsSync(path)) {
      this.cache.set(chatId, [])
      return []
    }

    try {
      const data = JSON.parse(readFileSync(path, "utf-8"))
      const entries = Array.isArray(data) ? data : []
      this.cache.set(chatId, entries)
      return entries
    } catch {
      this.cache.set(chatId, [])
      return []
    }
  }

  private save(chatId: string, entries: GroupLogEntry[]): void {
    try {
      writeFileSync(this.filePath(chatId), JSON.stringify(entries))
    } catch {
      // Best-effort persistence
    }
  }
}
