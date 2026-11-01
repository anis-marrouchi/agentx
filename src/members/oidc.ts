import type { IncomingMessage } from "http"
import { createHash, randomBytes } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import type { Person } from "@/people/people"
import { clientAddress, machineName } from "./pairing"
import { SIGN_IN_ROLES, openSession, personByEmail, type SignInDeps, type SignInResult } from "./signin"

// --- Signing in with an OpenID Connect provider, such as Google (#1675) ---
//
// A configured sign-in provider (`wall.signIn.oidc`), nothing written for
// one provider only. It proves an email address, as the mailed link does;
// from there the person is let in exactly as by link (openSession): a
// personal ax_person session, the owner's card on a first sign-in.
//
//   flow     the authorization code flow with PKCE (S256), `state` and
//            `nonce`, scopes `openid email`. The state lives in memory for
//            10 minutes and is bound to this browser by a cookie.
//   the code is exchanged by the Wall itself, at the provider's token
//            endpoint over TLS, with the client secret. The ID token comes
//            straight from there, so its issuer is checked by TLS (OpenID
//            Connect Core 3.1.3.7) instead of a signature; the Wall keeps
//            no provider token.
//   counts   only a verified address, of `hd` when that is set, whose
//            person is a member or a client (SIGN_IN_ROLES).
//   bound    the first account that signs in for a person is kept
//            (.agentx/signin-accounts.json); another account later showing
//            the same address is refused, so a recycled address gets nobody in.

export const STATE_TTL_MS = 10 * 60 * 1000
export const STATE_COOKIE = "ax_oidc"
export const CALLBACK_PATH = "/member/signin/oidc/done"
export const PROVIDER_FAILED = "That sign-in did not work. Try again, or ask for a link by email."
const MAX_PENDING = 200
const ACCOUNTS_FILE = ".agentx/signin-accounts.json"

export interface OidcSetup {
  /** The button reads "Sign in with <name>". */
  name: string
  issuer: string
  clientId: string
  clientSecret: string
  /** Only accounts of this hosted domain (Google Workspace). */
  hd?: string
  /** `wall.signIn.origin`: the return address is fixed on it. */
  origin: string
  firstSignIn: "card" | "auto"
}

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string }
interface Pending { verifier: string; nonce: string; label: string; expiresAt: number }

const hashOf = (s: string) => createHash("sha256").update(s).digest("base64url")
export const redirectUri = (origin: string) => `${origin.replace(/\/+$/, "")}${CALLBACK_PATH}`

/** Sign-ins started and not back yet, by the hash of their state. */
export class OidcStateStore {
  private pending = new Map<string, Pending>()
  constructor(private now: () => number = Date.now) {}

  create(label: string): { state: string; verifier: string; nonce: string } {
    const t = this.now()
    for (const [k, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(k)
    // Oldest first out, so a flood of starts cannot grow it without end.
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!)
    const state = randomBytes(32).toString("base64url")
    const verifier = randomBytes(32).toString("base64url")
    const nonce = randomBytes(16).toString("base64url")
    this.pending.set(hashOf(state), { verifier, nonce, label, expiresAt: t + STATE_TTL_MS })
    return { state, verifier, nonce }
  }

  /** The pending sign-in for `state`, once; null if unknown or old. */
  spend(state: unknown): Pending | null {
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) return null
    const key = hashOf(state)
    const found = this.pending.get(key) ?? null
    this.pending.delete(key)
    return found && found.expiresAt > this.now() ? found : null
  }
}

/** The account each person first signed in with, per provider. */
export class SignInAccountStore {
  private file: string
  constructor(baseDir: string = process.cwd()) { this.file = resolve(baseDir, ACCOUNTS_FILE) }

  /** The subject kept for this person at this issuer, if any. */
  get(personId: string, issuer: string): string | null {
    return this.read()[`${personId} ${issuer}`] ?? null
  }

