import type { EnvelopeListener } from "@/events/bus"
import type { EventEnvelope } from "@/events/envelope"
import type { OutgoingMessage } from "./types"
import type { PushStore } from "./push-store"
import type { PushPrefs } from "./push-prefs"

// --- Push a notification for each new mesh announcement (#268) ---
//
// Runs only on the node that hosts the phone app (the one running
// PushAdapter). Announcements from other nodes reach this node's bus
// through the peer feed, so listening to the bus covers the whole mesh
// and each announcement is pushed once, by one node.
//
// Not pushed:
//   - the same event twice (key node:id; the bus already refuses repeats
//     from the feed, this guards against a second path in),
//   - anything published before this process started, which is what the
//     feed's first-contact backfill and catch-up reads bring in,
//   - anything older than `maxAgeMs`, so a peer that reconnects after a
//     long outage doesn't fire a stack of stale notifications,
//   - phones that turned "Notify me of announcements" off (push_prefs
//     switch "announce").

/** Longest announcement text in a notification body. */
export const ANNOUNCE_PUSH_MAX = 200
const SEEN_MAX = 1000

export interface AnnouncePushDeps {
  bus: { subscribe(fn: EnvelopeListener): () => void }
  store: Pick<PushStore, "list">
  prefs: Pick<PushPrefs, "on">
  /** The PushAdapter's send; chatId is one phone's device id. */
  send: (msg: OutgoingMessage) => Promise<unknown>
  /** Events stamped before this are replays. Defaults to attach time. */
  startedAt?: number
  maxAgeMs?: number
  now?: () => number
  log?: (...args: unknown[]) => void
}

export function announceBody(e: Pick<EventEnvelope, "summary" | "agentId">): string {
  const text = e.agentId ? `${e.agentId}: ${e.summary}` : e.summary
  const chars = [...text]
  return chars.length > ANNOUNCE_PUSH_MAX ? chars.slice(0, ANNOUNCE_PUSH_MAX - 1).join("") + "…" : text
}

/** Subscribes to the bus; returns the unsubscribe function. */
export function attachAnnouncePush(deps: AnnouncePushDeps): () => void {
  const now = deps.now ?? Date.now
  const startedAt = deps.startedAt ?? now()
  const maxAgeMs = deps.maxAgeMs ?? 10 * 60_000
  const log = deps.log ?? (() => {})
  const seen = new Set<string>()

  return deps.bus.subscribe((e) => {
    if (e.kind !== "announce") return
    const key = `${e.node}:${e.id}`
    if (seen.has(key)) return
    seen.add(key)
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string)

    const at = Date.parse(e.at)
    if (!Number.isFinite(at) || at < startedAt || at < now() - maxAgeMs) return

    const devices = [...new Set(deps.store.list().map((s) => s.deviceId))]
      .filter((id) => deps.prefs.on(id, "announce"))
    if (devices.length === 0) return
    const text = `Announcement\n${announceBody(e)}`
    for (const chatId of devices) {
      deps.send({ channel: "push", chatId, text }).catch((err: any) => {
        log(`push: announcement not sent to ${chatId}: ${err?.message ?? err}`)
      })
    }
  })
}
