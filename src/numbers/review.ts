import type { CardInput, DecisionCard } from "@/approvals/cards"
import type { NumberOrigin } from "@/approvals/origin"
import { describePeriod, describeTarget, formatValue, meets, statusOf, type NumberStatus, type NumberTarget, type Reading } from "./model"
import type { NumberAlert, NumberRecord, NumberStore } from "./store"

// --- Numbers that need a look, and the missed-twice card (#1826, N3) ---
//
// The review list holds every tracked number that is missed, missed twice
// or has no reading, worst first. The CLI (`agentx numbers review`), the
// daemon (GET /numbers?review=1) and the agentx_numbers tool all read it.
//
// A number that misses twice in a row raises one decision card, raised for
// its owner agent: the operator sees it on the Approvals page and the
// owner is told the answer. `numbers.reviewer` names an agent that checks
// the owner's follow-up. A run of misses raises one card: none again
// until a reading meets the target and the number then misses twice
// again. A failed read (no reading) does not end a run of misses.

/** The statuses on the review list, worst first. */
export const REVIEW_STATUSES = ["missed_twice", "missed", "no_reading"] as const satisfies readonly NumberStatus[]
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

export function needsReview(status: NumberStatus): status is ReviewStatus {
  return (REVIEW_STATUSES as readonly string[]).includes(status)
}

/** Readings read to find where a run of misses started. */
const STREAK_READINGS = 200

/** Start of the window of the first miss in the current run of misses,
 *  from readings newest first. Failed reads are skipped; a reading that
 *  meets the target ends the run. Null when the newest value meets it. */
export function missStreakStart(target: NumberTarget, readings: readonly Reading[]): number | null {
  let start: number | null = null
  for (const r of readings) {
    if (r.value === null) continue
    if (meets(r.value, target)) break
    start = r.periodStart
  }
  return start
}

export interface ReviewItem {
  number: NumberRecord
  status: ReviewStatus
  latest: Reading | null
  /** The newest missed-twice card of this number, if any. */
  card: NumberAlert | null
}

/** Tracked numbers that need a look, worst first, then by name. */
export function reviewList(store: NumberStore, now: number, opts: { tags?: string[] } = {}): ReviewItem[] {
  const out: ReviewItem[] = []
  for (const n of store.list({ tags: opts.tags })) {
    const recent = store.readings(n.id, 2)
    const status = statusOf(n, recent, now)
    if (!needsReview(status)) continue
    out.push({ number: n, status, latest: recent[0] ?? null, card: store.lastAlert(n.id) })
  }
  const rank = (s: ReviewStatus) => REVIEW_STATUSES.indexOf(s)
  return out.sort((a, b) => rank(a.status) - rank(b.status))
}

export interface CardRoute {
  /** The agent the card is raised for: it is told the answer. */
  raisedFor: string
  /** The agent that reviews the follow-up, when one is set. */
  reviewer: string | null
}

/** Who gets a number's missed-twice card: its owner agent; with no owner
 *  on this node, the reviewer. The reviewer is kept only when it is
 *  another agent on this node. */
export function cardRoute(n: Pick<NumberRecord, "ownerAgent">, reviewer: string | undefined, hasAgent: (id: string) => boolean): CardRoute | { error: string } {
  const owner = n.ownerAgent && hasAgent(n.ownerAgent) ? n.ownerAgent : null
  const rev = reviewer && hasAgent(reviewer) ? reviewer : null
  const raisedFor = owner ?? rev
  if (!raisedFor) {
    const why = n.ownerAgent ? `its owner ${n.ownerAgent} is not an agent on this node` : "it has no owner agent"
    return { error: `no card: ${why}, and numbers.reviewer ${reviewer ? `(${reviewer}) is not an agent on this node` : "is not set"}` }
  }
  return { raisedFor, reviewer: rev && rev !== raisedFor ? rev : null }
}

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** The decision card for a number that missed twice. */
export function missedTwiceCard(n: NumberRecord, readings: readonly Reading[], route: CardRoute): CardInput {
  const misses = readings.filter((r) => r.value !== null).slice(0, 2)
  const said = misses.map((r) => `${formatValue(r.value, n.unit)} for ${describePeriod({ start: r.periodStart, end: r.periodEnd })}`).join(" and ")
  const target = n.target ? describeTarget(n.target, n.unit) : "its target"
  const name = cut(n.name, 60)
  return {
    title: cut(`${n.name} missed its target twice`, 120),
    ask: cut(`${name} was ${said}, against ${target}. Should ${route.raisedFor} find out why and change the plan?`, 300),
    recommend: cut(`Yes: ${route.raisedFor} reads the readings, finds the cause and says what changes${route.reviewer ? `; ${route.reviewer} reviews it` : ""}.`, 300),
    if_silent: "keep",
    source: cut(`agentx numbers show ${n.id}`, 500),
    raised_by: route.raisedFor,
  }
}

export interface CardDeps {
  hasAgent: (id: string) => boolean
  /** Saves the card (createCard in the daemon). */
  raise: (input: CardInput, origin: NumberOrigin) => { ok: true; card: DecisionCard } | { ok: false; error: string }
  reviewer?: string
  log?: (msg: string) => void
}

export interface CardOutcome {
  numberId: string
  result: "raised" | "failed"
  cardId?: string
  raisedFor?: string
  error?: string
}

/** Raise one card for each number whose current run of misses has none.
 *  Every attempt is kept, so a run that could not raise its card (no
 *  owner, the card refused) is not tried again at every check. */
export function raiseMissedTwiceCards(store: NumberStore, deps: CardDeps, now: number): CardOutcome[] {
  const out: CardOutcome[] = []
  for (const n of store.list()) {
    if (!n.target) continue
    const readings = store.readings(n.id, STREAK_READINGS)
    if (statusOf(n, readings, now) !== "missed_twice") continue
    const streakStart = missStreakStart(n.target, readings)
    if (streakStart === null || store.alertOf(n.id, streakStart)) continue
    const route = cardRoute(n, deps.reviewer, deps.hasAgent)
    if ("error" in route) {
      store.recordAlert({ numberId: n.id, streakStart, raisedAt: now, cardId: null, raisedFor: null, reviewer: null, error: route.error })
      deps.log?.(`[numbers] ${n.id} missed twice; ${route.error}`)
      out.push({ numberId: n.id, result: "failed", error: route.error })
      continue
    }
    const origin: NumberOrigin = { kind: "number", numberId: n.id, streakStart, ...(route.reviewer ? { reviewer: route.reviewer } : {}) }
    const made = deps.raise(missedTwiceCard(n, readings, route), origin)
    if (!made.ok) {
      store.recordAlert({ numberId: n.id, streakStart, raisedAt: now, cardId: null, raisedFor: route.raisedFor, reviewer: route.reviewer, error: made.error })
      deps.log?.(`[numbers] ${n.id} missed twice; card refused: ${made.error}`)
      out.push({ numberId: n.id, result: "failed", raisedFor: route.raisedFor, error: made.error })
      continue
    }
    store.recordAlert({ numberId: n.id, streakStart, raisedAt: now, cardId: made.card.id, raisedFor: route.raisedFor, reviewer: route.reviewer, error: null })
    deps.log?.(`[numbers] ${n.id} missed twice; card ${made.card.id} raised for ${route.raisedFor}${route.reviewer ? `, reviewer ${route.reviewer}` : ""}`)
    out.push({ numberId: n.id, result: "raised", cardId: made.card.id, raisedFor: route.raisedFor })
  }
  return out
}
