// --- Situation templates (#1892, phase 6) ---
//
// A template says how a kind of talk runs (design 3.1, 4). Phase 6 ships
// the hand-written ones, in code: they are high stakes, so they are not
// learned and not edited in a file (learned templates are phase 8, as
// drafts a reviewer approves).
//
// What a template may do, and only this:
//   - add prompt rules (`enforce: prompt`): one sentence per phase that the
//     [Situation] line carries. A wrongly picked template can only add
//     sentences;
//   - say whether the talk has closing steps (notes, follow-ups, one owner
//     message; the `situation-close` workflow);
//   - give the note's agent a line on what the note must hold.
// It cannot add a code gate or loosen one. Every template keeps the same
// code gates as `conversation`: one goodbye in `ending`, no reply to a
// courtesy message after the end, the owner told through the hold, and
// nothing outward without the owner's yes on a card.
//
// Who picks a template: a person (`agentx situation closing --template`,
// POST /situations/closing), or the chat's own agent in its turn
// (`agentx_situation`, POST /situations/fill) when
// `situations.templates.agentFill` is on. Nothing picks one from a chat
// message. Read only when `situations.templates.enabled` is on.

export type TemplateKind = "conversation" | "meeting" | "job" | "hand-off"

export interface SituationTemplate {
  id: string
  kind: TemplateKind
  version: number
  /** `general`: a skeleton for a kind of talk. `hand`: written by hand
   *  for a high-stakes case. */
  source: "general" | "hand"
  /** How the [Situation] line names it. */
  title: string
  /** One prompt sentence per phase, added to the [Situation] line. */
  rules: Partial<Record<"during" | "ending" | "ended", string>>
  /** The talk has closing steps when it ends (notes, follow-ups, one
   *  message to the owner). */
  closing: boolean
  /** The chat's agent may pick it for its own chat. */
  agentMay: boolean
  /** What the closing note must hold, for the note's agent. */
  noteGuidance?: string
}

export const SITUATION_TEMPLATES: readonly SituationTemplate[] = [
  {
    id: "conversation", kind: "conversation", version: 1, source: "general",
    title: "Conversation", rules: {}, closing: false, agentMay: false,
  },
  {
    id: "meeting", kind: "meeting", version: 1, source: "general",
    title: "Meeting",
    rules: { during: "Keep to the meeting's purpose; note what is agreed and who owes it." },
    closing: true, agentMay: true,
    noteGuidance: "Say what was decided and what is still open.",
  },
  {
    id: "meeting.external", kind: "meeting", version: 1, source: "hand",
    title: "Meeting with an outside party",
    rules: {
      during: "An outside party is in this talk: share no inside facts (other clients, prices, internal plans, people), make no offer, and make no promise that has no owner.",
      ending: "Make no new promise in the goodbye.",
    },
    closing: true, agentMay: true,
    noteGuidance: "Keep the note to what the outside party said and what was agreed; do not copy inside facts into it.",
  },
  {
    id: "job.production", kind: "job", version: 1, source: "hand",
    title: "Change on a live system",
    rules: {
      during: "This talk is about a change on a live system: before a change, say what will change and how to undo it; after it, check that it worked and say how you checked. Do not call it done without that check.",
      ending: "Report the result and the check once, then stop.",
    },
    closing: true, agentMay: true,
    noteGuidance: "Say what changed, how it was checked, and how to undo it.",
  },
  {
    id: "hand-off", kind: "hand-off", version: 1, source: "general",
    title: "Hand-off",
    rules: {
      during: "Work is being handed over: say what is handed over, to whom, and what done looks like, and ask the receiver to confirm.",
      ending: "One short confirmation is enough; do not answer thanks with thanks.",
    },
    closing: true, agentMay: true,
    noteGuidance: "Say what was handed over, to whom, and what done looks like; each handed task is a follow-up with its owner.",
  },
]

const BY_ID = new Map(SITUATION_TEMPLATES.map((t) => [t.id, t]))

/** The template with this id, or null. */
export function situationTemplate(id: string | null | undefined): SituationTemplate | null {
  return (id && BY_ID.get(id)) || null
}

/** The ids, for an error message. */
export function templateIds(): string {
  return SITUATION_TEMPLATES.map((t) => t.id).join(", ")
}

/** Collapse agent- or person-supplied text to one line, capped. */
export function oneLine(v: unknown, max: number): string {
  return (typeof v === "string" ? v : "").replace(/\s+/g, " ").trim().slice(0, max)
}

/** The ids an agent may pick, for an error message. */
export function agentTemplateIds(): string {
  return SITUATION_TEMPLATES.filter((t) => t.agentMay).map((t) => t.id).join(", ")
}
