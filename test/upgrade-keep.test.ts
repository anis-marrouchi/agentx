import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { Agent } from "undici"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import {
  HELD_UPGRADE, RESTART_REASON, UPGRADE_HELD_LINE, UPGRADE_KEEP_MS, UPGRADE_TOO_OLD, VoiceRequestStore, handleVoiceRequests,
} from "../src/daemon/voice-requests-api"
import { drainAsk, keepAskForUpgrade, postKeptAsk, readWidgetKeep, replayKept, upgradingText, writeWidgetKeep } from "../src/daemon/upgrade-keep"

// #2502: a widget message sent while the daemon drains for an upgrade is
// kept on its row, answered at once, and sent once by the next daemon.

let tmp: string
let db: Database.Database
const T0 = Date.UTC(2026, 10, 27, 14, 26, 0)

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-upgrade-keep-"))
  db = openDb({ path: path.join(tmp, "db.sqlite") })!
})
afterEach(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }) })

describe("keepAskForUpgrade (old daemon, draining)", () => {
  it("keeps the row and answers 202 with a speakable line", () => {
    const store = new VoiceRequestStore(db, T0)
    const r = store.create("pm-agent", "are we on 300?", false, T0)
    const t = Date.now()
    const reply = keepAskForUpgrade({ store, body: { message: "are we on 300?", request: r.id, session: "S1" }, msLeft: 200_000, now: T0 + 1000 })
    expect(Date.now() - t).toBeLessThan(2000)
    expect(reply?.status).toBe(202)
    expect(reply?.body).toMatchObject({ kept: true, request: r.id, agentId: "pm-agent", text: "AgentX is upgrading, back in about 5 minutes. Your message is kept." })
    expect(store.get(r.id)).toMatchObject({ state: "thinking", held: UPGRADE_HELD_LINE })
    expect(db.prepare("SELECT held, session FROM voice_requests WHERE id = ?").get(r.id)).toEqual({ held: HELD_UPGRADE, session: "S1" })
  })

  it("without a row, or with a closed or done one, nothing is kept (the caller answers 503)", () => {
    const store = new VoiceRequestStore(db, T0)
    expect(keepAskForUpgrade({ store, body: { message: "hi" }, msLeft: 0 })).toBeNull()
    expect(keepAskForUpgrade({ store: null, body: { request: "rabcdefgh1" }, msLeft: 0 })).toBeNull()
    const done = store.create("pm-agent", "q", false, T0)
    store.settle(done.id, 200, { text: "ok" }, T0)
    expect(keepAskForUpgrade({ store, body: { request: done.id }, msLeft: 0 })).toBeNull()
    const closed = store.create("pm-agent", "q2", false, T0)
    store.close(closed.id, T0)
    expect(keepAskForUpgrade({ store, body: { request: closed.id }, msLeft: 0 })).toBeNull()
  })

  it("says at least one minute, and the start minute on top of the drain left", () => {
    expect(upgradingText(0)).toBe("AgentX is upgrading, back in about 1 minute. Your message is kept.")
    expect(upgradingText(-5000)).toContain("about 1 minute.")
    expect(upgradingText(61_000)).toContain("about 3 minutes.")
  })
})

describe("drainAsk (drain gate, #2502 B3)", () => {
  it("a caller that fails the mesh check keeps nothing, and the body is not read", async () => {
    const store = new VoiceRequestStore(db, T0)
    const r = store.create("pm-agent", "q", false, T0)
    let read = false
    const out = await drainAsk({
      authorized: () => false,
      readBody: async () => { read = true; return { request: r.id } },
      keep: (body) => keepAskForUpgrade({ store, body, msLeft: 0, now: T0 }),
    })
    expect(out).toBe("refused")
    expect(read).toBe(false)
    expect(db.prepare("SELECT held FROM voice_requests WHERE id = ?").get(r.id)).toEqual({ held: null })
  })

  it("a caller that passes the mesh check has its row kept", async () => {
    const store = new VoiceRequestStore(db, T0)
    const r = store.create("pm-agent", "q", false, T0)
    const out = await drainAsk({
      authorized: () => true,
      readBody: async () => ({ request: r.id }),
      keep: (body) => keepAskForUpgrade({ store, body, msLeft: 0, now: T0 }),
    })
    expect(out).toMatchObject({ status: 202, body: { kept: true, request: r.id } })
    expect(db.prepare("SELECT held FROM voice_requests WHERE id = ?").get(r.id)).toEqual({ held: HELD_UPGRADE })
  })
})

