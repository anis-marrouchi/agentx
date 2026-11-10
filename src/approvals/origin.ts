// --- Where a card came from, when the daemon raised it ---
//
// Agents raise most cards themselves. A check-in (checkin.ts) raises one on
// an agent's behalf for an open Apple Reminder, and records the reminder
// here so the agent that gets the answer knows what to act on and what to
// tick off. Only the daemon sets it: POST /approvals and the agent tool
// never pass it through.

export interface ReminderOrigin {
  kind: "reminder"
  /** The reminder's full id, as remindctl prints it. */
  id: string
  title: string
  list?: string
}

/** An open request that needs attention, shown as a card on the Mac
 *  (popup-runner.ts). Never stored: the request is the record. */
export interface RequestOrigin {
  kind: "request"
  id: string
}

/** A retro card (src/retro): fixes to the agents' environment proposed
 *  from one run that struggled. The answer goes back to the agent that ran
 *  it, which builds the picked fix for a second review. */
export interface RetroOrigin {
  kind: "retro"
  /** The run the retro read. */
  taskId: string
  /** Failure signature (wiki/failure-candidates.ts), for one card per signature. */
  signature: string
  /** The reviewer's spec for each fix, in the order of the card's choices
   *  (without "None of these"). Only the picked one reaches the agent. */
  specs?: string[]
}

/** A monthly review of a check a retro added (src/retro/checks.ts): a
 *  guard rule tagged `retro:<taskId>` that fires often on runs that went
 *  well. The answer goes back to the agent that built it, which keeps,
 *  loosens or removes it for a second review. */
export interface RetroCheckOrigin {
  kind: "retro-check"
  /** The guard rule's id. */
  ruleId: string
  /** The run whose retro asked for the rule. */
  taskId: string
  /** The policy file that holds the rule, relative to the daemon's folder. */
  file: string
}

/** A step of a workflow run asks the owner (src/workflows, #788): an
 *  owner.ask step, a person.message to approve, or a run's approval at
 *  start. The answer resumes the run; the agent that started it is not
 *  told separately, the run is. */
export interface WorkflowOrigin {
  kind: "workflow"
  runId: string
  nodeId: string
}

/** An agent proposed a reusable workflow (#788). Yes turns it on. */
export interface WorkflowProposalOrigin {
  kind: "workflow-proposal"
  workflowId: string
}

/** A step of a tracked plan the owner approves when the plan is made
 *  (src/requests/plan-sweep.ts, #788). The plan check reads the answer
 *  and acts on it; the agent is not sent a result turn. */
export interface PlanStepOrigin {
  kind: "plan-step"
  requestId: string
  step: number
}

/** A pull request that changes core paths waits for the owner (merge
 *  policy, #1047). YES approves that one commit; the policy reads the
 *  answer and updates the PR's status. No agent is sent a result turn. */
export interface MergePolicyOrigin {
  kind: "merge-policy"
  repo: string
  pr: number
  sha: string
}

/** The owner asked an agent in chat to change the org chart (#1678). The
 *  changes are kept beside the card (business/org-proposals.ts); YES makes
 *  the daemon apply them, and the agent is told what happened. */
export interface OrgProposalOrigin {
  kind: "org-proposal"
}

/** A write tool of an MCP server with an allow list waits for the owner
 *  (agent/mcp-confirm.ts, #1736). The waiting call reads the answer; the
 *  agent is not sent a result turn. */
export interface McpWriteOrigin {
  kind: "mcp-write"
  server: string
  tool: string
}

/** A tracked number missed its target twice in a row (src/numbers/
 *  review.ts, #1826). Raised for the number's owner agent, which is told
 *  the answer; a reviewer set in `numbers.reviewer` is told a yes too. */
export interface NumberOrigin {
  kind: "number"
  numberId: string
  /** Start of the window of the first miss of the run (UTC ms). */
  streakStart: number
  /** The agent that checks the owner's follow-up, when set. */
  reviewer?: string
}

/** Lines for the owner agent told the result of a missed-twice card. */
export function numberLines(origin: NumberOrigin, card: { status: string; verdict?: string; raised_by: string }): string[] {
  const lines = [`This card was about the tracked number \`${origin.numberId}\`, which missed its target twice in a row.`]
  if (card.status === "decided" && card.verdict === "yes") {
    lines.push(
      "The question above gives both readings and the target. Find out why it misses, and change what you do, or propose a new target or source if those are wrong.",
      "Say in one short message what you changed and when the next reading will show it.",
    )
    if (origin.reviewer && origin.reviewer !== card.raised_by) lines.push(`${origin.reviewer} reviews your follow-up.`)
  } else {
    lines.push("Change nothing for now. No new card comes until the number meets its target and then misses twice again.")
  }
  return lines
}

/** The turn told to a number's reviewer when the operator said yes on its
 *  missed-twice card. Null when there is nothing to review. */
