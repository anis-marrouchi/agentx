import { totalmem } from "os"
import type { AdmissionConfig } from "@/daemon/config"
import type { ResourceSample } from "./node-resources"

// --- Admission gate: one queue for every session this node starts (#1521) ---
//
// A small machine used to start a CLI session for each piece of work the
// moment it arrived: on 8 GB that reached ~22 live sessions, full swap and
// kernel watchdog panics. Every run that would start a session now waits
// here, in one queue, and starts only when:
//   - the machine has room: available memory, swap, disk and load are
//     inside the configured thresholds;
//   - fewer than maxSessions gated runs are live (a delegated run may go
//     delegationHeadroom above it, so a parent waiting on its helper can't
//     hold every slot);
//   - its class (e.g. "browser") is under its own cap, and its agent has a
//     free slot of its own;
//   - the last start was startGapSeconds ago, and, while the daemon is
//     warming up after a start, fewer than `batch` runs started in the
//     current interval: work resumed after a restart comes back a few
//     sessions at a time.
// Order is priority (owner > critical > normal > background), then age.
// A run held back by the whole machine holds everyone behind it too; one
// held back only by its own agent or class is stepped over.
//
// Plain code, no model: it needs no judgment and must not use memory itself.

export type AdmissionPriority = "owner" | "critical" | "normal" | "background"
export const PRIORITY_ORDER: AdmissionPriority[] = ["owner", "critical", "normal", "background"]

export interface AdmissionRequest {
  agentId: string
  channel: string
  chatId: string
  priority: AdmissionPriority
  /** A hop of a delegation: its caller is a live run waiting on it. */
  delegated: boolean
  /** Can the agent itself take one more run right now? */
  canStart?: () => boolean
  /** Called synchronously at the moment of admission, so the agent's own
   *  slot is taken before any other waiter is looked at. */
  reserve?: () => void
}

export interface AdmissionGrant {
  ok: true
  waitedMs: number
  release(): void
}

export interface AdmissionRefusal {
  ok: false
  reason: "timeout" | "aborted"
  waitedMs: number
  /** What held it back last. */
  blockedBy: string | null
}

interface Ticket extends AdmissionRequest {
  id: number
  classes: string[]
  enqueuedAt: number
  blockedBy: string | null
  settle: (r: AdmissionGrant | AdmissionRefusal) => void
}

interface Running {
  id: number
  agentId: string
  channel: string
  chatId: string
  priority: AdmissionPriority
  delegated: boolean
  classes: string[]
  startedAt: number
  waitedMs: number
}

export interface AdmissionSnapshot {
  enabled: boolean
  at: number
  gate: { open: boolean; reasons: string[] }
  resources: ResourceSample | null
  thresholds: { minAvailableMemoryMB: number; maxSwapUsedPercent: number; minDiskFreeMB: number; maxLoadPerCpu: number }
  cap: { maxSessions: number; delegationHeadroom: number; running: number }
  classes: Array<{ name: string; max: number; running: number }>
  warmup: { active: boolean; until: number; batch: number; intervalSeconds: number }
  running: Array<Omit<Running, "id">>
  waiting: Array<{ position: number; agentId: string; channel: string; chatId: string; priority: AdmissionPriority; delegated: boolean; classes: string[]; waitingSince: number; blockedBy: string | null }>
  next: AdmissionSnapshot["waiting"][number] | null
  totals: { admitted: number; refused: number }
}

export type AdmissionSettings = AdmissionConfig

/** One session per GB above the first 2 GB, at least 2, at most 24. */
export function autoMaxSessions(totalMB: number): number {
  return Math.min(24, Math.max(2, Math.floor((totalMB - 2048) / 1024)))
}

/** 10% of the memory, between 512 and 2048 MB. */
export function autoMinAvailableMB(totalMB: number): number {
  return Math.round(Math.min(2048, Math.max(512, totalMB * 0.1)))
}

