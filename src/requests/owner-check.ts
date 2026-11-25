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
//
// A decline or drop can say it was superseded (#2082), with a link to the
// newer work or the owner's later word. The check reads that as a match
// unless the owner's words ask for the old version anyway. Once the check
// has reopened a request, a later close as superseded is not judged again:
// the request waits on the owner with one question ("Closed as superseded
// by <link>. Agree?"). Their close is the yes, their reply the no. Before,
// the same close was reopened again and again, and the agent's only way
// out was to send something, even older work.

import { OWNER_BY, type RequestRecord, type RequestStore } from "./store"
import { deliverablesOf, missingProofs, oneLine, proofBlock, splitCheckEvidence, type Deliverables } from "./close-proof"

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
  /** Any other close judged a mismatch (an agent's done, decline or drop,
   *  a check, a settle) wakes the agent that closed it, or the request's
   *  agent, once, with what is missing (noqta#876). Off: reopened and the
   *  owner told, nobody woken. */
  wakeOnMismatch: boolean
  /** Reopens per request (#2056). Past it, a close judged a mismatch
   *  stands and the owner is told once with the reason. */
  maxReopens: number
  /** retro:01M7VXKHCDJMX90PCDN6JT04WN (#2047): the same judge runs inside
   *  an agent's or a plan's done, before the close is written. warn: it
   *  closes and the caller is told what the proof does not show. block:
   *  a mismatch is refused. A model error or no time left never blocks.
   *  Acts only while `enabled`. */
  beforeClose?: BeforeCloseMode
  /** Most seconds the judge may take inside a done. An agent's done also
   *  stays inside its call's own time (BEFORE_CLOSE_CALL_MS). */
  beforeCloseSeconds?: number
}

export type BeforeCloseMode = "off" | "warn" | "block"

export const DEFAULT_OWNER_CHECK: OwnerCheckSettings = {
  enabled: false, perCheck: 2, maxAgeHours: 48, timeoutSeconds: 60, wakeOnPlanMismatch: true, wakeOnMismatch: true, maxReopens: 2,
  beforeClose: "warn", beforeCloseSeconds: 20,
}

/** The judge's answer: `uncovered` lists the parts of the owner's ask the
 *  evidence does not show (#2047); the after-close sweep ignores it. */
export interface OwnerVerdict {
  verdict: "match" | "mismatch" | "unclear"
  why: string
  uncovered: string[]
}

const UNCOVERED_MAX = 6
const UNCOVERED_CLIP = 120
/** Verdicts judged before a close kept for the same request and evidence,
 *  so a held plan is not judged again every minute. */
const MEMO_MAX = 500

/** The link a close as superseded points to, or null (#2082). */
export function supersededLink(r: Pick<RequestRecord, "state" | "closeKind" | "proof">): string | null {
  return r.state !== "done" && r.closeKind === "superseded" && r.proof?.kind === "link" ? r.proof.value : null
}

/** The one question the owner is asked about a close as superseded after
 *  a reopen (#2082), and what they are told with it. */
export function supersededAsk(r: RequestRecord, link: string): { question: string; need: string; title: string; text: string } {
  const question = `Closed as superseded by ${link}. Agree?`
  const need = "Yes: close it (the Hub or agentx requests drop). No: reply on it with what you want, and it goes back to its agent."
  return {
    question,
    need,
    title: "Closed as superseded: agree?",
    text: [
      `${r.closedBy ?? r.agentId} ${r.state === "dropped" ? "dropped" : "declined"} it as superseded by ${link}. The check already reopened it once, so it is not judged or reopened again: it waits on you.`,
      `What you asked: ${clip(oneLine(r.text))}`,
      ...(r.closeReason ? [`Reason given: ${clip(oneLine(r.closeReason))}`] : []),
      question,
      `Yes: close it (on the Hub, or agentx requests drop ${r.id}). No: reply on it with what you want, and ${r.agentId} gets your words.`,
    ].join("\n"),
  }
}