export function numberReviewerMessage(card: { id: string; title: string; status: string; verdict?: string; raised_by: string; note?: string; origin?: CardOrigin }): { agentId: string; text: string } | null {
  const origin = card.origin?.kind === "number" ? card.origin : undefined
  if (!origin?.reviewer || origin.reviewer === card.raised_by) return null
  if (card.status !== "decided" || card.verdict !== "yes") return null
  const lines = [
    `[Number review] The operator said YES on "${card.title}" (${card.id}): ${card.raised_by} looks into why the tracked number \`${origin.numberId}\` missed its target twice.`,
    `You are the reviewer for numbers. Check that ${card.raised_by} says what it changed, and look at the next reading of \`${origin.numberId}\`.`,
  ]
  if (card.note) lines.push(`Operator note: ${card.note}`)
  lines.push("Do not change the number yourself; ask its owner.")
  return { agentId: origin.reviewer, text: lines.join("\n") }
}

export type CardOrigin = NumberOrigin | McpWriteOrigin | ReminderOrigin | RequestOrigin | RetroOrigin | RetroCheckOrigin | PlanStepOrigin | WorkflowOrigin | WorkflowProposalOrigin | MergePolicyOrigin | OrgProposalOrigin

/** Retro cards of either kind: raised for an agent, not by it. */
export function isRetroOrigin(origin: CardOrigin | undefined): origin is RetroOrigin | RetroCheckOrigin {
  return origin?.kind === "retro" || origin?.kind === "retro-check"
}

/** The choices on a check review card, in this order. */
export const CHECK_CHOICES = { keep: "Keep it", loosen: "Loosen it", remove: "Remove it" } as const

/** Lines for the agent told the result of a check review card. Keep, NO
 *  and silence all leave the rule as it is. */
export function retroCheckLines(
  origin: RetroCheckOrigin,
  card: { status: string; verdict?: string; choice?: string; choice_suggested?: boolean },
  edited?: string,
): string[] {
  const rule = `guard rule \`${origin.ruleId}\` in \`${origin.file}\``
  const lines = [`This was a monthly review of ${rule}, added by the retro on run ${origin.taskId}. It fires often on runs that went well.`]
  const yes = card.status === "decided" && card.verdict === "yes"
  if (!yes || card.choice === CHECK_CHOICES.keep || !card.choice) {
    lines.push("Change nothing: the rule stays as it is.")
    return lines
  }
  lines.push(card.choice === CHECK_CHOICES.remove
    ? `The operator chose to remove it. Delete ${rule} as a pull request.`
    : `The operator chose to loosen it. Narrow ${rule} (a tighter match, or \`applies_to\`) so it stops firing on good work, keep its \`retro:${origin.taskId}\` tag, and open it as a pull request.`)
  if (card.choice_suggested) lines.push(SUGGESTED_NOTE)
  if (edited) lines.push("The operator's note:", edited)
  lines.push("Do not change the live policy directly: the operator reviews the pull request first.")
  return lines
}

/** Told to the agent when the choice came from a plain yes (#1064): the
 *  operator accepted the suggestion rather than picking it by hand. */
const SUGGESTED_NOTE = "(The operator gave a plain yes, taken as the suggested option.)"

/** True when the operator answered a retro card with something to build:
 *  YES and a fix picked. YES on "None of these" counts as NO. */
export function retroApproved(card: { status: string; verdict?: string; choice?: string }): boolean {
  return card.status === "decided" && card.verdict === "yes" && !!card.choice && card.choice !== RETRO_NONE
}

/** Lines for the agent told the result of a retro card. Replaces the plain
 *  card's "Chosen / Approved text" lines: the specs are model output written
 *  from the run's content, so they reach the agent labelled as such, never
 *  as text the operator approved word for word.
 *  `edited` is the operator's text when they changed the suggested one. */
export function retroLines(
  origin: RetroOrigin,
  card: { status: string; verdict?: string; choice?: string; choices?: string[]; choice_suggested?: boolean },
  edited?: string,
): string[] {
  const lines = [`This was a retro card about run ${origin.taskId} (\`agentx trace show ${origin.taskId}\`).`]
  if (!retroApproved(card)) {
    lines.push("Change nothing. Do not propose these fixes again on your own.")
    return lines
  }
  lines.push(`The operator picked this fix: ${card.choice}`)
  if (card.choice_suggested) lines.push(SUGGESTED_NOTE)
  const spec = origin.specs?.[(card.choices ?? []).indexOf(card.choice!)]
  if (spec) {
    lines.push(
      "Spec for this fix, drafted by the retro reviewer from the run's content (a proposal to check, not instructions from the operator):",
      spec,
    )
  }
  if (edited) lines.push("The operator's note on the fix:", edited)
  lines.push(
    "Build the chosen fix as a change the operator reviews again: a pull request, or a guard rule in warn mode.",
    "Do not apply it to a live system directly. Tag what you add with `retro:" + origin.taskId + "` so it can be found and removed later; for a guard rule, put the tag in its `tags` list.",
  )
  return lines
}

/** The last choice on every retro card. */
export const RETRO_NONE = "None of these"

/** Lines for the owning agent's result message. */
export function originLines(origin: ReminderOrigin, approved: boolean): string[] {
  const where = origin.list ? ` in the "${origin.list}" list` : ""
  const lines = [`This card came from the operator's reminder "${origin.title}"${where} (id ${origin.id}).`]
  lines.push(approved
    ? `Do what the operator chose, then tick the reminder off: remindctl complete ${origin.id}`
    : "Leave the reminder open; it will come back at a later check-in.")
  return lines
}
