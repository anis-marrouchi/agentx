import { describeProof } from "./promise"
import {
  CLOSED_BY_OWNER, OWNER_CHECK_REASON, OWNER_CHECK_VERDICTS,
  type OwnerCheckVerdict, type RequestRecord, type RequestStore,
} from "./store"

// --- Check a close against the owner's words (#1770) ---
//
// Agents close the owner's requests as done or declined, and plans,
// checks, settling and workflows close them on their own. Nothing used to
// compare a close with what the owner asked: a request was declined
// because it "waits on the tester's pass" right after the owner removed
// the tester step, and closes narrowed the task without a word.
//
// Every close now records who made it (`closed_by`). With
// `requests.ownerCheck.enabled`, the requests check reads each close not
// made by the owner with one small model call: the owner's words, the
// owner's latest note, and how it was closed. The model answers match,
// mismatch or unclear. A mismatch opens the request again as needing
// attention, with the reason, and the requests check tells the owner once.
// Each close is read at most once, across restarts; a new close is read
// again.

export interface OwnerCheckSettings {
  enabled: boolean
  /** Closes read per requests check, at most. */
  perCheck: number
  /** Only closes this recent are read: turning it on does not read the
   *  whole history. */
  lookbackHours: number
  provider?: string
  model?: string
  timeoutSeconds: number
}

export const DEFAULT_OWNER_CHECK: OwnerCheckSettings = { enabled: false, perCheck: 5, lookbackHours: 24, timeoutSeconds: 30 }

export const OWNER_CHECK_SYSTEM =
  "You check whether an AI agent's close of a task keeps to what the person asked. Respond with a single JSON object on one line. No prose, no code fences."

const WORDS_MAX = 2000
const REASON_WORDS_MAX = 300

const fence = (s: string) => ["```", s.replace(/```/g, "'''").slice(0, WORDS_MAX), "```"]

/** Who closed it, in words. */
export function closerWords(by: string | null): string {
  switch (by) {
    case null: return "nobody named"
    case CLOSED_BY_OWNER: return "the owner"
    case "plan": return "its plan, when its steps finished"
    case "settle": return "the requests check, when its handed-on work came back"
    case "check": return "its check, when the check was met"
    case "promise": return "the promise it followed, when that was kept"
    case "workflow": return "its workflow, when the run finished"
    case "card-expired": return "its decision card, which expired unanswered"
    default: return `agent ${by}`
  }
}

/** How it was closed, for the prompt and the owner. */
export function closeWords(r: Pick<RequestRecord, "state" | "evidence" | "closeReason" | "proof" | "verifyDetail">): string {
  const said = r.state === "done" ? r.evidence : r.closeReason
  const proof = r.proof ? describeProof(r.proof) : null
  return [
    `${r.state}${said ? `: ${said}` : ""}`,
    proof && proof !== said ? `proof: ${proof}` : "",
    r.verifyDetail && r.verifyDetail !== said ? `check: ${r.verifyDetail}` : "",
  ].filter(Boolean).join("; ")
}

/** The model's prompt. Everything from the owner and the agent is data, fenced. */
export function ownerCheckPrompt(r: RequestRecord): string {
  const latestNote = r.ownerNote?.trim() || null
  return [
    "A person asked an AI agent for something. The request was then closed. Decide whether the close keeps to what the person asked, as they last said it.",
    "- match: the close does what was asked, or declines or drops it for a reason that holds given the person's latest words.",
    "- mismatch: the close does less or something other than what was asked (it narrows the task, skips a part, or changes it), or its reason contradicts what the person last said (for example, it waits on a step the person removed).",
    "- unclear: you cannot tell from what is here.",
    "Judge only against the person's words. Do not judge the quality of the work.",
    "",
    "WHAT THE PERSON ASKED:",
    ...fence(r.text),
    ...(latestNote ? ["", "THE PERSON'S LATEST NOTE ON IT (newer than the request, it wins where they differ):", ...fence(latestNote)] : []),
    "",
    `HOW IT WAS CLOSED (by ${closerWords(r.closedBy)}):`,
    ...fence(closeWords(r)),
    "",
    `Return ONE JSON object on one line: {"verdict": "match" | "mismatch" | "unclear", "reason": string}. The reason is one plain sentence for the person, at most ${REASON_WORDS_MAX} characters.`,
  ].join("\n")
}

/** The verdict in the model's answer, or null when it gave none that reads. */
export function readOwnerCheck(text: string): { verdict: OwnerCheckVerdict; reason: string } | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  let parsed: any
  try { parsed = JSON.parse(m[0]) } catch { return null }
  const verdict = typeof parsed?.verdict === "string" ? parsed.verdict.trim().toLowerCase() : ""
  if (!(OWNER_CHECK_VERDICTS as readonly string[]).includes(verdict)) return null
  const reason = typeof parsed?.reason === "string" ? parsed.reason.replace(/\s+/g, " ").trim().slice(0, REASON_WORDS_MAX) : ""
  return { verdict: verdict as OwnerCheckVerdict, reason }
}

/** The reason a mismatch opens the request again with. */
export function mismatchReason(r: Pick<RequestRecord, "closedBy" | "state">, reason: string): string {
  return `${OWNER_CHECK_REASON}${closerWords(r.closedBy)} as ${r.state}, but that does not match what you asked: ${reason || "no reason given"}`
}

export interface OwnerCheckDeps {
  store: Pick<RequestStore, "closesToCheck" | "claimOwnerCheck" | "setOwnerCheck" | "reopenMismatch">
  /** One model call: the prompt in, the model's text out. */
  generate: (prompt: string, signal: AbortSignal) => Promise<string>
  settings: () => OwnerCheckSettings
  log: (msg: string) => void
}

export interface OwnerCheckResult {
  checked: number
  reopened: number
}

/** Reads the closes not made by the owner, each once. A mismatch opens the
 *  request again as needing attention; the requests check tells the owner. */
export async function checkCloses(deps: OwnerCheckDeps, now: number): Promise<OwnerCheckResult> {
  const out: OwnerCheckResult = { checked: 0, reopened: 0 }
  const settings = deps.settings()
  if (!settings.enabled) return out
  for (const r of deps.store.closesToCheck(now - settings.lookbackHours * 3_600_000, settings.perCheck)) {
    // Claimed first: a call that hangs or crashes is not repeated.
    if (r.closedAt === null || !deps.store.claimOwnerCheck(r.id, r.closedAt, now)) continue
    out.checked++
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), settings.timeoutSeconds * 1000)
    timer.unref?.()
    try {
      const v = readOwnerCheck(await deps.generate(ownerCheckPrompt(r), ac.signal))
      if (!v) {
        deps.store.setOwnerCheck(r.id, null, "not read: the model gave no verdict that reads")
        deps.log(`[requests] ${r.id}: owner check gave no verdict that reads`)
        continue
      }
      deps.store.setOwnerCheck(r.id, v.verdict, v.reason)
      if (v.verdict !== "mismatch") continue
      if (deps.store.reopenMismatch(r.id, r.closedAt, mismatchReason(r, v.reason), now)) {
        out.reopened++
        deps.log(`[requests] ${r.id} opened again: the close by ${r.closedBy} does not match the owner's words (${v.reason})`)
      }
    } catch (e: any) {
      deps.store.setOwnerCheck(r.id, null, `not read: ${e?.message ?? e}`)
      deps.log(`[requests] ${r.id}: owner check failed: ${e?.message ?? e}`)
    } finally {
      clearTimeout(timer)
    }
  }
  return out
}

