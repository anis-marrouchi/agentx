import type { BatteryReading } from "./battery"
import { readBattery } from "./battery"
import { everyMs, type SensorConfig, type SensorLevel, type SensorsConfig } from "./config"
import { checkHolds, emptyState, failed, HOLD_MS, pushed, started, step, type SensorAction, type Step } from "./levels"
import { loadSensorStates, saveSensorStates, type SensorStates } from "./state"
import type { OwnerPushResult } from "@/notify/owner-push"
import { readingText, sensorJobId, type SensorRunRow } from "./run-record"

// --- The sensor loop on the daemon (#863) ---
//
// Reads each sensor every `every`, feeds the reading to the level engine
// (levels.ts) and carries out what it returns: a wake on the target agent
// (priority critical, counted once its run starts), the model-free push,
// a Wall line, a log line. Everything that changes a sensor's state runs
// one at a time, so a wake's start, its failure, the 2 min hold check and
// a reading never interleave.

/** How long one push may take before it counts as failed (the script's 60 s). */
export const PUSH_LIMIT_MS = 60_000
const TICK_MS = 5_000

export interface WakeRequest {
  sensor: string
  level: string
  target: string
  text: string
  /** Aborted when the wake is dropped (held, or AC came back). */
  signal: AbortSignal
  onStart: () => void
}

export interface SensorRunnerDeps {
  sensors: () => SensorsConfig
  read?: (cfg: SensorConfig) => Promise<BatteryReading>
  /** Run the wake on the target agent; resolves when the run ends. */
  wake: (w: WakeRequest) => Promise<{ error?: string }>
  /** The model-free push to the owner (`agentx notify --urgent`). */
  push: (sensor: string, level: SensorLevel, text: string) => Promise<OwnerPushResult>
  /** One line on the Wall. */
  wall: (sensor: string, text: string) => void
  /** Each wake as a run-history row, once it ends (run-record.ts). */
  record?: (row: SensorRunRow) => void
  log: (msg: string) => void
  stateFile: string
  now?: () => number
}

export class SensorRunner {
  private states: SensorStates
  private chain: Promise<void> = Promise.resolve()
  private lastRead = new Map<string, number>()
  private queued = new Set<string>()
  private runs = new Map<string, { seq: number; ctl: AbortController }>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private tickTimer?: ReturnType<typeof setInterval>
  private readonly now: () => number

  constructor(private deps: SensorRunnerDeps) {
    this.now = deps.now ?? Date.now
    this.states = loadSensorStates(deps.stateFile, deps.log)
  }

  start(): void {
    if (this.tickTimer) return
    this.tickTimer = setInterval(() => this.tick(), TICK_MS)
    this.tickTimer.unref?.()
    this.tick()
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = undefined
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  /** A copy of one sensor's state (tests, status). */
  state(id: string) {
    return structuredClone(this.states[id] ?? emptyState())
  }

  /** Read each sensor that is due. */
  tick(): void {
    const now = this.now()
    for (const [id, cfg] of Object.entries(this.deps.sensors())) {
      const every = everyMs(cfg.every) ?? 60_000
      if (this.queued.has(id) || now - (this.lastRead.get(id) ?? -Infinity) < every) continue
      this.lastRead.set(id, now)
      void this.readOnce(id)
    }
  }

  /** Take one reading of a sensor now. Resolves when its actions are done. */
  readOnce(id: string): Promise<void> {
    this.queued.add(id)
    return this.serial(async () => {
      try {
        const cfg = this.deps.sensors()[id]
        if (!cfg) return
        const reading = await (this.deps.read ?? (() => readBattery()))(cfg)
        await this.apply(id, cfg, step(cfg, this.stateOf(id), reading, this.now(), id))
      } finally {
        this.queued.delete(id)
      }
    })
  }

  /** The 2 min check of held wakes, between readings. */
  checkHolds(id: string): Promise<void> {
    return this.serial(async () => {
      const cfg = this.deps.sensors()[id]
      if (cfg) await this.apply(id, cfg, checkHolds(cfg, this.stateOf(id), this.now(), id))
    })
  }

  /** Waits for everything queued so far (tests). */
  idle(): Promise<void> {
    return this.chain
  }

  private stateOf(id: string) {
    return this.states[id] ?? emptyState()
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn).catch((e: any) => this.deps.log(`[sensors] ${e?.message ?? e}`))
    return this.chain
  }