/** The owner's notice for a close kept after the reopen limit (#2056). */
export function reopenLimitText(r: RequestRecord, why: string, reopens: number): { title: string; text: string } {
  return {
    title: "Closed without doing what you asked, not reopened again",
    text: [
      `The check found the close does not do what you asked, and it was already reopened ${reopens} time${reopens === 1 ? "" : "s"}, so it stays ${r.state} (by ${r.closedBy}).`,
      `What you asked: ${clip(oneLine(r.text))}`,
      `Why it does not match: ${why || "the close does not match your words"}`,
      `To have it done, reopen it or ask again. Request ${r.id}.`,
    ].join("\n"),
  }
}

export const OWNER_CHECK_SYSTEM =
  "You check whether work closed by an assistant did what its owner asked. You are strict about the owner's words and fair to the assistant. " +
  "Respond with a single JSON object on one line. No prose, no code fences."

const TEXT_CLIP = 2000
const MAX_TRIES = 3
export const MISMATCH_PREFIX = "Closed without doing what you asked"

/** Who closes a request when every step of its tracked plan finished. */
export const PLAN_BY = "plan"

/** Who closes a request when its own close check (closeWhen, an issue
 *  home) is met: store.closeVerified. */
export const CHECK_BY = "check"

/** How a close by a met check reads to the reviewer (#1943). The check
 *  proves only what it checks (a merge, an issue closed), so the agent's
 *  own evidence is given on its own line, not as an aside after it: the
 *  reviewer judged the rest of the request on the check alone. */
function metCheckLines(evidence: string): string {
  const { check, agent } = splitCheckEvidence(evidence)
  // The assistant chose the check (closeWhen), so it is not called
  // independent; its words are on one line and quoted (#1943 review).
  return [
    `Closed as DONE: the request's close check (set by the assistant) was met: ${clip(oneLine(check))}`,
    "That check proves only what it checks (for example that a merge request is merged), and a deliverable it covers needs no other link. " +
      "It says nothing about the other things the owner asked: judge those on the assistant's evidence and proof links below.",
    `Evidence given by the assistant (its own words, quoted): ${agent ? `"${clip(oneLine(agent))}"` : "(none)"}`,
  ].join("\n")
}

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

/** Ends the reopen reason when an agent is woken for it (noqta#876): the
 *  owner's notice then says the next step is that agent's, not theirs. */
export const WOKEN_MARK = " Next step:"
export const wokenTail = (agentId: string) => `${WOKEN_MARK} ${agentId}, woken to finish it.`

/** The agent woken for a request that needs attention, read back from
 *  its reason (an owner-words mismatch, a due time); null: none. */
export function wokenAgent(r: { state: string; attentionReason?: string | null }): string | null {
  if (r.state !== "needs_attention" || !r.attentionReason) return null
  const m = r.attentionReason.match(/ Next step: (\S+), woken to finish it\.$/)
  return m ? m[1] : null
}

/** What the closing agent is told when its close was reopened (noqta#876):
 *  the owner's words, why, and each deliverable it must link again.
 *  The reopen clears the request's own proofs (#1952), so every deliverable
 *  is asked for, not only those that had none. A plan's step links are not
 *  cleared: there only the ones still without a link are asked for. */
export function mismatchText(r: RequestRecord, why: string, d: Deliverables | null): string {
  const missing = !d ? [] : d.fromPlan ? missingProofs(r, d) : allProofsAsked(d)
  // No list was read, but a check closes it (#1943 review): the same
  // check result is held (#692 B1) until a new proof link, so the agent
  // is told it can give them.
  const byCheck = !d && (!!r.closeWhen || r.closedBy === CHECK_BY)
  const how = r.state === "done" ? "closed it as done" : `closed it as ${r.state}`
  return [
    `[agentx:request-reopened id=${r.id}] You ${how}, but the close does not do what the owner asked, so the request is open again.`,
    "",
    "What the owner asked:",
    clip(r.text),
    ...(r.ownerNote ? ["", "The owner's latest note on it:", clip(r.ownerNote)] : []),
    "",
    `Why the close does not match: ${why || "the close does not match the owner's words"}`,
    ...(missing.length
      ? ["", d?.fromPlan ? "Still without a proof link:" : "Give a proof link for each (the earlier links were cleared with the reopen):", ...missing.map((m) => `- ${m}`)]
      : []),
    ...(byCheck ? ["", "Its check alone does not close it again: give a proof link for each thing the owner asked, numbered in the order they asked."] : []),
    "",
    "Do what is still missing now. Do not repeat an outside action you already took: check first.",
    `When it is really done, close it with agentx_request {action:"done", id:"${r.id}", evidence:"<link>"${missing.length || byCheck ? ', proofs:[{deliverable:<number>, link:"<url>"}]' : ""}}. ` +
      `If work goes on past this turn, give it a due time with {action:"accept", id:"${r.id}", due:"<ISO time>"} so you are woken for it. ` +
      "The owner is told it is open again and that it is yours.",
    "",
    "There are two ways out:",
    "- deliver what the owner asked, as above;",
    `- or, when newer work or a later word of the owner replaced this request, close it as superseded with a link to that: {action:"decline", id:"${r.id}", reasonKind:"superseded", link:"<url of the newer work or the owner's later instruction>", reason:"<what replaced it>"}. ` +
      "That close is not reopened again: it goes to the owner as one question.",
    "Never send older work just to get the request closed.",
  ].join("\n")
}

