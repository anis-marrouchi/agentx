import type { IncomingMessage, ServerResponse } from "http"
import type { TokenRecord } from "./token-store"
import type { PushStore } from "@/channels/push-store"
import { PUSH_PREFS, type PushPrefName } from "@/channels/push-prefs"
import { readJson } from "./app-fleet"

// --- Phone app: notifications (/api/app/push*, /api/app/alerts) ---
//
// Phase 4 of the mobile epic. Runs behind the device-token check in
// app-routes.ts. A phone subscribes here; the daemon's PushAdapter reads the
// same table to deliver. Each subscription is tied to the phone's device
// token, so `agentx app revoke` also stops that phone's notifications.
//
// On a node that relays pushes (channels.push.relayTo), `forward` is set and
// every call goes to the push host instead, through this node's daemon and
// the mesh (push-bridge.ts), so a phone paired with any node can turn
// notifications on (#711).

export interface AppPushDeps {
  /** Null when this node doesn't send pushes itself; `reason` says why. */
  store: () => PushStore | null
  /** VAPID public key the browser subscribes with, or null without keys. */
  publicKey: () => string | null
  keepRecent: number
  /** channels.push.allowedHosts: push services a phone may subscribe with. */
  allowedHosts: string[]
  reason?: string
  /** Set on a relaying node: sends each call to the push host. */
  forward?: (call: AppPushCall) => Promise<AppPushResult>
}

/** One phone-app push request, as handled here or by the push host. */
export interface AppPushCall {
  path: string
  method: string
  body: Record<string, any>
  device: { id: string; name: string }
}

export interface AppPushResult {
  status: number
  body: unknown
}

/** The routes this module answers. */
export function isAppPushPath(path: string): boolean {
  return path === "/api/app/push" || path.startsWith("/api/app/push/") || path === "/api/app/alerts"
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
  if (!isAppPushPath(path)) return false
  let body: Record<string, any> = {}
  if (method === "POST") {
    try { body = await readJson(req) } catch (e: any) { return json(res, 400, { error: e.message }) }
  }
  const call: AppPushCall = { path, method, body, device: { id: device.id, name: device.name } }
  if (!deps.forward) {
    const out = runAppPush(call, deps)
    return json(res, out.status, out.body)
  }
  let out: AppPushResult
  try {
    out = await deps.forward(call)
    relayedPush.note(call, out)
  } catch (e: any) {
    out = unreachable(call, `${deps.reason ?? "Can't reach the computer that sends notifications"}: ${e?.message ?? e}`)
  }
  return json(res, out.status, out.body)
}

/** On a relaying node: what the push host last said about each phone, for
 *  the checks that must answer at once (a finish notification, the
 *  announcement switch). Filled from the phone's own calls on their way
 *  through, so it is as fresh as the phone's last look at Alerts. */
export class RelayedPushState {
  private phones = new Map<string, { subscribed: boolean; prefs: Record<string, boolean> }>()

  note(call: AppPushCall, out: AppPushResult): void {
    if (out.status !== 200 || !out.body || typeof out.body !== "object") return
    const body = out.body as Record<string, any>
    const phone = this.phones.get(call.device.id) ?? { subscribed: false, prefs: {} }
    if (call.method === "GET" && call.path === "/api/app/push") {
      phone.subscribed = body.available === true && Number(body.subscriptions) > 0
      phone.prefs = pickPrefs(body)
    } else if (call.path === "/api/app/push/prefs") {
      phone.prefs = { ...phone.prefs, ...pickPrefs(body) }
    } else if (call.path === "/api/app/push/subscribe") {
      phone.subscribed = true
    } else if (call.path === "/api/app/push/unsubscribe") {
      if (body.removed) phone.subscribed = false
    } else {
      return
    }
    this.phones.set(call.device.id, phone)
  }

  /** A switch as last seen, or its default. */
  on(deviceId: string, name: PushPrefName): boolean {
    return this.phones.get(deviceId)?.prefs[PUSH_PREFS[name].field] ?? PUSH_PREFS[name].default
  }

  /** Subscribed and wanting finish notifications, as far as last seen. */
  finishOn(deviceId: string): boolean {
    return !!this.phones.get(deviceId)?.subscribed && this.on(deviceId, "finish")
  }
}

/** One per dashboard process. */
export const relayedPush = new RelayedPushState()

function pickPrefs(body: Record<string, any>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const p of Object.values(PUSH_PREFS)) if (typeof body[p.field] === "boolean") out[p.field] = body[p.field]
  return out
}

/** What a relaying node answers when the push host can't be reached: the
 *  Alerts card says why instead of failing to load. */
