import { createHash, randomBytes } from "crypto"
import { createServer, type Server } from "http"
import type { OAuthGrant, OAuthSpec, ProviderContext, ProviderSpec } from "./providers/types"

// --- OAuth 2.0 authorization-code flow for provider specs ---
//
// Used by `agentx agent integrations connect` (sign in once) and by the
// token resolver (refresh at use time). Errors never carry a token: the
// provider's own error text is kept short and token-shaped values in it
// are cut.

export interface AuthorizeRequest {
  url: string
  state: string
  /** PKCE verifier to send with the code; absent when the spec turns PKCE off. */
  verifier?: string
  redirectUri: string
  scopes: string[]
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** The scopes a connect asks for: the spec's own plus the opted-in extras. */
export function scopesFor(spec: OAuthSpec, extras: string[] = []): { scopes: string[]; unknown: string[] } {
  const scopes = [...spec.scopes]
  const unknown: string[] = []
  for (const name of extras) {
    const add = spec.optionalScopes?.[name]
    if (!add) { unknown.push(name); continue }
    for (const s of add) if (!scopes.includes(s)) scopes.push(s)
  }
  return { scopes, unknown }
}

export function buildAuthorizeRequest(
  spec: ProviderSpec,
  clientId: string,
  redirectUri: string,
  scopes: string[] = spec.oauth.scopes,
): AuthorizeRequest {
  const state = b64url(randomBytes(18))
  const u = new URL(spec.oauth.authorizeUrl)
  u.searchParams.set("response_type", "code")
  u.searchParams.set("client_id", clientId)
  u.searchParams.set("redirect_uri", redirectUri)
  u.searchParams.set("scope", scopes.join(spec.oauth.scopeSeparator ?? " "))
  u.searchParams.set("state", state)
  let verifier: string | undefined
  if (spec.oauth.pkce !== false) {
    verifier = b64url(randomBytes(32))
    u.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()))
    u.searchParams.set("code_challenge_method", "S256")
  }
  for (const [k, v] of Object.entries(spec.oauth.authorizeParams ?? {})) u.searchParams.set(k, v)
  return { url: u.toString(), state, verifier, redirectUri, scopes }
}

/** Cut anything that looks like a token out of provider error text. */
export function safeProviderText(text: string, max = 300): string {
  return text
    .replace(/(access_token|refresh_token|client_secret|code)=([^&\s"]+)/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9_\-.~+/]{40,}/g, "[redacted]")
    .slice(0, max)
}

async function postToken(tokenUrl: string, form: Record<string, string>, f: typeof fetch): Promise<any> {
  const res = await f(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  let data: any
  try { data = JSON.parse(text) } catch { data = Object.fromEntries(new URLSearchParams(text)) }
  if (!res.ok || !data?.access_token) {
    const why = data?.error_description || data?.error?.message || data?.error || `HTTP ${res.status}`
    throw new Error(`the provider refused the token request: ${safeProviderText(String(why))}`)
  }
  return data
}

function grantFrom(data: any, asked: string[], now: number, previous?: OAuthGrant): OAuthGrant {
  const granted = typeof data.scope === "string" && data.scope.trim()
    ? data.scope.split(/[\s,]+/).filter(Boolean)
    : previous?.scopes ?? asked
  const expiresIn = Number(data.expires_in)
  return {
    accessToken: String(data.access_token),
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : previous?.refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
    scopes: granted,
    connectedAt: previous?.connectedAt ?? now,
  }
}

/** Swap the code from the callback for a grant, then run the spec's afterConnect. */
export async function exchangeCode(
  spec: ProviderSpec,
  req: AuthorizeRequest,
  code: string,
  ctx: ProviderContext,
): Promise<OAuthGrant> {
  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: req.redirectUri,
    client_id: ctx.clientId,
    client_secret: ctx.clientSecret,
  }
  if (req.verifier) form.code_verifier = req.verifier
  const grant = grantFrom(await postToken(spec.oauth.tokenUrl, form, ctx.fetch), req.scopes, ctx.now)
  return spec.oauth.afterConnect ? spec.oauth.afterConnect(grant, ctx) : grant
}

/** A fresh access token from the grant's refresh token. Keeps the refresh
 *  token unless the provider rotated it. */
export async function refreshGrant(spec: ProviderSpec, grant: OAuthGrant, ctx: ProviderContext): Promise<OAuthGrant> {
  if (!grant.refreshToken) throw new Error("no refresh token: reconnect the integration")
  const data = await postToken(spec.oauth.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: grant.refreshToken,
    client_id: ctx.clientId,
    client_secret: ctx.clientSecret,
  }, ctx.fetch)
  return grantFrom(data, grant.scopes, ctx.now, grant)
}

/** What the callback URL carried. */
export type CallbackResult = { code: string } | { error: string }

/** Read code/state/error off a redirect URL (the loopback request, or the
 *  address the owner pastes back with --paste). */
export function parseCallback(urlText: string, expectedState: string): CallbackResult {
  let u: URL
  try { u = new URL(urlText.trim(), "http://localhost") } catch { return { error: "that is not the address the browser was sent to" } }
  const err = u.searchParams.get("error")
  if (err) return { error: `the provider said ${safeProviderText(u.searchParams.get("error_description") || err)}` }
  if (u.searchParams.get("state") !== expectedState) return { error: "the sign-in answer does not match this request (state differs); start again" }
  const code = u.searchParams.get("code")
  if (!code) return { error: "the address has no code; copy the whole address from the browser bar" }
  return { code }
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`

/** Wait for one browser redirect on 127.0.0.1 (and ::1 when it exists).
 *  Only loopback: the sign-in answer never reaches another machine. */
export function waitForLoopbackCallback(
  port: number,
  expectedState: string,
  timeoutMs = 5 * 60_000,
): { ready: Promise<void>; result: Promise<CallbackResult>; close: () => void } {
  const servers: Server[] = []
  let settle!: (r: CallbackResult) => void
  const result = new Promise<CallbackResult>((res) => { settle = res })
  const close = () => { for (const s of servers) s.close() }
  const handler = (req: any, res: any) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`)
    if (url.pathname !== "/callback") { res.writeHead(404).end(); return }
    // Only an answer carrying this request's state ends the wait. Anything
    // else (another local process, a stale tab) gets a 400 and is ignored,
    // so it cannot cancel the sign-in.
    if (url.searchParams.get("state") !== expectedState) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      res.end(PAGE("Not this sign-in", "This answer does not match the sign-in AgentX is waiting for. Finish the sign-in in the tab AgentX opened."))
      return
    }
    const r = parseCallback(url.toString(), expectedState)
    res.writeHead("code" in r ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" })
    res.end("code" in r
      ? PAGE("AgentX is connected", "You can close this tab and go back to the terminal.")
      : PAGE("AgentX could not connect", r.error.replace(/[<>&]/g, "")))
    settle(r)
  }
  const listen = (host: string, required: boolean) => new Promise<void>((ok, fail) => {
    const s = createServer(handler)
    s.once("error", (e) => (required ? fail(e) : ok()))
    s.listen(port, host, () => { servers.push(s); ok() })
  })
  const ready = listen("127.0.0.1", true).then(() => listen("::1", false))
  const timer = setTimeout(() => settle({ error: "no answer from the browser within 5 minutes" }), timeoutMs)
  result.finally(() => { clearTimeout(timer); close() })
  return { ready, result, close }
}