/** Every deliverable, numbered as in the list. One deliverable needs no
 *  proof link: it closes as before (as missingProofs). */
function allProofsAsked(d: Deliverables): string[] {
  return d.names.length <= 1 ? [] : d.names.map((name, i) => `${i + 1}. ${name}`)
}

/** `d`: what the owner's words ask for and the links given (#692 B4).
 *  Default: the list and proofs kept on the request. */
export function ownerCheckPrompt(r: RequestRecord, d: Deliverables | null = deliverablesOf(r, null)): string {
  const how = r.state === "done" && r.closedBy === CHECK_BY && r.evidence
    ? metCheckLines(r.evidence)
    : r.state === "done"
    ? `Closed as DONE by ${r.closedBy}. Evidence given: ${clip(oneLine(r.evidence ?? "(none)"))}`
    : `Closed as ${r.state.toUpperCase()} by ${r.closedBy}. Reason given: ${clip(oneLine(r.closeReason ?? "(none)"))}`
  const link = supersededLink(r)
  return [
    "The owner asked for this (their own words, possibly a voice transcript):",
    clip(r.text),
    ...(r.ownerNote ? ["", "The owner's latest note on it:", clip(r.ownerNote)] : []),
    "",
    how,
    ...(link ? [`It was closed as SUPERSEDED: newer work or a later instruction of the owner replaced it. Link given: ${link}`] : []),
    ...proofBlock(d, r.deliverableProofs ?? []),
    "",
    "Answer \"mismatch\" when the close does not deliver what the owner asked, for example:",
    "- it did a smaller or different task than the one asked, or only part of it;",
    "- it stops on, or waits for, a condition the owner did not set (another person, a test, a card, an approval the owner already gave or removed);",
    "- it was declined or dropped for a reason that goes against the owner's words;",
    "- it claims done but the evidence does not show what was asked.",
    "Answer \"match\" when the close does what was asked, or the owner's words were only a question, a status check or a remark that the close answers.",
    ...(link
      ? [
          "A close as SUPERSEDED, with a link to newer work or to a later instruction of the owner, is a \"match\", unless the owner's words say to deliver the old version anyway. " +
            "It is not a refusal: the owner's later word is not in this text, the link points to it.",
          "If that link cannot be read or does not show what replaced the request, answer \"unclear\", not \"mismatch\".",
        ]
      : []),
    "Answer \"unclear\" when you cannot tell from this text.",
    "",
    "Reply as {\"verdict\":\"match\"|\"mismatch\"|\"unclear\",\"why\":\"one plain sentence, addressed to the owner\",\"uncovered\":[\"each part of the owner's ask the evidence and proof links do not show, a few words each\"]}. " +
      "Give uncovered as [] when nothing is missing.",
  ].join("\n")
}

