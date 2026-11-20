import { CHECK_EVIDENCE_MAX, type DeliverableProof, type RequestRecord, type RequestStore } from "./store"
import type { PlanStep, PlanStore } from "./plan-store"
import { parseRef } from "./checkers/issue"

// --- Proof per deliverable before a close by check, and reopen once ---
//
// A checker (closeWhen) or an issue home can close a request as done on
// its own. A check on issue state alone says nothing about what the owner
// asked for. When the owner named several things ("confirm each stage:
// build, MR, merge, staging, test, production"), the request closed with
// no proof for any of them.
//
// Part A, `requests.closeProof.mode` (off | warn | block):
//   - The owner's words (text, plus the latest owner note) are read once
//     by the model into a short list of deliverables (DeliverablesReader).
//     A request with a tracked plan needs no read: its steps are the list,
//     and each step's own evidence link is its proof.
//   - The agent gives one link per deliverable with agentx_request
//     `proofs: [{deliverable, link}]` on step or done, in every mode.
//   - A close by check counts only when each deliverable has a link. One
//     deliverable, or an unreadable list, closes as before.
//   - warn: the close goes through, with one log line and one
//     close_proof_missing signal per request. block: it is refused,
//     verify_state = proof_missing, and the agent is told once.
//
// Part B (every mode, acts only after an owner-words mismatch, so only
// with `requests.ownerCheck` on): the same checker detail that was judged
// a mismatch does not close the request again. It closes again only on a
// proof added after the reopen and after the owner's last send-back, a
// changed checker detail, or the owner's own close. An owner note alone
// gives the work back to the agent; it does not let the check close.
//
// closeByCheck is the only caller of store.closeVerified().

export type CloseProofMode = "off" | "warn" | "block"

export interface CloseProofSettings {
  mode: CloseProofMode
  /** Requests whose words are read per requests check (once a minute). */
  perCheck: number
  /** Agents told per requests check which deliverables need a link. */
  askPerCheck: number
}

export const DEFAULT_CLOSE_PROOF: CloseProofSettings = { mode: "off", perCheck: 2, askPerCheck: 3 }

/** Same cut as store.closeVerified: kept evidence is compared with it. */
const DETAIL_MAX = CHECK_EVIDENCE_MAX
const cut = (t: string) => t.trim().slice(0, DETAIL_MAX) || "the check was met"

/** What the callers add after the checker's own words (daemon-api: the
 *  agent's words on done; home-check: the plan's steps left). */
const SUFFIXES = [" (agent: ", "; its plan stopped with steps left: "]

/** Agent-supplied text on one line (#1943 review): a line break in the
 *  agent's evidence, proof or label must not start a line of its own in
 *  the reviewer's prompt, where it could read as the check's. */
export const oneLine = (t: string) => t.replace(/\s+/g, " ").trim()

/** At most this much of the agent's words is kept beside a long check
 *  detail; the detail is cut first, down to CHECK_KEEP_MIN. */
const AGENT_KEEP_MAX = 300
const CHECK_KEEP_MIN = 120
const ELLIPSIS = "…"

/** What a close by a met check keeps as its evidence: the checker's
 *  detail, then the agent's words (#1943). Near the 500-character cut the
 *  detail is shortened (ending in "…"), not the agent's words: the
 *  reviewer judges the rest of the request on them. */
export function checkEvidence(detail: string, said: string): string {
  const d = detail.trim()
  const s = oneLine(said)
  if (!s || s === d) return d
  const full = `${d}${SUFFIXES[0]}${s})`
  if (full.length <= DETAIL_MAX) return full
  const agent = s.length > AGENT_KEEP_MAX ? s.slice(0, AGENT_KEEP_MAX - 1) + ELLIPSIS : s
  const room = Math.max(CHECK_KEEP_MIN, DETAIL_MAX - SUFFIXES[0].length - agent.length - 1)
  const check = d.length > room ? d.slice(0, room - 1) + ELLIPSIS : d
  return `${check}${SUFFIXES[0]}${agent})`.slice(0, DETAIL_MAX)
}

/** The kept evidence holds this checker detail, and nothing else of the
 *  checker's (#692 B1). The agent's words on done are never new. */
