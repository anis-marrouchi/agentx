import { isAppPushPath, runAppPush, type AppPushCall, type AppPushDeps, type AppPushResult } from "./app-push"
import { remoteDeviceId } from "@/channels/push"
import type { PushStore } from "@/channels/push-store"

// --- Push bridge: phones paired with a relaying node (#711) ---
//
// Push has one host per mesh: the node that holds the VAPID keys and the
// subscriptions table. A node with channels.push.relayTo forwards outbound
// pushes to it (PushRelayAdapter); this module covers the other direction,
// for a phone paired with that relaying node:
//
//   phone → relay dashboard /api/app/push*  (device token checked there)
//         → relay daemon POST /push/app     (loopback)
//         → host daemon  POST /push/app     (mesh token, origin = relay name)
//         → runAppPush on the host's table, device id "<origin>:<tok_…>"
//
// The relay also sends its roster of active token ids ("roster" op). The
// host drops that node's rows whose phone is no longer in it, so
// `agentx app revoke` on the relay stops the phone's notifications at the
// next sync, as it does for a phone paired with the host.
//
// Every answer is { status, body }: the phone-app status and JSON, wrapped
// so a relay can tell them apart from a transport failure.

/** What a relay sends to the host's POST /push/app. */
export type PushBridgeRequest =
  | { op: "app"; origin: string; call: AppPushCall }
  | { op: "roster"; origin: string; active: string[] }

const ORIGIN = /^[A-Za-z0-9._-]{1,64}$/
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_NAME = 100
const MAX_ROSTER = 1000

/** How often a relay checks its roster, and the longest it goes without
 *  sending one even when nothing changed (the host may have restarted
 *  from a backup, or missed a send while down). */
export const ROSTER_CHECK_MS = 60_000
export const ROSTER_RESEND_MS = 15 * 60_000

/** This node's name as a relay origin: letters, digits, dot, dash and
 *  underscore, so it can't contain the ":" that scopes a device id. */
export function pushOrigin(nodeName: string): string {
  return (nodeName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "node").slice(0, 64)
}

/** On the host: answers one bridged request. `deps` is null when this node
 *  is not sending pushes itself; `reason` then says why. */
export function handlePushBridge(raw: unknown, deps: (AppPushDeps & { store: () => PushStore | null }) | null, reason?: string): AppPushResult {
  const req = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>
  const origin = typeof req.origin === "string" ? req.origin : ""
  if (!ORIGIN.test(origin)) return { status: 400, body: { error: "origin must be the relaying node's name" } }
  if (!deps) return { status: 503, body: { error: reason ?? "Notifications are not set up on the computer that sends them." } }

  if (req.op === "roster") {
    if (!Array.isArray(req.active) || req.active.length > MAX_ROSTER || !req.active.every((id: unknown) => typeof id === "string" && DEVICE_ID.test(id))) {
      return { status: 400, body: { error: "active must be a list of device ids" } }
    }
    const store = deps.store()
    if (!store) return { status: 503, body: { error: deps.reason ?? "the database is unavailable" } }
    return { status: 200, body: { ok: true, removed: store.pruneOrigin(origin, req.active) } }
  }

  if (req.op !== "app") return { status: 400, body: { error: "op must be app or roster" } }
  const call = (req.call && typeof req.call === "object" ? req.call : {}) as Record<string, any>
  const device = (call.device && typeof call.device === "object" ? call.device : {}) as Record<string, any>
  const path = typeof call.path === "string" ? call.path : ""
  const method = call.method === "GET" || call.method === "POST" ? call.method : ""
  if (!isAppPushPath(path) || !method) return { status: 404, body: { error: "not found" } }
  if (typeof device.id !== "string" || !DEVICE_ID.test(device.id)) return { status: 400, body: { error: "device.id is required" } }
  const name = typeof device.name === "string" && device.name.trim() ? device.name.trim() : device.id
  const body = call.body && typeof call.body === "object" && !Array.isArray(call.body) ? call.body : {}
  return runAppPush({
    path,
    method,
    body,
    // The relay's name goes with the phone's, so `agentx app devices` and
    // the host's logs say where the phone is paired.
    device: { id: remoteDeviceId(origin, device.id), name: clip(`${name} (${origin})`, MAX_NAME) },
  }, deps)
}

/** On a relay: sends the roster of active token ids when it changed, or
 *  every ROSTER_RESEND_MS. A failed send is retried at the next tick. */
export class PushRosterSync {
  private lastKey: string | null = null
  private lastSentAt = 0
  private failing = false

  constructor(private deps: {
    active: () => string[]
    send: (active: string[]) => Promise<unknown>
    now?: () => number
    log?: (...args: unknown[]) => void
  }) {}

  async tick(): Promise<boolean> {
    const now = (this.deps.now ?? Date.now)()
    const active = [...new Set(this.deps.active())].sort()
    const key = active.join(",")
    if (key === this.lastKey && now - this.lastSentAt < ROSTER_RESEND_MS) return false
    try {
      await this.deps.send(active)
      this.lastKey = key
      this.lastSentAt = now
      if (this.failing) this.deps.log?.("push: phone list sent to the push host again")
      this.failing = false
      return true
    } catch (e: any) {
      // Once per outage, not every minute.
      if (!this.failing) this.deps.log?.(`push: phone list not sent to the push host, retrying every minute: ${e?.message ?? e}`)
      this.failing = true
      return false
    }
  }
}

function clip(s: string, max: number): string {
  const chars = [...s]
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : s
}
