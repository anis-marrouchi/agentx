import type { IncomingMessage, ServerResponse } from "http"
import { TokenStore, recordHasScope, type TokenRecord } from "./token-store"
import { appIconPng } from "./app-icon"
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
// Manifest, icons, service worker and the pair page stay public. They hold
// no data, and browsers fetch manifests and icons without cookies.

export const APP_COOKIE = "agentx_app"
const COOKIE_MAX_AGE = 400 * 86400 // the longest browsers honour

export interface AppRouteCtx {
  nodeName?: string
  tokens?: TokenStore
}

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
  }

  // Trade a device token for the session cookie. The token arrives in the
  // Authorization header (never the URL); it must carry the `app` scope.
  if (method === "POST" && path === "/api/app/session") {
    const rec = verifyAppToken(bearer(req), tokens)
    if (!rec) return sendJson(res, 401, { error: "invalid or revoked device token" })
    res.setHeader("Set-Cookie", `${APP_COOKIE}=${bearer(req)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`)
    return sendJson(res, 200, { device: rec.name })
  }

  const rec = verifyAppToken(appToken(req), tokens)
  if (!rec) {
    if (path === "/app") return send(res, 401, "text/html; charset=utf-8", renderAppLockedPage())
    return sendJson(res, 401, { error: "this device is not paired", hint: "run: agentx app pair" })
  }

  if (method === "GET" && path === "/app") return send(res, 200, "text/html; charset=utf-8", renderAppPage())
  if (method === "GET" && path === "/api/app/me") {
    return sendJson(res, 200, { id: rec.id, device: rec.name, node: ctx.nodeName ?? null })
  }
  return sendJson(res, 404, { error: "not found" })
}

/** Returns the record for an active token carrying the `app` scope, else null. */
export function verifyAppToken(token: string | null, tokens: TokenStore): TokenRecord | null {
  if (!token) return null
  const rec = tokens.verify(token)
  return rec && recordHasScope(rec, "app") ? rec : null
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