/** Why the machine has no room, one line per crossed threshold. A field the
 *  sampler could not read never closes the gate. */
export function resourceReasons(s: ResourceSample | null, t: AdmissionSnapshot["thresholds"]): string[] {
  if (!s) return []
  const out: string[] = []
  if (s.memAvailableMB !== null && s.memAvailableMB < t.minAvailableMemoryMB) {
    out.push(`available memory ${Math.round(s.memAvailableMB)} MB is under ${t.minAvailableMemoryMB} MB`)
  }
  if (s.swapTotalMB && s.swapUsedMB !== null) {
    const pct = (s.swapUsedMB / s.swapTotalMB) * 100
    if (pct > t.maxSwapUsedPercent) out.push(`swap ${Math.round(pct)}% used, over ${t.maxSwapUsedPercent}%`)
  }
  if (s.diskFreeMB !== null && s.diskFreeMB < t.minDiskFreeMB) {
    out.push(`disk free ${Math.round(s.diskFreeMB)} MB is under ${t.minDiskFreeMB} MB`)
  }
  if (s.loadPerCpu > t.maxLoadPerCpu) {
    out.push(`load ${s.load1.toFixed(1)} on ${s.cpus} CPUs is over ${t.maxLoadPerCpu} per CPU`)
  }
  return out
}

/** The queue position a channel gets when config names none. */
export function defaultPriority(input: { channel: string; humanFacing: boolean; ownerTurn: boolean; delegated: boolean }): AdmissionPriority {
  const ch = input.channel
  if (ch === "voice" || ch === "app" || input.ownerTurn) return "owner"
  if (ch === "cron" || ch === "heartbeat" || ch === "reminder" || ch === "routine" || ch.startsWith("cron:")) return "background"
  // A person waiting in a chat, or a running parent waiting on its helper.
  if (input.humanFacing || input.delegated) return "critical"
  return "normal"
}

export interface AdmissionDeps {
  /** The latest resource sample, or null when none is known yet. */
  sample: () => ResourceSample | null
  /** Ask for a fresh sample; the gate re-checks when it lands. */
  refresh?: () => Promise<unknown>
  now?: () => number
  log?: (msg: string) => void
  /** When the daemon started (warm-up counts from here). */
  bootAt?: number
  totalMemMB?: number
  /** How often a waiting queue is re-checked, ms. */
  tickMs?: number
}

export class AdmissionGate {
  private settings: AdmissionSettings
  private queue: Ticket[] = []
  private live = new Map<number, Running>()
  private seq = 0
  private lastStartAt = 0
  private windowStart = 0
  private windowStarts = 0
  private admitted = 0
  private refused = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number
  private readonly bootAt: number
  private readonly totalMemMB: number

  constructor(settings: AdmissionSettings, private readonly deps: AdmissionDeps) {
    this.settings = settings
    this.now = deps.now ?? Date.now
    this.bootAt = deps.bootAt ?? this.now()
    this.totalMemMB = deps.totalMemMB ?? totalmem() / (1024 * 1024)
  }

  configure(next: AdmissionSettings): void {
    this.settings = next
    this.pump()
  }

  /** Does a run of this agent kind wait in the queue? */
  gates(tier: string | undefined): boolean {
    return this.settings.enabled && !!tier && this.settings.tiers.includes(tier)
  }

  maxSessions(): number {
    return this.settings.maxSessions ?? autoMaxSessions(this.totalMemMB)
  }

  thresholds(): AdmissionSnapshot["thresholds"] {
    const t = this.settings.thresholds
    return {
      minAvailableMemoryMB: t.minAvailableMemoryMB ?? autoMinAvailableMB(this.totalMemMB),
      maxSwapUsedPercent: t.maxSwapUsedPercent,
      minDiskFreeMB: t.minDiskFreeMB,
      maxLoadPerCpu: t.maxLoadPerCpu,
    }
  }

