import { isValidCardId, type DecisionCard } from "./cards"
import type { ApiReply } from "./daemon-api"

// --- Decision cards across the mesh (#668) ---
//
// The inbox and the Mac popup live on the operator's machine. An agent on
// another node raises its card against its own daemon, which has no
// screen, so nobody would see it. With `approvals.forwardTo` naming the
// operator's machine (a mesh peer), that daemon hands the card over
// instead of keeping it:
//
//   agent ─agentx_approval─▶ its daemon ─POST /approvals {node}─▶ operator's daemon
//   agent ◀─result turn────  its daemon ◀─POST /approvals/result─ operator's daemon
//
// The operator's daemon keeps the card with `node` = where it came from,
// shows it like any other, and when it is decided or expires sends the
// card back to that node, which runs the short result turn on the raising
// agent. Both hops are mesh-token gated: /approvals already is, and a
// result is believed only from a request that carries one of this node's
// mesh tokens, never from loopback alone, since agents on this node reach
// loopback themselves.

export interface ForwardPeer {
  /** The peer's name in this node's `mesh.peers`. */
  name: string
  url: string
  token?: string
}

export interface ForwardDeps {
  /** This node's `node.name`: the card's `node` on the other side. */
  self: string
  peer: ForwardPeer
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

function headersFor(deps: ForwardDeps): Record<string, string> {
  const token = deps.peer.token || (deps.env ?? process.env).MESH_TOKEN
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

async function call(deps: ForwardDeps, method: string, path: string, body?: unknown): Promise<ApiReply> {
  const doFetch = deps.fetch ?? fetch
  const url = `${deps.peer.url.replace(/\/+$/, "")}${path}`
  try {
    const res = await doFetch(url, {
      method,
      headers: headersFor(deps),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, body: data }
  } catch (e: any) {
    return { status: 502, body: { error: `couldn't reach ${deps.peer.name} (${deps.peer.url}): ${e?.message ?? e}` } }
  }
}

/** Raising node: POST /approvals on the operator's node, in this node's
 *  name. The caller has checked that `raised_by` is an agent here. The
 *  operator's answer (201 with the card, or its refusal) is passed back
 *  to the agent as is. */
export function forwardCard(input: Record<string, unknown>, deps: ForwardDeps): Promise<ApiReply> {
  return call(deps, "POST", "/approvals", { ...input, node: deps.self })
}

/** Raising node: GET /approvals/:id on the operator's node, for a card
 *  that was forwarded there (the agent's status check). */
export function readForwardedCard(id: string, deps: ForwardDeps): Promise<ApiReply> {
  return call(deps, "GET", `/approvals/${encodeURIComponent(id)}`)
}

/** Operator's node: hand a decided or expired card back to the node its
 *  agent is on. Throws when that node did not take it, so the sweep can
 *  try again next minute. */
export async function deliverResult(card: DecisionCard, deps: ForwardDeps): Promise<void> {
  const r = await call(deps, "POST", "/approvals/result", { card })
  if (r.status < 200 || r.status >= 300) {
    throw new Error((r.body as { error?: string })?.error || `HTTP ${r.status}`)
  }
}

export interface ReceiveResultDeps {
  /** This node's `node.name`. */
  self: string
  /** `approvals.forwardTo`; unset means this node never forwarded a card. */
  forwardTo?: string
  /** True when the agent exists on this node. */
  hasAgent: (agentId: string) => boolean
  /** True when the request carried one of this node's mesh tokens. */
  authorized: boolean
}

/** Raising node: what POST /approvals/result accepts. The card comes back
 *  whole, so the agent is told exactly what the operator's node recorded. */
export function receiveResult(
  body: Record<string, unknown> | undefined,
  deps: ReceiveResultDeps,
): { ok: true; card: DecisionCard } | { ok: false; status: number; error: string } {
  if (!deps.authorized) return { ok: false, status: 401, error: "a card result needs a mesh token (Authorization: Bearer <token>)" }
  if (!deps.forwardTo) return { ok: false, status: 409, error: "this node does not forward cards (approvals.forwardTo is unset)" }
  const card = body?.card as Partial<DecisionCard> | undefined
  if (!card || typeof card !== "object") return { ok: false, status: 400, error: "card is required" }
  if (typeof card.id !== "string" || !isValidCardId(card.id)) return { ok: false, status: 400, error: "card.id is not a card id" }
  if (card.status !== "decided" && card.status !== "expired") return { ok: false, status: 400, error: "card.status must be decided or expired" }
  if (typeof card.raised_by !== "string" || !deps.hasAgent(card.raised_by)) {
    return { ok: false, status: 400, error: `unknown agent "${card.raised_by ?? ""}": raised_by must be an agent on this node` }
  }
  if (normalizeNodeName(card.node) !== normalizeNodeName(deps.self)) {
    return { ok: false, status: 400, error: `card.node "${card.node ?? ""}" is not this node ("${deps.self}")` }
  }
  return { ok: true, card: card as DecisionCard }
}

/** Node names are typed by hand on each side of the mesh and often differ
 *  in case, spaces or hyphens ("HQ Mac" vs "hq-mac"); compare the letters. */
export function normalizeNodeName(name: unknown): string {
  return typeof name === "string" ? name.toLowerCase().replace(/[^a-z0-9]/g, "") : ""
}

/** Operator's node: the peer a card's `node` names. A node sends its own
 *  `node.name`, which the operator may have listed under another spelling
 *  or another name entirely, so a peer matches by the name in `mesh.peers`
 *  or by the name its agent card advertises (what `/mesh` shows as node). */
export function resolvePeerForNode(
  node: string,
  peers: ReadonlyArray<ForwardPeer>,
  advertised: ReadonlyArray<{ peer: string; node?: string }> = [],
): ForwardPeer | undefined {
  const want = normalizeNodeName(node)
  if (!want) return undefined
  const byName = peers.find((p) => normalizeNodeName(p.name) === want)
  if (byName) return byName
  const seen = advertised.find((a) => a.node && normalizeNodeName(a.node) === want)
  return seen ? peers.find((p) => p.name === seen.peer) : undefined
}
