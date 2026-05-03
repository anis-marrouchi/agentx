import type { DaemonConfig, CronJobDef } from "@/daemon/config"
import type { AgentRegistry } from "@/agents/registry"
import type { HookRegistry } from "@/hooks"
import type { CronJobState, CronRunResult } from "./types"
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs"
import { resolve } from "path"
import { applyConfigMutation, setAtPath } from "@/daemon/config-mutator"
import { getLedgerMode } from "@/intent/mode"
import { getDefaultLedger } from "@/intent/instance"
import { recordCronDispatch } from "@/intent/sources/cron"

// --- Cron Scheduler: lightweight cron engine with timezone support ---
// No external dependencies — uses setTimeout-based scheduling.

/**
 * Append a soft output-length cap to a cron prompt when the job configured
 * `maxOutputTokens`. Claude Code CLI has no hard flag for output length,
 * but a clear instruction at the end of the prompt is reliably honored by
 * the model. Keeps a cheap knob available for operators without us needing
 * to invent our own token counter or hack a post-response truncate.
 */
function withOutputCap(prompt: string, maxOutputTokens?: number): string {
  if (!maxOutputTokens) return prompt
  const approxChars = maxOutputTokens * 4
  return `${prompt}\n\n[Response budget]\nKeep your response under ~${maxOutputTokens} tokens (~${approxChars} chars). Be concise — this is automated batch work, not a conversation.`
}

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

