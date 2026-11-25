/**
 * G3 (#2085 v2 G3, v3 T, v4 T′, v5 T″): live state before a status claim.
 *
 * Rule (CLAUDE.md "Anis's word comes first" item 11, Anis 2026-11-07):
 * "Check before you repeat a status ... If you cannot check, say 'not
 * checked'." A reply to the owner that says merged, live, deployed,
 * released or closed about a PR, MR, issue, version or commit must rest on
 * a read of that thing in the same run.
 *
 * The check is code: a claim word, the refs in the sentences that carry
 * it, and the run's tool calls (from its trace) that read each ref. The
 * `status-claim` seat is the switch (off / shadow / active, like
 * `due-time`): shadow writes rows only, active asks the run once, in the
 * same session, before its answer is returned to the caller that posts it.
 */
import { getSeatMode } from "@/decisions/seat"
import type { SeatMode } from "@/decisions/store"

export const STATUS_CLAIM_SEAT = "status-claim"
export const STATUS_CLAIM_GATE = "status-claim"
export const STATUS_CLAIM_RULE = "check-before-you-repeat-a-status"

/** The seat's mode on this node: decisions.seats["status-claim"].mode, or
 *  AGENTX_DECISION_SEAT_STATUS_CLAIM. Off when it cannot be read. */
export function statusClaimMode(): SeatMode {
  try {
    return getSeatMode(STATUS_CLAIM_SEAT)
  } catch {
    return "off"
  }
}

const CLAIM_WORD = /\b(?:merged|live|deployed|released|closed)\b/i

/** Does the text say merged, live, deployed, released or closed? */
export function hasClaimWord(text: string): boolean {
  return CLAIM_WORD.test(text)
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/

const REF_PATTERNS: Array<{ kind: "number" | "version" | "sha"; re: RegExp }> = [
  // #12, !12, PR 12, MR !12, pull/12, merge_requests/12, issues/12
  { kind: "number", re: /(?:[#!]|\b(?:PR|MR|pull|issue)\s*[#!]?|\/(?:pull|merge_requests|issues)\/)(\d{1,7})\b/gi },
  { kind: "version", re: /\bv?(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/g },
  { kind: "sha", re: /\b([0-9a-f]{7,40})\b/g },
]

export interface ClaimRef {
  kind: "number" | "version" | "sha"
  /** The value as read: "12", "0.263.1", "1a24bd32". */
  value: string
  /** How it is shown: "#12", "0.263.1", "1a24bd32". */
  label: string
}

/** The refs named in the sentences that carry a claim word. */
export function claimRefs(text: string): ClaimRef[] {
  const out = new Map<string, ClaimRef>()
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    if (!hasClaimWord(sentence)) continue
    for (const { kind, re } of REF_PATTERNS) {
      for (const m of sentence.matchAll(re)) {
        const value = m[1]
        // A sha has at least one letter and one digit; a bare number is not one.
        if (kind === "sha" && !(/[a-f]/.test(value) && /\d/.test(value))) continue
        const label = kind === "number" ? `#${value}` : value
        if (!out.has(`${kind}:${value}`)) out.set(`${kind}:${value}`, { kind, value, label })
      }
    }
  }
  return [...out.values()]
}

export interface ToolCall { action: string | null; inputSummary: string | null }

/** Calls that read live state: the forge, git after a fetch, the registry,
 *  a URL, or AgentX's own request check. */
const LIVE_READ = /\b(?:gh\s+(?:pr|issue|api|release|run)|glab\s+(?:mr|issue|api|release|ci)|git\s+(?:log|fetch|branch|show|tag|ls-remote|rev-parse)|npm\s+(?:view|info)|curl|wget|WebFetch|fetch)\b|\/api\/v4\/|api\.github\.com|merge_requests|pulls?\/|agentx_request|__get_(?:merge_request|issue|pull_request)|__(?:list|get)_/i

/** Did one of the run's calls name this ref and read live state? */
export function refWasRead(ref: ClaimRef, calls: ToolCall[]): boolean {
  const named = ref.kind === "number"
    ? new RegExp(`(?<![\\w.])${ref.value}(?![\\w.])`)
    : ref.kind === "sha"
      ? new RegExp(ref.value.slice(0, 7), "i")
      : new RegExp(ref.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return calls.some((c) => {
    if (MID_RUN_SEND.test(c.action ?? "")) return false
    const text = `${c.action ?? ""} ${c.inputSummary ?? ""}`
    return named.test(text) && LIVE_READ.test(text)
  })
}

export type ClaimVerdict =
  | { kind: "none" }
  /** A claim word with no ref it can be tied to: logged, not asked. */
  | { kind: "untied" }
  | { kind: "read" }
  | { kind: "unread"; refs: ClaimRef[] }

export function judgeClaim(reply: string, calls: ToolCall[]): ClaimVerdict {
  if (!hasClaimWord(reply)) return { kind: "none" }
  const refs = claimRefs(reply)
  if (!refs.length) return { kind: "untied" }
  const unread = refs.filter((r) => !refWasRead(r, calls))
  return unread.length ? { kind: "unread", refs: unread } : { kind: "read" }
}

/** The one question a run gets when it claimed a state it did not read. */
export function claimAsk(refs: ClaimRef[]): string {
  const list = refs.map((r) => r.label).join(", ")
  return "[Status check] Your answer says merged, live, deployed, released or closed about " + list +
    ", and nothing in this run read its live state. Check it now (gh pr view, glab mr view, git log after a fetch, npm view …) " +
    "and reply with your full answer corrected. If you cannot check, keep the answer and say \"not checked\" next to each claim. " +
    "Do not redo or continue the work in this turn."
}

/** The line added when the ask got no answer: the claim stays, marked. */
export function notCheckedLine(refs: ClaimRef[]): string {
  return `(Not checked in this run: ${refs.map((r) => r.label).join(", ")}.)`
}

/** Tool names that send a message while the run is still going. */
const MID_RUN_SEND = /(?:^|_)(?:channel_reply|send|send_contact)$/

/** Claims a run already sent mid-run through agentx_channel_reply or
 *  agentx_send, with refs it did not read. They are gone: logged only. */
export function midRunClaims(calls: ToolCall[]): ClaimRef[] {
  const out: ClaimRef[] = []
  for (const c of calls) {
    if (!MID_RUN_SEND.test(c.action ?? "") || !c.inputSummary || !hasClaimWord(c.inputSummary)) continue
    for (const ref of claimRefs(c.inputSummary)) if (!refWasRead(ref, calls)) out.push(ref)
  }
  return out
}