  private async apply(id: string, cfg: SensorConfig, result: Step): Promise<void> {
    this.states[id] = result.state
    try {
      saveSensorStates(this.deps.stateFile, this.states)
    } catch (e: any) {
      this.deps.log(`[sensors] ${id}: state not saved: ${e?.message ?? e}`)
    }
    for (const a of result.actions) await this.act(id, cfg, a)
  }

  private async act(id: string, cfg: SensorConfig, a: SensorAction): Promise<void> {
    const key = `${id}\0${a.kind === "wall" || a.kind === "log" ? "" : a.level}`
    switch (a.kind) {
      case "log":
        this.deps.log(`[sensors] ${id}: ${a.text}`)
        return
      case "wall":
        this.deps.log(`[sensors] ${id}: ${a.text}`)
        this.deps.wall(id, a.text)
        return
      case "abort": {
        const run = this.runs.get(key)
        if (run && run.seq === a.seq) {
          run.ctl.abort()
          this.runs.delete(key)
          this.deps.log(`[sensors] ${id}: ${a.level} wake dropped`)
        }
        return
      }
      case "wake":
        this.startWake(id, a)
        return
      case "push": {
        const level = cfg.levels.find((l) => l.id === a.level)
        if (!level) return
        const result = await withLimit(this.deps.push(id, level, a.text), PUSH_LIMIT_MS)
        await this.apply(id, cfg, pushed(this.stateOf(id), a.level, a.fallback, result))
      }
    }
  }

  private startWake(id: string, a: Extract<SensorAction, { kind: "wake" }>): void {
    const key = `${id}\0${a.level}`
    const ctl = new AbortController()
    this.runs.set(key, { seq: a.seq, ctl })
    this.deps.log(`[sensors] ${id}: ${a.level} wake to ${a.target} (critical): ${a.text}`)
    const timer = setTimeout(() => { this.timers.delete(timer); void this.checkHolds(id) }, HOLD_MS + 1_000)
    timer.unref?.()
    this.timers.add(timer)
    const withCfg = (fn: (cfg: SensorConfig) => Step) => this.serial(async () => {
      const cfg = this.deps.sensors()[id]
      if (cfg) await this.apply(id, cfg, fn(cfg))
    })
    const reading = readingText(this.stateOf(id).last)
    let startedAt: number | null = null
    const onStart = () => {
      startedAt = this.now()
      void withCfg((cfg) => started(cfg, this.stateOf(id), a.level, this.now()))
    }
    this.deps.wake({ sensor: id, level: a.level, target: a.target, text: a.text, signal: ctl.signal, onStart })
      .catch((e: any) => ({ error: String(e?.message ?? e) }))
      .then((res) => {
        const error = ctl.signal.aborted ? "dropped: held past its time, or the stretch ended" : res.error
        this.recordRun(id, a, reading, startedAt, error)
        // A dropped wake's end is not news: the engine already let it go.
        if (ctl.signal.aborted) return
        if (this.runs.get(key)?.seq === a.seq) this.runs.delete(key)
        if (res.error) void withCfg((cfg) => failed(cfg, this.stateOf(id), a.level, a.seq, res.error!, id, this.now()))
      })
  }

  /** The wake as a run row (kind "sensor"). A run that never started is
   *  stamped when it was given up, with its error. Never throws. */
  private recordRun(id: string, a: Extract<SensorAction, { kind: "wake" }>, reading: string, startedAt: number | null, error: string | undefined): void {
    if (!this.deps.record) return
    const end = this.now()
    const start = startedAt ?? end
    try {
      this.deps.record({
        jobId: sensorJobId(id), kind: "sensor", sensor: id, level: a.level, target: a.target, reading,
        startedAt: new Date(start).toISOString(), completedAt: new Date(end).toISOString(), duration: Math.max(0, end - start),
        success: !error && startedAt !== null, response: a.text, ...(error ? { error } : startedAt === null ? { error: "the run never started" } : {}),
      })
    } catch (e: any) {
      this.deps.log(`[sensors] ${id}: run row not written: ${e?.message ?? e}`)
    }
  }
}

async function withLimit(p: Promise<OwnerPushResult>, ms: number): Promise<OwnerPushResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<OwnerPushResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, why: `no answer in ${Math.round(ms / 1000)} s` }), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([p.catch((e: any) => ({ ok: false as const, why: String(e?.message ?? e) })), late])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
