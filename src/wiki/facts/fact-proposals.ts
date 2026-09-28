import { createHash } from "crypto"
import { citedCheck, classifyFact, splitMemo, type FactClass } from "@/agents/fact-freshness"
import { assertPerson, FactLedger, type FactInput, type WriteResult } from "./ledger"
import { withLock } from "./ledger-file"

// --- Fact proposals: what a session summary claims, waiting for a check ---
//
// A rotation or continuity memo is a model's summary of a session. When it
// says "the vendor account is past due", that is a claim nobody checked in
// this form, and storing it as memory is how a stale note became a stated
// fact (#273). So memo claims about outside systems come here instead,
// with where they came from. They reach the ledger only when a person
// approves one (a confirmation), never on their own.

export type FactProposalStatus = "pending" | "approved" | "rejected"

export interface FactProposal {
  id: string
  status: FactProposalStatus
  /** The line as the memo stated it. */
  claim: string
  /** Best guess at the structured fact, editable on approval. */
  subject?: string
  attribute?: string
  value?: string
  volatility: FactClass
  /** The check the memo cited, or where the claim came from. */
  source: string
  /** When that check happened, or when the memo was written. */
  verifiedAt: string
  verifiedBy: string
  /** e.g. "rotation-memo:tier-2" or "continuity-memo". */
  origin: string
  agentId: string
  chat?: string
  createdAt: string
  decidedAt?: string
  decidedBy?: string
  reason?: string
}

export interface ProposalInput {
  claim: string
  agentId: string
  origin: string
  chat?: string
  at?: string
}

const proposalId = (agentId: string, claim: string) =>
  "fp-" + createHash("sha1").update(`${agentId}\u0000${claim.toLowerCase().replace(/\s+/g, " ").trim()}`).digest("hex").slice(0, 10)

/** "X is Y" → subject X, value Y, attribute named after the class. */
export function parseClaim(claim: string): { subject?: string; attribute?: string; value?: string } {
  const text = claim.replace(/^[-*•]\s*/, "").replace(/\s*\((?:[^)]*)\)\s*$/, "").trim()
  const m = text.match(/^(.{2,60}?)\s+(?:is|are|was|were|has been|went|got)\s+(.{1,80})$/i)
  if (!m) return {}
  const cls = classifyFact(text)
  return { subject: m[1].trim(), attribute: cls === "stable" ? "state" : `${cls} status`, value: m[2].trim() }
}

function newProposal(it: ProposalInput, id: string, claim: string): FactProposal {
  const at = it.at ?? new Date().toISOString()
  const cited = citedCheck(claim)
  const cls = classifyFact(claim)
  return {
    id, status: "pending", claim, ...parseClaim(claim),
    // A summary's claim is never stable: at best it was true that day.
    volatility: cls === "stable" ? "work-state" : cls,
    source: cited?.source ?? `${it.origin} (unchecked summary)`,
    verifiedAt: cited?.verifiedAt ?? at,
    verifiedBy: it.agentId,
    origin: it.origin, agentId: it.agentId,
    ...(it.chat ? { chat: it.chat } : {}),
    createdAt: at,
  }
}

/** Queue claims, under the ledger's lock. The same claim from the same
 *  agent is kept once. Throws on an unreadable ledger rather than
 *  writing over it. */
export function proposeFacts(ledger: FactLedger, items: ProposalInput[]): FactProposal[] {
  if (items.length === 0) return []
  return ledger.update((data) => {
    const out: FactProposal[] = []
    let added = false
    for (const it of items) {
      const claim = it.claim.replace(/^[-*•]\s*/, "").trim()
      if (!claim) continue
      const id = proposalId(it.agentId, claim)
      const seen = data.proposals.find((p) => p.id === id)
      if (seen) { out.push(seen); continue }
      const p = newProposal(it, id, claim)
      data.proposals.push(p)
      out.push(p)
      added = true
    }
    return { save: added, result: out }
  })
}

export function listFactProposals(ledger: FactLedger, status?: FactProposalStatus): FactProposal[] {
  return ledger.load().proposals.filter((p) => !status || p.status === status)
}

