import { createHmac, timingSafeEqual } from "crypto"
import type { IncomingMessage, ServerResponse } from "http"
import { isLoopback } from "./mesh-auth"

// --- Who may see dashboard.token in a page (#1306) ---
//
// Dashboard pages used to carry dashboard.token as window.AX_LOCAL_TOKEN for
// every caller, so anyone who could reach a non-loopback bind could read it
// and call /api/admin/*. Now only a caller on this machine gets it. A browser
// on another machine signs in once at /login and gets a session cookie; the
// API gates accept that cookie, so its pages need no token.
//
// Pure helpers plus the /login page; board-dashboard.ts wires them in.

export const SESSION_COOKIE = "ax_session"
const SESSION_MAX_AGE_S = 30 * 24 * 3600

/** True unless the socket peer is on this host and no proxy says the request
 *  came from somewhere else. A reverse proxy on this machine (one that
 *  publishes the board on a tailnet, say) connects from loopback for every
 *  caller, so a forwarded request is treated as off-box. */
export function isOffBox(req: IncomingMessage): boolean {
  const h = req.headers
  if (h["x-forwarded-for"] || h.forwarded || h["x-real-ip"]) return true
  return !isLoopback(req.socket.remoteAddress || "")
}

/** The cookie value for a token: an HMAC, so the token itself never sits in
 *  the browser, and rotating dashboard.token signs every browser out. */
export function sessionValue(token: string): string {
  return createHmac("sha256", token).update("agentx-dashboard-session-v1").digest("base64url")
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function cookie(req: IncomingMessage, name: string): string {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=")
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return ""
}

/** The Set-Cookie header of a session for this token: /login's, and the
 *  owner's sign-in by email link once its browser is confirmed (#1478). */
export function sessionCookieHeader(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${sessionValue(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_S}${secure ? "; Secure" : ""}`
}

/** True when the request carries a session cookie for this token. */
export function hasSession(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return false
  const got = cookie(req, SESSION_COOKIE)
  return !!got && sameSecret(got, sessionValue(token))
}

/** What a page may embed as AX_LOCAL_TOKEN: the token for a caller on this
 *  machine, nothing for anyone else. */
export function pageToken(req: IncomingMessage, token: string | undefined): string | undefined {
  return token && !isOffBox(req) ? token : undefined
}

// --- Stream tickets (#1305 follow-up) ---
//
// EventSource cannot send an Authorization header, so a page on this machine
// (which holds AX_LOCAL_TOKEN but no session cookie) trades the token for a
// ticket at POST /api/admin/stream-ticket and puts it in the stream URL as
// ?st=. A ticket is an expiry plus an HMAC keyed by the token: it opens a
// stream for a minute, never names the token, and dies with a token rotation.

export const STREAM_TICKET_TTL_S = 60

function ticketMac(token: string, exp: number): string {
  return createHmac("sha256", token).update(`agentx-stream-ticket-v1:${exp}`).digest("base64url")
}

/** A ticket for `token` that opens a stream until now + STREAM_TICKET_TTL_S. */
export function streamTicket(token: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + STREAM_TICKET_TTL_S
  return `${exp}.${ticketMac(token, exp)}`
}

/** True when the request URL carries an unexpired ticket for this token. */
export function hasStreamTicket(req: IncomingMessage, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false
  let got = ""
  try { got = new URL(req.url || "/", "http://_").searchParams.get("st") || "" } catch { return false }
  const dot = got.indexOf(".")
  const exp = Number(got.slice(0, dot))
  if (dot <= 0 || !Number.isInteger(exp) || exp * 1000 < now) return false
  return sameSecret(got.slice(dot + 1), ticketMac(token, exp))
}

/** Only a path on this server; anything else goes home. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/"
}

/** Send an off-box caller with no session to /login, back to `path` after. */
export function redirectToLogin(res: ServerResponse, path: string): void {
  res.writeHead(302, { Location: "/login?next=" + encodeURIComponent(path), "Cache-Control": "no-store" })
  res.end()
}

function loginPage(next: string, failed: boolean): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · AgentX</title>
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f6f4;color:#222}
form{background:#fff;padding:24px;border-radius:10px;box-shadow:0 1px 4px #0002;display:grid;gap:12px;min-width:280px}
input,button{font:inherit;padding:8px 10px}p.err{color:#b00020;margin:0}</style></head><body>
<form method="post" action="/login">
<h1 style="font-size:18px;margin:0">Sign in to this dashboard</h1>
<label>Dashboard token<br><input type="password" name="token" autocomplete="current-password" autofocus required></label>
<input type="hidden" name="next" value="${esc(next)}">
${failed ? '<p class="err">That token is not right.</p>' : ""}
<button type="submit">Sign in</button>
</form></body></html>`
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let body = ""
  for await (const chunk of req) {
    body += chunk
    if (body.length > 8192) break
  }
  return new URLSearchParams(body)
}

/** GET and POST /login. Returns false for any other request. */
export async function handleLogin(
  req: IncomingMessage, res: ServerResponse, url: URL, method: string, token: string | undefined,
): Promise<boolean> {
  if (url.pathname !== "/login") return false
  if (!token) {
    res.writeHead(302, { Location: "/" })
    res.end()
    return true
  }
  if (method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(loginPage(safeNext(url.searchParams.get("next")), false))
    return true
  }
  if (method !== "POST") return false
  const form = await readForm(req)
  const next = safeNext(form.get("next"))
  if (!sameSecret(form.get("token") || "", token)) {
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(loginPage(next, true))
    return true
  }
  const secure = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"
  res.writeHead(303, {
    Location: next,
    "Set-Cookie": sessionCookieHeader(token, secure),
    "Cache-Control": "no-store",
  })
  res.end()
  return true
}
