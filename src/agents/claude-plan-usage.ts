// --- Claude plan usage reader (#2161) ---
//
// Reads the plan's 5-hour and weekly use, with reset times, from the same
// endpoint Claude Code's `/usage` reads. The dispatch gate uses it to decide
// which cold runs go first when the plan fills up (agents/plan-priority.ts).
//
// The login is the one Claude Code already stores on this node:
//   CLAUDE_CONFIG_DIR set:  Keychain "Claude Code-credentials-<sha256(dir)[:8]>",
//                           then <dir>/.credentials.json
//   otherwise:              Keychain "Claude Code-credentials",
//                           then ~/.claude/.credentials.json
// (the Keychain read lives in native/keyring.ts and only reads on a Mac)
//
// AgentX only reads that login. It never renews or writes it: renewing it
// on the side could leave Claude Code holding a dead renewal key and log
// every agent out. When the stored access token has lapsed, the reading
// waits until Claude Code next runs and saves a fresh one. Meanwhile the
// `rate_limit_event` from runs (agents/claude-code-quota.ts) stays the
// fallback. The token is held for one request and never logged.

import { createHash } from "crypto"
import { existsSync, readFileSync } from "fs"
import os from "os"
import path from "path"
import { readClaudeCodeKeychainEntry } from "@/native/keyring"
import { withCliAccountEnv } from "./cli-accounts"

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const KEYCHAIN_SERVICE = "Claude Code-credentials"
const REQUEST_TIMEOUT_MS = 10_000
/** A reading older than this is not used by the gate. */
export const READING_MAX_AGE_MS = 30 * 60_000

export interface PlanWindowReading {
  /** "five_hour", "seven_day", or a model's weekly window ("seven_day_fable"). */
  window: string
  /** 0..1 share of the window used. */
  utilization: number
  /** Wall-clock ms when the window resets, when reported. */
  resetsAt?: number
}

export interface PlanUsageReading {
  windows: PlanWindowReading[]
  readAt: number
  /** Where the login came from (never the token itself). */
  source: LoginSource
}

export type LoginSource = "config-dir-keychain" | "keychain" | "credentials-file" | "none"

export type PlanUsageErrorKind = "no-login" | "stale-login" | "signed-out" | "missing-scope" | "rate-limited" | "failed"

export interface PlanUsageError { kind: PlanUsageErrorKind; message: string; at: number }

export interface PlanUsageState {
  enabled: boolean
  reading: PlanUsageReading | null
  lastError: PlanUsageError | null
  nextReadAt: number | null
}

// --- The stored login ---

export interface StoredLogin {
  token: string | null
  source: LoginSource
  /** Claude Code can still renew it (a renewal key that has not run out). */
  renewable: boolean
}

export interface LoginReadDeps {
  env?: NodeJS.ProcessEnv
  home?: string
  /** One keychain item of `service`; with `account`, that account's only. */
  readKeychain?: (service: string, account?: string) => Promise<string | null>
  /** The OS user name Claude Code saves its login under (default: os.userInfo()). */
  user?: string
  readFile?: (file: string) => string | null
  now?: number
}

export function keychainServiceFor(configDir?: string): string {
  if (!configDir) return KEYCHAIN_SERVICE
  const suffix = createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8)
  return `${KEYCHAIN_SERVICE}-${suffix}`
}

function readFileOrNull(file: string): string | null {
  try { return existsSync(file) ? readFileSync(file, "utf8") : null } catch { return null }
}

/** The OAuth part of a stored Claude Code login, or null. */
export function parseStoredLogin(raw: string | null, source: LoginSource, now: number = Date.now()): StoredLogin | null {
  if (!raw) return null
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth
    if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) return null
    const renewExp = typeof oauth.refreshTokenExpiresAt === "number" ? oauth.refreshTokenExpiresAt : undefined
    const renewable = typeof oauth.refreshToken === "string" && !!oauth.refreshToken && (renewExp === undefined || renewExp > now)
    return { token: oauth.accessToken, source, renewable }
  } catch {
    return null
  }
}

