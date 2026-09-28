import type { IncomingMessage, ServerResponse } from "http"
import { readFileSync } from "fs"
import { createRequire } from "module"
import { TokenStore, recordHasScope, type TokenRecord } from "./token-store"
import { appIconPng } from "./app-icon"
import { handleAppFleet, type AppFleetDeps } from "./app-fleet"
import { handleAppPush, type AppPushDeps } from "./app-push"
import { handleAppChat, type AppChatDeps } from "./app-chat"
import { handleAppFiles } from "./app-files"
import { handleAppVoice, type AppVoiceDeps } from "./app-voice"
import { PairAttemptLimiter, redeemPairCode } from "./app-pair-code"
import { PairCodeStore } from "./pair-codes"
import { RejectLog, credentialState, rejectFields } from "./app-auth-log"
import {
  APP_SERVICE_WORKER,
  renderAppLockedPage,
  renderAppManifest,
  renderAppPage,
  renderAppPairPage,
} from "./ui/pages/app"

// --- Phone app routes: /app and /api/app/* ---
//
// Unlike the rest of the dashboard there is NO loopback exemption here.
// `tailscale serve` terminates HTTPS and proxies from 127.0.0.1, so every
// phone request looks local; the only thing that says "this is a paired
// phone" is its device token. Each phone gets its own token with the single
// scope `app` (minted by `agentx app pair`), so revoking one phone never
// touches another, and an app token opens nothing outside these routes —
// the dashboard gates require `dashboard:*` scopes it doesn't carry.
//
// The browser holds the token in an HttpOnly cookie set by
// POST /api/app/session; scripts and non-browser clients can send it as a
// Bearer header instead. Deliberately no `?token=` fallback: URLs end up in
// history and proxy logs.
//
// Manifest, icons, service worker, the QR decoder and the pair page stay public. They hold
// no data, and browsers fetch manifests and icons without cookies. So does
// POST /api/app/pair-code: it trades a one-time code from `agentx app pair`
// for the same cookie, for the installed app that can't see Safari's cookie
// (see app-pair-code.ts for its guessing limits).

export const APP_COOKIE = "agentx_app"
const COOKIE_MAX_AGE = 400 * 86400 // the longest browsers honour

export interface AppRouteCtx {
  nodeName?: string
  tokens?: TokenStore
  fleet?: AppFleetDeps
  push?: AppPushDeps
  chat?: AppChatDeps
  voice?: AppVoiceDeps
  pairCodes?: PairCodeStore
  pairLimiter?: PairAttemptLimiter
  /** Minimum duration of a pair-code attempt (tests shorten it). */
  pairMinMs?: number
  /** Where refused requests are traced (tests pass their own). */
  rejectLog?: RejectLog
}

/** One limiter per dashboard process: the global cap must span requests. */
const defaultPairLimiter = new PairAttemptLimiter()
/** Likewise one rate limit for the "unauthenticated" trace lines. */
const defaultRejectLog = new RejectLog()

