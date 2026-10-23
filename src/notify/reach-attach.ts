import type Database from "better-sqlite3"
import { getEventBus, type AgentXEvents } from "@/events/bus"
import type { TellSettings, ToldLedger, ToldRow } from "./told"
import {
  ChannelWatch, escalateUnseen, firstStop, ladderStops, PresenceStore, ReachMarks, stopChannel, stopChat, turnSurface,
  type ChannelHealth, type ReachSettings,
} from "./reach"

// --- Reach, as the daemon runs it (#1138 step B) ---
//
// Glue between reach.ts and the daemon: an owner turn marks him present
// and answers the told rows of its request's chat; a minute's tick checks
// the channels, marks rows whose request card was decided, and escalates
// urgent rows left unseen. Everything host-specific comes in through deps.

export interface ReachDeps {
  db: Database.Database
  ledger: ToldLedger
  settings: () => ReachSettings
  told: () => TellSettings
  channels: {
    has: (name: string) => boolean
    health: (name: string) => ChannelHealth
    all: () => Record<string, ChannelHealth>
  }
  /** Sends an escalation through the router, past the gate (its row is
   *  already written). Rejects when it did not go. */
  send: (channel: string, chatId: string, text: string, row: ToldRow) => Promise<void>
  /** Tells the owner one channel is down. */
  notice: (channel: string, reason: string) => void
  /** Is this turn the owner's own (requests' owner check)? */
  isOwnerTurn: (p: AgentXEvents["task:started"]) => boolean
  /** The chat a request was asked in, and the cards it links. */
  request: (id: string) => { channel: string; chatId: string; cards: string[] } | null
  /** When a card was decided, or null while it waits. */
  cardDecidedAt: (id: string) => number | null
  /** The computer's idle seconds, Focus, a call: read live. */
  idleSeconds?: () => Promise<number | null>
  focus?: () => Promise<boolean | null>
  inCall?: () => string | null
  log: (msg: string) => void
  now?: () => number
}

export interface AttachedReach {
  marks: ReachMarks
  presence: PresenceStore
  watch: ChannelWatch
  /** Where an urgent item goes first, as channel and chat; null: leave it
   *  to the caller's default. */
  firstStop(): { channel: string; chatId: string } | null
  tick(): Promise<void>
  view(): Promise<ReachView>
  detach(): void
}

export interface ReachView {
  person: string
  /** Surfaces newest first, each with when he was last seen there. */
  surfaces: Array<{ surface: string; at: number }>
  lastSeen: { surface: string; at: number } | null
  computer: { idleSeconds: number | null } | null
  focus: boolean | null
  inCall: string | null
  ladder: { enabled: boolean; escalateAfterMinutes: number; stops: string[] }
  channels: Record<string, ChannelHealth & { since?: number }>
}

export function attachReach(deps: ReachDeps): AttachedReach {
  const now = deps.now ?? Date.now
  const marks = new ReachMarks(deps.db, now)
  const presence = new PresenceStore(deps.db, now)
  const watch = new ChannelWatch({ read: deps.channels.all, notice: deps.notice, log: deps.log, now })
  const up = (ch: string) => deps.channels.health(ch).up
  const stops = () => ladderStops(deps.settings(), deps.told(), deps.channels.has)

  const started = (p: AgentXEvents["task:started"]) => {
    try {
      // A pickup is the daemon's own turn (plans, the requests check), never a reply.
      if (p.pickup || !p.humanRoot || !deps.isOwnerTurn(p)) return
      presence.touch(turnSurface(p.channel, p.chatId))
      // A reply in the chat a request was asked in answers what he was
      // told about it.
      const ids = [...new Set(marks.openRequestRows().map((r) => r.requestId))]
      const here = ids.filter((id) => {
        const r = deps.request(id)
        return r && r.channel === p.channel && r.chatId === p.chatId
      })
      if (here.length) marks.answeredByRequest(here, "reply")
    } catch (e: any) {
      deps.log(`[reach] owner turn not recorded: ${e?.message ?? e}`)
    }
  }
  const bus = getEventBus()
  bus.on("task:started", started)

  /** Rows whose request's card was decided are answered, as of then. */
  const decidedCards = () => {
    const seen = new Set<string>()
    for (const row of marks.openRequestRows()) {
      if (seen.has(row.requestId)) continue
      seen.add(row.requestId)
      const r = deps.request(row.requestId)
      for (const card of r?.cards ?? []) {
        const at = deps.cardDecidedAt(card)
        if (at !== null) marks.answeredByRequest([row.requestId], "card", at)
      }
    }
  }

  return {
    marks,
    presence,
    watch,
    firstStop() {
      if (!deps.settings().enabled) return null
      const stop = firstStop(stops(), presence.list(), up)
      return stop ? { channel: stopChannel(stop), chatId: stopChat(stop) } : null
    },
    async tick() {
      const step = async (what: string, fn: () => unknown) => {
        try { await fn() } catch (e: any) { deps.log(`[reach] ${what} failed: ${e?.message ?? e}`) }
      }
      await step("channel check", () => watch.tick())
      await step("decided cards", decidedCards)
      await step("escalation", () => escalateUnseen({
        db: deps.db, ledger: deps.ledger, settings: deps.settings(), stops: stops(), up, now: now(), log: deps.log,
        send: (stop, row, text) => deps.send(stopChannel(stop), stopChat(stop), text, row),
      }))
    },
    async view() {
      const surfaces = presence.list()
      const s = deps.settings()
      const channels = deps.channels.all()
      return {
        person: "owner",
        surfaces,
        lastSeen: surfaces[0] ?? null,
        computer: deps.idleSeconds ? { idleSeconds: await deps.idleSeconds().catch(() => null) } : null,
        focus: deps.focus ? await deps.focus().catch(() => null) : null,
        inCall: deps.inCall?.() ?? null,
        ladder: { enabled: s.enabled, escalateAfterMinutes: s.escalateAfterMinutes, stops: stops() },
        channels: Object.fromEntries(Object.entries(channels).map(([n, h]) => [n, h.up ? h : { ...h, since: watch.downSince(n) }])),
      }
    },
    detach() {
      bus.off("task:started", started)
    },
  }
}