  /** The person this account was bound to, if any. */
  personOf(issuer: string, subject: string): string | null {
    for (const [k, v] of Object.entries(this.read())) if (v === subject && k.endsWith(` ${issuer}`)) return k.slice(0, -issuer.length - 1)
    return null
  }

  bind(personId: string, issuer: string, subject: string): void {
    const all = this.read()
    all[`${personId} ${issuer}`] = subject
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(tmp, JSON.stringify({ accounts: all }, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })
    renameSync(tmp, this.file)
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {}
    try {
      const a = JSON.parse(readFileSync(this.file, "utf-8")).accounts
      return a && typeof a === "object" ? a : {}
    } catch { return {} }
  }
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

const discoveries = new Map<string, Promise<Discovery>>()

/** The provider's discovery document, read once per issuer. */
export function discover(issuer: string, fetchFn: Fetch = fetch): Promise<Discovery> {
  let found = discoveries.get(issuer)
  if (!found) {
    found = (async () => {
      const r = await fetchFn(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new Error(`discovery answered ${r.status}`)
      const d = await r.json() as Discovery
      if (d.issuer !== issuer) throw new Error(`discovery names issuer ${d.issuer}, not ${issuer}`)
      for (const k of ["authorization_endpoint", "token_endpoint"] as const) {
        if (typeof d[k] !== "string" || !d[k].startsWith("https://")) throw new Error(`discovery has no https ${k}`)
      }
      return d
    })()
    found.catch(() => discoveries.delete(issuer))
    discoveries.set(issuer, found)
  }
  return found
}

export interface OidcDeps extends SignInDeps {
  states: OidcStateStore
  accounts: SignInAccountStore
  oidc: () => OidcSetup | null
  fetch?: Fetch
}

export type StartResult = { status: 302; location: string; state: string } | { status: 404 | 502; error: string }

/** GET /member/signin/oidc?machine=…: off to the provider. */
export async function startOidc(url: URL, deps: OidcDeps): Promise<StartResult> {
  const setup = deps.oidc()
  if (!setup) return { status: 404, error: "Signing in with an account is not set up here." }
  let d: Discovery
  try { d = await discover(setup.issuer, deps.fetch) } catch (err) {
    ;(deps.log ?? console.log)(`[member] sign-in with ${setup.name}: ${err instanceof Error ? err.message : String(err)}`)
    return { status: 502, error: PROVIDER_FAILED }
  }
  const { state, verifier, nonce } = deps.states.create(machineName(url.searchParams.get("machine")))
  const q = new URLSearchParams({
    response_type: "code", client_id: setup.clientId, redirect_uri: redirectUri(setup.origin),
    scope: "openid email", state, nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    prompt: "select_account",
  })
  if (setup.hd) q.set("hd", setup.hd)
  return { status: 302, location: `${d.authorization_endpoint}?${q}`, state }
}

/** The claims of an ID token, unverified: only for one taken from the token endpoint. */
export function idTokenClaims(token: unknown): Record<string, any> | null {
  if (typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) } catch { return null }
}

/** What is wrong with these claims, or null. `iss` may also come without
 *  its scheme, as Google sends it sometimes. */
export function claimsProblem(c: Record<string, any>, setup: OidcSetup, nonce: string, now: number): string | null {
  if (c.iss !== setup.issuer && `https://${c.iss}` !== setup.issuer) return `issuer ${c.iss}`
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud]
  if (!aud.includes(setup.clientId)) return "audience"
  if (aud.length > 1 && c.azp !== setup.clientId) return "authorized party"
  if (typeof c.exp !== "number" || c.exp * 1000 <= now) return "expired"
  if (c.nonce !== nonce) return "nonce"
  if (typeof c.sub !== "string" || !c.sub) return "no subject"
  if (typeof c.email !== "string" || !c.email) return "no email"
  if (c.email_verified !== true && c.email_verified !== "true") return "email not verified"
  if (setup.hd && c.hd !== setup.hd) return `hosted domain ${c.hd ?? "none"}`
  return null
}

