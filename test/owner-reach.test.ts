import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { DEFAULT_TELL_SETTINGS, OwnerGate, ToldLedger, type TellSettings } from "../src/notify/told"
import {
  ChannelWatch, DEFAULT_REACH_SETTINGS, escalateUnseen, firstStop, ladderStops, nextStop, PresenceStore, ReachMarks, turnSurface,
  type ReachSettings,
} from "../src/notify/reach"
import { attachReach, type ReachDeps } from "../src/notify/reach-attach"
import { getEventBus } from "../src/events/bus"
import { ChannelDownError, MessageRouter } from "../src/channels/router"
import { WhatsAppAdapter } from "../src/channels/whatsapp"
import { appReachDeps } from "../src/daemon/app-reach"
import { runAppPush } from "../src/daemon/app-push"
import { PushStore } from "../src/channels/push-store"
import { idleSecondsIn, macosIdle } from "../src/native/macos/idle"

// #1138 step B, Reach: did a told row land (sent → seen → answered), where
// the owner is, an urgent item sent on once when unseen, and a channel
// that is down refused with a reason instead of reported sent.

const MIN = 60_000
let tmp: string
let db: Database.Database
let clock: number
let told: TellSettings
let ledger: ToldLedger
let gate: OwnerGate

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-reach-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  clock = Date.UTC(2026, 9, 23, 9)
  told = { ...DEFAULT_TELL_SETTINGS, addresses: ["telegram:42"] }
  ledger = new ToldLedger(db)
  gate = new OwnerGate(ledger, () => told, () => clock)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const tell = (title: string, meta: Record<string, unknown> = {}, channel = "push", chatId = "default") =>
  gate.decide({ channel, chatId, title, text: "body" }, { key: `k:${title}`, ...meta }).rowId

describe("the told record's new columns", () => {
  it("are added to a table made before them, and an old row reads as sent, unseen", () => {
    const old = new Database(path.join(tmp, "old.sqlite"))
    old.exec(`CREATE TABLE owner_told (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, item_key TEXT NOT NULL, request_id TEXT,
      kind TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL, sender TEXT, title TEXT NOT NULL, text TEXT NOT NULL,
      outcome TEXT NOT NULL, digested_at INTEGER)`)
    old.prepare("INSERT INTO owner_told (at, item_key, kind, channel, chat_id, title, text, outcome) VALUES (1, 'k', 'notice', 'push', 'default', 'T', 'x', 'sent')").run()
    const l = new ToldLedger(old)
    new ToldLedger(old) // a second process opening the same file
    expect(l.since(0)[0]).toMatchObject({ state: "sent", seenAt: null, answeredAt: null, urgent: false })
    old.close()
  })
})

