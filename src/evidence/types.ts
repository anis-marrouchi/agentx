import type { FactClass } from "@/agents/fact-freshness"
import type { FactReview, SourceTrust } from "@/agents/memory-trust"
import type { WikiAccess } from "@/wiki/types"

// --- Evidence: one record shape for wiki knowledge and recent observations (#604) ---
//
// The wiki holds what was approved; memory, raw entries and task results
// hold what was seen lately. Both answer "what do we know about X", and a
// memory backend (#605) indexes both. This is the record they share, so a
// retrieved line always says where it came from, when it was true, who
// checked it and who may read it.
//
// Nothing here is new policy. Every field reuses a rule that already
// exists: volatility and checks from the fact ledger (#273), source trust
// and review from memory capture (#97), approval from promotion review
// (#95), access from wiki articles. docs/architecture/evidence-authority.md
// is the decision record.
//
// AgentX keeps these records. A backend keeps an index of them and nothing
// else: it is handed records, and gives back ids (backend.ts).

/**
 * What a record is, which decides what can replace it.
 *   approved     a curated wiki article: written by promotion review or an operator.
 *   fact         a fact-ledger entry: subject, attribute, value and a check.
 *   observation  recent evidence nobody curated: a raw entry, a memory fact, a task result.
 *   derived      text a backend wrote from other records. Never an authority.
 */
export type EvidenceKind = "approved" | "fact" | "observation" | "derived"

/** Records are never dropped silently: an old one keeps its id and says why it is no longer current. */
export type EvidenceState = "active" | "superseded" | "revoked" | "deleted"

/** The thing a record was made from, and which version of it. */
export interface EvidenceSource {
  /** Stable across edits: "wiki:<article path>", "fact:<fact id>", "entry:<entry id>", "memory:<agent>/<fact id>", "task:<task id>". */
  id: string
  /** Changes on every edit: a content hash for articles, `updatedAt` for facts, "1" for things that never change. */
  version: string
}

/** A check against the source of the claim, as the fact ledger records it. */
export interface EvidenceCheck {
  /** When the check was made. */
  at: string
  /** The agent or person who made it. */
  by: string
  /** How: a system, URL or command, or "owner said". */
  method: string
  /** Set when a person confirmed the value. Only another confirmation replaces it. */
  confirmedBy?: string
}

/** Who may read a record. Set by trusted code when the record is made, from the source's own access rules. */
export interface EvidenceScope {
  /** The agent the record belongs to. */
  owner: string
  access: WikiAccess
  sharedWith?: string[]
  /** When set, only a requester working on this project may read it. */
  project?: string
}

export interface Evidence {
  /** `evidenceId(source)`: the same source version always gets the same id. */
  id: string
  kind: EvidenceKind
  source: EvidenceSource
  /** What the record is about. Two active records with the same key and different values are a conflict. */
  claim?: { subject: string; attribute: string; value: string }
  content: string
  /** When it happened or was observed. Never later than `ingestedAt`. */
  eventAt: string
  /** When AgentX stored it. Bookkeeping only: it is never read to decide freshness or precedence. */
  ingestedAt: string
  /** Absent means nobody checked it, and it is shown as unverified. */
  check?: EvidenceCheck
  volatility: FactClass
  /** Overrides the class's time to live. */
  ttlDays?: number
  scope: EvidenceScope
  trust: SourceTrust
  /** External-source records are held until a person approves them (#97). */
  review?: FactReview
  /** Who approved an `approved` record and when (#95). Says the text was reviewed. It is not permission to act. */
  approval?: { by: string; at: string }
  state: EvidenceState
  /** The record that replaced this one. */
  supersededBy?: string
  /** For `derived`: the records the backend wrote it from. A derived record with none is dropped. */
  derivedFrom?: string[]
}

/** Who is asking. Built by AgentX from the running task, never from model output or a backend's tags. */
export interface Requester {
  agentId: string
  projects?: string[]
}

/** How far a returned record can be relied on. Always shown with the record. */
export type Standing =
  /** Curated and reviewed. */
  | "approved"
  /** Checked, and still within its time to live. */
  | "verified"
  /** Checked once, but past its time to live: re-check before stating it. */
  | "stale"
  /** Nobody checked it. */
  | "unverified"

/** One retrieved record as a caller sees it: the record, its standing and anything that disagrees with it. */
export interface EvidenceResult {
  evidence: Evidence
  standing: Standing
  /** Ids of other returned records with the same claim key and a different value. */
  conflictsWith?: string[]
}
