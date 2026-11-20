// --- Read one hand-off by its id (#2007 piece 1) ---
//
// GET /a2a/delegations/:id returns one row of the `handoffs` table: who
// asked whom, how it ended, and the answer (capped when it was written).
// The route is behind mesh auth (mesh-auth.ts covers /a2a/delegations/*).
// On top of that, who may read which row (the #2007 review's Q1 default):
//   - the operator key reads every row;
//   - on this machine, a request that names the row's caller or callee
//     (`?as=<agent>`);
//   - a peer, only a row it is the callee of: the row went to a peer, the
//     request names that callee, and when the peer's token is its own, the
//     peer named on the row is that peer.
// A row the asker may not read answers like an unknown id, so the route
// does not tell which ids exist.

import type { HandoffStore } from "./handoff-store"

export interface HandoffAsker {
  /** Showed this node's operator key. */
  operator: boolean
  /** The request comes from this machine. */
  local: boolean
  /** The agent the request names as itself (`?as=`). */
  as: string | null
  /** The peer whose own token the request carries; null for the shared
   *  mesh token, or on this machine. */
  peer: string | null
}

export function mayReadHandoff(a: HandoffAsker, row: { caller: string; callee: string; peer?: string }): boolean {
  if (a.operator) return true
  if (!a.as) return false
  if (a.local) return a.as === row.caller || a.as === row.callee
  if (!row.peer || a.as !== row.callee) return false
  return !a.peer || a.peer === row.peer
}

export function readHandoff(
  store: Pick<HandoffStore, "read"> | null,
  id: string,
  asker: HandoffAsker,
): { status: number; body: Record<string, unknown> } {
  if (!store) return { status: 409, body: { error: "Reading a hand-off by its id needs the database: this node keeps hand-offs in memory only." } }
  if (!asker.operator && !asker.as) {
    return { status: 400, body: { error: "Name the asking agent with ?as=<agent>: only the hand-off's caller or callee may read it." } }
  }
  const row = store.read(id)
  if (!row || !mayReadHandoff(asker, row)) return { status: 404, body: { error: "no hand-off with this id that you may read" } }
  return { status: 200, body: { ...row } }
}
