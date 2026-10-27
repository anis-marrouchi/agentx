// --- The Wall's forge reads: cached and time-boxed (#1189, #1184) ---
//
// The page refreshes every minute, so answers are cached, and one Wall
// read waits at most `budgetMs` for the forge: what is not back by then is
// "unknown" this time and is filled from the cache on the next refresh.
// Errors are kept for a shorter time than answers, so a forge that comes
// back is read again soon.
//
// A quick read (#1442) waits only QUICK_BUDGET_MS: the Wall's first paint
// shows what is cached, the reads it started go on, and busy() tells the
// reply to say so, so the page asks again in a moment.

const MINUTE = 60_000
const OK_TTL_MS = 5 * MINUTE
const ERROR_TTL_MS = MINUTE
const BUDGET_MS = 4_000
export const QUICK_BUDGET_MS = 300
/** What a post says about a home a quick read left unread. */
export const LATE_QUICK = "still being read; shown in a moment"
/** Homes read per Wall read; the rest are "not read yet" until cached. */
const MAX_READS = 40
const CONCURRENCY = 4
const CACHE_MAX = 2_000

export type ForgeAnswer<T> = T | { error: string }

/** One home's answer this time: read (with when), not back in time, or
 *  over the read cap. */
export type ForgeRead<T> =
  | { kind: "answer"; answer: ForgeAnswer<T>; at: number }
  | { kind: "late" }
  | { kind: "skipped" }

export interface ForgeCacheOptions { budgetMs?: number; maxReads?: number; clock?: () => number }

export interface ForgeCache<R, T> {
  /** Reads every ref (keyed, in order) inside one time box; a quick read
   *  uses the short one. */
  readAll(refs: Map<string, R>, quick?: boolean): Promise<Map<string, ForgeRead<T>>>
  /** True while a read started earlier has not answered yet. */
  busy(): boolean
}

export function forgeCache<R, T>(read: (ref: R) => Promise<ForgeAnswer<T>>, opts: ForgeCacheOptions = {}): ForgeCache<R, T> {
  const clock = opts.clock ?? Date.now
  const cache = new Map<string, { at: number; answer: ForgeAnswer<T> }>()
  const inFlight = new Map<string, Promise<{ at: number; answer: ForgeAnswer<T> }>>()
  let running = 0
  const queue: Array<() => void> = []

  const fetchOne = (key: string, ref: R) => {
    const had = inFlight.get(key)
    if (had) return had
    const p = new Promise<{ at: number; answer: ForgeAnswer<T> }>((resolve) => {
      const go = () => {
        running++
        read(ref).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }))
          .then((answer) => {
            const entry = { at: clock(), answer }
            if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
            cache.set(key, entry)
            resolve(entry)
          })
          .finally(() => { running--; inFlight.delete(key); queue.shift()?.() })
      }
      if (running < CONCURRENCY) go()
      else queue.push(go)
    })
    inFlight.set(key, p)
    return p
  }

  const fresh = (key: string) => {
    const c = cache.get(key)
    if (!c) return null
    const ttl = typeof c.answer === "object" && c.answer !== null && "error" in c.answer ? ERROR_TTL_MS : OK_TTL_MS
    return clock() - c.at < ttl ? c : null
  }

  return {
    busy: () => inFlight.size > 0,
    async readAll(refs, quick) {
      const budget = quick ? Math.min(QUICK_BUDGET_MS, opts.budgetMs ?? BUDGET_MS) : opts.budgetMs ?? BUDGET_MS
      const maxReads = opts.maxReads ?? MAX_READS
      const out = new Map<string, ForgeRead<T>>()
      let reads = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<null>((r) => { timer = setTimeout(() => r(null), budget) })
      try {
        await Promise.all([...refs].map(async ([key, ref]) => {
          let entry = fresh(key)
          if (!entry) {
            if (!inFlight.has(key) && reads >= maxReads) { out.set(key, { kind: "skipped" }); return }
            if (!inFlight.has(key)) reads++
            entry = await Promise.race([fetchOne(key, ref), deadline])
          }
          out.set(key, entry ? { kind: "answer", answer: entry.answer, at: entry.at } : { kind: "late" })
        }))
      } finally {
        clearTimeout(timer)
      }
      return out
    },
  }
}

export const isForgeError = <T>(a: ForgeAnswer<T>): a is { error: string } =>
  typeof a === "object" && a !== null && "error" in a
