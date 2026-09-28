import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs"
import { dirname } from "path"

// --- The fact ledger's file: strict reads, locked writes (#273) ---
//
// Two rules keep the ledger from losing facts with nobody watching:
//   1. A file that does not parse is never treated as empty. Reading it
//      throws LedgerCorruptError, so no write can replace it; the file is
//      left exactly as it is for a person to repair.
//   2. load → modify → save runs under a lockfile, so a daemon proposing
//      memo claims and a CLI `set` or `approve` can't drop each other's
//      write.

export class LedgerCorruptError extends Error {
  constructor(readonly file: string, cause: string) {
    super(
      `fact ledger ${file} is unreadable (${cause}). Nothing was written to it. ` +
      `Repair the JSON, or move the file aside to start an empty ledger.`,
    )
    this.name = "LedgerCorruptError"
  }
}

export interface RawLedger {
  facts: unknown[]
  proposals: unknown[]
}

/** Null when the file does not exist; throws when it exists but is not a ledger. */
export function readLedger(file: string): RawLedger | null {
  if (!existsSync(file)) return null
  let raw: any
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"))
  } catch (e) {
    throw new LedgerCorruptError(file, String((e as Error)?.message ?? e))
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.facts) || (raw.proposals !== undefined && !Array.isArray(raw.proposals))) {
    throw new LedgerCorruptError(file, "not a ledger: expected { facts: [], proposals: [] }")
  }
  return { facts: raw.facts, proposals: raw.proposals ?? [] }
}

export function writeLedger(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n")
  renameSync(tmp, file)
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Run `fn` holding `<file>.lock`. Waits up to `timeoutMs` for another
 * holder; a lock older than `staleMs` is a crashed holder and is taken over.
 */
export function withLock<T>(file: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const lock = `${file}.lock`
  const timeoutMs = opts.timeoutMs ?? 3000
  const staleMs = opts.staleMs ?? 15_000
  mkdirSync(dirname(lock), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let fd: number | undefined
  while (fd === undefined) {
    try {
      fd = openSync(lock, "wx")
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) { unlinkSync(lock); continue }
      } catch { continue }
      if (Date.now() > deadline) throw new Error(`fact ledger is busy (${lock}); try again`)
      sleep(25)
    }
  }
  try {
    return fn()
  } finally {
    closeSync(fd)
    try { unlinkSync(lock) } catch { /* already gone */ }
  }
}