export async function readStoredLogin(deps: LoginReadDeps = {}): Promise<StoredLogin> {
  const env = deps.env ?? process.env
  const home = deps.home ?? os.homedir()
  const readKeychain = deps.readKeychain ?? ((service: string, account?: string) => readClaudeCodeKeychainEntry(service, account))
  const readFile = deps.readFile ?? readFileOrNull
  const now = deps.now ?? Date.now()
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || undefined
  const user = deps.user ?? currentUser()
  const service = keychainServiceFor(configDir)
  const kc: LoginSource = configDir ? "config-dir-keychain" : "keychain"

  // Claude Code saves its login under the user's account name. An item an
  // older Claude Code saved (account "Claude Code") can sit beside it with
  // the same service and a login that ran out months ago (#2101 R5): the
  // keychain items and the file are all read, and the login that runs out
  // last wins. On a tie the keychain comes first, then the file.
  const raws: Array<[string | null, LoginSource]> = [
    [user ? await readKeychain(service, user) : null, kc],
    [await readKeychain(service), kc],
    [readFile(path.join(configDir ?? path.join(home, ".claude"), ".credentials.json")), "credentials-file"],
  ]
  let best: { login: StoredLogin; expires: number } | null = null
  for (const [raw, source] of raws) {
    const login = parseStoredLogin(raw, source, now)
    if (!login) continue
    const expires = loginExpiresAt(raw)
    if (!best || expires > best.expires) best = { login, expires }
  }
  return best?.login ?? { token: null, source: "none", renewable: false }
}

/** When a stored login's access token runs out (ms); 0 when it does not say. */
function loginExpiresAt(raw: string | null): number {
  try {
    const e = (JSON.parse(raw ?? "null") as { claudeAiOauth?: { expiresAt?: unknown } } | null)?.claudeAiOauth?.expiresAt
    return typeof e === "number" && Number.isFinite(e) ? e : 0
  } catch {
    return 0
  }
}

function currentUser(): string | undefined {
  try { return os.userInfo().username || undefined } catch { return undefined }
}

// --- The usage endpoint ---

export class PlanUsageRequestError extends Error {
  constructor(public kind: PlanUsageErrorKind, message: string, public retryAfterMs?: number) { super(message) }
}

function asEpochMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e10 ? v : v * 1000
  if (typeof v === "string" && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n)) return n > 1e10 ? n : n * 1000
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

function windowFrom(name: string, v: unknown): PlanWindowReading | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const pct = typeof o.utilization === "number" ? o.utilization : typeof o.used_percentage === "number" ? o.used_percentage : undefined
  if (pct === undefined || !Number.isFinite(pct)) return null
  const resetsAt = asEpochMs(o.resets_at)
  return { window: name, utilization: Math.max(0, pct) / 100, ...(resetsAt && { resetsAt }) }
}

/** The windows in a usage response: 5-hour, weekly, and per-model weekly. */
export function parseUsageResponse(body: unknown): PlanWindowReading[] {
  if (!body || typeof body !== "object") return []
  const data = body as Record<string, unknown>
  const out = new Map<string, PlanWindowReading>()
  for (const [key, value] of Object.entries(data)) {
    if (key !== "five_hour" && key !== "seven_day" && !/^seven_day_(opus|sonnet|haiku|fable)$/.test(key)) continue
    const w = windowFrom(key, value)
    if (w) out.set(key, w)
  }
  // Newer responses list model-scoped weekly limits here instead.
  if (Array.isArray(data.limits)) {
    for (const l of data.limits as Array<Record<string, unknown>>) {
      if (l?.kind !== "weekly_scoped") continue
      const name = (l.scope as { model?: { display_name?: unknown } } | null)?.model?.display_name
      if (typeof name !== "string" || !/^[a-z]+$/i.test(name.trim())) continue
      const key = `seven_day_${name.trim().toLowerCase()}`
      const w = windowFrom(key, { used_percentage: l.percent, resets_at: l.resets_at })
      if (w && !out.has(key)) out.set(key, w)
    }
  }
  return [...out.values()]
}

export async function fetchPlanUsage(token: string, fetchImpl: typeof fetch = fetch): Promise<PlanWindowReading[]> {
  let res: Response
  try {
    res = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new PlanUsageRequestError("failed", `usage request failed: ${(err as Error).message}`)
  }
  if (res.ok) return parseUsageResponse(await res.json().catch(() => null))
  const text = (await res.text().catch(() => "")).slice(0, 300)
  if (res.status === 429) {
    const after = Number(res.headers.get("retry-after"))
    throw new PlanUsageRequestError("rate-limited", "usage endpoint rate limited", Number.isFinite(after) && after > 0 ? after * 1000 : undefined)
  }
  if (res.status === 403 && /scope/i.test(text)) throw new PlanUsageRequestError("missing-scope", "the stored login cannot read usage (missing user:profile)")
  if (res.status === 401) {
    if (/revoked/i.test(text)) throw new PlanUsageRequestError("signed-out", "the stored Claude login was revoked; sign in again")
    throw new PlanUsageRequestError("stale-login", "the stored Claude login has lapsed; reading resumes when Claude Code saves a fresh one")
  }
  throw new PlanUsageRequestError("failed", `usage endpoint answered ${res.status}`)
}

