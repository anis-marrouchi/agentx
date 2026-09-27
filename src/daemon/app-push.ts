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
  /** channels.push.allowedHosts: push services a phone may subscribe with. */
  allowedHosts: string[]
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
      // Only rows made with the current key count, so a phone subscribed
      // before `push-keys --force` sees 0 and subscribes again.
      subscriptions: store && publicKey ? store.list(device.id).filter((s) => s.publicKey === publicKey).length : 0,
    })
  }
  if (method === "GET" && path === "/api/app/alerts") {
    return json(res, 200, { items: store ? store.recent(deps.keepRecent, device.id) : [] })
  }
  if (method !== "POST" || (path !== "/api/app/push/subscribe" && path !== "/api/app/push/unsubscribe")) {
    return json(res, 404, { error: "not found" })
  }
  if (!store || unavailable) return json(res, 503, { error: unavailable })

  let body: Record<string, any>
  try { body = await readJson(req) } catch (e: any) { return json(res, 400, { error: e.message }) }
  const endpoint = validEndpoint(body.endpoint, deps.allowedHosts)
  if (!endpoint) {
    let host = ""
    try { host = new URL(String(body.endpoint)).hostname } catch { /* not a URL */ }
    return json(res, 400, { error: `not a known push service${host ? `: ${host}` : ""} (see channels.push.allowedHosts)` })
  }

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
  // The browser subscribed with the key GET /api/app/push just handed it;
  // `publicKey` in the body must match it, so a stale page can't store a
  // subscription made with replaced keys.
  if (body.publicKey !== undefined && body.publicKey !== publicKey) {
    return json(res, 409, { error: "this computer's push keys changed; turn notifications on again" })
  }
  store.subscribe({ endpoint, p256dh, auth, deviceId: device.id, deviceName: device.name, publicKey: publicKey! })
  return json(res, 200, { ok: true })
}

/** The endpoint if it is https on an allowed push-service host (or a
 *  subdomain of one). The daemon POSTs to whatever is stored, so a name
 *  that merely looks public (and may resolve inside the network) is refused. */
export function validEndpoint(v: unknown, allowedHosts: string[]): string | null {
  if (typeof v !== "string" || v.length > MAX_ENDPOINT) return null
  try {
    const u = new URL(v)
    if (u.protocol !== "https:" || u.port || u.username || u.password) return null
    const host = u.hostname.toLowerCase()
    const ok = allowedHosts.some((h) => {
      const allowed = h.toLowerCase().replace(/^\.+|\.+$/g, "")
      return !!allowed && (host === allowed || host.endsWith("." + allowed))
    })
    return ok ? v : null
  } catch {
    return null
  }
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
