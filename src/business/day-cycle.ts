import type { AgentRegistry } from "@/agents/registry"
import type { DaemonConfig } from "@/daemon/config"
import type { BusinessConfig } from "./config"
import type { Organization } from "./organization"
import type { Schedule } from "./schedule"
import type { Reporter } from "./reporter"
import type { KPI } from "./kpi"
import type { WorkSource } from "./work-pool"
import { businessToolsDoc } from "./http"
import { DayPlanStore, parsePriorities, type ResolvedPlan } from "./day-plan"

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
  private standupsFiredToday = 0                 // counter for maxAgentsPerDay guard
  private noPlanNoticePostedFor?: string         // YYYY-MM-DD; ensures we post the "no plan today" line at most once per day
  private planStore: DayPlanStore

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
    this.planStore = new DayPlanStore(this.config.standup.plansDir)
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
      this.standupsFiredToday = 0
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
    const standup = this.config.standup
    // Master switch — operator wanted a way to silence the cycle without
    // turning off the whole business layer.
    if (!standup.enabled) {
      this.log(`[business] STANDUP skipped (standup.enabled=false) → ${agentId}`)
      return
    }
    // Hard ceiling — guards against an org-chart misconfig fanning out to
    // dozens of Claude calls in one morning before anyone notices.
    if (this.standupsFiredToday >= standup.maxAgentsPerDay) {
      this.log(`[business] STANDUP ceiling hit (${standup.maxAgentsPerDay}/day) — skipping ${agentId}`)
      return
    }

    // Resolve the plan: day → week → month. If nothing is set anywhere,
    // post a single "no plan today" notification to the main channel and
    // dispatch nothing — the explicit anti-mechanical-burn rule.
    const plan = this.planStore.resolve()
    if (!plan) {
      await this.postNoPlanNoticeOnce()
      this.log(`[business] STANDUP skipped (no plan for ${this.currentDate}) → ${agentId}`)
      return
    }

    // Dry-run mode: post the plan to the channel for human review but don't
    // dispatch any agent. Lets operators eyeball the resolved plan before
    // letting it drive Claude calls.
    if (standup.dryRun) {
      await this.postPlanPreviewOnce(plan)
      this.log(`[business] STANDUP dry-run (plan ${plan.tier}/${plan.date}) — no dispatch`)
      return
    }

    this.log(`[business] STANDUP → ${agentId} (plan ${plan.tier}/${plan.date})`)
    this.standupsFiredToday++
    const role = this.roleContext(agentId)
    const priorities = parsePriorities(plan.content)
    const prioritiesBlock = priorities.length
      ? `Today's priorities (from the ${plan.tier} plan, ${plan.date}):\n${priorities.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}`
      : `Today's plan (${plan.tier}, ${plan.date}):\n${plan.content.trim()}`

    const prompt =
`${role}

[STANDUP] It's the start of your work day.

${prioritiesBlock}

1. Call GET /business/work?agent=${agentId} to see your open work items, and reconcile them with the priorities above. The plan wins on tie-breaks.
2. Pick your top 3 for today, in priority order, citing which plan item each one serves.
3. Post your plan to the main channel via POST /business/post — keep it to 4-6 short lines.
4. Flag any blockers via POST /business/escalate.`
    const content = await this.runLifecycle(agentId, prompt)
    if (content) {
      const state = this.day.get(agentId) || {}
      state.hadWorkToday = true
      this.day.set(agentId, state)
    }
  }

  /** Post one "no plan today" line to mainChannel per calendar date. After
   *  the first STANDUP would have fired, we let the team know the cycle
   *  saw nothing to do — quiet enough not to be annoying, loud enough that
   *  a forgotten plan doesn't go unnoticed for a whole morning. */
  private async postNoPlanNoticeOnce(): Promise<void> {
    if (this.noPlanNoticePostedFor === this.currentDate) return
    this.noPlanNoticePostedFor = this.currentDate
    const text = `No plan for ${this.currentDate} — skipping standup. Set one with \`agentx plan set today …\` or via the admin → Plans tab.`
    try { await this.reporter.postToMain(text) }
    catch (e: any) { this.log(`[business] no-plan notice post failed: ${e?.message || e}`) }
  }

  /** Dry-run preview: post the resolved plan to the main channel so the
   *  operator can eyeball it before turning dryRun off. Once per day per
   *  resolved plan. */
  private async postPlanPreviewOnce(plan: ResolvedPlan): Promise<void> {
    if (this.noPlanNoticePostedFor === this.currentDate) return
    this.noPlanNoticePostedFor = this.currentDate
    const head = `[dry-run] Plan for ${this.currentDate} (resolved from ${plan.tier}/${plan.date}):`
    try { await this.reporter.postToMain(`${head}\n${plan.content.trim()}`) }
    catch (e: any) { this.log(`[business] plan-preview post failed: ${e?.message || e}`) }
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