const matches = (x: FactProposal, id: string) => x.id === id || (id.length >= 6 && x.id.startsWith(id))

function findProposal(ledger: FactLedger, id: string): FactProposal | undefined {
  return ledger.load().proposals.find((x) => matches(x, id))
}

/** Decide a pending proposal under the ledger's lock. */
function decide(ledger: FactLedger, id: string, fields: Partial<FactProposal>): FactProposal {
  return ledger.update((data) => {
    const p = data.proposals.find((x) => matches(x, id))
    if (!p) throw new Error(`no fact proposal "${id}"`)
    if (p.status !== "pending") throw new Error(`proposal ${p.id} is already ${p.status}`)
    Object.assign(p, fields)
    return { save: true, result: p }
  })
}

/**
 * Approve a claim: a person confirms it, so it is written to the ledger
 * with their name, even over a newer-dated value.
 */
export function approveFactProposal(
  ledger: FactLedger, id: string, by: string,
  edit: Partial<Pick<FactInput, "subject" | "attribute" | "value" | "source">> = {},
): { proposal: FactProposal; write: WriteResult } {
  assertPerson("approve a fact proposal")
  // One lock for the whole approval: the fact write and the decision
  // land together, or neither does (both re-enter this lock).
  return withLock(ledger.file, () => approveLocked(ledger, id, by, edit))
}

function approveLocked(
  ledger: FactLedger, id: string, by: string,
  edit: Partial<Pick<FactInput, "subject" | "attribute" | "value" | "source">>,
): { proposal: FactProposal; write: WriteResult } {
  const p = findProposal(ledger, id)
  if (!p) throw new Error(`no fact proposal "${id}"`)
  if (p.status !== "pending") throw new Error(`proposal ${p.id} is already ${p.status}`)
  const subject = edit.subject ?? p.subject
  const attribute = edit.attribute ?? p.attribute
  const value = edit.value ?? p.value
  if (!subject || !attribute || !value) {
    throw new Error("could not read a subject, attribute and value from the claim; pass --subject, --attribute and --value")
  }
  const write = ledger.write(
    { subject, attribute, value, source: edit.source ?? p.source, verifiedBy: p.verifiedBy, verifiedAt: p.verifiedAt, volatility: p.volatility },
    { confirmedBy: by },
  )
  const proposal = decide(ledger, p.id, { status: "approved", decidedAt: new Date().toISOString(), decidedBy: by })
  return { proposal, write }
}

export function rejectFactProposal(ledger: FactLedger, id: string, by: string, reason?: string): FactProposal {
  assertPerson("reject a fact proposal")
  return decide(ledger, id, { status: "rejected", decidedAt: new Date().toISOString(), decidedBy: by, ...(reason ? { reason } : {}) })
}

/**
 * Route a session memo: claims about outside systems become proposals;
 * the rest is work state. `pinned` is what the next fresh session reads,
 * with each claim marked unverified and pointing at its proposal.
 */
export function routeMemo(
  wikiDir: string, memo: string, ctx: { agentId: string; origin: string; chat?: string },
): { workState: string; pinned: string; proposals: FactProposal[]; error?: string } {
  const { workState, claims } = splitMemo(memo)
  if (claims.length === 0) return { workState: workState.join("\n"), pinned: memo, proposals: [] }
  let proposals: FactProposal[] = []
  let error: string | undefined
  try {
    proposals = proposeFacts(new FactLedger(wikiDir), claims.map((claim) => ({ claim, ...ctx })))
  } catch (e) {
    // An unwritable wiki must not lose the memo: claims stay out of
    // memory and are pinned for this chat only, still marked.
    error = String((e as Error)?.message ?? e)
  }
  const flagged = claims.map((c, i) =>
    `- UNVERIFIED claim (${proposals[i] ? `wiki proposal ${proposals[i].id}` : "not checked"}): ${c.replace(/^[-*•]\s*/, "")}`)
  return { workState: workState.join("\n"), pinned: [...workState, ...flagged].join("\n"), proposals, ...(error ? { error } : {}) }
}