  /** Configured priority for this run, else the default for its channel. */
  priorityFor(agentId: string, channel: string, fallback: AdmissionPriority): AdmissionPriority {
    const p = this.settings.priorities
    return p.agents[agentId] ?? p.channels[channel] ?? fallback
  }

  classesFor(agentId: string, channel: string): string[] {
    return Object.entries(this.settings.classes)
      .filter(([, c]) => c.agents.includes(agentId) || c.channels.includes(channel))
      .map(([name]) => name)
  }

  /** Wait for room. Resolves at once when there is some. */
  admit(req: AdmissionRequest, opts: { signal?: AbortSignal; maxWaitMs?: number } = {}): Promise<AdmissionGrant | AdmissionRefusal> {
    return new Promise((resolve) => {
      const enqueuedAt = this.now()
      let timeout: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const ticket: Ticket = {
        ...req,
        id: ++this.seq,
        classes: this.classesFor(req.agentId, req.channel),
        enqueuedAt,
        blockedBy: null,
        settle: (r) => {
          if (timeout) clearTimeout(timeout)
          if (onAbort) opts.signal?.removeEventListener("abort", onAbort)
          resolve(r)
        },
      }
      const drop = (reason: AdmissionRefusal["reason"]) => {
        const i = this.queue.indexOf(ticket)
        if (i === -1) return
        this.queue.splice(i, 1)
        this.refused++
        ticket.settle({ ok: false, reason, waitedMs: this.now() - enqueuedAt, blockedBy: ticket.blockedBy })
        this.pump()
      }
      if (opts.signal?.aborted) {
        this.refused++
        resolve({ ok: false, reason: "aborted", waitedMs: 0, blockedBy: null })
        return
      }
      const maxWaitMs = opts.maxWaitMs ?? this.settings.maxWaitMinutes * 60_000
      timeout = setTimeout(() => drop("timeout"), maxWaitMs)
      timeout.unref?.()
      if (opts.signal) {
        onAbort = () => drop("aborted")
        opts.signal.addEventListener("abort", onAbort, { once: true })
      }
      this.queue.push(ticket)
      this.pump()
      if (this.queue.includes(ticket)) {
        this.deps.log?.(`[admission] ${req.agentId} ${req.channel}:${req.chatId} waits (${req.priority}, ${this.queue.length} waiting): ${ticket.blockedBy ?? "queued"}`)
      }
    })
  }

