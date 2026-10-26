import type { GoalSummary } from "@/requests/goals"

// --- Goals on the Wall (#1392) ---
//
// The Wall filters its posts by the goal their request serves (#1168). Over
// the filtered posts it shows the goal's progress and cost, read from the
// same per-goal summary the Approvals page shows (RequestStore.goals(), read
// counts-only through goalCounts()), so both pages agree. The summary covers
// every request kept for the goal, not only the posts of the Wall's last days.
//
// The list reply carries one bounded row per goal, without its request list:
// the posts are already the requests. Across the mesh, rows with the same id
// add up, and the title is the one of the most recently active node.

export interface WallGoal {
  id: string
  title: string
  open: number
  done: number
  dropped: number
  /** done / (open + done), 0 to 1. Null when it has neither. */
  progress: number | null
  costUsd: number
  runs: number
  /** Runs that reported no cost. */
  unpriced: number
  lastAt: number
}

/** A goal summary without its request list, for the Wall's reply. */
export function wallGoalOf(g: Omit<GoalSummary, "requests">): WallGoal {
  return { id: g.id, title: g.title, open: g.open, done: g.done, dropped: g.dropped, progress: g.progress, costUsd: g.costUsd, runs: g.runs, unpriced: g.unpriced, lastAt: g.lastAt }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)

/** Every node's goal rows as one list, most recently active first. Rows
 *  with the same id add up; a malformed row (an older or odd peer) is
 *  skipped. */
export function mergeGoals(lists: unknown[][]): WallGoal[] {
  const byId = new Map<string, WallGoal>()
  for (const list of lists) {
    for (const raw of list) {
      const g = raw as Partial<WallGoal> | null
      if (!g || typeof g.id !== "string" || !g.id || typeof g.title !== "string") continue
      const lastAt = num(g.lastAt)
      const m = byId.get(g.id)
      if (!m) {
        byId.set(g.id, { id: g.id, title: g.title, open: num(g.open), done: num(g.done), dropped: num(g.dropped), progress: null, costUsd: num(g.costUsd), runs: num(g.runs), unpriced: num(g.unpriced), lastAt })
        continue
      }
      if (lastAt > m.lastAt) { m.title = g.title; m.lastAt = lastAt }
      m.open += num(g.open)
      m.done += num(g.done)
      m.dropped += num(g.dropped)
      m.costUsd += num(g.costUsd)
      m.runs += num(g.runs)
      m.unpriced += num(g.unpriced)
    }
  }
  const out = [...byId.values()].sort((a, b) => b.lastAt - a.lastAt)
  for (const g of out) {
    g.progress = g.open + g.done ? g.done / (g.open + g.done) : null
    g.costUsd = Math.round(g.costUsd * 10_000) / 10_000
  }
  return out
}