export function readVerdict(text: string): OwnerVerdict | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0])
    const v = typeof o.verdict === "string" ? o.verdict.trim().toLowerCase() : ""
    if (v !== "match" && v !== "mismatch" && v !== "unclear") return null
    const why = typeof o.why === "string" ? o.why.replace(/\s+/g, " ").trim() : ""
    const uncovered = Array.isArray(o.uncovered)
      ? o.uncovered.filter((u: unknown): u is string => typeof u === "string" && !!u.trim())
        .slice(0, UNCOVERED_MAX).map((u: string) => u.replace(/\s+/g, " ").trim().slice(0, UNCOVERED_CLIP))
      : []
    return { verdict: v, why, uncovered }
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
  /** The request's tracked plan as deliverables (#692 B6), for this close
   *  (#2022). */
  plan?: (r: RequestRecord) => Deliverables | null
  /** Starts a turn on the request's agent with `text` (#1908): a plan's
   *  close judged a mismatch wakes it. Fire and forget. Unset: only the
   *  owner is told. */
  wake?: (r: RequestRecord, text: string, agentId?: string) => void
  /** The id is an agent of this node: a close made by one wakes it
   *  (noqta#876). Unset: every id is taken for one. */
  hasAgent?: (id: string) => boolean
  /** Tells the request's owner (#2056): a close kept after the reopen
   *  limit, or the one question about a close as superseded (#2082).
   *  Unset: only recorded. */
  tellOwner?: (r: RequestRecord, title: string, text: string) => Promise<void> | void
}

export class OwnerWordsCheck {
  private running = false
  private tries = new Map<string, number>()
  /** A mismatch judged before a close that went through (warn), by
   *  request id and its closedAt: the sweep acts on it without judging the
   *  same close again (#2047). Lost on restart: the sweep then judges once. */
  private prejudged = new Map<string, { closedAt: number; v: OwnerVerdict }>()
  private memo = new Map<string, OwnerVerdict>()

  constructor(private readonly deps: OwnerCheckDeps) {}

