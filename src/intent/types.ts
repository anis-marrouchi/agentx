// Intent ledger types — Phase 1 of the architectural rescue.
//
// Every dispatch decision in the system flows through `decideAndCommit(event)`
// (added in a later commit) which writes to the append-only ledger. These
// types are the wire format for that ledger. They map 1:1 to the SQLite
// schema in src/intent/ledger.ts.
//
// Design notes:
//   - The shape is deliberately narrow. Anything richer (full message body,
//     full agent prompt, etc.) goes into `raw_json` so the structured columns
//     can stay queryable without column churn.
//   - `source` is closed-set so cross-source analysis is robust to typos.
//   - `outcome` and `status` are likewise closed-set; everything else is
//     `reason` (free-form, human-readable, never machine-parsed).
//   - No agent metadata here. The ledger records intent + dispatch +
//     resolution. Per-agent state lives in the agent registry and sessions.

/** Shape callers pass to `IntentLedger.recordEvent`. The ledger fills in
 *  the id (a fresh ULID derived from `ts`) when omitted; tests may supply
 *  one for deterministic assertions. */
export type IntentEventInput = Omit<IntentEvent, "id"> & { id?: string }

/** A normalized record of one external event entering the system. */
export interface IntentEvent {
  /** ULID, monotonically increasing across all events. */
  id: string
  /** ms since epoch — when the event was observed by agentx. */
  ts: number
  source: IntentSource
  /** External system's id for the event, when available (telegram message_id,
   *  gitlab object_attributes.id, mesh task id). Used for idempotency of
   *  re-deliveries from the same external source. Null when no stable id
   *  exists (e.g., cron firings have only the cron expression). */
  sourceEventId: string | null
  /** "owner/repo" for GitLab/GitHub, "noqta" for cross-project events,
   *  null when the event has no project axis (DM-only telegram, ad-hoc cron). */
  project: string | null
  /** The conversational unit. Examples: "issue:709", "chat:-1003861455814",
   *  "mr:225". Combined with project, this is the dedup key for "is something
   *  already in flight on this thing?" */
  subject: string | null
  /** Optional canonical intent name. Free-form for now; later phases may
   *  constrain this to a registry. Examples: "issue.opened", "comment.added",
   *  "cron.daily-standup". */
  intent: string | null
  /** Full original event for replay + debugging. JSON-serialized. */
  rawJson: string
}

export type IntentSource =
  | "telegram"
  | "slack"
  | "whatsapp"
  | "discord"
  | "gitlab"
  | "github"
  | "workflow"
  | "cron"
  | "mesh"

/** A dispatch decision made by some component (channel router, workflow
 *  dispatcher, PM gate, etc.) about an event. One event can yield multiple
 *  decisions (e.g., the channel router decides "dispatch to mtgl-v2", then
 *  the PM gate decides "halt"). Decisions form a chain via decided_by. */
export interface IntentDecision {
  eventId: string
  decidedAt: number
  /** Which component decided. Examples: "channel-router", "workflow:gitlab-sdlc-loop",
   *  "pm:pm-mtgl", "ledger". Must be unique per (eventId, decidedBy). */
  decidedBy: string
  /** Target agent. Null when outcome != "dispatched". */
  agentId: string | null
  outcome: IntentOutcomeKind
  /** Required when outcome is anything other than "dispatched". Free-form. */
  reason: string | null
}

export type IntentOutcomeKind = "dispatched" | "halted" | "deduped" | "queued"

/** The resolution of a decision — populated when a dispatched task ends. */
export interface IntentResolution {
  decisionEventId: string
  decisionDecidedBy: string
  resolvedAt: number
  status: IntentResolutionStatus
  /** Wall-clock duration of the dispatched task. Null if status is
   *  set without timing data. */
  durationMs: number | null
  /** First ~200 chars of the agent's reply / error / cancelation reason.
   *  Long form lives in the agent's session log. */
  resultSummary: string | null
}

export type IntentResolutionStatus = "completed" | "failed" | "timed-out" | "canceled"

/** A recorded mismatch between a ledger decision and the legacy dispatch
 *  path's outcome, captured during shadow-mode operation (1b in the staged
 *  rollout). The soak's success criterion is "zero divergences for ≥7
 *  days" before promoting any source to authoritative — this is the
 *  queryable surface that criterion is measured against. */
export interface IntentDivergence {
  /** Standalone ULID for the divergence record. Distinct from the event id. */
  id: string
  /** ms since epoch — when the divergence was observed. */
  ts: number
  source: IntentSource
  /** The event whose dispatch produced both decisions. */
  eventId: string
  /** The decider whose ledger decision diverged. Composite FK with eventId
   *  references the corresponding intent_decisions row. */
  decidedBy: string
  ledgerAgentId: string | null
  ledgerOutcome: IntentOutcomeKind
  ledgerReason: string | null
  legacyAgentId: string | null
  legacyOutcome: IntentOutcomeKind
  legacyReason: string | null
}
