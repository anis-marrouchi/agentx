import { randomBytes, timingSafeEqual } from "crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"

// --- Proof that a turn on one of this node's own surfaces is the owner's (#393) ---
//
// The voice widget, the phone app and the dashboard are the owner's
// surfaces: a turn there is a request of theirs. But `POST /task` takes
// the caller's `context` as it is, so any local caller, an agent included,
// could name `channel: "dashboard"` and be recorded as the owner.
//
// A turn counts as the owner's on those surfaces only when the daemon
// marked it. The daemon marks the turns it starts itself (/ask, the
// dashboard's assistant) and a /task whose caller showed the operator key:
// a secret in `.agentx/operator.key`, readable by this user only, that the
// dashboard process presents for the phone app. The mark is a symbol, so it
// cannot arrive in a JSON body; a bare `context.channel` proves nothing.

/** The header a /task caller presents the operator key in. */
export const OPERATOR_HEADER = "x-agentx-operator"

const OPERATOR_MARK = Symbol("requests.operator")

/** Marks `ctx` as a turn the owner started on one of this node's own
 *  surfaces. Only the daemon calls this. */
export function operatorContext<T extends object>(ctx: T): T {
  return Object.assign(ctx, { [OPERATOR_MARK]: true })
}

/** Did the daemon mark this turn as the owner's? */
export function isOperatorTurn(ctx: object | undefined | null): boolean {
  return !!ctx && (ctx as Record<symbol, unknown>)[OPERATOR_MARK] === true
}

/** Where this install keeps its operator key. */
export function operatorKeyPath(root: string = process.cwd()): string {
  return resolve(root, ".agentx", "operator.key")
}

/** The operator key of this install: created on first use when `create`
 *  is set, null when there is none. The file is readable by this user only. */
export function loadOperatorKey(root: string = process.cwd(), opts: { create?: boolean } = {}): string | null {
  const path = operatorKeyPath(root)
  try {
    if (existsSync(path)) {
      const key = readFileSync(path, "utf-8").trim()
      if (key) return key
    }
    if (!opts.create) return null
    const key = randomBytes(32).toString("hex")
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, key + "\n", { mode: 0o600 })
    chmodSync(path, 0o600)
    return key
  } catch {
    return null
  }
}

/** Does what the caller presented match this node's key? A missing key
 *  on either side never matches. */
export function operatorKeyMatches(key: string | null | undefined, presented: string | string[] | undefined): boolean {
  const p = Array.isArray(presented) ? presented[0] : presented
  if (!key || !p) return false
  const a = Buffer.from(key)
  const b = Buffer.from(p.trim())
  return a.length === b.length && timingSafeEqual(a, b)
}

// ── A mesh peer vouching for the owner (#407) ────────────────────────────
//
// The phone app paired with node A talks to an agent on node B through
// node A's /mesh/task. Node A's operator key means nothing to node B, so
// node A, having checked its own key, tells node B the turn is the
// owner's. Node B believes that only from a request that carries one of
// its peers' tokens: never from loopback, the dashboard token or a bare
// header. An agent on node A that calls /mesh/task without the key gets
// no vouching, so the rule of #393 holds on node A.

/** The header a forwarding node sets after checking its own operator key. */
export const OPERATOR_VOUCH_HEADER = "x-agentx-operator-vouch"

/** Does this /mesh/task call come from the owner's surface with the key?
 *  True only for a context on one of this node's own surfaces whose
 *  caller showed this node's operator key. */
export function operatorVouch(
  context: unknown,
  headers: Record<string, string | string[] | undefined>,
  key: string | null | undefined,
  operatorChannels: ReadonlySet<string>,
): boolean {
  if (!context || typeof context !== "object") return false
  const channel = String((context as Record<string, unknown>).channel ?? "").toLowerCase().split("@")[0]
  if (!operatorChannels.has(channel)) return false
  return operatorKeyMatches(key, headers[OPERATOR_HEADER])
}

/** Does a peer vouch for the owner on this request? The vouch header must
 *  be set and the bearer must be one of this node's peer tokens. */
export function peerVouches(
  headers: Record<string, string | string[] | undefined>,
  peerTokens: Iterable<string>,
): boolean {
  const v = headers[OPERATOR_VOUCH_HEADER]
  if ((Array.isArray(v) ? v[0] : v) !== "1") return false
  const auth = headers.authorization
  const h = (Array.isArray(auth) ? auth[0] : auth) || ""
  const bearer = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : ""
  if (!bearer) return false
  const b = Buffer.from(bearer)
  for (const t of peerTokens) {
    if (!t) continue
    const a = Buffer.from(t)
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}
