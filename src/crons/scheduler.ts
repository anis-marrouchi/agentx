import type { DaemonConfig, CronJobDef } from "@/daemon/config"
import type { AgentRegistry } from "@/agents/registry"
import type { HookRegistry } from "@/hooks"
import type { CronJobState, CronRunResult } from "./types"
import { writeFileSync, mkdirSync, existsSync } from "fs"
import { resolve } from "path"

// --- Cron Scheduler: lightweight cron engine with timezone support ---
// No external dependencies — uses setTimeout-based scheduling.

/**
 * Parse a cron expression into next-fire timestamp.
 * Supports standard 5-field format: minute hour day-of-month month day-of-week
 */
function parseCronField(field: string, min: number, max: number): number[] {
  const values: number[] = []

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.push(i)
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/")
      const step = parseInt(stepStr, 10)
      const start = range === "*" ? min : parseInt(range, 10)
      for (let i = start; i <= max; i += step) values.push(i)
    } else if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number)
      for (let i = a; i <= b; i++) values.push(i)
    } else {
      values.push(parseInt(part, 10))
    }
  }

  return [...new Set(values)].sort((a, b) => a - b)
}

function getNextCronDate(expression: string, after: Date, timezone: string): Date {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`Invalid cron: ${expression}`)

  const minutes = parseCronField(fields[0], 0, 59)
  const hours = parseCronField(fields[1], 0, 23)
  const daysOfMonth = parseCronField(fields[2], 1, 31)
  const months = parseCronField(fields[3], 1, 12)
  const daysOfWeek = parseCronField(fields[4], 0, 6)

  // Convert to timezone-aware date
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })

  // Start searching from next minute
  const candidate = new Date(after.getTime() + 60_000)
  candidate.setSeconds(0, 0)

  // Search up to 1 year ahead
  const limit = new Date(candidate.getTime() + 366 * 24 * 60 * 60 * 1000)

  while (candidate < limit) {
    const parts = fmt.formatToParts(candidate)
    const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value || "0", 10)

    const m = get("minute")
    const h = get("hour")
    const dom = get("day")
    const mon = get("month")
    const dow = candidate.getDay()

    if (
      minutes.includes(m) &&
      hours.includes(h) &&
      daysOfMonth.includes(dom) &&
      months.includes(mon) &&
      daysOfWeek.includes(dow)
    ) {
      return candidate
    }

    // Advance by 1 minute
    candidate.setTime(candidate.getTime() + 60_000)
  }

  throw new Error(`No next run found for cron "${expression}" within 1 year`)
}

export class CronScheduler {
  private jobs: Map<string, CronJobState> = new Map()
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private registry: AgentRegistry
  private hooks?: HookRegistry
  private runsDir: string
  private running = false
  private log: (...args: unknown[]) => void

  constructor(
    config: DaemonConfig,
    registry: AgentRegistry,
    hooks?: HookRegistry,
    log: (...args: unknown[]) => void = console.error.bind(console, "[cron]"),
  ) {
    this.registry = registry
    this.hooks = hooks
    this.log = log
    this.runsDir = resolve(process.cwd(), ".agentx/cron/runs")

    for (const [id, def] of Object.entries(config.crons)) {
      this.jobs.set(id, {
        id,
        enabled: def.enabled,
        schedule: def.schedule,
        timezone: def.timezone,
        agent: def.agent,
        prompt: def.prompt,
        timeout: def.timeout,
        model: def.model,
        onError: def.onError,
        consecutiveErrors: 0,
        totalRuns: 0,
      })
    }
  }

  async start(): Promise<void> {
    this.running = true

    if (!existsSync(this.runsDir)) {
      mkdirSync(this.runsDir, { recursive: true })
    }

    for (const [id, job] of this.jobs) {
      if (!job.enabled) {
        this.log(`Job "${id}" is disabled, skipping`)
        continue
      }
      this.scheduleNext(id)
    }

    this.log(`${this.jobs.size} cron job(s) loaded, ${Array.from(this.jobs.values()).filter((j) => j.enabled).length} enabled`)
  }

  async stop(): Promise<void> {
    this.running = false
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }

  private scheduleNext(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job || !job.enabled || !this.running) return

    try {
      const nextRun = getNextCronDate(job.schedule, new Date(), job.timezone)
      job.nextRun = nextRun
      const delay = nextRun.getTime() - Date.now()

      this.log(`Job "${jobId}" next run: ${nextRun.toISOString()} (in ${Math.round(delay / 1000)}s)`)

      const timer = setTimeout(() => this.executeJob(jobId), delay)
      this.timers.set(jobId, timer)
    } catch (e: any) {
      this.log(`Failed to schedule "${jobId}": ${e.message}`)
    }
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job || !this.running) return

    // Pre-hook
    if (this.hooks?.has("pre:cron-run" as any)) {
      const hookResult = await this.hooks.execute("pre:cron-run" as any, {
        event: "pre:cron-run" as any,
        jobId,
        agent: job.agent,
        prompt: job.prompt,
      })
      if (hookResult.blocked) {
        this.log(`Job "${jobId}" blocked by hook: ${hookResult.message}`)
        this.scheduleNext(jobId)
        return
      }
    }

    this.log(`Executing job "${jobId}" -> agent "${job.agent}"`)
    const startedAt = new Date()
    job.lastRun = startedAt
    job.totalRuns++

    try {
      const response = await this.registry.execute({
        message: job.prompt,
        agentId: job.agent,
        context: { channel: "cron" },
      })

      const result: CronRunResult = {
        jobId,
        startedAt,
        completedAt: new Date(),
        success: !response.error,
        response: response.content,
        error: response.error,
        duration: response.duration || Date.now() - startedAt.getTime(),
      }

      if (response.error) {
        job.consecutiveErrors++
        this.log(`Job "${jobId}" failed (${job.consecutiveErrors} consecutive): ${response.error}`)

        if (job.onError === "disable" && job.consecutiveErrors >= 3) {
          job.enabled = false
          this.log(`Job "${jobId}" disabled after ${job.consecutiveErrors} consecutive errors`)
        }
      } else {
        job.consecutiveErrors = 0
        this.log(`Job "${jobId}" completed in ${result.duration}ms`)
      }

      // Log run
      this.logRun(result)

      // Post-hook
      if (this.hooks?.has("post:cron-run" as any)) {
        await this.hooks.execute("post:cron-run" as any, {
          event: "post:cron-run" as any,
          jobId,
          success: result.success,
          duration: result.duration,
          error: result.error ? new Error(result.error) : undefined,
        })
      }
    } catch (e: any) {
      job.consecutiveErrors++
      this.log(`Job "${jobId}" threw: ${e.message}`)
    }

    // Schedule next run
    this.scheduleNext(jobId)
  }

  private logRun(result: CronRunResult): void {
    try {
      const runDir = resolve(this.runsDir, result.jobId)
      if (!existsSync(runDir)) {
        mkdirSync(runDir, { recursive: true })
      }

      const filename = `${result.startedAt.toISOString().replace(/[:.]/g, "-")}.json`
      writeFileSync(
        resolve(runDir, filename),
        JSON.stringify(result, null, 2),
      )
    } catch {
      // Don't fail on logging errors
    }
  }

  /**
   * List all jobs and their status.
   */
  list(): CronJobState[] {
    return Array.from(this.jobs.values())
  }
}
