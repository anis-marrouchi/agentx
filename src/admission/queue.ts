// --- Admission queue: one gate in front of every new session (#1521) ---
//
// Plain code, no model. Every run that would start an agent session asks
// here first (AgentRegistry.executeInternal). A run starts only when:
//   1. the node has room: available memory, swap, disk and load inside the
//      configured limits (see gateReasons);
//   2. fewer than maxSessions runs are going on this node, and fewer than
//      its class's cap (e.g. one browser job);
//   3. its agent has a free slot (canStart), checked and taken in the same
//      step, so a waiting run never holds its agent's slot and a later,
//      higher-priority message to the same agent still reaches this queue;
//   4. the start pace allows it: a gap between any two starts, and a few
//      starts per interval in the warm-up window after boot, so a restart
//      does not bring every queued run up at once.
// Otherwise it waits in one queue, ordered by priority (owner > critical >
// normal > background), then by age. The queue is read by GET /api/queue
// and `agentx queue`.
//
// Two ways past a closed gate, both on purpose and both settings:
//   - allowOneWhenIdle: with nothing of ours running, one run starts even
//     when resources are short. The pressure is not ours.
//   - owner turns skip the pace and may go ownerExtraSessions over the cap
//     (never past resources).
// A helper run started by a running session (a delegation) may go
// delegationHeadroom over the cap: its parent holds a place while it
// waits for the helper, so without headroom a full node deadlocks.

import type { ResourceSample, ResourceSampler } from "../native/resources"

export type AdmissionPriority = "owner" | "critical" | "normal" | "background"
export const PRIORITY_ORDER: AdmissionPriority[] = ["owner", "critical", "normal", "background"]

export interface AdmissionClass {
  /** Most runs of this class at once on the node. */
  max: number
  /** Agents whose runs belong to the class. */
  agents?: string[]
  /** Channels whose runs belong to the class. */
  channels?: string[]
}

export interface AdmissionSettings {
  enabled: boolean
  /** "observe" logs what it would hold but starts everything. */
  mode: "enforce" | "observe"
  /** Agent tiers whose runs go through the queue (the ones that start a
   *  local process); other tiers start at once and are not counted. */
  tiers: string[]
  /** Node-wide most live sessions; 0 = one per GB of memory above the
   *  first 2 GB (kept for the system), at least 2. */
  maxSessions: number
  /** Owner runs may go this many over maxSessions (never over resources). */
  ownerExtraSessions: number
  /** Delegated helper runs may go this many over maxSessions. */
  delegationHeadroom: number
  /** Hold below this much available memory: the larger of the two. */
  minAvailableMemoryMB: number
  minAvailableMemoryPercent: number
  /** Hold above this much swap in use. 0 = half the swap size, or three
   *  quarters of the memory size where swap grows on demand (macOS). */
  maxSwapUsedMB: number
  /** Hold below this much free disk where the daemon keeps its data; 0 = off. */
  minDiskFreeMB: number
  /** Hold above this 1-minute load average per CPU; 0 = off. */
  maxLoadPerCpu: number
  /** Least time between two starts, any time. A session takes several
   *  seconds to reach its full memory, so the next reading must see it. */
  minStartGapSeconds: number
  /** Warm-up after the daemon starts: at most `startsPerInterval` starts
   *  every `intervalSeconds`, for `windowSeconds`. */
  boot: { windowSeconds: number; startsPerInterval: number; intervalSeconds: number }
  allowOneWhenIdle: boolean
  /** A run still waiting after this long is refused in plain words; 0 = never. */
  maxWaitMinutes: number
  /** Seconds between resource re-reads while work is waiting. */
  sampleSeconds: number
  classes: Record<string, AdmissionClass>
  priority: {
    ownerChannels: string[]
    /** People ids (config.people) whose turns run at owner priority. */
    ownerPeople: string[]
    criticalAgents: string[]
    backgroundChannels: string[]
  }
}

export const DEFAULT_ADMISSION_SETTINGS: AdmissionSettings = {
  enabled: true,
  mode: "enforce",
  tiers: ["claude-code", "codex-cli", "opencode"],
  maxSessions: 0,
  ownerExtraSessions: 1,
  delegationHeadroom: 2,
  minAvailableMemoryMB: 512,
  minAvailableMemoryPercent: 10,
  maxSwapUsedMB: 0,
  minDiskFreeMB: 2048,
  maxLoadPerCpu: 2,
  minStartGapSeconds: 10,
  boot: { windowSeconds: 300, startsPerInterval: 2, intervalSeconds: 30 },
  allowOneWhenIdle: true,
  maxWaitMinutes: 60,
  sampleSeconds: 5,
  classes: {},
  priority: {
    ownerChannels: ["voice", "app"],
    ownerPeople: [],
    criticalAgents: [],
    backgroundChannels: ["cron", "heartbeat", "routine"],
  },
}

