export interface CapacityAction {
  when: "now" | "later"
  minutes: number
  effort: "low" | "medium" | "high"
  needsHuman: boolean
}
/** A view over the backlog, never a deletion or automatic dismissal. */
export function fitCapacity(actions: CapacityAction[], minutes: number, focus: string) {
  const levels: Record<string, number> = { low: 1, medium: 2, high: 3 }
  let remaining = Number.isFinite(minutes) ? Math.max(0, minutes) : 15
  const selected: number[] = [], deferred: number[] = []
  let urgentDeferred = 0
  actions.forEach((a, i) => {
    const urgent = a.when === "now" && a.needsHuman
    if (urgent && selected.length < 3 && a.minutes <= remaining && a.minutes > 0 && (levels[a.effort] || 2) <= (levels[focus] || 2)) {
      selected.push(i)
      remaining -= a.minutes
    } else {
      deferred.push(i)
      if (urgent) urgentDeferred++
    }
  })
  return { selected, deferred, urgentDeferred, usedMinutes: Math.max(0, minutes - remaining) }
}