export function sameCheckDetail(evidence: string | null, detail: string): boolean {
  if (evidence == null) return false
  const d = cut(detail)
  if (evidence === d) return true
  // A detail shortened to keep the agent's words (checkEvidence).
  const { check, agent } = splitCheckEvidence(evidence)
  if (agent != null && check.endsWith(ELLIPSIS) && check.length >= CHECK_KEEP_MIN && check.length < d.length) {
    return d.startsWith(check.slice(0, -ELLIPSIS.length))
  }
  if (!evidence.startsWith(d)) return false
  const rest = evidence.slice(d.length)
  // A suffix cut short at the 500 characters still counts.
  return SUFFIXES.some((s) => rest.startsWith(s) || (evidence.length >= DETAIL_MAX && s.startsWith(rest)))
}

/** The list a close is held to, and the proofs given for it. */
export interface Deliverables {
  names: string[]
  proofs: DeliverableProof[]
  /** From a tracked plan's steps (#692 B6). */
  fromPlan: boolean
}

/** A tracked plan's steps as deliverables: each step's own link. Skipped
 *  steps were decided away and are left out. */
export function planDeliverables(steps: PlanStep[], linkOf: (text: string) => string | null): Deliverables | null {
  const kept = steps.filter((s) => s.state !== "skipped")
  if (!kept.length) return null
  const proofs: DeliverableProof[] = []
  for (const s of kept) {
    const link = s.state === "done" && s.evidence ? linkOf(s.evidence) : null
    if (link) proofs.push({ deliverable: s.name, link, at: s.updatedAt })
  }
  return { names: kept.map((s) => s.name), proofs, fromPlan: true }
}

/** Only an active plan stands in for the deliverables (#2020). A closed
 *  or done plan on a reopened request leaves the request's own list and
 *  its kept proofs, as for a request without a plan. */
export const hasActivePlan = (plans: Pick<PlanStore, "get">, id: string): boolean => plans.get(id)?.state === "active"

export function activePlanDeliverables(plans: Pick<PlanStore, "get" | "steps">, id: string, linkOf: (text: string) => string | null): Deliverables | null {
  return hasActivePlan(plans, id) ? planDeliverables(plans.steps(id), linkOf) : null
}

/** What a request is held to. Null: its words are not read yet. */
export function deliverablesOf(r: RequestRecord, plan: Deliverables | null): Deliverables | null {
  if (plan) return plan
  if (r.deliverables === "unreadable") return { names: ["what was asked"], proofs: r.deliverableProofs ?? [], fromPlan: false }
  if (!r.deliverables) return null
  return { names: r.deliverables, proofs: r.deliverableProofs ?? [], fromPlan: false }
}

const normLink = (l: string) => l.trim().replace(/\/+$/, "").toLowerCase()

/** Links that are no proof of a deliverable (#692 S6): the checker's own
 *  ref and the home. Issue state alone proves nothing asked. */
export function refusedLinks(r: Pick<RequestRecord, "home" | "closeWhen">): string[] {
  const out: string[] = []
  if (r.home?.link) out.push(normLink(r.home.link))
  const ref = (r.closeWhen as { ref?: unknown } | null)?.ref
  if (typeof ref === "string" && ref) out.push(normLink(ref))
  return out
}

/** The link names the checker's own issue or merge request itself, not a
 *  note or comment inside it (no anchor). */
function isCheckedItem(r: Pick<RequestRecord, "closeWhen">, link: string): boolean {
  const cw = r.closeWhen as { kind?: string; provider?: unknown; ref?: unknown } | null
  if (cw?.kind !== "issue" || (cw.provider !== "github" && cw.provider !== "gitlab") || typeof cw.ref !== "string") return false
  try { if (new URL(link).hash) return false } catch { return false }
  const a = parseRef(cw.provider, cw.ref)
  const b = parseRef(cw.provider, link)
  return !!a && !!b && a.project.toLowerCase() === b.project.toLowerCase() && a.number === b.number && a.mr === b.mr
}

export function isRefusedLink(r: Pick<RequestRecord, "home" | "closeWhen">, link: string): boolean {
  return refusedLinks(r).includes(normLink(link)) || isCheckedItem(r, link)
}

/** Whether proof `p` is for deliverable `i` (0-based) named `name`. */
function proves(p: DeliverableProof, i: number, name: string): boolean {
  const d = p.deliverable.trim().toLowerCase()
  return d === name.trim().toLowerCase() || d === String(i + 1)
}

/** The deliverables with no proof link, numbered as in the list. One
 *  deliverable needs none: it closes as before. */
export function missingProofs(r: RequestRecord, d: Deliverables): string[] {
  if (d.names.length <= 1) return []
  const refused = refusedLinks(r)
  return d.names
    .map((name, i) => ({ name, i }))
    .filter(({ name, i }) => !d.proofs.some((p) => proves(p, i, name) && !refused.includes(normLink(p.link)) && !isCheckedItem(r, p.link)))
    .map(({ name, i }) => `${i + 1}. ${name}`)
}

