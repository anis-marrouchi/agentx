import type { Evidence, EvidenceScope } from "./types"

// --- The memory backend contract (#604) ---
//
// A backend is an index, not a store of record. AgentX hands it records
// and gets ids back; the text, the check and the access rules shown to an
// agent are read from AgentX's own copy (authority.ts `gate`). So a
// backend can be rebuilt from AgentX at any time, swapped, or switched
// off, and nothing it writes can make a claim more trusted than its
// source.
//
// Four operations and no more. Anything a product adds on top (reflect,
// retain, bank management) stays inside its adapter.
//
// Every call takes an AbortSignal, and a backend that is down must not
// stop a task: callers treat a rejected promise as "no evidence from this
// backend" and say so, never as "nothing is known".

/** What a backend may store about a record. The id and version come back unchanged on retrieval. */
export interface BackendRecord {
  id: string
  sourceId: string
  sourceVersion: string
  content: string
  eventAt: string
  /** A hint for pre-filtering. The backend's answer is checked again by AgentX, so this is not the enforcement. */
  scope: EvidenceScope
}

export interface BackendQuery {
  text: string
  limit: number
  /** The partitions to search, chosen by AgentX from the requester (authority.ts `partitionsFor`). An agent cannot name one. */
  partitions: string[]
}

export interface BackendHit {
  /** An id AgentX gave the backend, or the backend's own id for text it derived. A hit with an unknown id is dropped. */
  id: string
  sourceVersion: string
  score: number
  /** Text the backend wrote itself, and the ids it wrote it from. Returned as `derived`, never as a source. */
  derived?: { content: string; from: string[] }
}

export interface BackendHealth {
  ok: boolean
  /** Why not, for the operator. */
  detail?: string
}

export interface EvidenceBackend {
  name: string
  /** Store or replace records by id. Sending the same record twice changes nothing. */
  upsert(partition: string, records: BackendRecord[], signal?: AbortSignal): Promise<void>
  retrieve(query: BackendQuery, signal?: AbortSignal): Promise<BackendHit[]>
  /** Remove records, and everything the backend derived from them. Removing an unknown id is not an error. */
  delete(partition: string, ids: string[], signal?: AbortSignal): Promise<void>
  health(signal?: AbortSignal): Promise<BackendHealth>
}

export function toBackendRecord(e: Evidence): BackendRecord {
  return { id: e.id, sourceId: e.source.id, sourceVersion: e.source.version, content: e.content, eventAt: e.eventAt, scope: e.scope }
}