// --- The reader ---

export interface PlanUsageReaderDeps {
  readLogin?: () => Promise<StoredLogin>
  fetchUsage?: (token: string) => Promise<PlanWindowReading[]>
  now?: () => number
  log?: (msg: string) => void
}

const RATE_LIMIT_BACKOFF_MS = 15 * 60_000

export class PlanUsageReader {
  private state: PlanUsageState = { enabled: false, reading: null, lastError: null, nextReadAt: null }
  private timer: NodeJS.Timeout | null = null
  private intervalMs = 5 * 60_000
  private readonly readLogin: () => Promise<StoredLogin>
  private readonly fetchUsage: (token: string) => Promise<PlanWindowReading[]>
  private readonly now: () => number
  private log: (msg: string) => void

  constructor(deps: PlanUsageReaderDeps = {}) {
    // The login of the Claude account new runs use (the Hub's active
    // profile, #2101 P9b), not always the default one (#2101 R28g cause 2).
    this.readLogin = deps.readLogin ?? (() => readStoredLogin({ env: withCliAccountEnv({ ...process.env }) }))
    this.fetchUsage = deps.fetchUsage ?? ((t) => fetchPlanUsage(t))
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
  }

  setLog(log: (msg: string) => void): void { this.log = log }

  getState(): PlanUsageState {
    return { ...this.state, reading: this.state.reading && { ...this.state.reading, windows: [...this.state.reading.windows] } }
  }

  /** The latest reading when it is recent enough for the gate. */
  freshReading(now: number = this.now()): PlanUsageReading | null {
    const r = this.state.reading
    return r && now - r.readAt <= READING_MAX_AGE_MS ? r : null
  }

  configure(opts: { enabled: boolean; intervalMinutes: number }): void {
    this.intervalMs = Math.max(1, opts.intervalMinutes) * 60_000
    if (opts.enabled === this.state.enabled && (!opts.enabled || this.timer)) return
    this.stop()
    this.state.enabled = opts.enabled
    if (opts.enabled) this.schedule(0)
    else this.state.reading = null
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.state.nextReadAt = null
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.state.nextReadAt = this.now() + delayMs
    this.timer = setTimeout(() => { void this.readNow() }, delayMs)
    this.timer.unref?.()
  }

  /** One reading. Never throws; the outcome lands in the state. */
  async readNow(): Promise<PlanUsageState> {
    let delay = this.intervalMs
    try {
      const login = await this.readLogin()
      if (!login.token) throw new PlanUsageRequestError("no-login", "no stored Claude login on this node")
      const windows = await this.fetchUsage(login.token).catch((err) => {
        // Claude Code can't renew a login whose renewal key has run out.
        if (err instanceof PlanUsageRequestError && err.kind === "stale-login" && !login.renewable) {
          throw new PlanUsageRequestError("signed-out", "the stored Claude login has expired and can't be renewed; sign in again")
        }
        throw err
      })
      if (this.state.lastError) this.log(`[plan-usage] reading again (${login.source})`)
      this.state.reading = { windows, readAt: this.now(), source: login.source }
      this.state.lastError = null
    } catch (err) {
      const e = err instanceof PlanUsageRequestError ? err : new PlanUsageRequestError("failed", (err as Error).message)
      if (e.kind === "rate-limited") delay = Math.max(delay, e.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS)
      if (this.state.lastError?.kind !== e.kind) this.log(`[plan-usage] ${e.message}`)
      this.state.lastError = { kind: e.kind, message: e.message, at: this.now() }
    }
    if (this.state.enabled) this.schedule(delay)
    return this.getState()
  }
}

/** The reader settings from agentx.json, with their defaults. */
export function planUsageSettings(config: { session: { planUsage?: { enabled?: boolean; intervalMinutes?: number } } }): { enabled: boolean; intervalMinutes: number } {
  return { enabled: config.session.planUsage?.enabled ?? true, intervalMinutes: config.session.planUsage?.intervalMinutes ?? 5 }
}

/** The node's one reader. The daemon configures it from session.planUsage. */
export const planUsageReader = new PlanUsageReader()
