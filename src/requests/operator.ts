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