export interface AdmissionRequest {
  agentId: string
  channel: string
  chatId?: string
  /** The person behind the turn (config.people id), when known. */
  person?: string | null
  /** The person behind the turn has the owner role. */
  owner?: boolean
  /** A helper run started from inside another run (delegation). */
  delegated?: boolean
  /** Set by the caller to override the computed priority. */
  priority?: AdmissionPriority
  /** Set by the caller to override the class computed from config. */
  class?: string
  /** Short text for the queue view (never the full message). */
  label?: string
  /** The caller's own condition, e.g. "the agent has a free slot". When
   *  false the run keeps waiting, without holding up the runs behind it. */
  canStart?: () => boolean
  /** Called in the same step as admission, before anything else can run:
   *  the place to take the agent's slot. */
  onStart?: () => void
  /** On close, leave this run unanswered (a chat message the router
   *  replays on boot) instead of answering "closed". */
  keepOnClose?: boolean
  signal?: AbortSignal
}

export interface AdmissionTicket {
  id: string
  /** Idempotent. */
  release(): void
}

export type AdmissionOutcome =
  | { ok: true; ticket: AdmissionTicket }
  | { ok: false; reason: "caller-gone" | "closed" | "timeout"; waitedMs: number; blockedBy: string[] }

interface Entry {
  id: string
  seq: number
  agentId: string
  channel: string
  chatId?: string
  priority: AdmissionPriority
  cls: string | null
  delegated: boolean
  label: string
  enqueuedAt: number
  /** Why it is still waiting, from the last pass. */
  blockedBy: string[]
  req: AdmissionRequest
  resolve: (o: AdmissionOutcome) => void
  onAbort?: () => void
}

interface Running {
  id: string
  agentId: string
  channel: string
  chatId?: string
  priority: AdmissionPriority
  cls: string | null
  label: string
  startedAt: number
  waitedMs: number
}

const baseChannel = (c: string) => (c || "").toLowerCase().split("@")[0]

export function priorityOf(req: AdmissionRequest, s: AdmissionSettings): AdmissionPriority {
  if (req.priority) return req.priority
  const ch = baseChannel(req.channel)
  if (req.owner || s.priority.ownerChannels.includes(ch)) return "owner"
  if (req.person && s.priority.ownerPeople.includes(req.person)) return "owner"
  if (s.priority.criticalAgents.includes(req.agentId)) return "critical"
  if (s.priority.backgroundChannels.includes(ch)) return "background"
  return "normal"
}

export function classOf(req: AdmissionRequest, s: AdmissionSettings): string | null {
  if (req.class) return req.class
  const ch = baseChannel(req.channel)
  for (const [name, c] of Object.entries(s.classes)) {
    if (c.agents?.includes(req.agentId) || c.channels?.includes(ch)) return name
  }
  return null
}

export function effectiveMaxSessions(s: AdmissionSettings, memTotalMB: number): number {
  return s.maxSessions > 0 ? s.maxSessions : Math.max(2, Math.round((memTotalMB - 2048) / 1024))
}

export interface ResourceLimits {
  minAvailableMemoryMB: number
  maxSwapUsedMB: number
  minDiskFreeMB: number
  maxLoad1: number
}

export function limitsFor(s: AdmissionSettings, r: ResourceSample): ResourceLimits {
  const autoSwap = r.swapGrows ? (r.memTotalMB * 3) / 4 : r.swapTotalMB / 2
  return {
    minAvailableMemoryMB: Math.max(s.minAvailableMemoryMB, Math.round((r.memTotalMB * s.minAvailableMemoryPercent) / 100)),
    maxSwapUsedMB: s.maxSwapUsedMB > 0 ? s.maxSwapUsedMB : Math.round(autoSwap),
    minDiskFreeMB: s.minDiskFreeMB,
    maxLoad1: s.maxLoadPerCpu > 0 ? Math.round(s.maxLoadPerCpu * r.cpuCount * 100) / 100 : 0,
  }
}

/** Why the node has no room for one more session, in plain words; empty
 *  when it has room. */