export const HELD_TEXT = "held: the owner-words check found this same result a mismatch; it closes again on a new proof link, a changed check result, or the owner's own close"

/** Part B (#692 B1–B3): why this met check must not close the request
 *  again, or null when it may. */
export function holdReason(r: RequestRecord, detail: string, d: Deliverables | null, ownerCheckOn: boolean): string | null {
  if (!ownerCheckOn || r.ownerCheck !== "mismatch") return null
  if (!sameCheckDetail(r.evidence, detail)) return null
  const since = Math.max(r.ownerCheckAt ?? 0, r.sentBackAt ?? 0)
  const proofs = d?.proofs ?? r.deliverableProofs ?? []
  return proofs.some((p) => p.at > since) ? null : HELD_TEXT
}

export interface CloseProofCtx {
  mode: CloseProofMode
  ownerCheckOn: boolean
  /** The request's tracked plan as deliverables, or null without one. */
  plan?: (requestId: string) => Deliverables | null
  /** Reads the request's words now (#692 B5). Unset: no provider; an
   *  unread list counts as one deliverable. */
  read?: (r: RequestRecord) => Promise<void>
  /** Tells the agent which deliverables need a link (a new turn). */
  tell?: (agentId: string, text: string, r: RequestRecord) => Promise<void>
  hasAgent?: (agentId: string) => boolean
  /** Agents still to be told in this check (#692 S5). */
  askBudget?: { left: number }
  log?: (msg: string) => void
}

export const PROOF_OFF: CloseProofCtx = { mode: "off", ownerCheckOn: false }

export type CloseOutcome =
  | { outcome: "closed" }
  | { outcome: "held"; detail: string }
  | { outcome: "blocked"; detail: string; missing: string[] }
  | { outcome: "reading"; detail: string }
  /** Already closed, or gone. */
  | { outcome: "lost" }

const READING_TEXT = "reading what the owner's words ask for; the check runs again shortly"

export function missingText(missing: string[]): string {
  return `no proof link yet for: ${missing.join("; ")}`
}

/** The gate, then the close: one transaction (#692 S1). `detail` is the
 *  checker's own words; `evidence` what the close keeps (with any suffix
 *  the caller adds). */
export function closeByCheckNow(store: RequestStore, id: string, detail: string, evidence: string, now: number, ctx: CloseProofCtx): CloseOutcome {
  return store.tx((): CloseOutcome => {
    const r = store.get(id)
    if (!r || ["done", "declined", "dropped"].includes(r.state)) return { outcome: "lost" }
    const plan = ctx.plan?.(r.id) ?? null
    const d = deliverablesOf(r, plan)
    const held = holdReason(r, detail, d, ctx.ownerCheckOn)
    if (held) {
      store.markChecked(r.id, "held", held, now)
      return { outcome: "held", detail: held }
    }
    if (ctx.mode !== "off") {
      if (!d) {
        // No provider: nothing will read it, so it counts as one.
        if (ctx.mode === "block" && ctx.read) {
          store.markChecked(r.id, "proof_missing", READING_TEXT, now)
          return { outcome: "reading", detail: READING_TEXT }
        }
        if (ctx.read) ctx.log?.(`[requests] ${r.id} closes by its check before its deliverables were read`)
      } else {
        const missing = missingProofs(r, d)
        if (missing.length) {
          const text = missingText(missing)
          if (ctx.mode === "block") {
            store.markChecked(r.id, "proof_missing", text, now)
            return { outcome: "blocked", detail: text, missing }
          }
          if (store.signalProofMissing(r.id, text, now)) ctx.log?.(`[requests] ${r.id} closed by its check with ${text}`)
        }
      }
    }
    return store.closeVerified(r.id, evidence, now) ? { outcome: "closed" } : { outcome: "lost" }
  })
}

/** closeByCheckNow, after reading an unread list first (#692 B5), and
 *  telling the agent once when it is refused for proof. */
export async function closeByCheck(store: RequestStore, r: RequestRecord, detail: string, evidence: string, now: number, ctx: CloseProofCtx): Promise<CloseOutcome> {
  if (ctx.mode !== "off" && ctx.read && r.deliverables == null && !ctx.plan?.(r.id)) {
    await ctx.read(r).catch((e: any) => ctx.log?.(`[requests] ${r.id}: reading its deliverables failed: ${e?.message ?? e}`))
  }
  const out = closeByCheckNow(store, r.id, detail, evidence, now, ctx)
  if (out.outcome === "blocked") askForProof(store, r.id, out.missing, now, ctx)
  return out
}

