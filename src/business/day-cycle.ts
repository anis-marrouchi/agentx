import type { AgentRegistry } from "@/agents/registry"
import type { DaemonConfig } from "@/daemon/config"
import type { BusinessConfig } from "./config"
import type { Organization } from "./organization"
import type { Schedule } from "./schedule"
import type { Reporter } from "./reporter"
import type { KPI } from "./kpi"
import type { WorkSource } from "./work-pool"
import { businessToolsDoc } from "./http"

// --- Day cycle: minute ticker that fires standup / work-tick / wrap prompts ---

const TICK_MS = 60_000  // one minute

interface AgentDayState {
  standupFiredAt?: number          // Date.now when standup was triggered today
  wrapFiredAt?: number
  lastWorkTickAt?: number
  hadWorkToday?: boolean           // to avoid wrap if agent did nothing
}

export class DayCycle {
  private timer?: ReturnType<typeof setInterval>
  private day: Map<string, AgentDayState> = new Map()
  private currentDate: string = new Date().toISOString().slice(0, 10)
  private runningTask: Set<string> = new Set()   // agentIds with an in-flight day-cycle call

  constructor(
    private config: BusinessConfig,
    private org: Organization,
    private schedule: Schedule,
    private registry: AgentRegistry,
    private reporter: Reporter,
    private kpi: KPI,
    private workSource: WorkSource,
    private daemonBase: string,
    private log: (...args: unknown[]) => void,
  ) {
    for (const emp of org.all()) this.day.set(emp.agentId, {})
  }

  start(): void {
    this.log("[business] day cycle starting")
    // Tick immediately then every minute
    this.tick().catch((e) => this.log(`[business] tick error: ${e.message}`))
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log(`[business] tick error: ${e.message}`))
    }, TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.kpi.flush()
  }

  private async tick(): Promise<void> {
    const now = new Date()
    const iso = now.toISOString().slice(0, 10)

    // Day rollover: reset per-agent day state
    if (iso !== this.currentDate) {
      this.currentDate = iso
      for (const key of this.day.keys()) this.day.set(key, {})
    }

    // KPI on-clock accrual
    this.kpi.tick()

    for (const emp of this.org.all()) {
      const state = this.day.get(emp.agentId) || {}
      this.day.set(emp.agentId, state)

      // Never fire multiple day-cycle tasks in parallel for the same agent
      if (this.runningTask.has(emp.agentId)) continue

      // 1. Morning standup — exactly at day-start minute
      if (this.schedule.isDayStart(emp.agentId, now) && !state.standupFiredAt) {
        state.standupFiredAt = Date.now()
        this.fireStandup(emp.agentId).catch((e) => this.log(`[business] standup err: ${e.message}`))
        continue
      }

      // 2. End-of-day wrap — exactly at day-end minute
      if (this.schedule.isDayEnd(emp.agentId, now) && !state.wrapFiredAt) {
        state.wrapFiredAt = Date.now()
        this.fireWrap(emp.agentId).catch((e) => this.log(`[business] wrap err: ${e.message}`))
        continue
      }

      // 3. Work tick — during business hours at workTickMinutes cadence
      if (this.schedule.isOnClock(emp.agentId, now)) {
        const elapsed = state.lastWorkTickAt ? (Date.now() - state.lastWorkTickAt) / 60_000 : Infinity
        if (elapsed >= this.config.workTickMinutes) {
          state.lastWorkTickAt = Date.now()
          this.fireWorkTick(emp.agentId).catch((e) => this.log(`[business] work-tick err: ${e.message}`))
        }
      }
    }
  }

  private roleContext(agentId: string): string {
    const emp = this.org.get(agentId)
    if (!emp) return ""
    const manager = emp.reportsTo ? `reporting to ${emp.reportsTo}` : "(no manager — top of org chart)"
    const responsibilities = emp.role.responsibilities.length
      ? `\nResponsibilities:\n${emp.role.responsibilities.map((r) => `- ${r}`).join("\n")}`
      : ""
    const sop = emp.role.sopPath ? `\nSOP: @${emp.role.sopPath}` : ""
    return `You are ${agentId}, role: ${emp.role.title} ${manager}.${responsibilities}${sop}\n\n${businessToolsDoc(this.daemonBase)}`
  }

  private async runLifecycle(agentId: string, prompt: string): Promise<string | undefined> {
    if (this.runningTask.has(agentId)) return
    this.runningTask.add(agentId)
    const start = Date.now()
    try {
      const resp = await this.registry.execute({
        message: prompt,
        agentId,
        context: { channel: "business", chatId: `day-cycle:${this.currentDate}:${agentId}` },
      })
      const seconds = Math.round((resp.duration ?? (Date.now() - start)) / 1000)
      if (!resp.error) {
        this.kpi.recordTaskCompletion({ agentId, durationSeconds: seconds, success: true, channel: "business" })
      }
      return resp.content
    } finally {
      this.runningTask.delete(agentId)
    }
  }

  private async fireStandup(agentId: string): Promise<void> {
    this.log(`[business] STANDUP → ${agentId}`)
    const role = this.roleContext(agentId)
    const prompt =
`${role}

[STANDUP] It's the start of your work day.
1. Call GET /business/work?agent=${agentId} to see your open work items.
2. Pick your top 3 for today, in priority order.
3. Post your plan to the main channel via POST /business/post — keep it to 4-6 short lines.
4. Flag any blockers via POST /business/escalate.`
    const content = await this.runLifecycle(agentId, prompt)
    if (content) {
      const state = this.day.get(agentId) || {}
      state.hadWorkToday = true
      this.day.set(agentId, state)
    }
  }

  private async fireWorkTick(agentId: string): Promise<void> {
    const items = await this.workSource.listOpen(agentId).catch(() => [])
    if (!items.length) return   // nothing assigned → skip (don't fake work)

    this.log(`[business] WORK-TICK → ${agentId} (${items.length} open)`)
    const role = this.roleContext(agentId)
    const prompt =
`${role}

[WORK] Continue your highest-priority open task.
- Call GET /business/work?agent=${agentId} to see what's assigned to you.
- If you complete one, POST /business/report with status:done and the time you spent.
- If blocked, POST /business/escalate with a concise blocker description.
- Then move on to the next item. Keep working until you hit a real stopping point — don't idle.`
    const content = await this.runLifecycle(agentId, prompt)
    if (content) {
      const state = this.day.get(agentId) || {}
      state.hadWorkToday = true
      this.day.set(agentId, state)
    }
  }

  private async fireWrap(agentId: string): Promise<void> {
    const state = this.day.get(agentId) || {}
    if (!state.hadWorkToday) {
      this.log(`[business] WRAP skipped for ${agentId} (no work done today)`)
      return
    }
    this.log(`[business] WRAP → ${agentId}`)
    const role = this.roleContext(agentId)
    const prompt =
`${role}

[WRAP] End of work day. Post a concise daily report to the main channel via POST /business/post:
- Tasks closed today
- Time logged (total)
- Carry-overs to tomorrow
- Any outstanding blockers
Keep it under 8 lines.`
    await this.runLifecycle(agentId, prompt)
  }
}
