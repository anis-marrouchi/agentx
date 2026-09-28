import type { IncomingMessage } from "http"
import { hashToken, type TokenStore } from "./token-store"

// --- Trace for refused phone-app requests ---
//
// Issue #234: paired phones stopped sending their cookie after an update and
// the owner had to pair again. To tell "the browser sent nothing" apart from
// "it sent a key we no longer accept", every refused /app or /api/app request
// logs one line:
//
//   [app] unauthenticated /app cookie=absent mode=navigate site=none
//
// It never prints a token, a hash or a token id. The Sec-Fetch-* headers are
// set by the browser and say whether it was a launch navigation (site=none),
// which is the case iOS used to send without a SameSite=Strict cookie.
//
// A phone that keeps polling while locked would otherwise write a line every
// few seconds, so each (path, state) pair is logged at most once a minute.

export type CookieState = "absent" | "invalid" | "revoked"

/** What the request's credential looks like, without saying which one it is. */
export function credentialState(token: string | null, tokens: TokenStore): CookieState {
  if (!token) return "absent"
  const hash = hashToken(token)
  const rec = tokens.list().find((r) => r.hash === hash)
  if (!rec) return "invalid"
  // Revoked and expired keys both mean "this was a real key once".
  if (rec.revokedAt || (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now())) return "revoked"
  return "invalid" // active, but not an `app` key
}

export class RejectLog {
  private last = new Map<string, number>()

  constructor(
    private log: (line: string) => void = (line) => console.log(line),
    private now: () => number = Date.now,
    private everyMs = 60_000,
  ) {}

  record(path: string, fields: Record<string, string>): void {
    const detail = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")
    const key = `${path} ${fields.cookie ?? ""} ${fields.bearer ?? ""}`
    const now = this.now()
    const seen = this.last.get(key)
    if (seen !== undefined && now - seen < this.everyMs) return
    if (this.last.size > 500) this.prune(now)
    this.last.set(key, now)
    this.log(`[app] unauthenticated ${path} ${detail}`)
  }

  private prune(now: number): void {
    for (const [k, t] of this.last) if (now - t >= this.everyMs) this.last.delete(k)
    // Still full (many distinct paths inside one minute): start over rather
    // than grow without bound. Worst case is one extra line per path.
    if (this.last.size > 500) this.last.clear()
  }
}

/** Fields for one refused request. Header values are browser-set enums;
 *  anything unexpected is replaced so the log can't be fed arbitrary text. */
export function rejectFields(req: IncomingMessage, cookie: CookieState, bearer: CookieState | null): Record<string, string> {
  const fields: Record<string, string> = { cookie }
  if (bearer) fields.bearer = bearer
  fields.mode = headerWord(req.headers["sec-fetch-mode"])
  fields.site = headerWord(req.headers["sec-fetch-site"])
  return fields
}

function headerWord(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v
  return s && /^[a-z-]{1,20}$/.test(s) ? s : "-"
}
