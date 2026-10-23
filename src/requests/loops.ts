import { OPEN_STATES, OWED_TO_OWNER, type RequestRecord, type RequestStore } from "./store"
import { runCheck, type CheckContext, type CheckResult, type CloseWhen } from "./checkers"

// --- Open loops: who each one waits on, and when it is stalled (#1039) ---
//
// A loop is an open request: one the owner asked for, or one an agent
// promised (action promise). It is stalled when it is past its due time,
// or, without one, when nothing has happened for staleAfterHours. A loop
// that needs attention is stalled too: nothing is retrying it.
//
// Stalled loops are grouped by what they wait on:
//   owner   the owner's answer (waiting_owner), or the owner's decision
//           on one that needs attention
//   agent   an agent: the one that has it, a plan step's agent, or the
//           agent it is owed to
//   person  an outside person: a promise owed to a known person
// The requests panel, `agentx requests --stalled` and the sweep's notice
// all use this one grouping.

export const STALL_GROUPS = ["owner", "agent", "person"] as const
export type StallGroup = (typeof STALL_GROUPS)[number]

export interface StalledLoop {
  request: RequestRecord
  group: StallGroup
  /** Who it waits on: "owner", an agent id or a person id. */
  who: string
  /** Why it counts as stalled, in words. */
  why: string
}

export interface LoopLookups {
  isAgent: (id: string) => boolean
  /** The agent of the active step of the request's plan, if it has one. */
  activeStepAgent?: (requestId: string) => string | null
}

const HOUR = 3_600_000
const isOpen = (r: RequestRecord) => (OPEN_STATES as readonly string[]).includes(r.state)

/** The agent of each request's active plan step, from the plan store. */
export function activeStepAgentOf(plans: { get(id: string): { state: string } | null; steps(id: string): Array<{ state: string; agentId: string }> } | null | undefined) {
  return (requestId: string): string | null => {
    if (!plans || plans.get(requestId)?.state !== "active") return null
    return plans.steps(requestId).find((s) => s.state === "active")?.agentId ?? null
  }
}

/** What an open loop waits on. */
export function waitsOn(r: RequestRecord, look: LoopLookups): { group: StallGroup; who: string } {
  if (r.state === "waiting_owner") return { group: "owner", who: OWED_TO_OWNER }
  if (r.promise && r.owedTo && r.owedTo !== OWED_TO_OWNER && !look.isAgent(r.owedTo)) return { group: "person", who: r.owedTo }
  if (r.state === "needs_attention") return { group: "owner", who: OWED_TO_OWNER }
  const step = look.activeStepAgent?.(r.id)
  return { group: "agent", who: step ?? r.agentId }
}

/** Why an open loop is stalled, or null when it is not. */
export function stalledWhy(r: RequestRecord, staleAfterHours: number, now: number): string | null {
  if (!isOpen(r)) return null
  if (r.state === "needs_attention") return r.attentionReason ?? "needs attention"
  if (r.dueAt !== null) return now > r.dueAt ? `past its due time (${when(r.dueAt)})` : null
  return now - r.updatedAt > staleAfterHours * HOUR ? `no activity for ${staleAfterHours} h or more` : null
}

/** Stalled loops among `items`, oldest first, grouped. */
export function stalledLoops(items: RequestRecord[], staleAfterHours: number, now: number, look: LoopLookups): Record<StallGroup, StalledLoop[]> {
  const out: Record<StallGroup, StalledLoop[]> = { owner: [], agent: [], person: [] }
  for (const r of items) {
    const why = stalledWhy(r, staleAfterHours, now)
    if (!why) continue
    const { group, who } = waitsOn(r, look)
    out[group].push({ request: r, group, who, why })
  }
  return out
}

/** The group, in words, for people. */
export function waitsOnWords(group: StallGroup, who: string): string {
  return group === "owner" ? "you" : group === "agent" ? `agent ${who}` : `${who} (outside person)`
}

export const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC"

/** A due time an agent or the owner gave: epoch ms, or an ISO date.
 *  Undefined when absent, a string when it is not a time. */
export function parseDue(v: unknown): number | undefined | string {
  if (v === undefined || v === null || v === "") return undefined
  const at = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v.trim()) : NaN
  if (!Number.isFinite(at) || at <= 0) return "due must be an ISO date (2030-01-31T17:00:00Z) or epoch milliseconds"
  return at
}

// ── Running the checkers from the requests check ─────────────────────────

/** Runs a loop's checker. The daemon's own; tests give their own. */
export type LoopChecker = (spec: CloseWhen, request: RequestRecord) => Promise<CheckResult>

export function loopChecker(ctx: () => CheckContext): LoopChecker {
  return (spec) => runCheck(spec, ctx())
}

/** How many checkers run at once, and how many loops one check takes on. */
const CHECK_BATCH = 10

/** Run the checker of every open loop whose last check is older than
 *  `everyMinutes`. Met closes it as done with the checker's evidence;
 *  unverifiable marks it unverified; not met leaves it as it is. */
export async function checkLoops(
  store: RequestStore,
  check: LoopChecker,
  opts: { everyMinutes: number; now: number; log: (msg: string) => void },
): Promise<{ checked: number; closed: number }> {
  const due = store.dueForCheck(opts.now - opts.everyMinutes * 60_000, CHECK_BATCH)
  let closed = 0
  await Promise.all(due.map(async (r) => {
    // Marked before the call: a check that hangs is not started again
    // at the next minute.
    store.markChecked(r.id, r.verifyState, r.verifyDetail ?? "", opts.now)
    const res = await check(r.closeWhen!, r).catch((e: any): CheckResult => ({ verdict: "unverifiable", detail: String(e?.message ?? e) }))
    if (res.verdict === "met") {
      if (store.closeVerified(r.id, res.detail, opts.now)) {
        closed++
        opts.log(`[requests] ${r.id} closed by its check: ${res.detail}`)
      }
      return
    }
    // A refused done stays "failed" until the check says otherwise.
    store.markChecked(r.id, res.verdict === "unverifiable" ? "unverified" : r.verifyState === "failed" ? "failed" : null, res.detail, opts.now)
  }))
  return { checked: due.length, closed }
}