export function getNextCronDate(expression: string, after: Date, timezone: string): Date {
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

// Retry config (inspired by OpenClaw's exponential backoff)
const MAX_RETRIES = 5
const RETRY_DELAYS = [30_000, 60_000, 300_000, 900_000, 3_600_000] // 30s, 1m, 5m, 15m, 60m

/** Notification callback — injected by daemon to send alerts via channels */
export type CronNotifyCallback = (jobId: string, agent: string, error: string, consecutiveErrors: number) => Promise<void>

export class CronScheduler {
  private jobs: Map<string, CronJobState> = new Map()
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private registry: AgentRegistry
  private hooks?: HookRegistry
  private runsDir: string
  private lastRunFile: string
  private running = false
  private notifyCallback?: CronNotifyCallback
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
    this.lastRunFile = resolve(process.cwd(), ".agentx/cron/last-runs.json")

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
        maxOutputTokens: def.maxOutputTokens,
        onError: def.onError,
        consecutiveErrors: 0,
        totalRuns: 0,
        totalFailures: 0,
      })
    }
  }

  /**
   * Set a notification callback for failed crons.
   * Called when onError is "notify" or after multiple consecutive failures.
   */
  setNotifyCallback(cb: CronNotifyCallback): void {
    this.notifyCallback = cb
  }

  async start(): Promise<void> {
    this.running = true

    if (!existsSync(this.runsDir)) {
      mkdirSync(this.runsDir, { recursive: true })
    }

    // Detect missed runs before scheduling
    const missedRuns = this.detectMissedRuns()
    if (missedRuns.length > 0) {
      this.log(`Detected ${missedRuns.length} missed cron run(s) while daemon was down:`)
      for (const { jobId, missedAt } of missedRuns) {
        this.log(`  "${jobId}" should have run at ${missedAt.toISOString()}`)
      }
      // Execute missed runs (fire-and-forget, don't block startup)
      this.executeMissedRuns(missedRuns).catch((e) => {
        this.log(`Error executing missed runs: ${e.message}`)
      })
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

    // Persist last run times for missed run detection on next start
    this.saveLastRuns()
  }

  private scheduleNext(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job || !job.enabled || !this.running) return

    // Clear any existing timer
    const existing = this.timers.get(jobId)
    if (existing) clearTimeout(existing)

    try {
      const nextRun = getNextCronDate(job.schedule, new Date(), job.timezone)
      job.nextRun = nextRun
      job.retryPending = false
      const delay = nextRun.getTime() - Date.now()

      this.log(`Job "${jobId}" next run: ${nextRun.toISOString()} (in ${Math.round(delay / 1000)}s)`)

      const timer = setTimeout(() => this.executeJob(jobId), delay)
      this.timers.set(jobId, timer)
    } catch (e: any) {
      this.log(`Failed to schedule "${jobId}": ${e.message}`)
    }
  }

  private scheduleRetry(jobId: string, attempt: number): void {
    const job = this.jobs.get(jobId)
    if (!job || !job.enabled || !this.running) return
    if (attempt >= MAX_RETRIES) {
      this.log(`Job "${jobId}" exhausted all ${MAX_RETRIES} retries, scheduling next regular run`)
      this.scheduleNext(jobId)
      return
    }

    const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1]
    job.retryPending = true

    this.log(`Job "${jobId}" retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay / 1000)}s`)

    const timer = setTimeout(() => this.executeJob(jobId, attempt + 1), delay)
    this.timers.set(jobId, timer)
  }

  /**
   * Phase 1 commit 6.d — record one cron-fire decision in the ledger
   * when the source is enabled. Wrapped in try/catch so a ledger
   * failure can never break cron dispatch — legacy stays authoritative
   * until the 1c per-source promotion lands.
   */
  private recordCronDecisionInLedger(
    jobId: string,
    agentId: string,
    firedAt: Date,
    legacy: import("@/intent/divergence").LegacyOutcome,
  ): { eventId: string; decidedBy: string } | undefined {
    if (getLedgerMode("cron") === "off") return undefined
    try {
      const decision = recordCronDispatch(
        getDefaultLedger(),
        { jobId, agentId, firedAt },
        JSON.stringify({ jobId, agentId, firedAt: firedAt.toISOString() }),
        legacy,
      )
      if (decision.outcome === "dispatched") {
        return { eventId: decision.eventId, decidedBy: decision.decidedBy }
      }
      return undefined
    } catch (e: any) {
      this.log(`[ledger] cron "${jobId}" record failed: ${e?.message ?? e}`)
      return undefined
    }
  }

  private async executeJob(jobId: string, retryAttempt: number = 0): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job || !this.running) return

    const isRetry = retryAttempt > 0
    // firedAt is captured here (rather than below at the original
    // `startedAt` declaration) so the ledger event has a stable
    // sourceEventId regardless of whether we record at the hook-block
    // path or the dispatch path.
    const firedAt = new Date()

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
        this.recordCronDecisionInLedger(jobId, job.agent, firedAt, {
          agentId: null, outcome: "halted",
          reason: `pre-hook blocked: ${hookResult.message ?? ""}`.trim(),
        })
        this.scheduleNext(jobId)
        return
      }
    }

    this.log(`${isRetry ? `[retry ${retryAttempt}] ` : ""}Executing job "${jobId}" -> agent "${job.agent}"`)
    const startedAt = firedAt
    job.lastRun = startedAt
    job.totalRuns++

    // Phase 1 commit 6.d — record the dispatch decision before the
    // (potentially long-running) registry.execute call. The returned
    // intentRef threads through to registry.execute so it records a
    // resolution on completion.
    const intentRef = this.recordCronDecisionInLedger(jobId, job.agent, firedAt, {
      agentId: job.agent, outcome: "dispatched", reason: isRetry ? `retry ${retryAttempt}` : null,
    })

    try {
      const response = await this.registry.execute({
        message: withOutputCap(job.prompt, job.maxOutputTokens),
        agentId: job.agent,
        model: job.model,
        intentRef,
        // chatId per-job so different cron jobs for the same agent don't
        // collide in one "default" session. Without this, the marketing
        // daily-brief and the marketing weekly-report cron share history,
        // and one job's prompt context bleeds into the other.
        context: { channel: "cron", chatId: `cron:${jobId}` },
      })

      const result: CronRunResult = {
        jobId,
        startedAt,
        completedAt: new Date(),
        success: !response.error,
        response: response.content,
        error: response.error,
        duration: response.duration || Date.now() - startedAt.getTime(),
        isRetry,
        retryAttempt,
      }

      if (response.error) {
        job.consecutiveErrors++
        job.totalFailures++
        job.lastError = response.error
        this.log(`Job "${jobId}" failed (${job.consecutiveErrors} consecutive): ${response.error}`)

        // Notify on failure
        await this.notifyFailure(job, response.error)

        if (job.onError.includes("disable") && job.consecutiveErrors >= 3) {
          job.enabled = false
          this.log(`Job "${jobId}" disabled after ${job.consecutiveErrors} consecutive errors`)
          // Persist to agentx.json so a daemon restart doesn't resurrect the
          // broken cron (previously this was in-memory only — a repeatedly
          // failing cron would keep burning money across restarts).
          try {
            const res = await applyConfigMutation(
              (cfg) => setAtPath(cfg, `crons.${jobId}.enabled`, false),
              { reload: false },
            )
            if (!res.success) {
              this.log(`Failed to persist disable for "${jobId}": ${res.error}`)
            }
          } catch (e: any) {
            this.log(`Failed to persist disable for "${jobId}": ${e.message}`)
          }
          await this.notifyDisabled(job)
        }

        // Retry
        this.logRun(result)
        this.scheduleRetry(jobId, retryAttempt)
        return
      } else {
        // Success — reset error state
        if (job.consecutiveErrors > 0) {
          this.log(`Job "${jobId}" recovered after ${job.consecutiveErrors} failure(s)`)
        }
        job.consecutiveErrors = 0
        job.lastSuccess = new Date()
        job.lastError = undefined
        job.retryPending = false
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
      job.totalFailures++
      job.lastError = e.message
      this.log(`Job "${jobId}" threw: ${e.message}`)

      await this.notifyFailure(job, e.message)
      this.scheduleRetry(jobId, retryAttempt)
      return
    }

    // Persist last run time
    this.saveLastRuns()

    // Schedule next regular run
    this.scheduleNext(jobId)
  }

  // --- Missed run detection ---

  /**
   * Detect cron jobs that should have fired while the daemon was down.
   * Compares saved last-run times against the cron schedule.
   */
  private detectMissedRuns(): Array<{ jobId: string; missedAt: Date }> {
    const missed: Array<{ jobId: string; missedAt: Date }> = []

    const lastRuns = this.loadLastRuns()
    if (!lastRuns) return missed // First boot — no history

    for (const [jobId, job] of this.jobs) {
      if (!job.enabled) continue

      const lastRunStr = lastRuns[jobId]
      if (!lastRunStr) continue // Never ran before

      const lastRun = new Date(lastRunStr)
      try {
        // What SHOULD the next run have been after the last recorded run?
        const shouldHaveRun = getNextCronDate(job.schedule, lastRun, job.timezone)
        if (shouldHaveRun.getTime() < Date.now()) {
          missed.push({ jobId, missedAt: shouldHaveRun })
        }
      } catch {
        // Invalid schedule — skip
      }
    }

    return missed
  }

  /**
   * Execute missed runs (catch-up). Runs sequentially to avoid overwhelming agents.
   */
  private async executeMissedRuns(missed: Array<{ jobId: string; missedAt: Date }>): Promise<void> {
    for (const { jobId, missedAt } of missed) {
      const job = this.jobs.get(jobId)
      if (!job || !job.enabled) continue

      this.log(`Running missed job "${jobId}" (was due at ${missedAt.toISOString()})`)

      try {
        const response = await this.registry.execute({
          message: withOutputCap(
            `[MISSED RUN — was scheduled for ${missedAt.toISOString()}]\n\n${job.prompt}`,
            job.maxOutputTokens,
          ),
          agentId: job.agent,
          context: { channel: "cron", chatId: `cron:${jobId}` },
        })

        const result: CronRunResult = {
          jobId,
          startedAt: new Date(),
          completedAt: new Date(),
          success: !response.error,
          response: response.content,
          error: response.error,
          duration: response.duration || 0,
          isRetry: false,
        }

        this.logRun(result)

        if (response.error) {
          this.log(`Missed job "${jobId}" failed: ${response.error}`)
        } else {
          this.log(`Missed job "${jobId}" completed`)
          job.lastSuccess = new Date()
        }
        job.lastRun = new Date()
        job.totalRuns++
      } catch (e: any) {
        this.log(`Missed job "${jobId}" threw: ${e.message}`)
      }
    }

    this.saveLastRuns()
  }

  // --- Notification ---

  private async notifyFailure(job: CronJobState, error: string): Promise<void> {
    if (!job.onError.includes("notify") && job.consecutiveErrors < 2) return
    if (!this.notifyCallback) {
      this.log(`[ALERT] Cron "${job.id}" failed (${job.consecutiveErrors}x): ${error.slice(0, 200)}`)
      return
    }

    try {
      await this.notifyCallback(job.id, job.agent, error, job.consecutiveErrors)
    } catch {
      // Don't fail on notification errors
    }
  }

  private async notifyDisabled(job: CronJobState): Promise<void> {
    if (!this.notifyCallback) {
      this.log(`[ALERT] Cron "${job.id}" has been DISABLED after ${job.consecutiveErrors} consecutive failures`)
      return
    }

    try {
      await this.notifyCallback(
        job.id,
        job.agent,
        `AUTO-DISABLED after ${job.consecutiveErrors} consecutive failures. Last error: ${job.lastError || "unknown"}`,
        job.consecutiveErrors,
      )
    } catch {
      // Don't fail on notification errors
    }
  }

  // --- Persistence ---

  private saveLastRuns(): void {
    try {
      const data: Record<string, string> = {}
      for (const [id, job] of this.jobs) {
        if (job.lastRun) data[id] = job.lastRun.toISOString()
      }
      const dir = resolve(process.cwd(), ".agentx/cron")
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.lastRunFile, JSON.stringify(data, null, 2))
    } catch {
      // Best-effort
    }
  }

  private loadLastRuns(): Record<string, string> | null {
    try {
      if (!existsSync(this.lastRunFile)) return null
      return JSON.parse(readFileSync(this.lastRunFile, "utf-8"))
    } catch {
      return null
    }
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
   * List all jobs and their status (including failure info).
   */
  list(): CronJobState[] {
    return Array.from(this.jobs.values())
  }

  /**
   * Get a health summary of cron jobs.
   */
  health(): { healthy: number; failing: number; disabled: number; missed: number; jobs: Array<{ id: string; status: string; consecutiveErrors: number; lastError?: string }> } {
    const jobs = Array.from(this.jobs.values())
    const missed = this.detectMissedRuns()

    return {
      healthy: jobs.filter(j => j.enabled && j.consecutiveErrors === 0).length,
      failing: jobs.filter(j => j.enabled && j.consecutiveErrors > 0).length,
      disabled: jobs.filter(j => !j.enabled).length,
      missed: missed.length,
      jobs: jobs.map(j => ({
        id: j.id,
        status: !j.enabled ? "disabled" : j.retryPending ? "retrying" : j.consecutiveErrors > 0 ? "failing" : "healthy",
        consecutiveErrors: j.consecutiveErrors,
        lastError: j.lastError,
      })),
    }
  }
}
