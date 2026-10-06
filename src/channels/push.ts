import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "./types"
import type { PushStore, PushSubscriptionRow } from "./push-store"
import type { PushKeys } from "./push-keys"
import { splitTitle } from "./ntfy"

// --- push channel — Web Push to the phone app ---
//
// Outbound only, like ntfy, and registered as a ChannelAdapter for the same
// reason: notifications.destination, POST /send, `agentx notify`, cron
// failure pings and Focus digests all reach it through router.sendOutbound().
//
// One node hosts the phone app (/app) and so holds the subscriptions; it
// runs PushAdapter. Every other node runs PushRelayAdapter under the same
// channel name, which forwards to the host over the mesh, so callers never
// need to know where the phone is paired.
//
// Addressing: `chatId` "default" (or empty) means every subscribed phone;
// anything else is one phone's device id (the tok_… id from
// `agentx app devices`).
//
// A phone paired with a relaying node subscribes on the host too, through
// that node (push-bridge.ts). Its rows carry a scoped device id,
// "<node>:<tok_…>", so two nodes' token ids never collide, and a push the
// relay addresses to one of its phones (chatId tok_…, origin <node>) is
// mapped to that id here (#711).

/** Device id on the host for a phone paired with relaying node `origin`. */
export function remoteDeviceId(origin: string, deviceId: string): string {
  return `${origin}:${deviceId}`
}

/** True for a scoped id (remoteDeviceId); local token ids have no colon. */
export function isRemoteDevice(deviceId: string): boolean {
  return deviceId.includes(":")
}

/** Where a tap lands when the message has no button of its own. */
export const DEFAULT_OPEN_URL = "/app#alerts"
/** Push services refuse payloads over 4096 bytes after encryption (413,
 *  which is not retried). The JSON is kept well under that, in bytes. */
export const MAX_PAYLOAD_BYTES = 3000
/** Chrome shows at most two action buttons. */
const MAX_ACTIONS = 2
const MAX_LABEL = 40
const MAX_TITLE = 120
/** Longer links are dropped rather than cut, since a cut link is broken. */
const MAX_URL = 1000

export interface PushPayload {
  title: string
  body: string
  /** Opened when the notification itself is tapped. */
  url: string
  actions: Array<{ action: string; title: string; url: string }>
}

/** What web-push's sendNotification needs; injected so tests stay offline. */
export type PushSender = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  opts: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number },
) => Promise<unknown>

export interface PushAdapterDeps {
  store: PushStore
  keys: () => PushKeys | null
  /** mailto: or https: contact the push services can reach you at. */
  subject: string
  ttlSeconds: number
  keepRecent: number
  /** False for a phone whose device token was revoked or expired. */
  deviceActive: (deviceId: string) => boolean
  sender: PushSender
  log?: (...args: unknown[]) => void
}

export function buildPushPayload(msg: OutgoingMessage, defaultTitle = "AgentX"): PushPayload {
  const split = splitTitle(msg.text || "")
  const actions = (msg.buttons ?? [])
    .filter((b) => b.url && b.url.length <= MAX_URL)
    .slice(0, MAX_ACTIONS)
    .map((b, i) => ({ action: `b${i}`, title: clip(b.label, MAX_LABEL), url: b.url }))
  const payload: PushPayload = {
    title: clip(split.title || defaultTitle, MAX_TITLE),
    body: split.body,
    url: actions[0]?.url ?? DEFAULT_OPEN_URL,
    actions,
  }
  // Trim the body by bytes, not characters: Arabic, CJK and emoji take
  // several bytes each.
  const size = () => Buffer.byteLength(JSON.stringify(payload), "utf8")
  if (size() > MAX_PAYLOAD_BYTES) {
    let chars = [...payload.body]
    const over = size() - MAX_PAYLOAD_BYTES
    chars = chars.slice(0, Math.max(0, chars.length - over - 1))
    payload.body = chars.join("") + "…"
    while (size() > MAX_PAYLOAD_BYTES && chars.length > 0) {
      chars = chars.slice(0, Math.max(0, chars.length - 32))
      payload.body = chars.join("") + "…"
    }
  }
  return payload
}

function clip(s: string, max: number): string {
  const chars = [...s]
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : s
}

export class PushAdapter implements ChannelAdapter {
  readonly name = "push"
  private log: (...args: unknown[]) => void

  constructor(private deps: PushAdapterDeps) {
    this.log = deps.log ?? console.error.bind(console, "[push]")
  }