export function gateReasons(r: ResourceSample, s: AdmissionSettings): string[] {
  const lim = limitsFor(s, r)
  const out: string[] = []
  if (r.memAvailableMB < lim.minAvailableMemoryMB) out.push(`memory: ${r.memAvailableMB} MB available, needs ${lim.minAvailableMemoryMB} MB`)
  if (r.swapTotalMB > 0 && r.swapUsedMB > lim.maxSwapUsedMB) out.push(`swap: ${r.swapUsedMB} MB used, limit ${lim.maxSwapUsedMB} MB`)
  if (lim.minDiskFreeMB > 0 && r.diskFreeMB !== null && r.diskFreeMB < lim.minDiskFreeMB) out.push(`disk: ${r.diskFreeMB} MB free, needs ${lim.minDiskFreeMB} MB`)
  if (lim.maxLoad1 > 0 && r.load1 > lim.maxLoad1) out.push(`load: ${r.load1}, limit ${lim.maxLoad1}`)
  return out
}

export class AdmissionQueue {
  private waiting: Entry[] = []
  private running = new Map<string, Running>()
  private starts: number[] = []
  private seq = 0
  private pumping = false
  private again = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private closedAt: number | null = null
  private lastReasons: string[] = []
  private readonly bootAt: number

  constructor(
    private readonly settings: () => AdmissionSettings,
    private readonly sampler: ResourceSampler,
    private readonly log: (msg: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    this.bootAt = now()
  }

  get closed(): boolean {
    return this.closedAt !== null
  }

  /** Waits until the run may start. A run with keepOnClose is never
   *  answered once the daemon is stopping. */
  admit(req: AdmissionRequest): Promise<AdmissionOutcome> {
    const s = this.settings()
    const id = `adm-${++this.seq}`
    const base = {
      id, agentId: req.agentId, channel: req.channel || "api", chatId: req.chatId,
      priority: priorityOf(req, s), cls: classOf(req, s),
      label: (req.label || "").replace(/\s+/g, " ").slice(0, 80),
    }
    if (this.closed) {
      if (req.keepOnClose) return new Promise(() => {})
      return Promise.resolve({ ok: false, reason: "closed", waitedMs: 0, blockedBy: [] })
    }
    if (req.signal?.aborted) return Promise.resolve({ ok: false, reason: "caller-gone", waitedMs: 0, blockedBy: [] })
    if (!s.enabled) {
      req.onStart?.()
      return Promise.resolve({ ok: true, ticket: this.start(base, 0) })
    }
    return new Promise((resolve) => {
      const entry: Entry = {
        ...base, seq: this.seq, delegated: !!req.delegated, enqueuedAt: this.now(), blockedBy: [], req, resolve,
      }
      if (req.signal) {
        entry.onAbort = () => {
          if (!this.waiting.includes(entry)) return
          this.log(`[admission] ${entry.agentId} left the queue (caller gone) after ${Math.round((this.now() - entry.enqueuedAt) / 1000)}s`)
          this.refuse(entry, "caller-gone")
        }
        req.signal.addEventListener("abort", entry.onAbort, { once: true })
      }
      this.waiting.push(entry)
      void this.pump()
    })
  }

  /** The daemon is stopping: nothing starts any more. Runs marked
   *  keepOnClose (chat messages) are left unanswered on purpose, so they
   *  keep their unfinished entry in the router's inflight log and are
   *  replayed on boot; every other waiting run is answered "closed", so a
   *  scheduled job logs its run and a calling agent gets a reply. */
  close(): { kept: number; refused: number } {
    this.closedAt = this.now()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    let kept = 0, refused = 0
    for (const e of [...this.waiting]) {
      if (e.req.keepOnClose) {
        this.drop(e)
        kept++
      } else {
        this.refuse(e, "closed")
        refused++
      }
    }
    return { kept, refused }
  }

  get waitingCount(): number {
    return this.waiting.length
  }

  private drop(e: Entry): void {
    const i = this.waiting.indexOf(e)
    if (i !== -1) this.waiting.splice(i, 1)
    if (e.req.signal && e.onAbort) e.req.signal.removeEventListener("abort", e.onAbort)
  }

  private refuse(e: Entry, reason: "caller-gone" | "closed" | "timeout"): void {
    this.drop(e)
    e.resolve({ ok: false, reason, waitedMs: this.now() - e.enqueuedAt, blockedBy: e.blockedBy })
  }

  private start(e: Omit<Running, "startedAt" | "waitedMs">, waitedMs: number): AdmissionTicket {
    const at = this.now()
    this.running.set(e.id, { ...e, startedAt: at, waitedMs })
    this.starts.push(at)
    let done = false
    return {
      id: e.id,
      release: () => {
        if (done) return
        done = true
        this.running.delete(e.id)
        if (this.waiting.length) void this.pump()
      },
    }
  }

  private ordered(): Entry[] {
    const rank = (p: AdmissionPriority) => PRIORITY_ORDER.indexOf(p)
    return [...this.waiting].sort((a, b) => rank(a.priority) - rank(b.priority) || a.enqueuedAt - b.enqueuedAt || a.seq - b.seq)
  }

  /** Ms until the pace allows one more start of `priority` (0 = now). */
  private paceWait(priority: AdmissionPriority, s: AdmissionSettings, now: number): number {
    if (priority === "owner") return 0
    const last = this.starts[this.starts.length - 1]
    let wait = last !== undefined ? Math.max(0, last + s.minStartGapSeconds * 1000 - now) : 0
    if (now - this.bootAt < s.boot.windowSeconds * 1000 && s.boot.startsPerInterval > 0) {
      const span = s.boot.intervalSeconds * 1000
      const recent = this.starts.filter((t) => t > now - span)
      if (recent.length >= s.boot.startsPerInterval) wait = Math.max(wait, recent[0] + span - now)
    }
    return wait
  }

  private classCount(cls: string): number {
    let n = 0
    for (const r of this.running.values()) if (r.cls === cls) n++
    return n
  }

  /** Starts every waiting run that may start now, in queue order. */
  async pump(): Promise<void> {
    if (this.pumping) { this.again = true; return }
    this.pumping = true
    try {
      do {
        this.again = false
        if (!this.waiting.length || this.closed) break
        let sample: ResourceSample
        try { sample = await this.sampler.read(this.now()) } catch { break }
        if (this.closed) break
        this.pass(this.settings(), sample)
      } while (this.again)
      // Drop pace entries nothing reads any more.
      const keep = Math.max(60_000, this.settings().boot.intervalSeconds * 1000)
      const cut = this.now() - keep
      while (this.starts.length > 1 && this.starts[0] < cut) this.starts.shift()
    } finally {
      this.pumping = false
    }
    this.arm()
  }

  private pass(s: AdmissionSettings, sample: ResourceSample): void {
    const now = this.now()
    const cap = effectiveMaxSessions(s, sample.memTotalMB)
    const reasons = gateReasons(sample, s)
    if (reasons.join() !== this.lastReasons.join()) {
      this.log(reasons.length ? `[admission] gate closed: ${reasons.join("; ")}` : `[admission] gate open`)
      this.lastReasons = reasons
    }
    let holdAll = false
    for (const e of this.ordered()) {
      const waitedMs = now - e.enqueuedAt
      if (s.maxWaitMinutes > 0 && waitedMs >= s.maxWaitMinutes * 60_000) {
        this.log(`[admission] ${e.agentId} refused after ${Math.round(waitedMs / 60_000)}m in the queue — ${e.blockedBy.join("; ") || "no room"}`)
        this.refuse(e, "timeout")
        continue
      }
      // Held only by its own limits (class, agent): the runs behind it move on.
      const own: string[] = []
      const clsCap = e.cls ? s.classes[e.cls]?.max : undefined
      if (clsCap !== undefined && this.classCount(e.cls!) >= clsCap) own.push(`class ${e.cls}: ${this.classCount(e.cls!)}/${clsCap} running`)
      if (e.req.canStart && !e.req.canStart()) own.push("agent busy")
      // Held by the node. Resources and pace hold the runs behind it too,
      // so order is kept; the session cap does not, since a run behind it
      // with more headroom (owner, delegated helper) may still fit.
      const node: string[] = []
      if (holdAll) node.push("behind earlier work")
      const extra = e.priority === "owner" ? s.ownerExtraSessions : 0
      const sessionCap = cap + Math.max(extra, e.delegated ? s.delegationHeadroom : 0)
      if (this.running.size >= sessionCap) node.push(`session cap: ${this.running.size}/${sessionCap} running`)
      const holds: string[] = []
      if (reasons.length && !(s.allowOneWhenIdle && this.running.size === 0)) holds.push(...reasons)
      const pace = this.paceWait(e.priority, s, now)
      if (pace > 0) holds.push(`start pace: next start in ${Math.ceil(pace / 1000)}s`)
      node.push(...holds)

      if (s.mode === "observe") {
        // Observe never holds for the node; a busy agent still waits, since
        // two runs on one slot would be a real double start.
        if (node.some((n) => n !== "behind earlier work")) this.log(`[admission] observe: would hold ${e.agentId} (${e.priority}) — ${node.join("; ")}`)
        if (own.includes("agent busy")) { e.blockedBy = own; continue }
        this.admitEntry(e, waitedMs)
        continue
      }
      if (own.length || node.length) {
        e.blockedBy = [...node, ...own]
        if (holds.length) holdAll = true
        continue
      }
      this.admitEntry(e, waitedMs)
    }
  }

  private admitEntry(e: Entry, waitedMs: number): void {
    this.drop(e)
    // Same step as the check: the agent's slot is taken before anything
    // else can look at it.
    try { e.req.onStart?.() } catch { /* the caller's bookkeeping must not stop the start */ }
    const ticket = this.start(e, waitedMs)
    if (waitedMs >= 1000) this.log(`[admission] started ${e.agentId} (${e.priority}) after ${Math.round(waitedMs / 1000)}s in the queue`)
    e.resolve({ ok: true, ticket })
  }

  /** Re-checks while work waits: resources change without any release. */
  private arm(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.waiting.length || this.closed) return
    const s = this.settings()
    const now = this.now()
    let ms = Math.max(1, s.sampleSeconds) * 1000
    for (const e of this.waiting) {
      const pace = this.paceWait(e.priority, s, now)
      if (pace > 0) ms = Math.min(ms, pace + 50)
    }
    this.timer = setTimeout(() => { this.timer = null; void this.pump() }, ms)
    this.timer.unref?.()
  }

