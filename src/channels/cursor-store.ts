import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"

// --- Generic per-channel cursor store ---
//
// Any channel that consumes a polling cursor (Telegram offset, IMAP UID,
// changefeed seq, …) must persist the cursor to disk BEFORE the upstream
// considers the messages acknowledged — otherwise a daemon crash between
// "received" and "acked" causes message replay (Telegram) or message loss
// (most other systems) on restart.
//
// Discipline: `commit()` is synchronous. Cursors are small (≤ a JSON object
// per account) and committed only once per poll cycle, so the cost of
// fsync is negligible. The previous Telegram-specific store debounced
// writes by 500ms, which is exactly the race window that caused message
// replay on 2026-04-27.

export interface CursorStore {
  read(channel: string, account: string): string | number | null
  commit(channel: string, account: string, cursor: string | number): void
  /** Optional: list every (channel, account) → cursor pair, for diagnostics. */
  snapshot(): Record<string, string | number>
}

export class FileCursorStore implements CursorStore {
  private filePath: string
  private data: Record<string, string | number>

  constructor(cwd: string, relPath = ".agentx/cursors.json") {
    this.filePath = resolve(cwd, relPath)
    this.data = {}
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf-8"))
        if (parsed && typeof parsed === "object") {
          this.data = parsed
        }
      }
    } catch {
      // First-run / corrupt — start clean. The cost of replay is bounded
      // by the upstream's retention window.
    }
  }

  private key(channel: string, account: string): string {
    return `${channel}:${account}`
  }

  read(channel: string, account: string): string | number | null {
    const v = this.data[this.key(channel, account)]
    return v === undefined ? null : v
  }

  commit(channel: string, account: string, cursor: string | number): void {
    const k = this.key(channel, account)
    if (this.data[k] === cursor) return
    this.data[k] = cursor
    this.persist()
  }

  snapshot(): Record<string, string | number> {
    return { ...this.data }
  }

  private persist(): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // Atomic write: write to .tmp, then rename. Crash mid-write leaves the
    // prior valid file in place rather than a truncated one.
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    // Node's fs.renameSync is atomic on POSIX (overwrites the target).
    // On Linux fsync is implicit before rename for ext4/journaled FS in
    // practice; macOS APFS guarantees atomicity. No explicit fsync needed
    // for the tiny payloads we write here.
    renameSync(tmp, this.filePath)
  }
}

/** Singleton lazily initialized at first call. The cwd is the daemon's
 *  process.cwd() at boot (where agentx.json lives). */
let _instance: FileCursorStore | undefined
export function getCursorStore(cwd?: string): CursorStore {
  if (!_instance) _instance = new FileCursorStore(cwd ?? process.cwd())
  return _instance
}
