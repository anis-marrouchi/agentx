import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs"
import { resolve } from "path"
import type { Organization } from "./organization"
import type { Schedule } from "./schedule"

// --- KPI: running utilization + daily summary ---

export interface DailyStats {
  date: string                     // YYYY-MM-DD
  perAgent: Record<string, {
    tasksCompleted: number
    timeLoggedSeconds: number
    onClockSeconds: number
    blockers: number
    utilization: number            // timeLogged / onClockSeconds (capped at 1)
  }>
}

export interface TaskCompletion {
  agentId: string
  durationSeconds: number
  success: boolean
  channel?: string
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export class KPI {
  private stats: DailyStats
  private dir: string
  private onClockTick: Map<string, number> = new Map()

  constructor(
    private org: Organization,
    private schedule: Schedule,
    private log: (...args: unknown[]) => void,
  ) {
    this.dir = resolve(process.cwd(), ".agentx/kpi")
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    this.stats = this.loadOrInit()
  }

  private loadOrInit(): DailyStats {
    const f = resolve(this.dir, `${today()}.json`)
    if (existsSync(f)) {
      try { return JSON.parse(readFileSync(f, "utf-8")) } catch { /* fall through */ }
    }
    const perAgent: DailyStats["perAgent"] = {}
    for (const emp of this.org.all()) {
      perAgent[emp.agentId] = {
        tasksCompleted: 0,
        timeLoggedSeconds: 0,
        onClockSeconds: 0,
        blockers: 0,
        utilization: 0,
      }
    }
    return { date: today(), perAgent }
  }

  /** Called by the day-cycle minute tick to accumulate on-clock time. */
  tick(): void {
    const now = Date.now()
    for (const emp of this.org.all()) {
      if (!this.schedule.isOnClock(emp.agentId)) {
        this.onClockTick.delete(emp.agentId)
        continue
      }
      const prev = this.onClockTick.get(emp.agentId)
      if (prev) {
        const delta = Math.min(now - prev, 120_000) / 1000  // cap at 2 min in case of lag
        const row = this.stats.perAgent[emp.agentId]
        if (row) row.onClockSeconds += delta
      }
      this.onClockTick.set(emp.agentId, now)
    }
    this.recomputeUtil()
    this.persist()
  }

  recordTaskCompletion(t: TaskCompletion): void {
    const row = this.stats.perAgent[t.agentId]
    if (!row) return
    row.tasksCompleted += 1
    row.timeLoggedSeconds += t.durationSeconds
    this.recomputeUtil()
    this.persist()
  }

  recordBlocker(agentId: string): void {
    const row = this.stats.perAgent[agentId]
    if (!row) return
    row.blockers += 1
    this.persist()
  }

  private recomputeUtil(): void {
    for (const row of Object.values(this.stats.perAgent)) {
      row.utilization = row.onClockSeconds > 0
        ? Math.min(1, row.timeLoggedSeconds / row.onClockSeconds)
        : 0
    }
  }

  private persist(): void {
    // Rotate if day changed
    if (this.stats.date !== today()) {
      this.flush()
      this.stats = this.loadOrInit()
    }
    try {
      writeFileSync(resolve(this.dir, `${this.stats.date}.json`), JSON.stringify(this.stats, null, 2))
    } catch (e: any) {
      this.log(`[business] KPI persist failed: ${e.message}`)
    }
  }

  flush(): void {
    this.persist()
  }

  snapshot(): DailyStats {
    return JSON.parse(JSON.stringify(this.stats))
  }

  /** Markdown summary for end-of-day main-channel post. */
  dailySummaryText(): string {
    const lines: string[] = [`📊 **Daily report — ${this.stats.date}**`, ""]
    let totalLogged = 0
    let totalOnClock = 0
    for (const [agentId, row] of Object.entries(this.stats.perAgent)) {
      totalLogged += row.timeLoggedSeconds
      totalOnClock += row.onClockSeconds
      const hrs = (row.timeLoggedSeconds / 3600).toFixed(1)
      const util = (row.utilization * 100).toFixed(0)
      lines.push(`• **${agentId}** — ${row.tasksCompleted} tasks, ${hrs}h logged, ${util}% utilization${row.blockers ? `, ${row.blockers} blocker(s)` : ""}`)
    }
    lines.push("")
    const overallUtil = totalOnClock > 0 ? ((totalLogged / totalOnClock) * 100).toFixed(0) : "0"
    lines.push(`**Team:** ${(totalLogged / 3600).toFixed(1)}h logged / ${(totalOnClock / 3600).toFixed(1)}h on-clock → ${overallUtil}% utilization`)
    return lines.join("\n")
  }
}