/** Handles the request and returns true if `path` belongs to the phone app. */
export async function handleAppRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  ctx: AppRouteCtx = {},
): Promise<boolean> {
  if (path !== "/app" && !path.startsWith("/app/") && !path.startsWith("/api/app/")) return false
  const tokens = ctx.tokens ?? new TokenStore()

  if (method === "GET") {
    if (path === "/app/manifest.webmanifest") return send(res, 200, "application/manifest+json", renderAppManifest())
    if (path === "/app/sw.js") {
      res.setHeader("Service-Worker-Allowed", "/app")
      return send(res, 200, "text/javascript; charset=utf-8", APP_SERVICE_WORKER)
    }
    if (path === "/app/icon-192.png") return send(res, 200, "image/png", appIconPng(192), "public, max-age=86400")
    if (path === "/app/icon-512.png") return send(res, 200, "image/png", appIconPng(512), "public, max-age=86400")
    if (path === "/app/pair") return send(res, 200, "text/html; charset=utf-8", renderAppPairPage())
    if (path === "/app/qr.js") {
      const js = qrDecoderJs()
      return js ? send(res, 200, "text/javascript; charset=utf-8", js, "public, max-age=2592000") : sendJson(res, 404, { error: "not found" })
    }
  }

  // Trade a device token for the session cookie. The token arrives in the
  // Authorization header (never the URL); it must carry the `app` scope.
  if (method === "POST" && path === "/api/app/session") {
    const rec = verifyAppToken(bearer(req), tokens)
    if (!rec) return sendJson(res, 401, { error: "invalid or revoked device token" })
    // Path=/ because one cookie must cover both /app and /api/app. Over the
    // path-scoped `tailscale serve` setup in the guide, no other dashboard
    // route is reachable from the phone anyway.
    res.setHeader("Set-Cookie", sessionCookie(bearer(req)!))
    return sendJson(res, 200, { device: rec.name })
  }

  // Trade a one-time pairing code for the same cookie.
  if (method === "POST" && path === "/api/app/pair-code") {
    const result = await redeemPairCode(req, {
      codes: ctx.pairCodes ?? new PairCodeStore(),
      limiter: ctx.pairLimiter ?? defaultPairLimiter,
      verify: (token) => verifyAppToken(token, tokens)?.name ?? null,
      minMs: ctx.pairMinMs,
    })
    if (result.status === 200) res.setHeader("Set-Cookie", sessionCookie(result.token))
    if (result.status === 429) res.setHeader("Retry-After", String(result.retryAfter))
    return sendJson(res, result.status, result.body)
  }

  const rec = verifyAppToken(appToken(req), tokens)
  if (!rec) {
    const sent = bearer(req)
    ;(ctx.rejectLog ?? defaultRejectLog).record(
      path.slice(0, 120),
      rejectFields(req, credentialState(cookie(req, APP_COOKIE), tokens), sent ? credentialState(sent, tokens) : null),
    )
    if (path === "/app") return send(res, 401, "text/html; charset=utf-8", renderAppLockedPage())
    return sendJson(res, 401, { error: "this device is not paired", hint: "run: agentx app pair" })
  }

  if (method === "GET" && path === "/app") {
    // Set the cookie again on each app load, so phones paired while it was
    // SameSite=Strict move to Lax without pairing again.
    const c = cookie(req, APP_COOKIE)
    if (c && !bearer(req)) res.setHeader("Set-Cookie", sessionCookie(c))
    return send(res, 200, "text/html; charset=utf-8", renderAppPage())
  }
  if (method === "GET" && path === "/api/app/me") {
    return sendJson(res, 200, { id: rec.id, device: rec.name, node: ctx.nodeName ?? null })
  }
  if (ctx.fleet && await handleAppFleet(req, res, path, method, rec.name, ctx.fleet)) return true
  if (ctx.push && await handleAppPush(req, res, path, method, rec, ctx.push)) return true
  if (ctx.chat && await handleAppChat(req, res, path, method, rec, ctx.chat)) return true
  if (ctx.chat && await handleAppFiles(req, res, path, method, rec, ctx.chat)) return true
  if (ctx.voice && await handleAppVoice(req, res, path, method, rec, ctx.voice)) return true
  return sendJson(res, 404, { error: "not found" })
}

/** The QR decoder the locked page loads when the owner taps Scan and the
 *  browser has no BarcodeDetector (iOS Safari). It is jsQR
 *  (https://github.com/cozmo/jsQR, by Cosmo Wolfe and contributors), the
 *  `jsqr` dependency's dist file served unmodified under the Apache
 *  License 2.0 (node_modules/jsqr/LICENSE); a notice naming it and its
 *  licence is prepended. Public like the icons: it is a library, holds no
 *  data, and the unpaired page needs it. Read once from the installed
 *  package, so it is not bundled into dist/. */
let qrJs: Buffer | null | undefined
export function qrDecoderJs(): Buffer | null {
  if (qrJs !== undefined) return qrJs
  try {
    const req = createRequire(import.meta.url)
    const { version } = req("jsqr/package.json") as { version: string }
    const notice = `/*! jsQR ${version} | Apache-2.0 | https://github.com/cozmo/jsQR */\n`
    qrJs = Buffer.concat([Buffer.from(notice), readFileSync(req.resolve("jsqr"))])
  } catch (e: any) {
    console.error(`[app] QR decoder unavailable (install the jsqr package): ${e.message}`)
    qrJs = null
  }
  return qrJs
}

/** Returns the record for an active token carrying the `app` scope, else null. */
export function verifyAppToken(token: string | null, tokens: TokenStore): TokenRecord | null {
  if (!token) return null
  const rec = tokens.verify(token)
  return rec && recordHasScope(rec, "app") ? rec : null
}

/** The one place the session cookie is built, for both the Bearer route
 *  and the pair-code route.
 *
 *  SameSite=Lax, not Strict (#234). An app on the iOS home screen opens and
 *  resumes /app with a top-level navigation that WebKit may treat as coming
 *  from outside the site, and a Strict cookie is then left off: the phone
 *  looked unpaired after every update or restart and the owner paired again.
 *  Lax sends the cookie on top-level GET navigations, which is all that
 *  changes.
 *
 *  POSTs stay protected. Lax still leaves the cookie off cross-site POSTs
 *  and subresource requests, and the dashboard rejects any state-changing
 *  request whose Origin is another site with a 403 before it reaches these
 *  routes (classifyBrowserRequest in board-dashboard.ts). A cross-site GET
 *  can at most open the app page; every GET under /api/app only reads. */
export function sessionCookie(token: string): string {
  return `${APP_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
}

function appToken(req: IncomingMessage): string | null {
  return bearer(req) ?? cookie(req, APP_COOKIE)
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization || ""
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() || null : null
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=")
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null
  }
  return null
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, cache = "no-store"): true {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": cache })
  res.end(body)
  return true
}

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  return send(res, status, "application/json", JSON.stringify(body))
}