  /** Judge up to `perCheck` closes. Never throws; one run at a time. */
  async run(): Promise<{ checked: number; reopened: string[]; woken: string[]; asked: string[] }> {
    const s = this.deps.settings()
    const out = { checked: 0, reopened: [] as string[], woken: [] as string[], asked: [] as string[] }
    if (!s.enabled || this.running) return out
    this.running = true
    try {
      const now = this.deps.now?.() ?? Date.now()
      for (const r of this.deps.store.pendingOwnerChecks(now - s.maxAgeHours * 3600_000, s.perCheck)) {
        out.checked++
        // Reopened once already: a close as superseded goes to the owner
        // as one question, not to the model again (#2082).
        const link = supersededLink(r)
        if (link && (r.ownerReopens ?? 0) >= 1) {
          await this.askOwner(r, link, out)
          continue
        }
        const pre = this.prejudged.get(r.id)
        if (pre) this.prejudged.delete(r.id)
        const v = pre && pre.closedAt === r.closedAt ? pre.v : await this.judge(r, s.timeoutSeconds * 1000)
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
        if (v.verdict === "mismatch" && (r.ownerReopens ?? 0) >= (s.maxReopens ?? DEFAULT_OWNER_CHECK.maxReopens)) {
          // A loop (#2056: a check met again by the same proof, judged a
          // mismatch again): the close stands and the owner is told once.
          if (this.deps.store.holdOwnerMismatch(r.id, `${MISMATCH_PREFIX} (closed as ${r.state} by ${r.closedBy}): ${v.why}`, at)) {
            this.deps.log?.(`[requests] ${r.id}: owner-words mismatch after ${r.ownerReopens ?? 0} reopens, kept ${r.state}: ${v.why}`)
            if (this.deps.tellOwner) {
              const n = reopenLimitText(r, v.why, r.ownerReopens ?? 0)
              try {
                await this.deps.tellOwner(r, n.title, n.text)
              } catch (e: any) {
                this.deps.log?.(`[requests] ${r.id}: could not tell the owner its close was kept: ${e?.message ?? e}`)
              }
            }
          }
        } else if (v.verdict === "mismatch") {
          const d = deliverablesOf(r, this.deps.plan?.(r) ?? null)
          const target = this.wakeTarget(r, s)
          const reason = `${MISMATCH_PREFIX} (closed as ${r.state} by ${r.closedBy}): ${v.why || "the close does not match your words"}`
          // Before, only a plan's close woke anyone (#1908); a held close
          // by an agent sat until the owner acted (noqta#876 cause 1). The
          // wake only starts a turn (fire and forget), so it goes first:
          // the reason then says "woken" only when it was.
          let woken: string | null = null
          if (target) {
            try {
              const text = r.closedBy === PLAN_BY ? planMismatchText(r, v.why) : mismatchText(r, v.why, d)
              this.deps.wake!(r, text, target)
              woken = target
            } catch (e: any) {
              this.deps.log?.(`[requests] ${r.id}: could not wake ${target} for its reopened close: ${e?.message ?? e}`)
            }
          }
          // The store keeps 500 characters: the tail must survive the cut.
          const kept = woken ? `${reason.replace(/\s+/g, " ").trim().slice(0, 490 - wokenTail(woken).length)}${wokenTail(woken)}` : reason
          if (this.deps.store.reopenForOwnerCheck(r.id, kept, at)) {
            out.reopened.push(r.id)
            this.deps.log?.(`[requests] ${r.id}: owner-words check reopened it (${r.state} by ${r.closedBy}): ${v.why}`)
            if (woken) {
              out.woken.push(r.id)
              this.deps.log?.(`[requests] ${r.id}: its close does not do what was asked; ${woken} woken`)
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

  /** The owner is asked once whether a close as superseded stands
   *  (#2082). Nothing is woken: the next step is theirs. */
  private async askOwner(r: RequestRecord, link: string, out: { asked: string[] }): Promise<void> {
    const ask = supersededAsk(r, link)
    if (!this.deps.store.askOwnerOnClose(r.id, ask.question, ask.need, this.deps.now?.() ?? Date.now())) return
    out.asked.push(r.id)
    this.deps.log?.(`[requests] ${r.id}: closed as superseded by ${link} after ${r.ownerReopens ?? 0} reopen(s); asked the owner, not judged again`)
    if (!this.deps.tellOwner) return
    try {
      await this.deps.tellOwner(r, ask.title, ask.text)
    } catch (e: any) {
      this.deps.log?.(`[requests] ${r.id}: could not ask the owner about its close as superseded: ${e?.message ?? e}`)
    }
  }

  /** Who is woken for a close judged a mismatch, or null. A plan's
   *  close: the request's agent. An agent's own close: that agent. A
   *  check or a settle: the request's agent. Never the owner. */
  private wakeTarget(r: RequestRecord, s: OwnerCheckSettings): string | null {
    if (!this.deps.wake) return null
    const has = (id: string) => this.deps.hasAgent ? this.deps.hasAgent(id) : true
    if (r.closedBy === PLAN_BY) return s.wakeOnPlanMismatch !== false ? r.agentId : null
    if (s.wakeOnMismatch === false) return null
    const target = r.closedBy && r.closedBy !== OWNER_BY && this.deps.hasAgent?.(r.closedBy) ? r.closedBy : r.agentId
    return has(target) ? target : null
  }

  /** Judge a close before it is written (#2047): `r` is the request as it
   *  would read once closed. Null: no answer in `timeoutMs` (never a
   *  reason to block). The same request and evidence are judged once. */
  async judgeBeforeClose(r: RequestRecord, timeoutMs: number): Promise<OwnerVerdict | null> {
    const key = `${r.id}\n${r.closedBy}\n${r.evidence ?? ""}`
    const kept = this.memo.get(key)
    if (kept) return kept
    const v = await this.judge(r, timeoutMs)
    if (v) {
      if (this.memo.size >= MEMO_MAX) this.memo.delete(this.memo.keys().next().value!)
      this.memo.set(key, v)
    }
    return v
  }

  /** Keep a verdict judged before a close that went through: match and
   *  unclear are recorded, so the sweep skips the close; a mismatch is
   *  handed to the sweep, which reopens and wakes as for any close. */
  keepBeforeClose(id: string, v: OwnerVerdict, now: number): void {
    const r = this.deps.store.get(id)
    if (!r || r.ownerCheck !== "pending" || r.closedAt == null) return
    if (v.verdict === "mismatch") this.prejudged.set(id, { closedAt: r.closedAt, v })
    else this.deps.store.setOwnerCheck(id, v.verdict, v.why || null, now)
  }

  private async judge(r: RequestRecord, timeoutMs: number): Promise<OwnerVerdict | null> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      return readVerdict(await this.deps.generate(ownerCheckPrompt(r, deliverablesOf(r, this.deps.plan?.(r) ?? null)), ac.signal))
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
