import { createHash } from "crypto"
import { isPastTtl } from "@/agents/fact-freshness"
import type { SourceTrust } from "@/agents/memory-trust"
import type { BackendHit } from "./backend"
import type { Evidence, EvidenceResult, EvidenceScope, EvidenceSource, Requester, Standing } from "./types"

// --- Who wins, who may read, and what a backend's answer is worth (#604) ---
//
// The rules a memory backend cannot change, as pure functions. They are
// the fact ledger's overwrite rule (#273), memory capture's review rule
// (#97) and the wiki's read rule, restated over one record shape so they
// hold for every backend. test/evidence-authority.test.ts is the table of
// cases; docs/architecture/evidence-authority.md says why.

/** The same source version always gets the same id, so a re-send lands on the same record. */
export function evidenceId(source: EvidenceSource): string {
  return "e-" + createHash("sha1").update(`${source.id}\u0000${source.version}`).digest("hex").slice(0, 16)
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()

/** Two records are about the same thing when this matches. */
export function claimKey(e: Evidence): string | null {
  return e.claim ? `${norm(e.claim.subject)}\u0000${norm(e.claim.attribute)}` : null
}

const checkedAt = (e: Evidence) => Date.parse(e.check?.at ?? "")

/**
 * How far a record can be relied on at `now`. Reads the check date and
 * the approval, never `ingestedAt`: storing an old claim today does not
 * make it fresh.
 */
export function standing(e: Evidence, now = Date.now()): Standing {
  if (e.kind === "derived") return "unverified"
  if (e.kind === "approved") return e.approval ? "approved" : "unverified"
  const at = checkedAt(e)
  // A check dated after now did not happen yet.
  if (!Number.isFinite(at) || at > now) return "unverified"
  return isPastTtl({ volatility: e.volatility, ttlDays: e.ttlDays, verifiedAt: e.check!.at }, now) ? "stale" : "verified"
}

/** Whether a record may be shown at all. Same rule as memory injection (#97). */
export function usable(e: Evidence): boolean {
  if (e.state !== "active") return false
  if (e.review === "held" || e.review === "rejected") return false
  if (e.trust === "external") return e.review === "approved"
  return true
}

/** The wiki's read rule, plus the project boundary. */
export function canRead(scope: EvidenceScope, who: Requester): boolean {
  if (scope.project && !who.projects?.includes(scope.project)) return false
  if (scope.access === "public") return true
  if (scope.owner === who.agentId) return true
  return scope.access === "shared" && !!scope.sharedWith?.includes(who.agentId)
}

/** Where a record is indexed. A shared record is indexed once per reader. */
export function partitionsOf(scope: EvidenceScope): string[] {
  if (scope.access === "public") return ["public"]
  const readers = scope.access === "shared" ? [scope.owner, ...(scope.sharedWith ?? [])] : [scope.owner]
  return [...new Set(readers)].map((a) => `agent:${a}`)
}

/** Where a requester may search. Derived from the task's agent, never passed in by it. */
export function partitionsFor(who: Requester): string[] {
  return ["public", `agent:${who.agentId}`]
}

export type Outcome =
  /** Same value: nothing to decide. */
  | "same"
  /** `incoming` becomes current; `current` is kept as superseded. */
  | "supersede"
  /** `incoming` is not evidence against `current`: it is kept or dropped, and nobody is asked. */
  | "keep"
  /** Both are kept, `current` stands, and a person is asked which is true. */
  | "conflict"

export interface Resolution { outcome: Outcome; reason: string }

/**
 * What happens when `incoming` disagrees with `current` about the same
 * claim. Callers match claim keys first.
 */
export function resolve(current: Evidence, incoming: Evidence, now = Date.now()): Resolution {
  if (incoming.kind === "derived") return { outcome: "keep", reason: "a backend's own text is not a source" }
  if (!usable(incoming)) return { outcome: "keep", reason: "the newer record is held, rejected or no longer active" }

  if (current.kind === "approved") {
    if (incoming.kind === "approved" && incoming.approval && incoming.source.id === current.source.id
      && incoming.source.version !== current.source.version) {
      return { outcome: "supersede", reason: "a reviewed new version of the same article" }
    }
    if (sameValue(current, incoming)) return { outcome: "same", reason: "same value" }
    return { outcome: "conflict", reason: "approved text changes only through review" }
  }

  if (sameValue(current, incoming)) return { outcome: "same", reason: "same value" }

  const next = standing(incoming, now)
  if (next === "unverified") return { outcome: "conflict", reason: "the newer claim was not checked" }
  if (incoming.check?.confirmedBy) return { outcome: "supersede", reason: "a person confirmed the newer value" }
  if (current.check?.confirmedBy) return { outcome: "conflict", reason: "a person confirmed the current value" }
  const prior = checkedAt(current)
  if (!Number.isFinite(prior) || checkedAt(incoming) > prior) {
    return { outcome: "supersede", reason: "checked more recently than the current value" }
  }
  return { outcome: "conflict", reason: "the current value was checked more recently" }
}

function sameValue(a: Evidence, b: Evidence): boolean {
  return !!a.claim && !!b.claim && norm(a.claim.value) === norm(b.claim.value)
}

const TRUST_ORDER: SourceTrust[] = ["external", "internal", "operator"]

/**
 * Turn one backend hit into something an agent may see, or nothing.
 * `lookup` reads AgentX's own records: the text, standing and access shown
 * are AgentX's, whatever the backend returned.
 *
 * Dropped: an id AgentX does not know (deleted), a version that is no
 * longer current (edited), a record that is revoked, superseded, held or
 * unreadable for this requester. Backend-written text is dropped unless
 * every record behind it passes the same checks, and it is always
 * returned as unverified.
 */
export function gate(
  hit: BackendHit, lookup: (id: string) => Evidence | undefined, who: Requester, now = Date.now(),
): EvidenceResult | null {
  const ok = (e: Evidence | undefined): e is Evidence => !!e && usable(e) && canRead(e.scope, who)

  if (hit.derived) {
    const from = hit.derived.from.map(lookup)
    if (!from.length || !from.every(ok)) return null
    const sources = from as Evidence[]
    const evidence: Evidence = {
      id: hit.id, kind: "derived", source: { id: `backend:${hit.id}`, version: hit.sourceVersion },
      content: hit.derived.content,
      eventAt: sources.map((s) => s.eventAt).sort().at(-1)!,
      ingestedAt: new Date(now).toISOString(),
      volatility: sources.find((s) => s.volatility !== "stable")?.volatility ?? "stable",
      scope: { owner: who.agentId, access: "private" },
      trust: TRUST_ORDER[Math.min(...sources.map((s) => TRUST_ORDER.indexOf(s.trust)))],
      state: "active", derivedFrom: sources.map((s) => s.id),
    }
    return { evidence, standing: "unverified" }
  }

  const e = lookup(hit.id)
  if (!ok(e) || e.source.version !== hit.sourceVersion) return null
  return { evidence: e, standing: standing(e, now) }
}

/** Mark returned records that disagree, so both are shown with their provenance. */
export function markConflicts(results: EvidenceResult[]): EvidenceResult[] {
  return results.map((r) => {
    const key = claimKey(r.evidence)
    if (!key) return r
    const others = results.filter((o) => o !== r && claimKey(o.evidence) === key && !sameValue(o.evidence, r.evidence))
    return others.length ? { ...r, conflictsWith: others.map((o) => o.evidence.id) } : r
  })
}
