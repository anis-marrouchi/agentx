import { OPEN_STATES, OWED_TO_OWNER, type RequestRecord, type RequestStore } from "./store"
import { runCheck, type CheckContext, type CheckResult, type CloseWhen } from "./checkers"
import { closeByCheck, PROOF_OFF, type CloseProofCtx } from "./close-proof"
import { wokenAgent } from "./owner-check"

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
  // Reopened by the owner-words check with its agent woken (noqta#876):
  // the next step is that agent's, not the owner's.
  const woken = wokenAgent(r)
  if (woken) return { group: "agent", who: woken }
  if (r.state === "needs_attention") return { group: "owner", who: OWED_TO_OWNER }
  const step = look.activeStepAgent?.(r.id)
  return { group: "agent", who: step ?? r.agentId }
}

/** Why an open loop is stalled, or null when it is not. */
export function stalledWhy(r: RequestRecord, staleAfterHours: number, now: number): string | null {
  if (!isOpen(r)) return null
  if (r.state === "needs_attention") return r.attentionReason ?? "needs attention"
  if (r.state === "waiting_owner" && r.attentionReason) return r.attentionReason
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

/** The first ISO date or time in a text ("2026-11-23T12:00:00Z (card expiry)"). */
const ISO_IN_TEXT = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/

/** A due time an agent or the owner gave: epoch ms, or an ISO date.
 *  Undefined when absent, a string when it is not a time. A text with
 *  words around an ISO time gives that time (#2073). A text time in a
 *  year before `now`'s is not a time: Date.parse reads "23 Nov 12:00Z"
 *  as 2001, which would stall a job at once. */
export function parseDue(v: unknown, now: number = Date.now()): number | undefined | string {
  if (v === undefined || v === null || v === "") return undefined
  const notATime = "due must be an ISO date (2030-01-31T17:00:00Z) or epoch milliseconds"
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : notATime
  if (typeof v !== "string") return notATime
  const minYear = new Date(now).getUTCFullYear()
  const ok = (t: number) => Number.isFinite(t) && t > 0 && new Date(t).getUTCFullYear() >= minYear
  const whole = Date.parse(v.trim())
  if (ok(whole)) return whole
  const iso = v.match(ISO_IN_TEXT)
  const found = iso ? Date.parse(iso[0]) : NaN
  return ok(found) ? found : notATime
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
  opts: { everyMinutes: number; now: number; log: (msg: string) => void; proof?: CloseProofCtx },
): Promise<{ checked: number; closed: number }> {
  const proof = opts.proof ?? PROOF_OFF
  const due = store.dueForCheck(opts.now - opts.everyMinutes * 60_000, CHECK_BATCH)
  let closed = 0
  await Promise.all(due.map(async (r) => {
    // Marked before the call: a check that hangs is not started again
    // at the next minute.
    store.markChecked(r.id, r.verifyState, r.verifyDetail ?? "", opts.now)
    const res = await check(r.closeWhen!, r).catch((e: any): CheckResult => ({ verdict: "unverifiable", detail: String(e?.message ?? e) }))
    if (res.verdict === "met") {
      // Proof per deliverable and reopen once (close-proof.ts, #692).
      if ((await closeByCheck(store, r, res.detail, res.detail, opts.now, proof)).outcome === "closed") {
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