describe("next daemon's boot", () => {
  it("keeps upgrade rows thinking, fails other thinking rows, and fails kept rows past 30 min", () => {
    const old = new VoiceRequestStore(db, T0)
    const kept = old.create("pm-agent", "kept", false, T0)
    const stale = old.create("pm-agent", "stale", false, T0 - UPGRADE_KEEP_MS - 1)
    const busy = old.create("pm-agent", "busy", false, T0)
    old.keepForUpgrade(kept.id, null, T0)
    old.keepForUpgrade(stale.id, null, T0)
    old.hold(busy.id, "Not started yet: busy.") // an admission hold is not an upgrade

    const store = new VoiceRequestStore(db, T0 + 60_000)
    expect(store.get(kept.id)).toMatchObject({ state: "thinking", held: UPGRADE_HELD_LINE })
    expect(store.get(stale.id)).toMatchObject({ state: "failed", error: UPGRADE_TOO_OLD })
    expect(store.get(busy.id)).toMatchObject({ state: "failed", error: RESTART_REASON })
    expect(store.keptForUpgrade().map((r) => r.id)).toEqual([kept.id])
  })

  it("replays each kept row once, oldest first; a second boot sends nothing", async () => {
    const old = new VoiceRequestStore(db, T0)
    const a = old.create("pm-agent", "first", false, T0)
    const b = old.create("coder-agent", "second", false, T0 + 1000)
    old.keepForUpgrade(b.id, "S", T0 + 2000)
    old.keepForUpgrade(a.id, "S", T0 + 3000)

    const store = new VoiceRequestStore(db, T0 + 60_000)
    const sent: string[] = []
    const ask = async (row: { id: string; question: string; session: string | null }) => {
      expect(store.get(row.id)?.held).toBeNull() // no longer kept while it runs
      sent.push(`${row.question}/${row.session}`)
      store.settle(row.id, 200, { text: `answer to ${row.question}` })
    }
    expect(await replayKept({ store, ask, log: () => {} })).toBe(2)
    expect(sent).toEqual(["first/S", "second/S"])
    expect(store.get(a.id)?.state).toBe("answered")

    const again = new VoiceRequestStore(db, T0 + 120_000)
    expect(await replayKept({ store: again, ask, log: () => {} })).toBe(0)
    expect(sent).toHaveLength(2)
  })

  it("a daemon that dies mid-replay fails the row at the next boot, never runs it twice", async () => {
    const old = new VoiceRequestStore(db, T0)
    const r = old.create("pm-agent", "q", false, T0)
    old.keepForUpgrade(r.id, null, T0)
    const store = new VoiceRequestStore(db, T0 + 60_000)
    // The ask never settles: the daemon stopped mid-run.
    void replayKept({ store, ask: () => new Promise(() => {}), log: () => {} })
    const next = new VoiceRequestStore(db, T0 + 120_000)
    expect(next.keptForUpgrade()).toEqual([])
    expect(next.get(r.id)).toMatchObject({ state: "failed", error: RESTART_REASON })
  })

  it("a send that throws fails the row with why", async () => {
    const old = new VoiceRequestStore(db, T0)
    const r = old.create("pm-agent", "q", false, T0)
    old.keepForUpgrade(r.id, null, T0)
    const store = new VoiceRequestStore(db, T0 + 60_000)
    await replayKept({ store, ask: async () => { throw new Error("connection refused") }, log: () => {} })
    expect(store.get(r.id)?.state).toBe("failed")
    expect(store.get(r.id)?.error).toContain("connection refused")
  })

  // C1 + B1: a kept row (window A) starts before a row the widget sends
  // once the daemon is back (window B), but B does not wait for A's answer.
  // The daemon's /ask waits on the replay promise for every widget row that
  // is not the replay's own; modelled here.
  it("a row sent after boot waits until the kept rows have started, not answered", async () => {
    const old = new VoiceRequestStore(db, T0)
    const a = old.create("pm-agent", "kept during drain", false, T0)
    const c = old.create("pm-agent", "also kept", false, T0 + 1)
    old.keepForUpgrade(a.id, null, T0)
    old.keepForUpgrade(c.id, null, T0 + 1)
    const store = new VoiceRequestStore(db, T0 + 60_000)
    const order: string[] = []
    let release!: () => void
    const slow = new Promise<void>((r) => { release = r })
    const replay = replayKept({ store, log: () => {}, ask: async (row, sent) => {
      order.push(`start ${row.question}`)
      sent()
      await slow
      order.push(`answer ${row.question}`)
      store.settle(row.id, 200, { text: "a" })
    } })
    const b = store.create("pm-agent", "sent after boot", false, T0 + 61_000, "client-key-b-0001")
    await replay
    order.push(`start ${store.get(b.id)!.question}`)
    expect(order).toEqual(["start kept during drain", "start also kept", "start sent after boot"])
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(store.get(a.id)?.state).toBe("answered")
  })

  it("a send that ends before sent() still lets the next row start", async () => {
    const old = new VoiceRequestStore(db, T0)
    const a = old.create("pm-agent", "one", false, T0)
    const c = old.create("pm-agent", "two", false, T0 + 1)
    old.keepForUpgrade(a.id, null, T0)
    old.keepForUpgrade(c.id, null, T0 + 1)
    const store = new VoiceRequestStore(db, T0 + 60_000)
    const seen: string[] = []
    expect(await replayKept({ store, log: () => {}, ask: async (row) => {
      seen.push(row.question)
      if (row.question === "one") throw new Error("refused")
    } })).toBe(2)
    expect(seen).toEqual(["one", "two"])
    expect(store.get(a.id)?.state).toBe("failed")
  })
})

