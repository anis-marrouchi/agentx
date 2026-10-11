// --- The floor: who may speak and show a bubble on this host (#924) ---
//
// The speaking queue (speaking-queue.ts) orders what the daemon itself
// says. The floor is for what it cannot see: a demo script that plays its
// own sound, a screen recording, an agent that wants the screen to
// itself. A holder takes the floor for a number of seconds; until it
// lets go, every line that is not its own waits in the queue, a new talk
// or lesson is refused, and the character obeys only the holder.
//
// One holder at a time, and never for good: the floor frees itself at
// the time limit, or sooner when the holder's process is gone, and the
// owner can take it back whenever they like (revoke).

import { randomBytes } from "crypto"

export interface FloorSettings {
  enabled: boolean
  /** How long a holder keeps the floor when it names no time. */
  defaultSeconds: number
  /** The longest a holder may ask for, in one take or one renewal. */
  maxSeconds: number
}

export const FLOOR_DEFAULTS: FloorSettings = { enabled: true, defaultSeconds: 120, maxSeconds: 1800 }
export const FLOOR_HOLDER_MAX = 80

export interface FloorRequest {
  /** Who holds it, as the owner reads it: "Product tour", "Screen recording". */
  holder: string
  agentId?: string | null
  seconds?: number
  /** The holder plays sound of its own: a microphone that opened by
   *  itself must not take that sound for the owner's words. */
  sound?: boolean
  /** A recording: the character and every bubble stay hidden. */
  hide?: boolean
  /** The holder's process on this host: the floor is freed when it is gone. */
  pid?: number | null
}

/** Why the floor was last freed. */
export type FloorEnd = "released" | "expired" | "holder gone" | "owner"

/** What anyone may know about the floor. The id is the holder's proof
 *  and is never in here. */
export interface FloorView {
  /** Grows with every change, so a waiting client knows a new one. */
  seq: number
  held: boolean
  holder: string | null
  agentId: string | null
  sound: boolean
  hide: boolean
  since: number | null
  expiresAt: number | null
  /** How the last hold ended; null before the first. */
  ended: FloorEnd | null
}

export type FloorTake =
  | { ok: true; id: string; view: FloorView }
  | { ok: false; reason: "off" | "held" | "busy" | "invalid"; error: string; view: FloorView }

interface Hold {
  id: string
  holder: string
  agentId: string | null
  sound: boolean
  hide: boolean
  pid: number | null
  since: number
  expiresAt: number
}

export interface FloorDeps {
  settings?: () => Partial<FloorSettings> | undefined
  now?: () => number
  /** Whether a process on this host still runs. */
  alive?: (pid: number) => boolean
  /** Something of the daemon's own that cannot be cut short is using the
   *  speakers and the screen: its name ("a talk"), else null. */
  busy?: () => string | null
  /** Told of every change, with the id of the hold in force. */
  onChange?: (view: FloorView, id: string | null) => void
}

/** A wait is answered within this, change or not, so a dead socket is noticed. */
export const FLOOR_WAIT_MS = 25_000
/** How often a holder's process is looked for. */
const ALIVE_MS = 2_000

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    // EPERM: it runs, as someone else.
    return e?.code === "EPERM"
  }
}

export class Floor {
  private hold: Hold | null = null
  private seq = 0
  private ended: FloorEnd | null = null
  private expiry: NodeJS.Timeout | null = null
  private watch: NodeJS.Timeout | null = null
  private waiters = new Set<() => void>()
  private now: () => number
  private alive: (pid: number) => boolean

  constructor(private deps: FloorDeps = {}) {
    this.now = deps.now ?? Date.now
    this.alive = deps.alive ?? processAlive
  }

  get settings(): FloorSettings { return { ...FLOOR_DEFAULTS, ...this.deps.settings?.() } }

  /** The hold in force, after a late expiry has been applied. */
  private get current(): Hold | null {
    if (this.hold && this.now() >= this.hold.expiresAt) this.end("expired")
    return this.hold
  }

  view(): FloorView {
    const h = this.current
    return {
      seq: this.seq, held: !!h, holder: h?.holder ?? null, agentId: h?.agentId ?? null,
      sound: h?.sound ?? false, hide: h?.hide ?? false, since: h?.since ?? null, expiresAt: h?.expiresAt ?? null,
      ended: this.ended,
    }
  }

  /** Whether `id` is the hold in force. */
  holds(id: unknown): boolean {
    const h = this.current
    return !!h && typeof id === "string" && id === h.id
  }

