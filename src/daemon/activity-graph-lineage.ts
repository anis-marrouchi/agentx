// Lineage of one dispatch for the activity map (#267): where the chain it
// belongs to really started, and whether it is a delegation's callback.
//
// Both come from markers #277 stamps on the turn's context, read through
// a2a/initiator.ts so the map and the delegation code agree:
//   context.initiator   the root of an A2A chain, carried by every hop,
//                       across mesh peers too (a peer records it on /task).
//   context.delegation  set on a callback turn: the callee's answer coming
//                       back to the caller. A return hop, not a new origin.
//
// Only small identifying fields leave here; the snapshot is a list API.

import { propagatedRootOf } from "@/a2a/initiator"

export interface DispatchRoot {
  kind: "human" | "agent"
  /** Channel the root turn arrived on (gitlab, voice, app, cron, …). */
  channel: string
  /** Who started it on that channel, when known. */
  sender?: string
  /** The agent the root turn reached first. */
  agentId?: string
}

export interface DispatchCallback {
  /** The agent whose answer this turn carries back. */
  from: string
  peer?: string
  status: string
}

export interface DispatchLineage {
  root?: DispatchRoot
  callback?: DispatchCallback
}

const clip = (v: unknown, n: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined

/** Read the lineage markers from an event's stored raw payload. Events that
 *  never carried a context (a webhook, a cron tick) have none. */
export function lineageOf(raw: unknown): DispatchLineage {
  const ctx = raw && typeof raw === "object" ? (raw as Record<string, unknown>).context : undefined
  if (!ctx || typeof ctx !== "object") return {}
  const out: DispatchLineage = {}
  const root = propagatedRootOf(ctx as Record<string, unknown>)
  if (root) {
    out.root = { kind: root.kind, channel: root.channel }
    if (root.sender) out.root.sender = root.sender
    if (root.agentId) out.root.agentId = root.agentId
  }
  const dlg = (ctx as Record<string, unknown>).delegation
  if (dlg && typeof dlg === "object") {
    const d = dlg as Record<string, unknown>
    const from = clip(d.from, 80)
    if (from) {
      out.callback = { from, status: clip(d.status, 20) ?? "done" }
      const peer = clip(d.peer, 80)
      if (peer) out.callback.peer = peer
    }
  }
  return out
}