  /** Start the timer that re-checks a waiting queue. */
  private arm(): void {
    if (this.timer || !this.queue.length) return
    this.timer = setInterval(() => {
      if (!this.queue.length) { this.disarm(); return }
      const refresh = this.deps.refresh?.()
      if (refresh) refresh.then(() => this.pump(), () => this.pump())
      else this.pump()
    }, this.deps.tickMs ?? 1000)
    this.timer.unref?.()
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  stop(): void {
    this.disarm()
  }

  private warmupActive(now: number): boolean {
    return now - this.bootAt < this.settings.warmup.minutes * 60_000
  }

  /** Why nobody can start right now, or null. */
  private nodeBlock(now: number): string | null {
    const reasons = resourceReasons(this.deps.sample(), this.thresholds())
    if (reasons.length) return reasons[0]
    const gap = this.settings.startGapSeconds * 1000
    if (gap && now - this.lastStartAt < gap) return "spacing out session starts"
    if (this.warmupActive(now)) {
      const w = this.settings.warmup
      if (now - this.windowStart >= w.intervalSeconds * 1000) { this.windowStart = now; this.windowStarts = 0 }
      if (this.windowStarts >= w.batch) return `warming up after start: ${w.batch} sessions per ${w.intervalSeconds}s`
    }
    return null
  }

  /** Why this run can't start even with room on the machine, or null. */
  private ticketBlock(t: Ticket): string | null {
    const cap = this.maxSessions() + (t.delegated ? this.settings.delegationHeadroom : 0)
    if (this.live.size >= cap) return `${this.live.size} of ${this.maxSessions()} sessions running`
    for (const name of t.classes) {
      const max = this.settings.classes[name]?.max ?? Infinity
      const n = [...this.live.values()].filter((r) => r.classes.includes(name)).length
      if (n >= max) return `class "${name}" at its cap of ${max}`
    }
    if (t.canStart && !t.canStart()) return `agent ${t.agentId} has no free slot`
    return null
  }

  private ordered(): Ticket[] {
    return [...this.queue].sort((a, b) =>
      PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || a.enqueuedAt - b.enqueuedAt || a.id - b.id)
  }

  /** Start whatever may start, in order. */
  pump(): void {
    if (!this.queue.length) { this.disarm(); return }
    const now = this.now()
    for (const t of this.ordered()) {
      const node = this.nodeBlock(now)
      if (node) {
        // The machine is full: nobody behind the first waiter goes either.
        for (const w of this.queue) w.blockedBy = node
        break
      }
      const own = this.ticketBlock(t)
      if (own) { t.blockedBy = own; continue }
      this.start(t, now)
    }
    if (this.queue.length) this.arm()
    else this.disarm()
  }

  private start(t: Ticket, now: number): void {
    this.queue.splice(this.queue.indexOf(t), 1)
    try { t.reserve?.() } catch { /* caller bug must not wedge the queue */ }
    const waitedMs = now - t.enqueuedAt
    const run: Running = {
      id: t.id, agentId: t.agentId, channel: t.channel, chatId: t.chatId,
      priority: t.priority, delegated: t.delegated, classes: t.classes,
      startedAt: now, waitedMs,
    }
    this.live.set(t.id, run)
    this.lastStartAt = now
    if (this.warmupActive(now)) {
      if (now - this.windowStart >= this.settings.warmup.intervalSeconds * 1000) { this.windowStart = now; this.windowStarts = 0 }
      this.windowStarts++
    }
    this.admitted++
    if (waitedMs >= 1000) {
      this.deps.log?.(`[admission] ${t.agentId} ${t.channel}:${t.chatId} starts after ${Math.round(waitedMs / 1000)}s (${this.live.size} running)`)
    }
    let released = false
    t.settle({
      ok: true,
      waitedMs,
      release: () => {
        if (released) return
        released = true
        this.live.delete(t.id)
        this.pump()
      },
    })
  }

  snapshot(): AdmissionSnapshot {
    const now = this.now()
    const thresholds = this.thresholds()
    const resources = this.deps.sample()
    const reasons = resourceReasons(resources, thresholds)
    if (this.live.size >= this.maxSessions()) reasons.push(`${this.live.size} of ${this.maxSessions()} sessions running`)
    const waiting = this.ordered().map((t, i) => ({
      position: i + 1, agentId: t.agentId, channel: t.channel, chatId: t.chatId,
      priority: t.priority, delegated: t.delegated, classes: t.classes,
      waitingSince: t.enqueuedAt, blockedBy: t.blockedBy,
    }))
    const w = this.settings.warmup
    return {
      enabled: this.settings.enabled,
      at: now,
      gate: { open: reasons.length === 0, reasons },
      resources,
      thresholds,
      cap: { maxSessions: this.maxSessions(), delegationHeadroom: this.settings.delegationHeadroom, running: this.live.size },
      classes: Object.entries(this.settings.classes).map(([name, c]) => ({
        name, max: c.max, running: [...this.live.values()].filter((r) => r.classes.includes(name)).length,
      })),
      warmup: { active: this.warmupActive(now), until: this.bootAt + w.minutes * 60_000, batch: w.batch, intervalSeconds: w.intervalSeconds },
      running: [...this.live.values()].sort((a, b) => a.startedAt - b.startedAt).map(({ id: _id, ...r }) => r),
      waiting,
      next: waiting[0] ?? null,
      totals: { admitted: this.admitted, refused: this.refused },
    }
  }
}
