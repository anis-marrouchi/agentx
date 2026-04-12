import type { BusinessConfig, BusinessSchedule } from "./config"
import type { Organization } from "./organization"

// --- Schedule: pure functions over org chart work hours ---

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

/** Get {hour, minute, dayOfWeek (0-6, sun=0)} in the business timezone for `when`. */
function tzParts(when: Date, timezone: string): { hour: number; minute: number; dow: number } {
  // Intl.DateTimeFormat with timeZone gives us the wall-clock time in that zone.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  const parts = fmt.formatToParts(when)
  const weekday = (parts.find((p) => p.type === "weekday")?.value || "sun").toLowerCase().slice(0, 3)
  const hourStr = parts.find((p) => p.type === "hour")?.value || "00"
  const minStr = parts.find((p) => p.type === "minute")?.value || "00"
  // "24" can appear in en-US locale for midnight — normalize.
  const hour = parseInt(hourStr, 10) % 24
  return {
    hour,
    minute: parseInt(minStr, 10),
    dow: DAY_MAP[weekday] ?? 0,
  }
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map(Number)
  return h * 60 + m
}

function worksOnDay(schedule: BusinessSchedule, dow: number): boolean {
  return schedule.days.some((d) => DAY_MAP[d] === dow)
}

/** Is `schedule` active at `when`? (Respects business timezone and lunch break.) */
export function isScheduleActive(schedule: BusinessSchedule, when: Date, timezone: string): boolean {
  const { hour, minute, dow } = tzParts(when, timezone)
  if (!worksOnDay(schedule, dow)) return false
  const nowMin = hour * 60 + minute
  const startMin = parseHHMM(schedule.start)
  const endMin = parseHHMM(schedule.end)
  if (nowMin < startMin || nowMin >= endMin) return false
  if (schedule.lunch) {
    const lStart = parseHHMM(schedule.lunch.start)
    const lEnd = parseHHMM(schedule.lunch.end)
    if (nowMin >= lStart && nowMin < lEnd) return false
  }
  return true
}

export class Schedule {
  constructor(
    private org: Organization,
    private config: BusinessConfig,
  ) {}

  isOnClock(agentId: string, when: Date = new Date()): boolean {
    const emp = this.org.get(agentId)
    if (!emp) return false
    return isScheduleActive(emp.schedule, when, this.config.timezone)
  }

  /** Is `when` exactly (to the minute) the scheduled day-start for this agent? */
  isDayStart(agentId: string, when: Date = new Date()): boolean {
    const emp = this.org.get(agentId)
    if (!emp) return false
    const { hour, minute, dow } = tzParts(when, this.config.timezone)
    if (!worksOnDay(emp.schedule, dow)) return false
    const startMin = parseHHMM(emp.schedule.start)
    return hour * 60 + minute === startMin
  }

  /** Is `when` exactly the scheduled day-end for this agent? */
  isDayEnd(agentId: string, when: Date = new Date()): boolean {
    const emp = this.org.get(agentId)
    if (!emp) return false
    const { hour, minute, dow } = tzParts(when, this.config.timezone)
    if (!worksOnDay(emp.schedule, dow)) return false
    const endMin = parseHHMM(emp.schedule.end)
    return hour * 60 + minute === endMin
  }

  clockedInAgents(when: Date = new Date()): string[] {
    return this.org.all()
      .filter((e) => this.isOnClock(e.agentId, when))
      .map((e) => e.agentId)
  }
}