export type DoneResult = SignInResult | { status: 502; body: { error: string } }

/** GET /member/signin/oidc/done?code&state: back from the provider. */
export async function finishOidc(req: IncomingMessage, url: URL, stateCookie: string | null, deps: OidcDeps): Promise<DoneResult> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const now = (deps.now ?? Date.now)()
  const setup = deps.oidc()
  if (!setup) return { status: 404, body: { error: "Signing in with an account is not set up here." } }
  const client = clientAddress(req)
  const wait = deps.limiter.retryAfter(client)
  if (wait > 0) return { status: 429, body: { error: "too many attempts", retryAfter: wait }, retryAfter: wait }
  const fail = (why: string, personId?: string): DoneResult => {
    deps.limiter.fail(client)
    if (personId) deps.members.log({ person: personId, event: "refused", address: client, detail: `sign-in with ${setup.name}: ${why}` })
    log(`[member] sign-in with ${setup.name} failed from ${client}: ${why}`)
    return { status: 401, body: { error: PROVIDER_FAILED } }
  }

  const state = url.searchParams.get("state")
  // The state must come back to the browser that started it.
  if (!state || state !== stateCookie) return fail("state does not match this browser")
  const pending = deps.states.spend(state)
  if (!pending) return fail("unknown or old state")
  if (url.searchParams.get("error")) return fail(`provider said ${url.searchParams.get("error")!.slice(0, 60)}`)
  const code = url.searchParams.get("code")
  if (!code) return fail("no code")

  let claims: Record<string, any> | null
  try {
    const d = await discover(setup.issuer, deps.fetch)
    const r = await (deps.fetch ?? fetch)(d.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: redirectUri(setup.origin),
        client_id: setup.clientId, client_secret: setup.clientSecret, code_verifier: pending.verifier,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) {
      log(`[member] sign-in with ${setup.name}: token endpoint answered ${r.status}`)
      return { status: 502, body: { error: PROVIDER_FAILED } }
    }
    claims = idTokenClaims((await r.json() as { id_token?: unknown }).id_token)
  } catch (err) {
    log(`[member] sign-in with ${setup.name}: ${err instanceof Error ? err.message : String(err)}`)
    return { status: 502, body: { error: PROVIDER_FAILED } }
  }
  if (!claims) return fail("no ID token")
  const problem = claimsProblem(claims, setup, pending.nonce, now)
  if (problem) return fail(problem)

  const person = matchPerson(deps.people(), claims.email, claims.sub, setup.issuer, deps.accounts)
  if ("refused" in person) return fail(person.refused, person.personId)
  deps.limiter.succeed(client)
  if (!deps.accounts.get(person.id, setup.issuer)) deps.accounts.bind(person.id, setup.issuer, claims.sub)
  return openSession(req, person, pending.label, { via: setup.name, proof: `${person.name.slice(0, 60)}'s ${setup.name} account` }, setup, deps)
}

/** The person this account signs in as, or why nobody. */
export function matchPerson(
  people: Person[], email: string, subject: string, issuer: string, accounts: SignInAccountStore,
): Person | { refused: string; personId?: string } {
  const person = personByEmail(people, email)
  if (!person) {
    const bound = accounts.personOf(issuer, subject)
    return { refused: bound ? "the address on this account changed" : "unknown address", personId: bound ?? undefined }
  }
  if (!SIGN_IN_ROLES.includes(person.role)) return { refused: `role ${person.role}`, personId: person.id }
  const kept = accounts.get(person.id, issuer)
  if (kept && kept !== subject) return { refused: "another account than the one first used", personId: person.id }
  const other = accounts.personOf(issuer, subject)
  if (other && other !== person.id) return { refused: `this account is ${other}'s`, personId: person.id }
  return person
}
