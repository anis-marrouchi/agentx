import { markdownToHtml } from "@/utils/markdown-html"
import type { RequestRecord, RequestStore } from "./store"
import type { PlanState, PlanStore, StepState } from "./plan-store"
import { describeCloseWhen } from "./checkers"
import { activeStepAgentOf, stalledWhy, waitsOn, type StallGroup } from "./loops"
import { awaitingQa } from "./qa"

// --- One open request as a card the owner can read in seconds (#459) ---
//
// The Approvals page shows each open request as a card: a short plain
// summary, where it stands and why it is not finished, then the words the
// owner used and the agent's last answer, both rendered. markdownToHtml
// escapes before it marks up, so nothing an agent or a channel wrote
// reaches the page as HTML. The summary is the request's headline (#1126);
// a request without one yet falls back to the start of its own words,
// without the markdown marks.

export const SUMMARY_MAX = 200
/** An answer of pages is cut: the card is for reading quickly. */
export const ANSWER_MAX = 4000

/** What a request needs from the owner when nothing does. */
export const NOTHING_NEEDED = "Nothing, just so you know."

/** A request as every surface titles it (#1126): what it is, the one
 *  thing needed from the owner, and the owner's own words. The need
 *  follows where it stands: a request that needs attention or waits on
 *  the owner's answer says so, whatever the agent wrote earlier. */
export function cardWords(
  r: Pick<RequestRecord, "text" | "headline" | "need" | "state" | "question" | "agentId">,
  max = SUMMARY_MAX,
): { headline: string; need: string; said: string } {
  const headline = r.headline ? (r.headline.length > max ? `${r.headline.slice(0, max - 1)}…` : r.headline) : summarize(r.text, max)
  const need = r.state === "needs_attention" ? `Hand it back to ${r.agentId}, or drop it.`
    : r.state === "waiting_owner" ? (r.need ?? (r.question ? `Answer: ${summarize(r.question, 150)}` : "Your answer."))
    : r.state === "candidate" || r.state === "in_progress" || r.state === "waiting_other" ? (r.need ?? NOTHING_NEEDED)
    : NOTHING_NEEDED
  return { headline, need, said: plain(r.text) }
}

export interface RequestCard extends RequestRecord {
  summary: string
  /** The one thing needed from the owner, in words: the agent's `need`
   *  or what follows from where the request stands (cardWords). */
  needed: string
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
  /** Marked as needing QA, with no verdict since (#1188). The verdict
   *  itself is `qa`, from the record. */
  awaitingQa: boolean
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

/** What the stall view needs: the quiet time, the clock, and which ids are agents. */
export interface StallLookup { staleAfterHours: number; now: number; isAgent: (id: string) => boolean }

/** A request's open loop (#1039): who it is owed to, when it is due, what
 *  check closes it and what that check last said. Null: none of it. The
 *  card and the Hub's post (#1440) both show it. */
export function loopOf(r: RequestRecord): RequestCard["loop"] {
  return r.promise || r.dueAt !== null || r.closeWhen ? {
    owedTo: r.owedTo, promise: r.promise, dueAt: r.dueAt, check: r.closeWhen ? describeCloseWhen(r.closeWhen) : null,
    verifyState: r.verifyState, verifyDetail: r.verifyDetail,
  } : null
}

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
  const words = cardWords(r)
  return {
    ...r,
    summary: words.headline,
    needed: words.need,
    textHtml: markdownToHtml(r.text),
    why: r.state === "waiting_owner" ? r.question : r.state === "needs_attention" ? r.attentionReason : null,
    ownerNoteHtml: r.ownerNote ? markdownToHtml(r.ownerNote) : null,
    lastAnswer: answer ? { agentId: answer.agentId, at: answer.at, html: markdownToHtml(cutAnswer!) } : null,
    loop: loopOf(r),
    awaitingQa: awaitingQa(r),
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
