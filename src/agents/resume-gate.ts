// --- Resume or start fresh: a cost gate (#621, step 3) ---
//
// `claude --resume` replays the whole transcript on every request of the
// next turn. While the provider's prompt cache still holds it, that replay
// is billed at the cache-read price (a tenth of input). Once the cache has
// expired, the first request writes the whole transcript again at the
// cache-write price, and every later request in the turn reads it back. A
// fresh lean start pays the same pattern on a much smaller prompt.
//
// So this compares the two for the coming turn, in units of one input
// token's price:
//
//   resume = C × (first + read × (N − 1))     first = read if warm, else write
//   fresh  = F × (write + read × (N − 1))
//
//   C  the transcript's size: the last request of the previous turn
//      (lastTurnContextTokens)
//   N  requests per turn: the previous turn's billed input summed across its
//      requests, divided by C. Each request re-reads roughly the whole
//      context, so the ratio is close to the number of requests.
//   F  the size of a fresh lean start (setting)
//
// What the coming turn adds is the same either way and drops out. Rotating
// also costs continuity, which no price shows, so a fresh start must be
// cheaper by `margin` before the gate picks it. It is the paper's "compact
// only when the saving beats the cache rewrite" rule applied to session
// reuse. Pure: no clock, no I/O, so it can be tested and backtested as is.

export type ResumeGateMode = "off" | "shadow" | "active"

export interface ResumeGateSettings {
  mode: ResumeGateMode
  /** Tokens a fresh lean session starts with. */
  freshTokens: number
  /** How long the cached transcript is assumed to survive. */
  cacheTtlMinutes: number
  /** Cache-write price as a multiple of the input price. */
  cacheWriteFactor: number
  /** A fresh start must be at least this many times cheaper. */
  margin: number
}

/** Cache-read price as a multiple of the input price. */
export const CACHE_READ_FACTOR = 0.1
/** Requests per turn assumed when the last turn's numbers can't tell. */
export const DEFAULT_REQUESTS_PER_TURN = 10
const MAX_REQUESTS_PER_TURN = 200

export interface ResumeGateInput {
  /** End-of-turn context of the previous turn (lastTurnContextTokens). */
  contextTokens: number | null | undefined
  /** Billed input of the previous turn, summed across its requests. */
  turnInputTokens: number | null | undefined
  /** Time since the session last did anything. */
  idleMs: number
}

export interface ResumeGateResult {
  /** True: start fresh is cheaper by the margin. */
  rotate: boolean
  /** Null when there is no context reading to judge by. */
  resumeCost: number | null
  freshCost: number
  warm: boolean
  requestsPerTurn: number
}

/** Requests in the previous turn, from its summed input and its context. */
export function requestsPerTurn(contextTokens: number | null | undefined, turnInputTokens: number | null | undefined): number {
  if (!contextTokens || contextTokens <= 0 || !turnInputTokens || turnInputTokens <= 0) return DEFAULT_REQUESTS_PER_TURN
  return Math.min(MAX_REQUESTS_PER_TURN, Math.max(1, Math.round(turnInputTokens / contextTokens)))
}

export function decideResume(input: ResumeGateInput, s: ResumeGateSettings): ResumeGateResult {
  const n = requestsPerTurn(input.contextTokens, input.turnInputTokens)
  const warm = input.idleMs < s.cacheTtlMinutes * 60_000
  const later = CACHE_READ_FACTOR * (n - 1)
  const freshCost = s.freshTokens * (s.cacheWriteFactor + later)
  const c = input.contextTokens
  // Without a context reading (a non-streaming turn) there is nothing to
  // compare, and resuming is what the code did before this gate.
  if (!c || c <= 0) return { rotate: false, resumeCost: null, freshCost, warm, requestsPerTurn: n }
  const resumeCost = c * ((warm ? CACHE_READ_FACTOR : s.cacheWriteFactor) + later)
  return { rotate: resumeCost > freshCost * s.margin, resumeCost, freshCost, warm, requestsPerTurn: n }
}

/** One log line: what the gate saw and what it would do. */
export function describeResume(r: ResumeGateResult): string {
  const k = (x: number) => `${Math.round(x / 1000)}k`
  const cache = r.warm ? "warm cache" : "cold cache"
  if (r.resumeCost === null) return `resume: no context reading (${cache})`
  return `${r.rotate ? "start fresh" : "resume"}: resume ≈${k(r.resumeCost)}, fresh ≈${k(r.freshCost)} input-token equivalents (${cache}, ${r.requestsPerTurn} requests/turn)`
}
