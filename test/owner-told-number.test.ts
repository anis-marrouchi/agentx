import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { DEFAULT_TELL_SETTINGS, OwnerGate, ToldLedger, toldOfBody, type TellSettings } from "../src/notify/told"
import { DEFAULT_REACH_SETTINGS, escalateUnseen, ladderStops, ReachMarks } from "../src/notify/reach"
import { attachReach } from "../src/notify/reach-attach"
import { getEventBus } from "../src/events/bus"
import { MessageRouter } from "../src/channels/router"
import { setSendToChatRecorder } from "../src/situations/send-to-chat"
import {
  deskOver24h, localNumber, numberLine, numberReport, peerNumbers, unansweredDays, type NodeNumber,
} from "../src/notify/unanswered"
import { digestText } from "../src/approvals/sweep"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"

// #1936, owner mediator phase 0: the number (items sent to the owner per
// day that he did not see or answer within 24 h), its two guards, the
// record-only list for his chats with agents, and the reply flag. Nothing
// here may change what is sent.

const MIN = 60_000
const HOUR = 60 * MIN
let tmp: string
let db: Database.Database
let clock: number
let settings: TellSettings
let ledger: ToldLedger
let gate: OwnerGate

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-number-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  clock = Date.UTC(2026, 10, 17, 9)
  settings = { ...DEFAULT_TELL_SETTINGS, addresses: ["telegram:42"], record: ["telegram:7"] }
  ledger = new ToldLedger(db)
  gate = new OwnerGate(ledger, () => settings, () => clock)
})
afterEach(() => {
  setSendToChatRecorder(null)
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const push = (title: string, text = "body") => ({ channel: "push", chatId: "default", title, text })

describe("the reply flag", () => {
  it("is added to a table made before it; old rows read as not a reply", () => {
    const old = new Database(path.join(tmp, "old.sqlite"))
    old.exec(`CREATE TABLE owner_told (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, item_key TEXT NOT NULL, request_id TEXT,
      kind TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL, sender TEXT, title TEXT NOT NULL, text TEXT NOT NULL,
      outcome TEXT NOT NULL, digested_at INTEGER)`)
    old.prepare("INSERT INTO owner_told (at, item_key, kind, channel, chat_id, title, text, outcome) VALUES (1, 'k', 'notice', 'push', 'default', 'T', 'x', 'sent')").run()
    const l = new ToldLedger(old)
    new ToldLedger(old) // a second process opening the same file
    expect(l.since(0)[0]).toMatchObject({ reply: false, state: "sent" })
    old.close()
  })

  it("is set by the daemon only: a /send caller cannot mark its message a reply", () => {
    expect(toldOfBody({ reply: true, key: "x" }, "cx")).toEqual({ key: "send:x", from: "cx" })
    const id = gate.decide(push("Answer"), { reply: true }).rowId
    expect(ledger.get(id)!.reply).toBe(true)
    expect(ledger.get(gate.decide(push("Notice"), {}).rowId)!.reply).toBe(false)
  })
})

describe("the record-only list", () => {
  it("writes a row for a send to a listed chat, outside the gate: never repeat, never digest, never urgent", () => {
    expect(gate.isOwnerAddress("telegram", "7")).toBe(false)
    const a = gate.record({ channel: "telegram", chatId: "7", title: "Here is the plan", text: "step 1" }, { from: "secretary" })
    const b = gate.record({ channel: "telegram", chatId: "7", title: "Here is the plan", text: "step 1" }, { from: "secretary", reply: true })
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(ledger.get(a!)).toMatchObject({ outcome: "recorded", urgent: false, reply: false, from: "secretary", channel: "telegram", chatId: "7" })
    expect(ledger.get(b!)!.reply).toBe(true)
    // Each send is its own item: two rows, two keys.
    expect(ledger.get(a!)!.key).not.toBe(ledger.get(b!)!.key)
    // A chat not on the list, an owner address (gated elsewhere), or the record off: nothing written.
    expect(gate.record({ channel: "telegram", chatId: "99", title: "x", text: "" })).toBeNull()
    expect(gate.record({ channel: "telegram", chatId: "42", title: "x", text: "" })).toBeNull()
    settings = { ...settings, enabled: false }
    expect(gate.record({ channel: "telegram", chatId: "7", title: "x", text: "" })).toBeNull()
  })

  it("is never on the urgent ladder", () => {
    expect(ladderStops({ ladder: [] }, settings, () => true)).toEqual(["push:default", "ntfy:default", "telegram:42"])
  })

  it("rows are seen when the owner writes again in that chat, and only those rows", () => {
    const rec = gate.record({ channel: "telegram", chatId: "7", title: "Plan", text: "" })!
    // A gated row in another owner chat is left to the existing marks.
    const gated = gate.decide({ channel: "telegram", chatId: "42", title: "Notice", text: "" }, { key: "n1" }).rowId
    const reach = attachReach({
      db, ledger, settings: () => DEFAULT_REACH_SETTINGS, told: () => settings,
      channels: { has: () => true, health: () => ({ up: true }), all: () => ({}) },
      send: async () => {}, notice: () => {}, isOwnerTurn: (p) => p.sender?.id === "owner",
      request: () => null, cardDecidedAt: () => null, log: () => {}, now: () => clock,
    })
    clock += 5 * MIN
    const turn = (over: Record<string, unknown>) => getEventBus().emit("task:started", {
      agentId: "secretary", taskId: "t1", channel: "telegram", chatId: "7", messagePreview: "ok", humanRoot: true, sender: { id: "owner" }, ...over,
    } as any)
    turn({ sender: { id: "someone" } })
    expect(ledger.get(rec)!.seenAt).toBeNull()
    turn({ chatId: "42" })
    expect(ledger.get(gated)!.seenAt).toBeNull()
    turn({})
    expect(ledger.get(rec)).toMatchObject({ seenAt: clock, seenVia: "chat" })
    reach.detach()
  })

  it("is written by the one send funnel after a send that worked, with the router's reply path marked reply", async () => {
    settings = { ...settings, record: ["signal:7"] }
    const sent: string[] = []
    const r = new MessageRouter({ getAgent: () => undefined, refusalFor: () => null } as any, { channels: {} } as any, undefined, () => {})
    const adapter = { name: "signal", start: async () => {}, stop: async () => {}, onMessage: () => {}, send: vi.fn(async (m: any) => { sent.push(`${m.chatId}:${m.text}`) }) }
    r.addChannel(adapter as any)
    r.setOwnerGate(gate)
    setSendToChatRecorder((m) => { gate.record({ channel: m.channel, chatId: m.chatId, title: m.text, text: "" }, { from: m.agentId, reply: m.reply }) })
    await r.sendOutbound({ channel: "signal", chatId: "7", agentId: "secretary", text: "Your report is ready" }, { countsAsReply: true })
    await r.sendOutbound({ channel: "signal", chatId: "99", text: "Someone else" })
    // The reply path (an agent's answer to the message just written there).
    await (r as any).adapterSend(adapter, { channel: "signal", chatId: "7", text: "Done, here it is" }, { countsAsReply: true })
    // A notice on the reply path is not a reply.
    await (r as any).adapterSend(adapter, { channel: "signal", chatId: "7", text: "Still working" }, { countsAsReply: false })
    expect(sent).toEqual(["7:Your report is ready", "99:Someone else", "7:Done, here it is", "7:Still working"])
    const rows = ledger.since(0).reverse()
    expect(rows.map((x) => [x.title, x.outcome, x.reply])).toEqual([
      // sendOutbound is never the reply path: what it carries counts.
      ["Your report is ready", "recorded", false],
      ["Done, here it is", "recorded", true],
      ["Still working", "recorded", false],
    ])
    expect(rows[0].from).toBe("secretary")
  })
})

describe("the gate, the urgent ladder and the repeat check act exactly as before", () => {
  // One script of sends, run with and without the record list: the same
  // verdicts, the same escalations, the same counts of gated rows.
  async function script(s: TellSettings) {
    const d2 = new Database(":memory:")
    let t = clock
    const l = new ToldLedger(d2)
    const g = new OwnerGate(l, () => s, () => t)
    const verdicts: string[] = []
    const say = (m: ReturnType<typeof push> | { channel: string; chatId: string; title: string; text: string }, meta: any) => {
      verdicts.push(g.decide(m, meta).verdict)
      // A record-only send in between must change nothing.
      g.record({ channel: "telegram", chatId: "7", title: m.title, text: m.text }, { from: "secretary", reply: false })
    }
    say(push("Disk low", "The Mac disk is low: 3.1 GB free on the system volume"), { textKey: true })
    say({ channel: "telegram", chatId: "42", title: "Disk low", text: "The Mac disk is low: 3.1 GB free on the system volume" }, { textKey: true })
    say(push("Not finished: Book the venue"), { kind: "nag", key: "request:r1:attention" })
    say(push("Not finished: Book the venue"), { kind: "nag", key: "request:r1:attention" })
    say(push("Call now"), { key: "call:1", urgent: true })
    say(push("Backups"), { key: "backup" })
    t += 2 * HOUR
    say(push("Backups"), { key: "backup" })
    const escalated: string[] = []
    await escalateUnseen({
      db: d2, ledger: l, settings: { enabled: true, escalateAfterMinutes: 10, ladder: [] },
      stops: ladderStops({ ladder: [] }, s, () => true), up: () => true, now: clock + 15 * MIN, log: () => {},
      send: async (stop, row) => { escalated.push(`${row.title}->${stop}`) },
    })
    const counts = l.counts(0)
    const landed = l.states(0)
    const digest = g.digestLine()?.line ?? null
    d2.close()
    return { verdicts, escalated, counts: { ...counts, recorded: undefined }, landed, digest }
  }

  it("with and without notifications.told.record", async () => {
    const before = await script({ ...DEFAULT_TELL_SETTINGS, addresses: ["telegram:42"] })
    const after = await script({ ...DEFAULT_TELL_SETTINGS, addresses: ["telegram:42"], record: ["telegram:7"] })
    expect(before.verdicts).toEqual(["send", "repeat", "digest", "repeat", "send", "send", "repeat"])
    expect(before.escalated).toEqual(["Call now->ntfy:default"])
    expect(after).toEqual(before)
  })
})

describe("the number", () => {
  const row = (at: number, key: string, over: Record<string, unknown> = {}) => ({
    at, key, outcome: "sent" as const, reply: false, seenAt: null as number | null, answeredAt: null as number | null, ...over,
  })
  const day = Date.UTC(2026, 10, 16, 8)

  it("counts per item, not per row; an escalation and its row are one item", () => {
    const days = unansweredDays([
      row(day, "a"), row(day + 10 * MIN, "a"), // escalation of a, unseen
      row(day + HOUR, "b", { seenAt: day + 2 * HOUR }),
      row(day + HOUR, "c", { answeredAt: day + 30 * HOUR }), // answered too late
      row(day + 2 * HOUR, "d", { outcome: "held", seenAt: day + 3 * HOUR }),
    ], { now: day + 3 * 24 * HOUR, timezone: "UTC" })
    expect(days).toEqual([{ day: "2026-11-16", items: 4, landed: 2, notLanded: 2, waiting: 0 }])
  })

  it("leaves out replies, kept-back rows and failed sends; counts record-only rows", () => {
    const days = unansweredDays([
      row(day, "a", { reply: true }),
      row(day, "b", { outcome: "repeat" }), row(day, "c", { outcome: "digest" }), row(day, "d", { outcome: "failed" }),
      row(day, "e", { outcome: "recorded" }),
    ], { now: day + 3 * 24 * HOUR, timezone: "UTC" })
    expect(days).toEqual([{ day: "2026-11-16", items: 1, landed: 0, notLanded: 1, waiting: 0 }])
  })

  it("an item younger than 24 h and not seen yet is waiting, not counted against him", () => {
    const now = day + 5 * HOUR
    const days = unansweredDays([row(day, "a"), row(day + HOUR, "b", { seenAt: day + 2 * HOUR })], { now, timezone: "UTC" })
    expect(days).toEqual([{ day: "2026-11-16", items: 2, landed: 1, notLanded: 0, waiting: 1 }])
  })

  it("buckets days in the digest's time zone", () => {
    const late = Date.UTC(2026, 10, 16, 23, 30)
    expect(unansweredDays([row(late, "a")], { now: late + 48 * HOUR, timezone: "Africa/Tunis" })[0].day).toBe("2026-11-17")
  })

  it("is read from the ledger with the Desk guard and the batch guard (0 until batching exists)", () => {
    gate.decide(push("One"), { key: "one" })
    gate.decide(push("Answer"), { key: "two", reply: true })
    gate.record({ channel: "telegram", chatId: "7", title: "Hello", text: "" })
    clock += 30 * HOUR
    const n = localNumber(ledger, {
      node: "this-node", days: 7, now: clock, timezone: "UTC",
      desk: { items: [{ askedAt: new Date(clock - 25 * HOUR).toISOString() }, { askedAt: new Date(clock - HOUR).toISOString() }, {}] as any },
    })
    expect(n).toMatchObject({ node: "this-node", reachable: true, guards: { deskOver24h: 1, batchedOver24h: 0 } })
    expect(n.reachable && n.days).toEqual([{ day: "2026-11-17", items: 2, landed: 0, notLanded: 2, waiting: 0 }])
  })

  it("counts Desk items older than 24 h; an item without an ask time is not guessed", () => {
    const now = Date.UTC(2026, 10, 18, 9)
    expect(deskOver24h({ items: [{ askedAt: new Date(now - 30 * HOUR).toISOString() }, { askedAt: "nonsense" }, {}] as any }, now)).toBe(1)
  })
})

describe("mesh peers", () => {
  const ok = (node: string, notLanded: number): NodeNumber => ({
    node, reachable: true, guards: { deskOver24h: 1, batchedOver24h: 0 },
    days: [{ day: "2026-11-17", items: notLanded + 2, landed: 2, notLanded, waiting: 0 }],
  })

  it("asks each peer for its own number; a peer down or failing is unreachable, never 0", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.startsWith("http://b")) return { ok: true, status: 200, json: async () => ok("b-node", 3) }
      return { ok: false, status: 401, json: async () => ({ error: "mesh token needed" }) }
    })
    const peers = [
      { peer: "b", peerUrl: "http://b:1", healthy: true },
      { peer: "c", peerUrl: "http://c:1", healthy: true },
      { peer: "d", peerUrl: "http://d:1", healthy: false },
    ]
    const out = await peerNumbers(peers, { days: 7, fetch: fetchFn as any, headers: () => ({ Authorization: "Bearer t" }) })
    expect(fetchFn).toHaveBeenCalledWith("http://b:1/owner/told/number?days=7", expect.objectContaining({ headers: { Authorization: "Bearer t" } }))
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(out).toEqual([
      { ...ok("b-node", 3), node: "b" },
      { node: "c", reachable: false, error: "answered 401" },
      { node: "d", reachable: false, error: "down at the last mesh check" },
    ])
  })

  it("is one line for the morning digest: the day, every node, both guards", () => {
    const line = numberLine([ok("this node", 5), ok("b", 3), { node: "c", reachable: false, error: "x" }], "2026-11-17")
    expect(line).toBe("Not seen or answered within 24 h on 2026-11-17: 8 of 12 items (this node 5 of 7, b 3 of 5, c unreachable). Desk items waiting over 24 h: 2. Batched over 24 h, not sent: 0.")
    // A day with nothing sent reads 0 of 0, never left out.
    expect(numberLine([ok("this node", 0)], "2026-11-16")).toContain("0 of 0 items (this node 0 of 0)")
  })

  it("agentx notify --told prints the line, then each node per day with its guards", () => {
    const nodes: NodeNumber[] = [
      { ...ok("this node", 5), days: [{ day: "2026-11-17", items: 7, landed: 2, notLanded: 5, waiting: 0 }, { day: "2026-11-18", items: 3, landed: 1, notLanded: 0, waiting: 2 }] } as NodeNumber,
      { node: "c", reachable: false, error: "answered 401" },
    ]
    expect(numberReport({ line: "L", nodes })).toEqual([
      "  L",
      "  this node: Desk items waiting over 24 h: 1; batched over 24 h, not sent: 0",
      "     2026-11-17  5 of 7 not seen or answered within 24 h",
      "     2026-11-18  0 of 3 not seen or answered within 24 h (2 still within 24 h)",
      "  c: unreachable (answered 401)",
    ])
    expect(numberReport(undefined)).toEqual([])
  })

  it("the digest carries the line next to its other lines", () => {
    expect(digestText({ count: 1, later: 0, items: [] }, undefined, undefined, "Not seen or answered within 24 h on 2026-11-17: 1 of 1 items.")).toContain("Not seen or answered within 24 h")
    expect(digestText({ count: 1, later: 0, items: [] })).not.toContain("Not seen")
  })

  it("the endpoint peers read is protected like the told record itself", () => {
    expect(isMeshGatedPath("/owner/told")).toBe(true)
    expect(isMeshGatedPath("/owner/told/number")).toBe(true)
  })
})

