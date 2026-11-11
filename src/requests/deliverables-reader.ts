import type { RequestRecord, RequestStore } from "./store"

// --- What the owner's words ask for, read once (#692 Part A) ---
//
// One small model call per request, through the provider and model of
// `requests.ownerCheck`, on the owner's words and their latest note. The
// list is kept on the request and read again only after a new owner note
// (store.handOff / store.reopen clear it). Only open requests that can
// close on their own are read: a checker, or an issue home. A request with
// a tracked plan is never read: its steps are its deliverables.
//
// A call that fails or answers something unreadable is tried again at the
// next check; after MAX_TRIES the list is "unreadable", which counts as one
// deliverable (it closes as before), with one log line.

export const DELIVERABLES_SYSTEM =
  "You list what an owner asked to be delivered. Respond with a single JSON object on one line. No prose, no code fences."

const TEXT_CLIP = 2000
const MAX_TRIES = 3
const MAX_ITEMS = 20
const ITEM_MAX = 80

export function deliverablesPrompt(r: Pick<RequestRecord, "text" | "ownerNote">): string {
  return [
    "The owner asked for this (their own words, possibly a voice transcript):",
    clip(r.text),
    ...(r.ownerNote ? ["", "The owner's latest note on it:", clip(r.ownerNote)] : []),
    "",
    "List the separate things the owner asks to be done or confirmed, each in a few words, in the order asked.",
    "Each item is something a person could show with its own link (a note, a commit, a merge request, a deploy).",
    "When the words ask for one thing, or only that an issue be closed or finished, give one item.",
    "",
    "Reply as {\"deliverables\":[\"…\",\"…\"]}.",
  ].join("\n")
}

export function readDeliverables(text: string): string[] | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0])
    if (!Array.isArray(o.deliverables)) return null
    const items = o.deliverables
      .filter((x: unknown): x is string => typeof x === "string")
      .map((x: string) => x.replace(/\s+/g, " ").trim().slice(0, ITEM_MAX))
      .filter(Boolean)
      .slice(0, MAX_ITEMS)
    return items.length ? items : null
  } catch {
    return null
  }
}

export interface DeliverablesReaderDeps {
  store: RequestStore
  /** Requests read per requests check. */
  perCheck: () => number
  generate: (prompt: string, signal: AbortSignal) => Promise<string>
  /** The request has a tracked plan: its steps are the list. */
  hasPlan?: (requestId: string) => boolean
  timeoutSeconds?: number
  log?: (line: string) => void
}

export class DeliverablesReader {
  private tries = new Map<string, number>()
  private reading = new Map<string, Promise<void>>()
  private running = false

  constructor(private readonly deps: DeliverablesReaderDeps) {}

  /** Read up to `perCheck` unread requests. Never throws. */
  async run(): Promise<number> {
    let n = 0
    if (this.running) return n
    this.running = true
    try {
      const due = this.deps.store.deliverablesDue(this.deps.perCheck() * 4).filter((r) => !this.deps.hasPlan?.(r.id)).slice(0, this.deps.perCheck())
      for (const r of due) { await this.read(r); n++ }
    } catch (e: any) {
      this.deps.log?.(`[requests] reading deliverables failed: ${e?.message ?? e}`)
    } finally {
      this.running = false
    }
    return n
  }

  /** One try at one request's list. One call at a time per request. */
  read(r: RequestRecord): Promise<void> {
    const running = this.reading.get(r.id)
    if (running) return running
    const p = this.readOnce(r).finally(() => this.reading.delete(r.id))
    this.reading.set(r.id, p)
    return p
  }

  private async readOnce(r: RequestRecord): Promise<void> {
    const list = await this.ask(r)
    if (list) {
      this.tries.delete(r.id)
      this.deps.store.setDeliverables(r.id, list)
      return
    }
    const n = (this.tries.get(r.id) ?? 0) + 1
    this.tries.set(r.id, n)
    if (n >= MAX_TRIES) {
      this.tries.delete(r.id)
      if (this.deps.store.setDeliverables(r.id, "unreadable")) {
        this.deps.log?.(`[requests] ${r.id}: its deliverables could not be read after ${MAX_TRIES} tries; it counts as one`)
      }
    }
  }

  private async ask(r: RequestRecord): Promise<string[] | null> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), (this.deps.timeoutSeconds ?? 60) * 1000)
    try {
      return readDeliverables(await this.deps.generate(deliverablesPrompt(r), ac.signal))
    } catch (e: any) {
      this.deps.log?.(`[requests] ${r.id}: reading its deliverables failed: ${e?.message ?? e}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

function clip(t: string): string {
  const s = t.trim()
  return s.length > TEXT_CLIP ? s.slice(0, TEXT_CLIP - 1) + "…" : s
}