describe("sent → seen → answered", () => {
  it("is seen when the phone app marks the push read, matched by title and time", () => {
    const id = tell("Invoice batch failed")
    tell("Something else")
    clock += 1000
    const marks = new ReachMarks(db, () => clock)
    expect(marks.seenPush([{ at: clock, title: "Invoice batch failed" }])).toBe(1)
    expect(ledger.get(id)).toMatchObject({ state: "seen", seenVia: "phone", seenAt: clock })
    // A push from long after the row matches nothing.
    expect(marks.seenPush([{ at: clock + 10 * MIN, title: "Something else" }])).toBe(0)
  })

  it("matches a push whose title was cut with an ellipsis", () => {
    const long = "A".repeat(150)
    const id = tell(long)
    expect(new ReachMarks(db, () => clock).seenPush([{ at: clock, title: `${"A".repeat(119)}…` }])).toBe(1)
    expect(ledger.get(id)!.state).toBe("seen")
  })

  it("is answered (and so seen) for the rows of a request, once, and the report counts each state", () => {
    const a = tell("Step blocked", { requestId: "req-1" })
    const b = tell("Plan finished", { requestId: "req-1" })
    const c = tell("Other", { requestId: "req-2" })
    clock += MIN
    const marks = new ReachMarks(db, () => clock)
    expect(marks.seenByRequest(["req-2"], "desk")).toBe(1)
    expect(marks.answeredByRequest(["req-1"], "reply")).toBe(2)
    expect(marks.answeredByRequest(["req-1"], "reply")).toBe(0)
    expect(ledger.get(a)).toMatchObject({ state: "answered", answeredVia: "reply", seenVia: "reply" })
    expect(ledger.get(b)!.state).toBe("answered")
    expect(ledger.get(c)).toMatchObject({ state: "seen", seenVia: "desk" })
    expect(gate.report(0).landed).toEqual({ sent: 0, seen: 1, answered: 2 })
    expect(gate.report(0).items[0]).toHaveProperty("seenAt")
  })

  it("does not answer a row told after the answer, nor one kept back", () => {
    const marks = new ReachMarks(db, () => clock)
    const kept = tell("Nag", { requestId: "req-1", kind: "nag" })
    marks.answeredByRequest(["req-1"], "card", clock - 1)
    expect(ledger.get(kept)!.answeredAt).toBeNull()
    clock += MIN
    const later = tell("Again", { requestId: "req-1" })
    marks.answeredByRequest(["req-1"], "card", clock - 1)
    expect(ledger.get(later)!.answeredAt).toBeNull()
  })
})

describe("reach in the daemon", () => {
  function attach(over: Partial<ReachDeps> = {}) {
    const sent: string[] = []
    const reach = attachReach({
      db, ledger,
      settings: () => ({ ...DEFAULT_REACH_SETTINGS, enabled: true }),
      told: () => told,
      channels: { has: () => true, health: () => ({ up: true }), all: () => ({ push: { up: true } }) },
      send: async (ch, chat, text) => { sent.push(`${ch}:${chat}`) },
      notice: () => {},
      isOwnerTurn: (p) => p.sender?.id === "owner",
      request: (id) => (id === "req-1" ? { channel: "telegram", chatId: "42", cards: ["c1"] } : null),
      cardDecidedAt: () => null,
      log: () => {},
      now: () => clock,
      ...over,
    })
    return { reach, sent }
  }
  const turn = (over: Record<string, unknown>) => getEventBus().emit("task:started", {
    agentId: "secretary", taskId: "t1", channel: "telegram", chatId: "42", messagePreview: "ok", humanRoot: true, sender: { id: "owner" }, ...over,
  } as any)

  it("answers what was told about a request when the owner replies in its chat, and marks him present there", () => {
    const { reach } = attach()
    const id = tell("Need a yes", { requestId: "req-1" })
    clock += MIN
    turn({ chatId: "99" })
    expect(ledger.get(id)!.state).toBe("sent")
    turn({ sender: { id: "someone" } })
    expect(ledger.get(id)!.state).toBe("sent")
    turn({ pickup: true })
    expect(ledger.get(id)!.state).toBe("sent")
    turn({})
    expect(ledger.get(id)).toMatchObject({ state: "answered", answeredVia: "reply" })
    expect(reach.presence.list().map((p) => p.surface)).toEqual(expect.arrayContaining(["telegram:42", "telegram:99"]))
    reach.detach()
  })

  it("answers the rows of a request whose card was decided, as of the decision", async () => {
    const { reach } = attach({ cardDecidedAt: () => clock + 1 })
    const id = tell("Approve?", { requestId: "req-1" })
    clock += MIN
    await reach.tick()
    expect(ledger.get(id)).toMatchObject({ state: "answered", answeredVia: "card" })
    reach.detach()
  })

  it("sends an urgent item first where the owner was seen last, and shows presence with Focus and calls", async () => {
    const { reach } = attach({ focus: async () => true, inCall: () => null, idleSeconds: async () => 42 })
    expect(reach.firstStop()).toEqual({ channel: "push", chatId: "default" })
    reach.presence.touch("phone")
    clock += MIN
    reach.presence.touch("telegram:42")
    expect(reach.firstStop()).toEqual({ channel: "telegram", chatId: "42" })
    const view = await reach.view()
    expect(view).toMatchObject({ lastSeen: { surface: "telegram:42" }, focus: true, inCall: null, computer: { idleSeconds: 42 } })
    expect(view.ladder.stops).toEqual(["push:default", "ntfy:default", "telegram:42"])
    reach.detach()
  })

  it("leaves the first stop to the caller while the ladder is off", () => {
    const { reach } = attach({ settings: () => DEFAULT_REACH_SETTINGS })
    expect(DEFAULT_REACH_SETTINGS.enabled).toBe(false)
    expect(reach.firstStop()).toBeNull()
    reach.detach()
  })
})

