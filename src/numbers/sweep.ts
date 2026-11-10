import { lastPeriod } from "./model"
import { parseNumberInput } from "./input"
import { readSourceValue, type ReaderDeps } from "./sources"
import type { NumberStore } from "./store"

// --- The daemon's read of numbers (#1826) ---
//
// At each requests check: the numbers of agentx.json (`numbers.items`) are
// written to the store, and every number with a reader whose last whole
// period has no value yet is read once. A failed read is kept as a reading
// without a value ("no reading") and tried again after `retryMinutes`.
// Numbers recorded by hand are never read.

export interface NumberSettings {
  /** Numbers the owner sets up in agentx.json, by id. */
  items: Record<string, Record<string, unknown>>
  /** Minutes before a failed read is tried again. */
  retryMinutes: number
  /** Raise a decision card when a number misses twice (review.ts). */
  missedTwiceCard: boolean
  /** The agent that reviews the owner's follow-up on that card. */
  reviewer?: string
}

export const DEFAULT_NUMBER_SETTINGS: NumberSettings = { items: {}, retryMinutes: 60, missedTwiceCard: true }

/** Write the numbers of agentx.json to the store; archive the ones taken
 *  out of it. Returns the errors of items that are refused. */
export function syncConfigNumbers(store: NumberStore, items: NumberSettings["items"], now: number): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const [id, raw] of Object.entries(items)) {
    const input = parseNumberInput({ ...raw, id }, "config")
    if ("error" in input) { errors.push(`numbers.items.${id}: ${input.error}`); continue }
    ids.add(input.id)
    const had = store.get(input.id)
    // Only write when something changed, so updated_at means a change.
    const next = { ...input, source: input.source ?? { kind: "manual" as const }, tags: input.tags ?? [], target: input.target ?? null, unit: input.unit ?? null, ownerAgent: input.ownerAgent ?? null, rhythm: input.rhythm ?? "weekly" as const }
    if (had && !had.archivedAt && had.origin === "config" && same(had, next)) continue
    store.upsert(next, now)
  }
  for (const n of store.list()) if (n.origin === "config" && !ids.has(n.id)) store.archive(n.id, now)
  return errors
}

function same(a: object, b: object): boolean {
  return ["name", "ownerAgent", "unit", "target", "rhythm", "source", "tags"].every((k) => JSON.stringify((a as any)[k]) === JSON.stringify((b as any)[k]))
}

/** Read every number that is due. Returns the ids read (with a value or
 *  not). One number's failure never stops the others. */
export async function readDueNumbers(store: NumberStore, deps: ReaderDeps, settings: Pick<NumberSettings, "retryMinutes">, now: number, log: (msg: string) => void = () => {}): Promise<string[]> {
  const read: string[] = []
  for (const n of store.list()) {
    if (n.source.kind === "manual") continue
    const period = lastPeriod(n.rhythm, now)
    if (store.readingOf(n.id, period.start, period.end)?.value != null) continue
    if (n.lastReadAt !== null && now - n.lastReadAt < settings.retryMinutes * 60_000) continue
    const res = await readSourceValue(n.source, period, deps)
    if ("value" in res) {
      store.record({ numberId: n.id, value: res.value, readAt: now, periodStart: period.start, periodEnd: period.end, by: "reader" })
      store.markRead(n.id, null, now)
    } else {
      store.record({ numberId: n.id, value: null, error: res.error, readAt: now, periodStart: period.start, periodEnd: period.end, by: "reader" })
      store.markRead(n.id, res.error, now)
      log(`[numbers] ${n.id}: no reading: ${res.error}`)
    }
    read.push(n.id)
  }
  return read
}