// B2: a kept run can take longer than fetch's 300 s header limit. The
// replay's fetch has none; shown with a short limit and a slow reply.
describe("postKeptAsk", () => {
  let server: Server
  let url: string
  beforeEach(async () => {
    server = createServer((_req, res) => { setTimeout(() => res.end("ok"), 2000) })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ask`
  })
  afterEach(async () => { await new Promise((r) => server.close(r)) })

  it("waits for a reply slower than a header time limit", { timeout: 15_000 }, async () => {
    const short = new Agent({ headersTimeout: 300 })
    await expect(postKeptAsk(url, {}, {}, short)).rejects.toThrow()
    await short.close()
    await expect(postKeptAsk(url, {}, {})).resolves.toBeUndefined()
  })
})

describe("clientKey", () => {
  it("one row per client message, however often it is sent", () => {
    const store = new VoiceRequestStore(db, T0)
    const deps = { store, knows: () => true, stop: () => 0 }
    const body = { agentId: "pm-agent", question: "hello", clientKey: "5f0e2c1a-aaaa-bbbb-cccc-0123456789ab" }
    const one = handleVoiceRequests(deps, "POST", "/voice/requests", body)
    const two = handleVoiceRequests(deps, "POST", "/voice/requests", body)
    expect((one.body as any).request.id).toBe((two.body as any).request.id)
    expect(store.list()).toHaveLength(1)
    // No key, or a malformed one: a new row each time, as before.
    handleVoiceRequests(deps, "POST", "/voice/requests", { agentId: "pm-agent", question: "hello" })
    handleVoiceRequests(deps, "POST", "/voice/requests", { agentId: "pm-agent", question: "hello", clientKey: "x" })
    expect(store.list()).toHaveLength(3)
  })
})

describe("widget-keep record for last.json", () => {
  it("old daemon counts kept messages, the new one adds replayed; an older upgrade's record is replaced", () => {
    const dir = path.join(tmp, ".agentx")
    const drainStart = "2026-11-27T14:24:16.000Z"
    writeWidgetKeep(dir, "2026-11-20T00:00:00.000Z", { kept: 4 }, new Date("2026-11-20T10:00:00.000Z"))
    writeWidgetKeep(dir, drainStart, { kept: 1 }, new Date("2026-11-27T14:26:00.000Z"))
    writeWidgetKeep(dir, drainStart, { kept: 1 }, new Date("2026-11-27T14:27:00.000Z"))
    writeWidgetKeep(dir, "2026-11-27T14:00:24.000Z", { replayed: 2 }, new Date("2026-11-27T14:30:24.000Z"))
    expect(readWidgetKeep(dir, drainStart)).toEqual({ at: "2026-11-27T14:26:00.000Z", kept: 2, replayed: 2 })
    expect(readWidgetKeep(dir, "2026-11-28T00:00:00.000Z")).toBeNull()
  })
})
