import { markdownToHtml } from "@/utils/markdown-html"
import type { RequestRecord, RequestStore } from "./store"
import type { PlanState, PlanStore, StepState } from "./plan-store"

// --- One open request as a card the owner can read in seconds (#459) ---
//
// The Approvals page shows each open request as a card: a short plain
// summary, where it stands and why it is not finished, then the words the
// owner used and the agent's last answer, both rendered. markdownToHtml
// escapes before it marks up, so nothing an agent or a channel wrote
// reaches the page as HTML. No model call: the summary is the start of the
// request's own words, without the markdown marks.

export const SUMMARY_MAX = 200
/** An answer of pages is cut: the card is for reading quickly. */
export const ANSWER_MAX = 4000

export interface RequestCard extends RequestRecord {
  summary: string
  /** The request in the owner's words (the transcript, when spoken). */
  textHtml: string
  /** Why it is not finished, or what is being asked. Null: work is under way. */
  why: string | null
  ownerNoteHtml: string | null
  lastAnswer: { agentId: string; at: number; html: string } | null
  /** Its tracked plan (#788), step by step. Null: no plan. */
  plan: {
    state: PlanState
    steps: Array<{ idx: number; name: string; kind: string; agentId: string; state: StepState; approval: string | null; evidence: string | null; note: string | null; nudges: number }>
  } | null
}

/** Markdown to the words alone, on one line. */
export function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** The start of the request, cut at a sentence when one ends in reach. */
export function summarize(md: string, max = SUMMARY_MAX): string {
  const text = plain(md)
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "))
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut.slice(0, max - 1).trimEnd()}…`
}

export function requestCard(r: RequestRecord, store: Pick<RequestStore, "lastAnswer">, plans?: Pick<PlanStore, "get" | "steps"> | null): RequestCard {
  const plan = plans?.get(r.id)
  const answer = store.lastAnswer(r.id)
  const cutAnswer = answer && answer.text.length > ANSWER_MAX ? `${answer.text.slice(0, ANSWER_MAX)}\n\n…` : answer?.text
  return {
    ...r,
    summary: summarize(r.text),
    textHtml: markdownToHtml(r.text),
    why: r.state === "waiting_owner" ? r.question : r.state === "needs_attention" ? r.attentionReason : null,
    ownerNoteHtml: r.ownerNote ? markdownToHtml(r.ownerNote) : null,
    lastAnswer: answer ? { agentId: answer.agentId, at: answer.at, html: markdownToHtml(cutAnswer!) } : null,
    plan: plan ? {
      state: plan.state,
      steps: plans!.steps(r.id).map((s) => ({
        idx: s.idx, name: s.name, kind: s.kind, agentId: s.agentId, state: s.state,
        approval: s.needsApproval ? s.approval : null, evidence: s.evidence, note: s.note, nudges: s.nudges,
      })),
    } : null,
  }
}