function unreachable(call: AppPushCall, reason: string): AppPushResult {
  if (call.method === "GET" && call.path === "/api/app/push") {
    return { status: 200, body: { available: false, reason, publicKey: null, subscriptions: 0, ...prefDefaults() } }
  }
  if (call.method === "GET" && call.path === "/api/app/alerts") return { status: 200, body: { items: [], error: reason } }
  return { status: 502, body: { error: reason } }
}

/** Answers one call against this node's own subscriptions table. Used for
 *  a phone paired here, and by the push host for a phone paired with a
 *  relaying node (push-bridge.ts), whose device id is then scoped to it. */
export function runAppPush(call: AppPushCall, deps: AppPushDeps): AppPushResult {
  const { path, method, body, device } = call
  if (!isAppPushPath(path)) return { status: 404, body: { error: "not found" } }
  const store = deps.store()
  const publicKey = store ? deps.publicKey() : null
  const unavailable = !store
    ? deps.reason ?? "Notifications are not set up on this computer."
    : !publicKey ? "This computer has no push keys yet. On it, run: agentx app push-keys" : undefined

  if (method === "GET" && path === "/api/app/push") {
    return ok(200, {
      available: !unavailable,
      reason: unavailable ?? null,
      publicKey,
      // Only rows made with the current key count, so a phone subscribed
      // before `push-keys --force` sees 0 and subscribes again.
      subscriptions: store && publicKey ? store.list(device.id).filter((s) => s.publicKey === publicKey).length : 0,
      // Per-phone switches (push-prefs.ts): chatFinish, announce.
      ...(store ? store.prefs.all(device.id) : prefDefaults()),
    })
  }
  if (method === "GET" && path === "/api/app/alerts") {
    return ok(200, { items: store ? store.recent(deps.keepRecent, device.id) : [] })
  }
  if (method !== "POST" || (path !== "/api/app/push/subscribe" && path !== "/api/app/push/unsubscribe" && path !== "/api/app/push/prefs")) {
    return ok(404, { error: "not found" })
  }
  if (!store || unavailable) return ok(503, { error: unavailable })

  if (path === "/api/app/push/prefs") {
    // Any of the switches, each true or false; answers with those it set.
    const changes = (Object.keys(PUSH_PREFS) as PushPrefName[]).filter((n) => body[PUSH_PREFS[n].field] !== undefined)
    const fields = changes.map((n) => PUSH_PREFS[n].field).join(", ")
    const all = Object.values(PUSH_PREFS).map((p) => p.field).join(" or ")
    if (changes.length === 0) return ok(400, { error: `send ${all}, true or false` })
    if (changes.some((n) => typeof body[PUSH_PREFS[n].field] !== "boolean")) return ok(400, { error: `${fields} must be true or false` })
    const out: Record<string, boolean> = {}
    for (const n of changes) {
      store.prefs.set(device.id, n, body[PUSH_PREFS[n].field])
      out[PUSH_PREFS[n].field] = body[PUSH_PREFS[n].field]
    }
    return ok(200, { ok: true, ...out })
  }
  const endpoint = validEndpoint(body.endpoint, deps.allowedHosts)
  if (!endpoint) {
    let host = ""
    try { host = new URL(String(body.endpoint)).hostname } catch { /* not a URL */ }
    return ok(400, { error: `not a known push service${host ? `: ${host}` : ""} (see channels.push.allowedHosts)` })
  }

  if (path === "/api/app/push/unsubscribe") {
    return ok(200, { ok: true, removed: store.unsubscribe(endpoint, device.id) })
  }
  const p256dh = body.keys?.p256dh
  const auth = body.keys?.auth
  if (typeof p256dh !== "string" || !B64URL.test(p256dh) || typeof auth !== "string" || !B64URL.test(auth)) {
    return ok(400, { error: "keys.p256dh and keys.auth are required" })
  }
  // An endpoint belongs to one browser. If another device had it (a phone
  // re-paired under a new name), the latest pairing takes it over.
  // The browser subscribed with the key GET /api/app/push just handed it;
  // `publicKey` in the body must match it, so a stale page can't store a
  // subscription made with replaced keys.
  if (body.publicKey !== undefined && body.publicKey !== publicKey) {
    return ok(409, { error: "this computer's push keys changed; turn notifications on again" })
  }
  store.subscribe({ endpoint, p256dh, auth, deviceId: device.id, deviceName: device.name, publicKey: publicKey! })
  return ok(200, { ok: true })
}

function ok(status: number, body: unknown): AppPushResult {
  return { status, body }
}

function prefDefaults(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const p of Object.values(PUSH_PREFS)) out[p.field] = p.default
  return out
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
