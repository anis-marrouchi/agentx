// --- The owner-words check: a close not made by the owner is read
//     against what the owner asked ---
//
// An agent can close the owner's request as done, decline it, or (through
// the CLI from its own shell) drop it. Nothing compared that close with
// the owner's words, so a narrowed task, a swapped task, or a stop the
// owner never set ("waits on the tester", "needs a yes on Telegram") could
// close a request as if it were handled.
//
// Every close records who made it (store.close `by`). A close not made by
// the owner waits here, and the daemon's requests check reads a few each
// minute with one small model call: the owner's words, any later note of
// theirs, and how it was closed. The model answers in JSON:
//   match     the close did what the owner asked: nothing happens
//   mismatch  it did not: the request opens again as needing attention,
//             with the reason, so the requests check tells the owner once
//   unclear   recorded, nothing happens (never a reason to bother them)
// A call that fails is tried again at the next check; after MAX_TRIES the
// close is marked unclear. Closes older than `maxAgeHours` are left alone.

import type { RequestRecord, RequestStore } from "./store"
import { deliverablesOf, proofBlock, type Deliverables } from "./close-proof"

export interface OwnerCheckSettings {
  enabled: boolean
  provider?: string
  model?: string
  /** Closes judged per requests check (once a minute). */
  perCheck: number
  /** Closes older than this are not judged. */
  maxAgeHours: number
  timeoutSeconds: number
  /** A plan's close judged a mismatch also wakes the request's agent
   *  (#1908). Off: reopened and the owner told, nobody woken. */
  wakeOnPlanMismatch: boolean
}

export const DEFAULT_OWNER_CHECK: OwnerCheckSettings = { enabled: false, perCheck: 2, maxAgeHours: 48, timeoutSeconds: 60, wakeOnPlanMismatch: true }

export const OWNER_CHECK_SYSTEM =
  "You check whether work closed by an assistant did what its owner asked. You are strict about the owner's words and fair to the assistant. " +
  "Respond with a single JSON object on one line. No prose, no code fences."

const TEXT_CLIP = 2000
const MAX_TRIES = 3
export const MISMATCH_PREFIX = "Closed without doing what you asked"

/** Who closes a request when every step of its tracked plan finished. */
export const PLAN_BY = "plan"

/** What the agent is told when its plan's close was reopened (#1908). */
export function planMismatchText(r: RequestRecord, why: string): string {
  return [
    `[agentx:request-reopened id=${r.id}] Your tracked plan for this request finished and closed it, but the close does not do what the owner asked, so the request is open again.`,
    "",
    "What the owner asked:",
    clip(r.text),
    ...(r.ownerNote ? ["", "The owner's latest note on it:", clip(r.ownerNote)] : []),
    "",
    `Why the close does not match: ${why || "the close does not match the owner's words"}`,
    ...(r.evidence ? [`What the plan closed with: ${clip(r.evidence)}`] : []),
    "",
    "Do what is still missing now. Do not repeat an outside action you already took: check first.",
    `When it is really done, close it with agentx_request {action:"done", id:"${r.id}", evidence:"<link to the proof>"}. ` +
      `If work goes on past this turn, give it a due time with {action:"accept", id:"${r.id}", due:"<ISO time>"} so you are woken for it. ` +
      "The owner is told it is open again.",
  ].join("\n")
}

/** `d`: what the owner's words ask for and the links given (#692 B4).
 *  Default: the list and proofs kept on the request. */
export function ownerCheckPrompt(r: RequestRecord, d: Deliverables | null = deliverablesOf(r, null)): string {
  const how = r.state === "done"
    ? `Closed as DONE by ${r.closedBy}. Evidence given: ${clip(r.evidence ?? "(none)")}`
    : `Closed as ${r.state.toUpperCase()} by ${r.closedBy}. Reason given: ${clip(r.closeReason ?? "(none)")}`
  return [
    "The owner asked for this (their own words, possibly a voice transcript):",
    clip(r.text),
    ...(r.ownerNote ? ["", "The owner's latest note on it:", clip(r.ownerNote)] : []),
    "",
    how,
    ...proofBlock(d),
    "",
    "Answer \"mismatch\" when the close does not deliver what the owner asked, for example:",
    "- it did a smaller or different task than the one asked, or only part of it;",
    "- it stops on, or waits for, a condition the owner did not set (another person, a test, a card, an approval the owner already gave or removed);",
    "- it was declined or dropped for a reason that goes against the owner's words;",
    "- it claims done but the evidence does not show what was asked.",
    "Answer \"match\" when the close does what was asked, or the owner's words were only a question, a status check or a remark that the close answers.",
    "Answer \"unclear\" when you cannot tell from this text.",
    "",
    "Reply as {\"verdict\":\"match\"|\"mismatch\"|\"unclear\",\"why\":\"one plain sentence, addressed to the owner\"}.",
  ].join("\n")
}