describe("the ladder", () => {
  const up = () => true
  it("lists the set ladder, else the told channels then addresses, only those on this node", () => {
    expect(ladderStops({ ladder: [] }, told, (c) => c !== "ntfy")).toEqual(["push:default", "telegram:42"])
    expect(ladderStops({ ladder: ["telegram:42", "push:default", "telegram:42"] }, told, up)).toEqual(["telegram:42", "push:default"])
  })

  it("goes first where he was seen last, among channels up; next is the one after, wrapping, never a down one", () => {
    const stops = ["push:default", "telegram:42", "whatsapp:216"]
    expect(firstStop(stops, [], up)).toBe("push:default")
    expect(firstStop(stops, [{ surface: "telegram:42", at: 5 }, { surface: "desk", at: 9 }], up)).toBe("push:default")
    expect(firstStop(stops, [{ surface: "whatsapp:216", at: 9 }], (c) => c !== "whatsapp")).toBe("push:default")
    expect(nextStop(stops, "telegram:42", up)).toBe("whatsapp:216")
    expect(nextStop(stops, "whatsapp:216", up)).toBe("push:default")
    expect(nextStop(stops, "push:default", (c) => c === "push")).toBeNull()
  })
})

describe("escalation", () => {
  const settings: ReachSettings = { enabled: true, escalateAfterMinutes: 10, ladder: [] }
  const stops = ["push:default", "telegram:42"]
  function run(over: Partial<Parameters<typeof escalateUnseen>[0]> = {}) {
    const sends: string[] = []
    return {
      sends,
      go: () => escalateUnseen({
        db, ledger, settings, stops, up: () => true, now: clock, log: () => {},
        send: async (stop) => { sends.push(stop) }, ...over,
      }),
    }
  }

  it("sends an urgent item left unseen on to the next channel exactly once", async () => {
    const id = tell("Server down", { urgent: true })
    const r = run()
    clock += 9 * MIN
    expect(await r.go()).toBe(0)
    clock += 2 * MIN
    expect(await r.go()).toBe(1)
    expect(await r.go()).toBe(0)
    clock += 60 * MIN
    expect(await r.go()).toBe(0)
    expect(r.sends).toEqual(["telegram:42"])
    const rows = ledger.since(0)
    const copy = rows.find((x) => x.escalationOf === id)!
    expect(copy).toMatchObject({ channel: "telegram", chatId: "42", outcome: "sent", urgent: true })
    expect(ledger.get(id)!.escalatedAt).not.toBeNull()
    // Seen on the copy is seen on the item.
    new ReachMarks(db, () => clock).seen([copy.id], "telegram")
    expect(ledger.get(id)!.state).toBe("seen")
  })

  it("does not send on an item that was seen or answered, a non-urgent one, or with the ladder off", async () => {
    const seen = tell("Seen", { urgent: true })
    tell("Plain")
    const answered = tell("Answered", { urgent: true, requestId: "req-9" })
    const marks = new ReachMarks(db, () => clock)
    marks.seen([seen], "phone")
    marks.answeredByRequest(["req-9"], "reply")
    clock += 30 * MIN
    expect(await run().go()).toBe(0)
    tell("Off", { urgent: true })
    clock += 30 * MIN
    expect(await run({ settings: { ...settings, enabled: false } }).go()).toBe(0)
    expect(ledger.get(answered)!.escalatedAt).toBeNull()
  })

  it("records a failed escalation and never tries it again", async () => {
    const id = tell("Disk full", { urgent: true })
    clock += 11 * MIN
    const r = run({ send: async () => { throw new Error("no") } })
    expect(await r.go()).toBe(0)
    expect(await run().go()).toBe(0)
    expect(ledger.since(0).find((x) => x.escalationOf === id)!.outcome).toBe("failed")
  })

  it("claims each row once even when two sweeps run at the same time", async () => {
    tell("Race", { urgent: true })
    clock += 11 * MIN
    const r = run()
    const [a, b] = await Promise.all([r.go(), r.go()])
    expect(a + b).toBe(1)
    expect(r.sends).toHaveLength(1)
  })
})