  take(req: FloorRequest): FloorTake {
    const s = this.settings
    const refuse = (reason: "off" | "held" | "busy" | "invalid", error: string): FloorTake => ({ ok: false, reason, error, view: this.view() })
    if (!s.enabled) return refuse("off", "The floor is off on this computer (voice.floor.enabled)")
    const holder = String(req.holder ?? "").replace(/\s+/g, " ").trim().slice(0, FLOOR_HOLDER_MAX)
    const seconds = req.seconds ?? s.defaultSeconds
    const pid = req.pid ?? null
    if (!holder || !Number.isFinite(seconds) || seconds <= 0 || seconds > s.maxSeconds || (pid !== null && !(Number.isInteger(pid) && pid > 1))) {
      return refuse("invalid", `Required: holder (who takes the floor); seconds is up to ${s.maxSeconds}; pid is a process on this computer`)
    }
    const cur = this.current
    if (cur) return refuse("held", `The floor is held by ${cur.holder}`)
    const busy = this.deps.busy?.()
    if (busy) return refuse("busy", `The floor is taken by ${busy}`)
    if (pid !== null && !this.alive(pid)) return refuse("invalid", `No process ${pid} runs on this computer`)
    const at = this.now()
    const hold: Hold = {
      id: randomBytes(12).toString("hex"), holder, agentId: req.agentId || null,
      sound: req.sound === true, hide: req.hide === true, pid, since: at, expiresAt: at + seconds * 1000,
    }
    this.hold = hold
    this.ended = null
    this.arm()
    this.changed()
    return { ok: true, id: hold.id, view: this.view() }
  }

  /** Keep the floor `seconds` longer from now. Null: it is no longer `id`'s. */
  renew(id: string, seconds?: number): FloorView | null {
    if (!this.holds(id)) return null
    const s = this.settings
    const more = seconds ?? s.defaultSeconds
    if (!Number.isFinite(more) || more <= 0 || more > s.maxSeconds) return null
    this.hold!.expiresAt = this.now() + more * 1000
    this.arm()
    this.changed()
    return this.view()
  }

  /** The holder lets go. False: the floor was not `id`'s (any more). */
  release(id: string): boolean {
    if (!this.holds(id)) return false
    this.end("released")
    return true
  }

  /** The owner takes the floor back, whoever holds it. */
  revoke(): boolean {
    if (!this.current) return false
    this.end("owner")
    return true
  }

  /** The view after `after`: at once when it has changed, else when it
   *  does, else the current one after `waitMs`. */
  next(after: number, waitMs = FLOOR_WAIT_MS, gone?: AbortSignal): Promise<FloorView> {
    if (after !== this.view().seq) return Promise.resolve(this.view())
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve(this.view())
      }
      const timer = setTimeout(done, waitMs)
      timer.unref?.()
      this.waiters.add(done)
      gone?.addEventListener("abort", done, { once: true })
    })
  }

  close(): void {
    this.disarm()
    for (const wake of [...this.waiters]) wake()
  }

  private end(why: FloorEnd): void {
    if (!this.hold) return
    this.hold = null
    this.ended = why
    this.disarm()
    this.changed()
  }

  private arm(): void {
    this.disarm()
    const h = this.hold
    if (!h) return
    this.expiry = setTimeout(() => { if (this.hold === h) this.view() }, Math.max(0, h.expiresAt - this.now()) + 5)
    this.expiry.unref?.()
    if (h.pid === null) return
    const pid = h.pid
    this.watch = setInterval(() => { if (this.hold === h && !this.alive(pid)) this.end("holder gone") }, ALIVE_MS)
    this.watch.unref?.()
  }

  private disarm(): void {
    if (this.expiry) clearTimeout(this.expiry)
    if (this.watch) clearInterval(this.watch)
    this.expiry = this.watch = null
  }

  private changed(): void {
    this.seq++
    try { this.deps.onChange?.(this.view(), this.hold?.id ?? null) } catch { /* a listener's failure is not the floor's */ }
    for (const wake of [...this.waiters]) wake()
  }
}

/** The floor in one plain line, for an agent or the CLI. */
export function describeFloor(v: FloorView, now = Date.now()): string {
  if (!v.held) return "The floor is free."
  const left = Math.max(0, Math.round(((v.expiresAt ?? now) - now) / 1000))
  const how = [v.sound ? "plays sound" : "", v.hide ? "character and bubbles hidden" : ""].filter(Boolean).join(", ")
  return `The floor is held by ${v.holder}${how ? ` (${how})` : ""} for up to ${left} more seconds: other lines wait until it is free.`
}
