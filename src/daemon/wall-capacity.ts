import { OPEN_STATES } from "@/requests/store"
import type { WallBlocker } from "./wall-blocks"

// --- The Wall's capacity per owner (#1191) ---
//
// For each agent: its work in progress now, the items waiting on it, and
// an over-capacity flag. Read from the Wall's own posts (open requests
// and their active plan step), so the fleet view counts every node's
// posts the same way. Nothing is written or sent.
//
//   in progress  open posts in progress that this agent works on now: the
//                agent of the active plan step, else the post's owner.
//   waiting      open posts held by someone else whose recorded blocker
//                (#1193: an open hand-off, another agent's active step)
//                is this agent.
//   over         in progress + waiting is above the threshold
//                (`dashboard.wall.capacity.threshold`). Unset: never.
//
// Every owner with open work gets a row, even with zeros; so does every
// agent something waits on. Rows go by load, then name.

export interface CapacityPost {
  state: string
  owner: string
  /** The agent of the post's active plan step. Missing on older nodes. */
  stepAgent?: string | null
  blockedBy?: WallBlocker | null
}

export interface WallCapacityRow {
  owner: string
  inProgress: number
  waiting: number
  over: boolean
}

export interface WallCapacity {
  /** Null: the flag is off. */
  threshold: number | null
  owners: WallCapacityRow[]
}

const isOpen = (state: string) => (OPEN_STATES as readonly string[]).includes(state)

/** Over capacity: a threshold is set and the load is above it (at it is not). */
export function overCapacity(load: number, threshold: number | null | undefined): boolean {
  return typeof threshold === "number" && threshold >= 0 && load > threshold
}

export function wallCapacity(posts: CapacityPost[], threshold?: number | null): WallCapacity {
  const rows = new Map<string, WallCapacityRow>()
  const row = (owner: string) => {
    let r = rows.get(owner)
    if (!r) rows.set(owner, r = { owner, inProgress: 0, waiting: 0, over: false })
    return r
  }
  for (const p of posts) {
    if (!isOpen(p.state)) continue
    row(p.owner)
    const worker = p.state === "in_progress" ? (p.stepAgent || p.owner) : null
    if (worker) row(worker).inProgress++
    const b = p.blockedBy
    if (b?.kind === "agent" && b.who !== p.owner && b.who !== worker) row(b.who).waiting++
  }
  const t = typeof threshold === "number" ? threshold : null
  for (const r of rows.values()) r.over = overCapacity(r.inProgress + r.waiting, t)
  return {
    threshold: t,
    owners: [...rows.values()].sort((a, b) => (b.inProgress + b.waiting) - (a.inProgress + a.waiting) || a.owner.localeCompare(b.owner)),
  }
}
