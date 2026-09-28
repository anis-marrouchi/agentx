// A2A hop chains — who asked whom, in order, back to where the work really
// came from (#267). Pure, no React.
//
// An A2A dispatch names only its sender agent, so its parent is the
// sender's run that was in progress when it asked. That link is followed
// recursively across the fleet snapshot, which holds every node's
// dispatches, so a hop across mesh peers resolves through the peer's rows.
// Where #277's markers are present they win over the timing guess:
//   root      (context.initiator) the channel the chain really started on,
//             even when the run that started it is outside the window or on
//             a node that did not answer.
//   callback  (context.delegation) the answer coming back to the caller: a
//             return hop on the train it answers, never a new origin.

import type { FleetDispatch } from "./api"

/** Agent that handed this dispatch over, if it was a delegation. */
export function delegatorOf(d: FleetDispatch): string | null {
  if (d.callback) return null
  if (d.initiatorKind !== "a2a") return null
  if (!d.initiatorId || d.initiatorId.startsWith("__")) return null
  return d.initiatorId
}

/** How long after its run ended an agent may still be the one asking
 *  (the run is recorded as resolved before its last message lands). */
const SLACK_MS = 30_000
/** Clock difference allowed between mesh nodes. */
const SKEW_MS = 5_000
/** Longest chain followed; guards against runaway data. */
const MAX_DEPTH = 12

export interface Hop {
  /** The run this hop started; null for a hop known only from a root marker. */
  dispatchId: string | null
  /** Agent that asked (or answered, for a return); null when the work came
   *  straight from a channel. */
  from: string | null
  to: string
  /** Mesh node the receiving run was on (fleet mode). */
  node: string | null
  at: number
  kind: "ask" | "return"
}

export interface Origin {
  /** Channel id as the map draws it (see mapChannelId in transit.ts). */
  channel: string
  /** The run the chain started with, when it is in the window. */
  dispatch: FleetDispatch | null
  /** Who started it on the channel, from the root marker. */
  sender: string | null
}

const originChannelOf = (d: FleetDispatch) => d.root?.channel ?? d.channelId

/** The sender's run in progress when it sent `d`. Preferred, in order: a run
 *  on the channel the root names, one that started before `d` (a later one
 *  only within clock skew), then the latest start. */
export function parentOf(d: FleetDispatch, pool: FleetDispatch[]): FleetDispatch | undefined {
  const sender = delegatorOf(d)
  if (!sender) return undefined
  const rank = (p: FleetDispatch) => [Number(!d.root || originChannelOf(p) === d.root.channel), Number(p.startedAt <= d.startedAt), p.startedAt]
  const better = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  let best: FleetDispatch | undefined
  for (const p of pool) {
    if (p.agentId !== sender || p.id === d.id) continue
    // The turn that carries this hop's own answer back is not its parent.
    if (p.callback?.from === d.agentId && p.startedAt >= d.startedAt) continue
    if (p.startedAt > d.startedAt + SKEW_MS) continue
    if (!p.active && (p.resolvedAt ?? p.startedAt) + SLACK_MS < d.startedAt) continue
    if (!best || better(rank(p), rank(best)) > 0) best = p
  }
  return best
}

/** Dispatches from the true origin down to `d`, root first. */
export function chainOf(d: FleetDispatch, pool: FleetDispatch[]): FleetDispatch[] {
  const out = [d]
  const seen = new Set([d.id])
  let cur = d
  while (out.length < MAX_DEPTH) {
    const p = parentOf(cur, pool)
    if (!p || seen.has(p.id)) break
    out.unshift(p)
    seen.add(p.id)
    cur = p
  }
  return out
}

/** Where a chain really started: its first run when that came in from a
 *  channel, else the root marker a hop carries, else the mesh. */
export function originOf(chain: FleetDispatch[]): Origin {
  const head = chain[0]
  if (!delegatorOf(head)) return { channel: head.channelId, dispatch: head, sender: null }
  const root = chain.find((d) => d.root)?.root
  if (root) return { channel: root.channel, dispatch: null, sender: root.sender ?? null }
  return { channel: head.channelId, dispatch: head, sender: null }
}

/** One hop per dispatch in the chain. A chain whose first run was itself a
 *  delegation starts at the agent the root names, when it names one. */
export function hopsOf(chain: FleetDispatch[]): Hop[] {
  const hops: Hop[] = chain.map((d, i) => ({
    dispatchId: d.id,
    from: i > 0 ? chain[i - 1].agentId : delegatorOf(d),
    to: d.agentId,
    node: d.nodeId ?? null,
    at: d.startedAt,
    kind: "ask" as const,
  }))
  const first = hops[0]
  const rootAgent = chain.find((d) => d.root)?.root?.agentId
  if (first.from && rootAgent && rootAgent !== first.from && originOf(chain).dispatch === null) {
    hops.unshift({ dispatchId: null, from: null, to: rootAgent, node: null, at: first.at, kind: "ask" })
  }
  return hops
}

/** Agents along a chain, a loop (A asks B, B asks A) cut back to its start. */
export function routeAgents(hops: Hop[]): string[] {
  const route: string[] = []
  for (const h of hops) {
    if (h.kind === "return") continue
    // A sender the route has not reached yet (a hop known only from the
    // root marker leaves a gap) is drawn in before its hop.
    if (h.from && route[route.length - 1] !== h.from) {
      const back = route.indexOf(h.from)
      if (back >= 0) route.length = back + 1
      else route.push(h.from)
    }
    const at = route.indexOf(h.to)
    if (at >= 0) route.length = at + 1
    else route.push(h.to)
  }
  return route
}

/** The route follows the first run's chain back to its true origin. A later
 *  run joins it only when its own chain passes through a route agent; runs
 *  with their own origin (a nudge, a second webhook) stay in the hop list. */
export function trainRoute(chains: FleetDispatch[][]): string[] {
  const route = routeAgents(hopsOf(chains[0]))
  for (const chain of chains.slice(1)) {
    const agents = routeAgents(hopsOf(chain))
    const join = agents.findIndex((a) => route.includes(a))
    if (join < 0) continue
    route.length = route.indexOf(agents[join]) + 1
    route.push(...agents.slice(join + 1))
  }
  return route
}

/** The delegated run a callback turn answers: the latest run of the callee
 *  that the caller asked for, started before the answer came back. */
export function askOf(cb: FleetDispatch, pool: FleetDispatch[]): FleetDispatch | undefined {
  const c = cb.callback
  if (!c) return undefined
  let best: FleetDispatch | undefined
  for (const p of pool) {
    if (p.agentId !== c.from || delegatorOf(p) !== cb.agentId || p.startedAt > cb.startedAt + SKEW_MS) continue
    const onPeer = (x: FleetDispatch) => Number(!c.peer || x.nodeId === c.peer)
    if (!best || onPeer(p) > onPeer(best) || (onPeer(p) === onPeer(best) && p.startedAt > best.startedAt)) best = p
  }
  return best
}

/** The return hop a callback turn draws. */
export function returnHop(cb: FleetDispatch): Hop {
  return { dispatchId: cb.id, from: cb.callback!.from, to: cb.agentId, node: cb.nodeId ?? null, at: cb.startedAt, kind: "return" }
}