describe("the morning digest", () => {
  const SET = { defaultExpiryDays: 3, maxExpiryDays: 30, laterHours: 24, notifyAgent: true, digest: { enabled: true, time: "09:00", timezone: "UTC" } }
  const sweep = async (numberLine: () => Promise<string | null>) => {
    const { runApprovalsSweep } = await import("../src/approvals/sweep")
    const texts: string[] = []
    const r = await runApprovalsSweep({
      ctx: { root: tmp, now: clock + 30 * MIN }, settings: SET as any, log: () => {},
      fallbackDestination: { channel: "push", chatId: "default" },
      sendDigest: async (_d, text) => { texts.push(text) },
      nags: { line: () => gate.digestLine(), done: (ids) => gate.markDigested(ids) },
      numberLine,
    })
    return { r, texts }
  }

  it("carries the number's line when a digest goes out", async () => {
    gate.decide(push("Not finished: Book the venue"), { kind: "nag", key: "request:r1:attention" })
    const { r, texts } = await sweep(async () => "Not seen or answered within 24 h on 2026-11-16: 3 of 4 items (this node 3 of 4).")
    expect(r.digest).toBe("sent")
    expect(texts[0]).toContain("Not seen or answered within 24 h on 2026-11-16")
  })

  it("never makes a digest go out by itself, and a number that cannot be read does not stop it", async () => {
    const asked = vi.fn(async () => "line")
    expect((await sweep(asked)).r.digest).toBe("empty")
    expect(asked).not.toHaveBeenCalled()
    gate.decide(push("Not finished: Book the venue"), { kind: "nag", key: "request:r1:attention" })
    const { r, texts } = await sweep(async () => { throw new Error("db closed") })
    expect(r.digest).toBe("sent")
    expect(texts[0]).not.toContain("Not seen")
  })
})

describe("seen marks", () => {
  it("seenInChat marks only record-only rows of that chat", () => {
    const rec = gate.record({ channel: "telegram", chatId: "7", title: "Plan", text: "" })!
    const other = gate.record({ channel: "telegram", chatId: "7", title: "Later", text: "" })!
    const gated = gate.decide({ channel: "telegram", chatId: "42", title: "N", text: "" }, { key: "n" }).rowId
    clock += MIN
    const marks = new ReachMarks(db, () => clock)
    expect(marks.seenInChat("telegram", "42")).toBe(0)
    expect(ledger.get(gated)!.seenAt).toBeNull()
    expect(marks.seenInChat("telegram", "7")).toBe(2)
    expect(ledger.get(rec)!.seenVia).toBe("chat")
    expect(ledger.get(other)!.seenAt).toBe(clock)
  })
})