export function readVerdict(text: string): { verdict: "match" | "mismatch" | "unclear"; why: string } | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0])
    const v = typeof o.verdict === "string" ? o.verdict.trim().toLowerCase() : ""
    if (v !== "match" && v !== "mismatch" && v !== "unclear") return null
    const why = typeof o.why === "string" ? o.why.replace(/\s+/g, " ").trim() : ""
    return { verdict: v, why }
  } catch {
    return null
  }
}

export interface OwnerCheckDeps {
  store: RequestStore
  settings: () => OwnerCheckSettings
  generate: (prompt: string, signal: AbortSignal) => Promise<string>
  log?: (line: string) => void
  now?: () => number
  /** The request's tracked plan as deliverables (#692 B6). */
  plan?: (requestId: string) => Deliverables | null
  /** Starts a turn on the request's agent with `text` (#1908): a plan's
   *  close judged a mismatch wakes it. Fire and forget. Unset: only the
   *  owner is told. */
  wake?: (r: RequestRecord, text: string) => void
}

export class OwnerWordsCheck {
  private running = false
  private tries = new Map<string, number>()

  constructor(private readonly deps: OwnerCheckDeps) {}

  /** Judge up to `perCheck` closes. Never throws; one run at a time. */
  async run(): Promise<{ checked: number; reopened: string[]; woken: string[] }> {
    const s = this.deps.settings()
    const out = { checked: 0, reopened: [] as string[], woken: [] as string[] }
    if (!s.enabled || this.running) return out
    this.running = true
    try {
      const now = this.deps.now?.() ?? Date.now()
      for (const r of this.deps.store.pendingOwnerChecks(now - s.maxAgeHours * 3600_000, s.perCheck)) {
        out.checked++
        const v = await this.judge(r, s)
        const at = this.deps.now?.() ?? Date.now()
        if (!v) {
          const n = (this.tries.get(r.id) ?? 0) + 1
          this.tries.set(r.id, n)
          if (n >= MAX_TRIES) {
            this.tries.delete(r.id)
            this.deps.store.setOwnerCheck(r.id, "unclear", "the check could not get an answer", at)
          }
          continue
        }
        this.tries.delete(r.id)
        if (v.verdict === "mismatch") {
          const reason = `${MISMATCH_PREFIX} (closed as ${r.state} by ${r.closedBy}): ${v.why || "the close does not match your words"}`
          if (this.deps.store.reopenForOwnerCheck(r.id, reason, at)) {
            out.reopened.push(r.id)
            this.deps.log?.(`[requests] ${r.id}: owner-words check reopened it (${r.state} by ${r.closedBy}): ${v.why}`)
            // A plan that closed too early (#1908): the flag alone woke
            // nobody. The agent that owns the request is woken with why.
            if (r.closedBy === PLAN_BY && this.deps.wake && s.wakeOnPlanMismatch !== false) {
              try {
                this.deps.wake(r, planMismatchText(r, v.why))
                out.woken.push(r.id)
                this.deps.log?.(`[requests] ${r.id}: its plan closed without doing what was asked; ${r.agentId} woken`)
              } catch (e: any) {
                this.deps.log?.(`[requests] ${r.id}: could not wake ${r.agentId} after its plan's close was reopened: ${e?.message ?? e}`)
              }
            }
          }
        } else {
          this.deps.store.setOwnerCheck(r.id, v.verdict, v.why || null, at)
        }
      }
    } catch (e: any) {
      this.deps.log?.(`[requests] owner-words check failed: ${e?.message ?? e}`)
    } finally {
      this.running = false
    }
    return out
  }

  private async judge(r: RequestRecord, s: OwnerCheckSettings): Promise<ReturnType<typeof readVerdict>> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), s.timeoutSeconds * 1000)
    try {
      return readVerdict(await this.deps.generate(ownerCheckPrompt(r, deliverablesOf(r, this.deps.plan?.(r.id) ?? null)), ac.signal))
    } catch (e: any) {
      this.deps.log?.(`[requests] ${r.id}: owner-words check call failed: ${e?.message ?? e}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

function clip(t: string): string {
  const s = t.trim()
  return s.length > TEXT_CLIP ? s.slice(0, TEXT_CLIP - 1) + "…" : s
}
