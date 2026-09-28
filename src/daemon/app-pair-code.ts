import type { IncomingMessage } from "http"
import { PairCodeStore } from "./pair-codes"
import { readJson } from "./app-fleet"

// --- POST /api/app/pair-code: trade a one-time code for the session ---
//
// Public by necessity (the phone isn't paired yet), so it is guarded three
// ways: an 8-symbol code (31^8 ≈ 850 billion), a per-client and a GLOBAL
// failure limit with lockout, and one answer for every failure. Behind
// `tailscale serve` every request arrives from 127.0.0.1, so the per-client
// limit alone would see one client; the global limit is what really bounds
// guessing: at most 10 wrong codes in any 10 minutes, whoever sends them.
//
// Every attempt is padded to the same minimum duration, so wrong, expired
// and used codes can't be told apart by timing either.

export interface PairLimitOptions {
  perClient: number   // failures per window before that client is locked out
  global: number      // failures per window, all clients together
  windowMs: number
  lockoutMs: number
}

export const DEFAULT_PAIR_LIMITS: PairLimitOptions = {
  perClient: 5,
  global: 10,
  windowMs: 10 * 60 * 1000,
  lockoutMs: 5 * 60 * 1000,
}

interface Bucket { failures: number[]; lockedUntil: number }

/** In-memory failure counter. A dashboard restart clears it; codes still
 *  expire after 10 minutes, so that grants an attacker nothing lasting. */
export class PairAttemptLimiter {
  private clients = new Map<string, Bucket>()
  private all: Bucket = { failures: [], lockedUntil: 0 }

  constructor(private opts: PairLimitOptions = DEFAULT_PAIR_LIMITS, private now: () => number = Date.now) {}

  /** Seconds until this client may try again, or 0 when it may try now. */
  retryAfter(client: string): number {
    const now = this.now()
    const until = Math.max(this.all.lockedUntil, this.clients.get(client)?.lockedUntil ?? 0)
    return until > now ? Math.ceil((until - now) / 1000) : 0
  }

  fail(client: string): void {
    let bucket = this.clients.get(client)
    if (!bucket) this.clients.set(client, (bucket = { failures: [], lockedUntil: 0 }))
    this.bump(bucket, this.opts.perClient)
    this.bump(this.all, this.opts.global)
  }

  succeed(client: string): void {
    this.clients.delete(client)
  }

  private bump(bucket: Bucket, limit: number): void {
    const now = this.now()
    bucket.failures = bucket.failures.filter((t) => now - t < this.opts.windowMs)
    bucket.failures.push(now)
    if (bucket.failures.length >= limit) bucket.lockedUntil = now + this.opts.lockoutMs
  }
}

export interface PairCodeDeps {
  codes: PairCodeStore
  limiter: PairAttemptLimiter
  /** Checks the redeemed token is still an active `app` token; returns its device name. */
  verify: (token: string) => string | null
  log?: (line: string) => void
  minMs?: number
}

export type PairCodeResult =
  | { status: 200; body: { device: string }; token: string }
  | { status: 401; body: { error: string } }
  | { status: 429; body: { error: string; retryAfter: number }; retryAfter: number }

export const PAIR_CODE_FAILED = "That code didn't work. Check it, or run agentx app pair for a new one."
const MIN_MS = 400

export async function redeemPairCode(req: IncomingMessage, deps: PairCodeDeps): Promise<PairCodeResult> {
  const started = Date.now()
  const log = deps.log ?? ((line: string) => console.log(line))
  const client = req.socket.remoteAddress || "unknown"

  const wait = deps.limiter.retryAfter(client)
  if (wait > 0) {
    log(`[app] pair-code refused from ${client}: locked out for ${wait}s more`)
    return { status: 429, body: { error: "too many attempts", retryAfter: wait }, retryAfter: wait }
  }

  let code: unknown = null
  try { code = (await readJson(req, 1024)).code } catch { /* counts as a wrong code */ }
  const redeemed = deps.codes.redeem(code)
  const device = redeemed ? deps.verify(redeemed.token) : null
  await padTo(started, deps.minMs ?? MIN_MS)

  if (!redeemed || !device) {
    deps.limiter.fail(client)
    log(`[app] pair-code failed from ${client}`)
    return { status: 401, body: { error: PAIR_CODE_FAILED } }
  }
  deps.limiter.succeed(client)
  log(`[app] pair-code paired ${redeemed.tokenId} (${device}) from ${client}`)
  return { status: 200, body: { device }, token: redeemed.token }
}

async function padTo(started: number, minMs: number): Promise<void> {
  const left = started + minMs - Date.now()
  if (left > 0) await new Promise((r) => setTimeout(r, left))
}