describe("a channel that is down", () => {
  function router(adapterHealth: () => { up: boolean; reason?: string }) {
    const send = vi.fn(async () => "id-1")
    const r = new MessageRouter({ getAgent: () => undefined, refusalFor: () => null } as any, { channels: {} } as any, undefined, () => {})
    r.addChannel({ name: "whatsapp", start: async () => {}, stop: async () => {}, onMessage: () => {}, send, health: adapterHealth } as any)
    r.addChannel({ name: "push", start: async () => {}, stop: async () => {}, onMessage: () => {}, send } as any)
    r.setOwnerGate(gate)
    return { r, send }
  }

  it("refuses a send with the reason instead of reporting it sent, and records it failed", async () => {
    const { r, send } = router(() => ({ up: false, reason: "WhatsApp is not connected" }))
    told.addresses = ["whatsapp:216"]
    const err = await r.sendOutbound({ channel: "whatsapp", chatId: "216", text: "Hello\nthere" }).catch((e) => e)
    expect(err).toBeInstanceOf(ChannelDownError)
    expect(err).toMatchObject({ channel: "whatsapp", reason: "WhatsApp is not connected" })
    expect(err.message).toContain("not sent")
    expect(send).not.toHaveBeenCalled()
    expect(ledger.counts(0)).toMatchObject({ failed: 1, sent: 0 })
    expect(r.channelsHealth()).toEqual({ whatsapp: { up: false, reason: "WhatsApp is not connected" }, push: { up: true } })
  })

  it("is refused while switched off, and goes again once switched on", async () => {
    const { r, send } = router(() => ({ up: true }))
    r.setChannelSwitch("push", false)
    await expect(r.sendOutbound({ channel: "push", chatId: "default", text: "A\nb" })).rejects.toThrow(/push channel is down \(switched off by the owner\)/)
    expect(r.channelHealth("push")).toEqual({ up: false, reason: "switched off by the owner" })
    r.setChannelSwitch("push", true)
    await expect(r.sendOutbound({ channel: "push", chatId: "default", text: "C\nd" })).resolves.toBe("id-1")
    expect(send).toHaveBeenCalledTimes(1)
    expect(() => r.setChannelSwitch("nope", false)).toThrow(/Unknown channel/)
  })

  it("WhatsApp without a socket says it is down", () => {
    const wa = new WhatsAppAdapter({ sessionDir: path.join(tmp, "wa") }, () => {})
    expect(wa.health()).toEqual({ up: false, reason: "WhatsApp is not connected" })
  })

  it("raises one notice per down spell, not for a one-check blip", () => {
    let health: Record<string, { up: boolean; reason?: string }> = { whatsapp: { up: false, reason: "closed" } }
    const notices: string[] = []
    const w = new ChannelWatch({ read: () => health, notice: (c, why) => notices.push(`${c}: ${why}`), log: () => {}, now: () => clock })
    w.tick()
    health = { whatsapp: { up: true } }
    w.tick()
    expect(notices).toEqual([])
    health = { whatsapp: { up: false, reason: "closed" } }
    w.tick(); w.tick(); w.tick()
    expect(notices).toEqual(["whatsapp: closed"])
    expect(w.downSince("whatsapp")).toBe(clock)
    health = { whatsapp: { up: true } }
    w.tick()
    health = { whatsapp: { up: false, reason: "again" } }
    w.tick(); w.tick()
    expect(notices).toEqual(["whatsapp: closed", "whatsapp: again"])
  })
})