export function proofAskText(r: RequestRecord, missing: string[], fromPlan: boolean): string {
  return [
    `[agentx:request-proof id=${r.id}]`,
    `The check of this request is met, but the owner asked for several things and it does not close until each has its own proof link.`,
    `No link yet for:`,
    ...missing.map((m) => `- ${m}`),
    "",
    fromPlan
      ? "Report each of these plan steps done with agentx_request {action: \"step\", step: <n>, status: \"done\", evidence: \"<link>\"}."
      : `Give one link per item with agentx_request {action: "step", id: "${r.id}", proofs: [{deliverable: <number or name>, link: "<url>"}]}. A note or comment link that shows the item done is a proof; the issue itself is not.`,
  ].join("\n")
}

/** Tell the agent once which deliverables need a link (#692 S5). Marked
 *  before the call, unmarked when it fails. An agent not on this node:
 *  the owner is told instead. */
export function askForProof(store: RequestStore, id: string, missing: string[], now: number, ctx: CloseProofCtx): void {
  const r = store.get(id)
  if (!r || r.proofAskedAt != null || !ctx.tell) return
  if (ctx.askBudget && ctx.askBudget.left <= 0) return
  if (ctx.hasAgent && !ctx.hasAgent(r.agentId)) {
    store.markProofAsked(id, now)
    store.needsAttention(id, `Its check is met, but it has ${missingText(missing)}, and ${r.agentId} is not on this node to give them`, now)
    return
  }
  if (ctx.askBudget) ctx.askBudget.left--
  store.markProofAsked(id, now)
  const fromPlan = !!ctx.plan?.(id)
  ctx.tell(r.agentId, proofAskText(r, missing, fromPlan), r).catch((e: any) => {
    store.markProofAsked(id, null)
    ctx.log?.(`[requests] ${id}: could not ask ${r.agentId} for proof links: ${e?.message ?? e}`)
  })
}

const LABELS_SHOWN = 20
const LINKS_SHOWN = 5

/** A met check's kept evidence, split into the checker's own words and
 *  the agent's words on done (#1943). Null `agent`: it gave none. */
export function splitCheckEvidence(evidence: string): { check: string; agent: string | null } {
  const at = evidence.indexOf(SUFFIXES[0])
  if (at < 0) return { check: evidence, agent: null }
  const agent = evidence.slice(at + SUFFIXES[0].length).replace(/\)$/, "").trim()
  return { check: evidence.slice(0, at), agent: agent || null }
}

/** The "proof per deliverable" block of the owner-words prompt (#692 B4):
 *  every kept link, where the 500-character evidence cannot hold them.
 *  `kept`: the request's own proof links, shown by the name or number the
 *  agent gave when its words were never read into a list (#1943: with
 *  closeProof off, no list is read, and the links reached nobody). */
export function proofBlock(d: Deliverables | null, kept: DeliverableProof[] = []): string[] {
  if (!d) {
    if (!kept.length) return []
    // addProofs has no total cap: the block has one (#1943 review).
    const labels = [...new Set(kept.map((p) => oneLine(p.deliverable)))]
    const shown = labels.slice(0, LABELS_SHOWN)
    const lines = shown.map((l) => {
      const links = kept.filter((p) => oneLine(p.deliverable) === l).map((p) => oneLine(p.link))
      const more = links.length > LINKS_SHOWN ? ` (${links.length - LINKS_SHOWN} more)` : ""
      // A number as given; a name the assistant wrote, quoted.
      return `${/^\d+$/.test(l) ? `${l}.` : `- "${l}":`} ${links.slice(0, LINKS_SHOWN).join(" ")}${more}`
    })
    return [
      "", "Proof per deliverable (one link or more each, given by the assistant, numbered or named as it counted what was asked):", ...lines,
      ...(labels.length > shown.length ? [`(${labels.length - shown.length} more not shown)`] : []),
    ]
  }
  if (d.names.length <= 1 && !d.proofs.length) return []
  const lines = d.names.map((name, i) => {
    const links = d.proofs.filter((p) => proves(p, i, name)).map((p) => oneLine(p.link))
    return `${i + 1}. ${oneLine(name)}: ${links.length ? links.join(" ") : "(no link)"}`
  })
  return ["", "Proof per deliverable (one link or more each, given by the assistant):", ...lines]
}