  async start(): Promise<void> {
    const n = this.deps.store.list().length
    this.log(`push: ready (${n} subscribed phone${n === 1 ? "" : "s"})${this.deps.keys() ? "" : " — no keys yet, run: agentx app push-keys"}`)
  }

  async stop(): Promise<void> {}

  onMessage(_handler: (msg: IncomingMessage) => Promise<void>): void {}

  async send(msg: OutgoingMessage & { origin?: string }): Promise<string | void> {
    const keys = this.deps.keys()
    if (!keys) throw new Error("push: no keys — run `agentx app push-keys` on this node")
    const requested = (msg.chatId || "").trim()
    let device = requested && requested !== "default" ? requested : undefined
    // A relay addressed one of its own phones: use the id it has here.
    if (device && msg.origin && !isRemoteDevice(device)) {
      const scoped = remoteDeviceId(msg.origin, device)
      if (this.deps.store.list(scoped).length > 0) device = scoped
    }

    const subs: PushSubscriptionRow[] = []
    for (const s of this.deps.store.list(device)) {
      // A revoked phone stops getting pushes even if its browser never
      // unsubscribed, and a row made with replaced keys can never be
      // delivered; either goes, so it isn't retried every time. The phone
      // re-subscribes with the new key when the app next opens.
      if (this.deps.deviceActive(s.deviceId) && s.publicKey === keys.publicKey) subs.push(s)
      else this.deps.store.unsubscribe(s.endpoint)
    }
    if (subs.length === 0) {
      throw new Error(device
        ? `push: phone ${device} has not turned on notifications`
        : "push: no phone has turned on notifications — open Alerts in the phone app")
    }

    const payload = buildPushPayload(msg)
    const body = JSON.stringify(payload)
    const opts = {
      vapidDetails: { subject: this.deps.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: this.deps.ttlSeconds,
    }
    let delivered = 0
    const errors: string[] = []
    await Promise.all(subs.map(async (s) => {
      try {
        await this.deps.sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, opts)
        delivered++
      } catch (e: any) {
        // 404/410: the browser dropped the subscription (app removed,
        // permission withdrawn). Anything else may be temporary; keep it.
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          this.deps.store.unsubscribe(s.endpoint)
          this.log(`push: removed expired subscription for ${s.deviceName}`)
        } else {
          errors.push(`${s.deviceName}: ${e?.statusCode ? `HTTP ${e.statusCode} ` : ""}${e?.body || e?.message || e}`.slice(0, 200))
        }
      }
    }))

    if (delivered === 0) throw new Error(`push: not delivered — ${errors.join("; ") || "every subscription had expired"}`)
    if (errors.length) this.log(`push: ${errors.length} phone(s) failed: ${errors.join("; ")}`)
    this.deps.store.log({ title: payload.title, body: payload.body, url: payload.url, delivered, deviceId: device ?? null }, this.deps.keepRecent)
    return String(delivered)
  }
}

/** Payload for the host's POST /channel/send. */
export interface PushRelayPayload {
  channel: "push"
  chatId: string
  text: string
  buttons?: OutgoingMessage["buttons"]
  relayed: true
  /** The relaying node's name, so the host can find its phones. */
  origin?: string
}

/** The `push` channel on a node that doesn't host the phone app: forwards
 *  each message to the host (channels.push.relayTo) over the mesh. */
export class PushRelayAdapter implements ChannelAdapter {
  readonly name = "push"

  constructor(
    private peer: string,
    private forward: (peer: string, payload: PushRelayPayload) => Promise<string | void>,
    private log: (...args: unknown[]) => void = console.error.bind(console, "[push]"),
    private origin?: string,
  ) {}

  async start(): Promise<void> {
    this.log(`push: relaying to ${this.peer}`)
  }

  async stop(): Promise<void> {}

  onMessage(_handler: (msg: IncomingMessage) => Promise<void>): void {}

  async send(msg: OutgoingMessage & { relayed?: boolean }): Promise<string | void> {
    // Two nodes each set to relay to the other would bounce a message forever.
    if (msg.relayed) throw new Error(`push: this node relays too (channels.push.relayTo = ${this.peer}); set relayTo only on nodes that don't host the phone app`)
    return this.forward(this.peer, {
      channel: "push",
      chatId: msg.chatId || "default",
      text: msg.text,
      ...(msg.buttons?.length ? { buttons: msg.buttons } : {}),
      relayed: true,
      ...(this.origin ? { origin: this.origin } : {}),
    })
  }
}
