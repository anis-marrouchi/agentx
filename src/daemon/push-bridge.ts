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
//         → host daemon  POST /push/app     (the relay's peer token)
//         → runAppPush on the host's table, device id "<origin>:<tok_…>"
//
// The host never takes the origin from the request: it is the name of the
// mesh.peers entry whose token the caller presented (pushBridgeCaller). A
// caller holding only MESH_TOKEN, which every node accepts, names no node
// and is refused, so one node can't subscribe, read or prune under
// another's name.
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

/** Who is calling, on the host: the origin of the mesh.peers entry whose
 *  token the caller presented, or why the call can't be tied to one. */
export type PushBridgeCaller = { origin: string } | { error: string }

export function pushBridgeCaller(
  authorization: string,
  peers: ReadonlyArray<{ name: string; token?: string }>,
  meshToken?: string,
): PushBridgeCaller {
  const token = /^bearer /i.test(authorization) ? authorization.slice(7).trim() : ""
  const needs = "Phones paired with another computer need that computer's own peer token: give it a token in mesh.peers on both computers."
  // MESH_TOKEN is shared by the whole mesh, so it says nothing about who sent it.
  if (!token || (meshToken && token === meshToken)) return { error: needs }
  const origins = new Set(peers.filter((p) => p.token === token).map((p) => pushOrigin(p.name)))
  if (origins.size === 0) return { error: needs }
  if (origins.size > 1) return { error: `Several mesh.peers entries share this token (${[...origins].join(", ")}). Give each computer its own token.` }
  const [origin] = origins
  // Two peers whose names map to one origin would share, and prune, each
  // other's phones ("my mac" and "my-mac").
  const clash = peers.filter((p) => p.token !== token && pushOrigin(p.name) === origin).map((p) => p.name)
  if (clash.length) return { error: `mesh.peers names ${clash.map((n) => `"${n}"`).join(", ")} too close to this computer's name: rename one so they differ in letters or digits.` }
  return { origin }
}

/** On the host: may `caller` send a /channel/send push to `chatId`? A
 *  scoped id ("<node>:tok_…") is one phone of one relay, so only that relay
 *  may address it; a plain id or "default" is unaffected here. */
export function scopedPushTarget(chatId: string, caller: PushBridgeCaller): { ok: true } | { error: string } {
  const i = chatId.indexOf(":")
  if (i < 0) return { ok: true }
  if ("error" in caller) return { error: caller.error }
  if (chatId.slice(0, i) !== caller.origin) return { error: `${chatId} is a phone paired with another computer; only that computer can send to it.` }
  return { ok: true }
}

/** On a relay: why phones paired here can't get notifications through
 *  `relayTo`, or null. The host ties a relay to its own peer token, so the
 *  token this node presents must be set and not the shared MESH_TOKEN. */
export function relayTokenProblem(relayTo: string, peers: ReadonlyArray<{ name: string; token?: string }>, meshToken?: string): string | null {
  const want = relayTo.toLowerCase()
  const peer = peers.find((p) => p.name.toLowerCase() === want)
  if (!peer) return null // reported when the first push is sent
  if (!peer.token) return `mesh.peers "${peer.name}" has no token, so phones paired here can't turn notifications on. Give it a token of its own on both computers.`
  if (meshToken && peer.token === meshToken) return `mesh.peers "${peer.name}" uses the shared MESH_TOKEN, so phones paired here can't turn notifications on. Give this pair a token of its own on both computers.`
  return null
}

/** The origins of the configured peers, for checking a scoped device id on
 *  the host: a row whose node left mesh.peers is no longer delivered. */
export function peerOrigins(peers: ReadonlyArray<{ name: string }>): Set<string> {
  return new Set(peers.map((p) => pushOrigin(p.name)))
}

/** On the host: answers one bridged request from `caller` (pushBridgeCaller).
 *  `deps` is null when this node is not sending pushes itself; `reason`
 *  then says why. An `origin` in the request itself is ignored. */
export function handlePushBridge(raw: unknown, caller: PushBridgeCaller, deps: (AppPushDeps & { store: () => PushStore | null }) | null, reason?: string): AppPushResult {
  const req = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>
  if ("error" in caller) return { status: 403, body: { error: caller.error } }
  const origin = caller.origin
  if (!ORIGIN.test(origin)) return { status: 403, body: { error: "this peer's name can't be used as a notification origin" } }
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
    let active: string[]
    try {
      active = [...new Set(this.deps.active())].sort()
    } catch (e: any) {
      // A torn or failed read of the phone list: sending nothing keeps the
      // host's rows; sending [] would unsubscribe every phone paired here.
      this.deps.log?.(`push: phone list not read, not sent this time: ${e?.message ?? e}`)
      return false
    }
    const key = active.join(",")
    if (key === this.lastKey && now - this.lastSentAt < ROSTER_RESEND_MS) return false
    try {
      const r = await this.deps.send(active) as { status?: unknown; body?: { error?: unknown } } | undefined
      // The host answers a refusal (no peer token, a name clash) inside a
      // 200: that is not a sent roster, and nothing was pruned.
      if (r && typeof r === "object" && typeof r.status === "number" && r.status !== 200) {
        throw new Error(`${r.status} ${typeof r.body?.error === "string" ? r.body.error : "refused"}`)
      }
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
