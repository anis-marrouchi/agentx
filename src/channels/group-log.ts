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
    log.push({ sender, text: ellipsize(text, MAX_ENTRY_CHARS), timestamp: Date.now() })

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

    // Walk backwards from most recent, skip the very last (it's the current message)
    for (let i = log.length - 2; i >= 0; i--) {
      const entry = log[i]
      const time = new Date(entry.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
      const line = `[${time}] ${entry.sender}: ${entry.text}`
      if (chars + line.length > MAX_CONTEXT_CHARS) break
      lines.splice(1, 0, line)
      chars += line.length
    }

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