  /** What GET /api/queue and `agentx queue` show. */
  snapshot(): AdmissionSnapshot {
    const s = this.settings()
    const now = this.now()
    const r = this.sampler.latest()
    const cap = r ? effectiveMaxSessions(s, r.memTotalMB) : s.maxSessions || null
    const waiting = this.ordered().map((e, i) => ({
      position: i + 1, id: e.id, agentId: e.agentId, channel: e.channel, chatId: e.chatId ?? null,
      priority: e.priority, class: e.cls, label: e.label,
      waitingSeconds: Math.round((now - e.enqueuedAt) / 1000), blockedBy: e.blockedBy,
    }))
    const classes: AdmissionSnapshot["caps"]["classes"] = {}
    for (const [name, c] of Object.entries(s.classes)) classes[name] = { max: c.max, running: this.classCount(name) }
    const warmUntil = this.bootAt + s.boot.windowSeconds * 1000
    const reasons = r ? gateReasons(r, s) : []
    return {
      enabled: s.enabled,
      mode: s.mode,
      checkedAt: r ? new Date(r.at).toISOString() : null,
      resources: r,
      limits: r ? limitsFor(s, r) : null,
      gate: { open: reasons.length === 0, reasons },
      caps: { maxSessions: cap, ownerExtraSessions: s.ownerExtraSessions, delegationHeadroom: s.delegationHeadroom, classes },
      warmUp: { active: now < warmUntil, until: new Date(warmUntil).toISOString(), startsPerInterval: s.boot.startsPerInterval, intervalSeconds: s.boot.intervalSeconds },
      running: [...this.running.values()].map((x) => ({
        id: x.id, agentId: x.agentId, channel: x.channel, chatId: x.chatId ?? null, priority: x.priority, class: x.cls,
        label: x.label, startedAt: new Date(x.startedAt).toISOString(), waitedSeconds: Math.round(x.waitedMs / 1000),
      })),
      waiting,
      next: waiting[0] ?? null,
    }
  }

  /** Reads resources now (the snapshot shows the last reading). */
  async refresh(): Promise<void> {
    await this.sampler.read(this.now())
  }
}

export interface AdmissionSnapshot {
  enabled: boolean
  mode: AdmissionSettings["mode"]
  /** When the resources shown were read. */
  checkedAt: string | null
  resources: ResourceSample | null
  limits: ResourceLimits | null
  gate: { open: boolean; reasons: string[] }
  caps: { maxSessions: number | null; ownerExtraSessions: number; delegationHeadroom: number; classes: Record<string, { max: number; running: number }> }
  warmUp: { active: boolean; until: string; startsPerInterval: number; intervalSeconds: number }
  running: Array<{ id: string; agentId: string; channel: string; chatId: string | null; priority: AdmissionPriority; class: string | null; label: string; startedAt: string; waitedSeconds: number }>
  waiting: Array<{ position: number; id: string; agentId: string; channel: string; chatId: string | null; priority: AdmissionPriority; class: string | null; label: string; waitingSeconds: number; blockedBy: string[] }>
  next: AdmissionSnapshot["waiting"][number] | null
}