describe("the phone app's marks", () => {
  it("records presence on the phone and the Desk, seen from the Desk, answered from a Desk reply", () => {
    const a = tell("On the desk", { requestId: "req-1" })
    const b = tell("Card one", { requestId: "req-2" })
    const c = tell("Answered here", { requestId: "req-3" })
    const deps = appReachDeps({ db: () => db, requestOfCard: (id) => (id === "c2" ? "req-2" : null), log: () => {} })
    deps.touch("phone")
    deps.deskSeen(["request:req-1", "card:c2", "card:unknown"])
    deps.deskAnswered("req-3")
    expect(ledger.get(a)).toMatchObject({ state: "seen", seenVia: "desk" })
    expect(ledger.get(b)!.state).toBe("seen")
    expect(ledger.get(c)).toMatchObject({ state: "answered", answeredVia: "desk" })
    expect(new PresenceStore(db).list().map((p) => p.surface).sort()).toEqual(["desk", "phone"])
  })

  it("never fails the page when the database is gone", () => {
    const logs: string[] = []
    const deps = appReachDeps({ db: () => { throw new Error("closed") }, requestOfCard: () => null, log: (m) => logs.push(m) })
    expect(() => deps.touch("phone")).not.toThrow()
    expect(deps.pushRead([{ at: 1, title: "x" }])).toBe(0)
    expect(logs[0]).toMatch(/phone presence not recorded: closed/)
  })

  it("POST /api/app/alerts/read hands the phone's own pushes to the marks", () => {
    const store = new PushStore(db)
    store.log({ title: "Mine", body: "b", url: "/app#alerts", delivered: 1, deviceId: null }, 50, clock)
    store.log({ title: "Other phone", body: "b", url: "/app#alerts", delivered: 1, deviceId: "tok_other" }, 50, clock)
    const ids = store.recent(50).map((r) => r.id)
    const read = vi.fn(() => 1)
    const out = runAppPush(
      { path: "/api/app/alerts/read", method: "POST", body: { ids }, device: { id: "tok_me", name: "phone" } },
      { store: () => store, publicKey: () => "k", keepRecent: 50, allowedHosts: [], alertsRead: read },
    )
    expect(out).toEqual({ status: 200, body: { ok: true, seen: 1 } })
    expect(read).toHaveBeenCalledWith([expect.objectContaining({ title: "Mine", at: clock })])
    expect(runAppPush({ path: "/api/app/alerts/read", method: "POST", body: {}, device: { id: "tok_me", name: "p" } },
      { store: () => store, publicKey: () => "k", keepRecent: 50, allowedHosts: [] }).status).toBe(400)
  })
})

describe("presence", () => {
  it("names the surface of an owner turn", () => {
    expect(turnSurface("app", "c1")).toBe("phone")
    expect(turnSurface("voice", "x")).toBe("computer")
    expect(turnSurface("telegram", "42")).toBe("telegram:42")
  })

  it("writes a surface at most once per throttle, newest first", () => {
    const p = new PresenceStore(db, () => clock, 30_000)
    p.touch("phone")
    clock += 10_000
    p.touch("phone")
    expect(p.list()).toEqual([{ surface: "phone", at: clock - 10_000 }])
    clock += 30_000
    p.touch("phone")
    p.touch("desk")
    expect(p.list()[0].at).toBe(clock)
  })

  it("reads the computer's idle time from ioreg, null when it can't", async () => {
    expect(idleSecondsIn(`    | |     "HIDIdleTime" = 490048478125`)).toBe(490)
    expect(idleSecondsIn("nothing")).toBeNull()
    expect(await macosIdle({ capture: async () => null }).seconds()).toBeNull()
  })
})
