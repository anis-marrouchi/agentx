import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import {
  HELD_UPGRADE, RESTART_REASON, UPGRADE_HELD_LINE, UPGRADE_KEEP_MS, UPGRADE_TOO_OLD, VoiceRequestStore, handleVoiceRequests,
} from "../src/daemon/voice-requests-api"
import { keepAskForUpgrade, readWidgetKeep, replayKept, upgradingText, writeWidgetKeep } from "../src/daemon/upgrade-keep"

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

  // C1: a kept row (window A) answers before a row the widget sends once
  // the daemon is back (window B). The daemon's /ask waits on the replay
  // promise for every widget row that is not the replay's own; modelled here.
  it("a row sent after boot waits for the kept rows", async () => {
    const old = new VoiceRequestStore(db, T0)
    const a = old.create("pm-agent", "kept during drain", false, T0)
    old.keepForUpgrade(a.id, null, T0)
    const store = new VoiceRequestStore(db, T0 + 60_000)
    const order: string[] = []
    let release!: () => void
    const slow = new Promise<void>((r) => { release = r })
    const replay = replayKept({ store, log: () => {}, ask: async (row) => { await slow; order.push(row.question); store.settle(row.id, 200, { text: "a" }) } })
    const b = store.create("pm-agent", "sent after boot", false, T0 + 61_000, "client-key-b-0001")
    const askB = (async () => { await replay; order.push(store.get(b.id)!.question) })()
    release()
    await askB
    expect(order).toEqual(["kept during drain", "sent after boot"])
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
