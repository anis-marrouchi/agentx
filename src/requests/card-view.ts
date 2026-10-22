import { markdownToHtml } from "@/utils/markdown-html"
import type { RequestRecord, RequestStore } from "./store"
import type { PlanState, PlanStore, StepState } from "./plan-store"
import { describeCloseWhen } from "./checkers"
import { activeStepAgentOf, stalledWhy, waitsOn, type StallGroup } from "./loops"

// --- One open request as a card the owner can read in seconds (#459) ---
//
// The Approvals page shows each open request as a card: its headline and
// what is needed from the owner (#1126), where it stands and why it is not
// finished, then the words the owner used ("You said") and the agent's
// last answer, both rendered. markdownToHtml escapes before it marks up,
// so nothing an agent or a channel wrote reaches the page as HTML. No
// model call here: a request with no headline yet is titled with the start
// of its own words, without the markdown marks.

export const SUMMARY_MAX = 200
/** An answer of pages is cut: the card is for reading quickly. */
export const ANSWER_MAX = 4000

export interface RequestCard extends RequestRecord {
  /** Its headline, else the start of its words. */
  summary: string
  /** The request in the owner's words (the transcript, when spoken). */
  textHtml: string
  /** Why it is not finished, or what is being asked. Null: work is under way. */
  why: string | null
  ownerNoteHtml: string | null
  lastAnswer: { agentId: string; at: number; html: string } | null
  /** The open loop (#1039): who it is owed to, when it is due, what
   *  closes it. Null on a request with none of it. */
  loop: {
    owedTo: string | null
    promise: boolean
    dueAt: number | null
    /** What its check waits for, in words. */
    check: string | null
    verifyState: string | null
    verifyDetail: string | null
  } | null
  /** Stalled, and what it waits on. Null: not stalled, or not asked. */
  stall: { group: StallGroup; who: string; why: string } | null
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

/** What a request is called on every surface (#1126): the headline the
 *  agent or the daemon wrote, else the start of the owner's words. */
export function requestTitle(r: Pick<RequestRecord, "headline" | "text">, max = SUMMARY_MAX): string {
  const headline = r.headline?.replace(/\s+/g, " ").trim()
  if (!headline) return summarize(r.text, max)
  return headline.length > max ? `${headline.slice(0, max - 1).trimEnd()}…` : headline
}

/** The owner's own words, on one line and cut, under "You said". */
export function youSaid(r: Pick<RequestRecord, "text">, max = 240): string {
  return summarize(r.text, max)
}

/** What the stall view needs: the quiet time, the clock, and which ids are agents. */
export interface StallLookup { staleAfterHours: number; now: number; isAgent: (id: string) => boolean }

export function requestCard(
  r: RequestRecord,
  store: Pick<RequestStore, "lastAnswer">,
  plans?: Pick<PlanStore, "get" | "steps"> | null,
  stall?: StallLookup,
): RequestCard {
  const plan = plans?.get(r.id)
  const why = stall ? stalledWhy(r, stall.staleAfterHours, stall.now) : null
  const answer = store.lastAnswer(r.id)
  const cutAnswer = answer && answer.text.length > ANSWER_MAX ? `${answer.text.slice(0, ANSWER_MAX)}\n\n…` : answer?.text
  return {
    ...r,
    summary: requestTitle(r),
    textHtml: markdownToHtml(r.text),
    why: r.state === "waiting_owner" ? r.question : r.state === "needs_attention" ? r.attentionReason : null,
    ownerNoteHtml: r.ownerNote ? markdownToHtml(r.ownerNote) : null,
    lastAnswer: answer ? { agentId: answer.agentId, at: answer.at, html: markdownToHtml(cutAnswer!) } : null,
    loop: r.promise || r.dueAt !== null || r.closeWhen ? {
      owedTo: r.owedTo, promise: r.promise, dueAt: r.dueAt, check: r.closeWhen ? describeCloseWhen(r.closeWhen) : null,
      verifyState: r.verifyState, verifyDetail: r.verifyDetail,
    } : null,
    stall: stall && why ? { ...waitsOn(r, { isAgent: stall.isAgent, activeStepAgent: activeStepAgentOf(plans) }), why } : null,
    plan: plan ? {
      state: plan.state,
      steps: plans!.steps(r.id).map((s) => ({
        idx: s.idx, name: s.name, kind: s.kind, agentId: s.agentId, state: s.state,
        approval: s.needsApproval ? s.approval : null, evidence: s.evidence, note: s.note, nudges: s.nudges,
      })),
    } : null,
  }
}
