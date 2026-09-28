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

const FACT_FIELDS = ["id", "subject", "attribute", "value", "source", "verifiedAt", "verifiedBy", "volatility"]
const PROPOSAL_FIELDS = ["id", "status", "claim", "source", "verifiedAt", "agentId"]

const hasStrings = (o: unknown, keys: string[]) =>
  !!o && typeof o === "object" && !Array.isArray(o) && keys.every((k) => typeof (o as Record<string, unknown>)[k] === "string")

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
  // Every entry is read by prompt rendering; one malformed entry must stop
  // the ledger being used, not crash a prompt or be dropped on the next save.
  const bad = raw.facts.findIndex((f: any) => !hasStrings(f, FACT_FIELDS))
  if (bad >= 0) throw new LedgerCorruptError(file, `fact #${bad + 1} is missing ${FACT_FIELDS.join("/")}`)
  const badP = (raw.proposals ?? []).findIndex((p: any) => !hasStrings(p, PROPOSAL_FIELDS))
  if (badP >= 0) throw new LedgerCorruptError(file, `proposal #${badP + 1} is missing ${PROPOSAL_FIELDS.join("/")}`)
  return { facts: raw.facts, proposals: raw.proposals ?? [] }
}

export function writeLedger(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n")
  renameSync(tmp, file)
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Locks this process holds, so a caller already inside one (approve →
 *  write) re-enters instead of waiting on itself. */
const held = new Set<string>()

const isStale = (path: string, staleMs: number) => {
  try { return Date.now() - statSync(path).mtimeMs > staleMs } catch { return false }
}

/**
 * Take over a crashed holder's lock. Only one waiter may do it at a time
 * (a second `.takeover` lock), and it re-checks under that lock, so two
 * waiters that both saw the old lock can't both delete it — the second
 * would otherwise delete the first one's fresh lock.
 */
export function takeOver(lock: string, staleMs: number): void {
  const guard = `${lock}.takeover`
  if (isStale(guard, staleMs)) { try { unlinkSync(guard) } catch { /* another waiter did */ } }
  let fd: number
  try { fd = openSync(guard, "wx") } catch { return }
  try {
    if (isStale(lock, staleMs)) unlinkSync(lock)
  } catch {
    // Not removable (a directory, a permission): the wait times out with
    // an error naming the lock, rather than spinning.
  } finally {
    closeSync(fd)
    try { unlinkSync(guard) } catch { /* gone */ }
  }
}

/**
 * Run `fn` holding `<file>.lock`. Waits up to `timeoutMs` for another
 * holder; a lock older than `staleMs` is a crashed holder and is taken
 * over. Re-entrant within one process.
 */
export function withLock<T>(file: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const lock = `${file}.lock`
  if (held.has(lock)) return fn()
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
      if (isStale(lock, staleMs)) takeOver(lock, staleMs)
      if (Date.now() > deadline) {
        throw new Error(`fact ledger is busy (${lock}). If no agentx command is running, delete that lock and try again.`)
      }
      sleep(25)
    }
  }
  held.add(lock)
  try {
    return fn()
  } finally {
    held.delete(lock)
    closeSync(fd)
    try { unlinkSync(lock) } catch { /* already gone */ }
  }
}
