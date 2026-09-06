// --- Ordering the backlog -------------------------------------------------
//
// This used to fit actions into a stated minute budget. That asked the
// reviewer to estimate durations it could not know, and asked the operator to
// know how many minutes they had. What actually decides order is how fast a
// delay costs something, and that is knowable: a client with a stated
// `respondWithin` accrues against it, and everything else is flat.
//
// A view over the backlog, never a deletion or automatic dismissal.

export interface DecayAction {
  needsHuman: boolean
  /** When the review that produced this action last changed, ms. */
  updatedAt?: number
  clientId?: string
}

/** clientId -> minutes before a wait starts costing. Absent = no clock. */
export type ClientClocks = Record<string, number | undefined>

export interface Decay {
  /** Higher is more urgent. Only meaningful relative to other actions. */
  score: number
  ageMs: number
  /** True when a client is actually waiting, so the cost grows with time. */
  rising: boolean
  /** True once the wait has passed the client's stated clock. */
  overdue: boolean
}

const DAY = 86_400_000

export function decayOf(action: DecayAction, clocks: ClientClocks, now = Date.now()): Decay {
  const ageMs = Math.max(0, now - (action.updatedAt || now))
  const clockMinutes = action.clientId ? clocks[action.clientId] : undefined
  if (!clockMinutes) {
    // Flat cost. Age still breaks ties, but this can never outrank someone
    // who is genuinely waiting on an answer.
    return { score: ageMs / DAY, ageMs, rising: false, overdue: false }
  }
  const ratio = ageMs / (clockMinutes * 60_000)
  return { score: 1000 + ratio, ageMs, rising: true, overdue: ratio >= 1 }
}

/** Indices of `actions`, most costly to leave first. Stable for equal scores
 *  so the list does not reshuffle under the reader between refreshes. */
export function rankByDecay(actions: DecayAction[], clocks: ClientClocks, now = Date.now()): number[] {
  return actions
    .map((a, i) => ({ i, s: decayOf(a, clocks, now).score }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .map(x => x.i)
}
