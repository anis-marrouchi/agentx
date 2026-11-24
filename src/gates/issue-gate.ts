/**
 * G1 at the GitLab adapter (#2085 v3 P, v4 P′, v7 B1 + condition C1).
 *
 * Every issue the adapter creates passes here first: the workflow node
 * `action.createIssue`, the built-in action `channel.create_issue`, and any
 * other caller of `GitlabAdapter.createIssue`.
 *
 * - No milestone given: the gate fills the month's milestone and logs
 *   `fixed` (C1: a filled default is logged as fixed, not allow).
 * - `milestone: "current"`: looked up, logged `allow` when found.
 * - `milestone: "none"`: a deliberate no-milestone, logged `allow` with the
 *   reason "override", so the owner can see who used it.
 * - Estimate or checklist missing, or no month's milestone found: `shadow`
 *   logs `would-refuse` and creates; `enforce` refuses with the reason.
 */
import { recordGateEvent, type GateEvent } from "./events"
import {
  CURRENT_MILESTONE,
  ISSUE_COMPLETE_GATE,
  ISSUE_COMPLETE_RULE,
  NO_MILESTONE,
  lookupCurrentMilestone,
  missingParts,
  missingReason,
  type GateMode,
} from "./issue-complete"

export interface IssueGateInput {
  mode: GateMode
  project: string
  description: string
  /** The caller's milestone: undefined, "current", "none" or a numeric id. */
  milestone?: string
  agentId?: string
  host: string
  /** Token for the milestone lookup. Absent (peer forward): no lookup, the
   *  peer resolves "current" itself. */
  token?: string
  now?: Date
  fetchFn?: typeof fetch
  record?: (e: GateEvent) => void
}

export interface IssueGateVerdict {
  /** The milestone value to send: a numeric id for the API, or the raw
   *  string for a peer forward. Undefined: send none. */
  milestone?: string
  /** Set under enforce when the create must not happen. */
  refuse?: string
}

export async function checkIssueCreate(input: IssueGateInput): Promise<IssueGateVerdict> {
  const record = input.record ?? ((e: GateEvent) => recordGateEvent(e))
  const raw = input.milestone?.trim() || undefined
  const base = { gate: ISSUE_COMPLETE_GATE, ruleId: ISSUE_COMPLETE_RULE, agent: input.agentId, ref: input.project }

  if (input.mode === "off") {
    // No check, no row. An explicit "current" is still looked up, so a
    // caller that asks for it gets it.
    if (raw === CURRENT_MILESTONE && input.token) {
      const { milestone } = await lookupCurrentMilestone(input.host, input.project, input.token, input.now, input.fetchFn)
      return { milestone: milestone ? String(milestone.id) : undefined }
    }
    return { milestone: raw && raw !== NO_MILESTONE && raw !== CURRENT_MILESTONE ? raw : undefined }
  }

  const filled = raw === undefined
  const wanted = filled ? CURRENT_MILESTONE : raw
  let milestone: string | undefined
  let lookupError: string | undefined
  let fixedTitle: string | undefined

  if (wanted === NO_MILESTONE) {
    milestone = undefined
  } else if (wanted === CURRENT_MILESTONE) {
    if (!input.token) {
      milestone = CURRENT_MILESTONE // peer forward: the peer looks it up
    } else {
      const found = await lookupCurrentMilestone(input.host, input.project, input.token, input.now, input.fetchFn)
      if (found.milestone) {
        milestone = String(found.milestone.id)
        fixedTitle = found.milestone.title
      } else {
        lookupError = found.error
      }
    }
  } else {
    milestone = wanted
  }

  const hasMilestone = milestone !== undefined || wanted === NO_MILESTONE
  const missing = missingParts(input.description, hasMilestone)
  if (missing.length > 0) {
    const reason = lookupError && missing.includes("milestone")
      ? `${missingReason(missing)} (${lookupError})`
      : missingReason(missing)
    if (input.mode === "enforce") {
      record({ ...base, outcome: "refused", reason })
      return { refuse: `Issue not created: it is not complete (${reason}). Give a milestone, a "/estimate <n>" line and a "- [ ]" checklist in the description.` }
    }
    record({ ...base, outcome: "would-refuse", reason })
    return { milestone }
  }

  if (wanted === NO_MILESTONE) {
    record({ ...base, outcome: "allow", reason: "override: milestone none" })
  } else if (filled && milestone !== undefined) {
    record({ ...base, outcome: "fixed", reason: `milestone filled: ${fixedTitle ?? milestone}` })
  } else {
    record({ ...base, outcome: "allow" })
  }
  return { milestone }
}
