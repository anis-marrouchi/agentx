import type { IncomingMessage, ServerResponse } from "http"
import type { TokenRecord } from "./token-store"
import type { PushStore } from "@/channels/push-store"
import { readJson } from "./app-fleet"

// --- Phone app: notifications (/api/app/push*, /api/app/alerts) ---
//
// Phase 4 of the mobile epic. Runs behind the device-token check in
// app-routes.ts. A phone subscribes here; the daemon's PushAdapter reads the
// same table to deliver. Each subscription is tied to the phone's device
// token, so `agentx app revoke` also stops that phone's notifications.

export interface AppPushDeps {
  /** Null when this node doesn't send pushes itself; `reason` says why. */
  store: () => PushStore | null
  /** VAPID public key the browser subscribes with, or null without keys. */
  publicKey: () => string | null
  keepRecent: number
  reason?: string
}

const MAX_ENDPOINT = 2048
const B64URL = /^[A-Za-z0-9_-]{8,256}$/

export async function handleAppPush(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  device: TokenRecord,
  deps: AppPushDeps,
): Promise<boolean> {
  if (path !== "/api/app/push" && !path.startsWith("/api/app/push/") && path !== "/api/app/alerts") return false
  const store = deps.store()
  const publicKey = store ? deps.publicKey() : null
  const unavailable = !store
    ? deps.reason ?? "Notifications are not set up on this computer."
    : !publicKey ? "This computer has no push keys yet. On it, run: agentx app push-keys" : undefined

  if (method === "GET" && path === "/api/app/push") {
    return json(res, 200, {
      available: !unavailable,
      reason: unavailable ?? null,
      publicKey,
      subscriptions: store ? store.list(device.id).length : 0,
    })
  }
  if (method === "GET" && path === "/api/app/alerts") {
    return json(res, 200, { items: store ? store.recent(deps.keepRecent) : [] })
  }
  if (method !== "POST" || (path !== "/api/app/push/subscribe" && path !== "/api/app/push/unsubscribe")) {
    return json(res, 404, { error: "not found" })
  }
  if (!store || unavailable) return json(res, 503, { error: unavailable })

  let body: Record<string, any>
  try { body = await readJson(req) } catch (e: any) { return json(res, 400, { error: e.message }) }
  const endpoint = validEndpoint(body.endpoint)
  if (!endpoint) return json(res, 400, { error: "endpoint must be an https:// URL" })

  if (path === "/api/app/push/unsubscribe") {
    return json(res, 200, { ok: true, removed: store.unsubscribe(endpoint, device.id) })
  }
  const p256dh = body.keys?.p256dh
  const auth = body.keys?.auth
  if (typeof p256dh !== "string" || !B64URL.test(p256dh) || typeof auth !== "string" || !B64URL.test(auth)) {
    return json(res, 400, { error: "keys.p256dh and keys.auth are required" })
  }
  // An endpoint belongs to one browser. If another device had it (a phone
  // re-paired under a new name), the latest pairing takes it over.
  store.subscribe({ endpoint, p256dh, auth, deviceId: device.id, deviceName: device.name })
  return json(res, 200, { ok: true })
}

function validEndpoint(v: unknown): string | null {
  if (typeof v !== "string" || v.length > MAX_ENDPOINT) return null
  try {
    const u = new URL(v)
    // Push services are public HTTPS hosts. The daemon POSTs to whatever is
    // stored here, so refuse IP literals and localhost outright.
    const host = u.hostname.replace(/^\[|\]$/g, "")
    if (u.protocol !== "https:" || host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":")) return null
    return v
  } catch {
    return null
  }
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
