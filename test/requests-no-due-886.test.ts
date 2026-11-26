import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { SlotStore } from "../src/requests/slot-store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi, type RequestsApiDeps } from "../src/requests/daemon-api"
import { DEFAULT_DUE_TIME_SETTINGS, dueTimesCtx, NO_ESTIMATE_REFUSAL, type DueTimeMode } from "../src/requests/due-times"
import { NO_DUE_ASKS_PER_CHECK, NO_DUE_GRACE_MS, runRequestsSweep } from "../src/requests/sweep"

// No open item without a due time (noqta#886): with dueTimes.fillMissing a
// promise or an accept with no due gets the daemon's time even in shadow,
// or is refused with no estimate; the requests check asks each open item
// with no due time, once, for its own. A fake clock throughout.

const MIN = 60_000
const T0 = Date.UTC(2030, 0, 14, 8, 0, 0)

let tmp: string
let db: Database.Database
let store: RequestStore
let slots: SlotStore
let tracker: RequestTracker
let woken: Array<{ agentId: string; text: string; id: string }>

const base: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-no-due-886-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  slots = new SlotStore(db)
  tracker = new RequestTracker(store, () => base, () => {}, () => T0)
  woken = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function deps(mode: DueTimeMode, fillMissing: boolean, now = T0): RequestsApiDeps {
  return {
    store, tracker, enabled: true, now,
    hasAgent: (id) => ["writer"].includes(id),
    runningTurn: (agentId) => ({ channel: "telegram", chatId: `chat-${agentId}` }),
    dueTimes: dueTimesCtx(db, { ...DEFAULT_DUE_TIME_SETTINGS, mode, fillMissing }, { capacity: 4, lanes: () => 1, now: () => now }, slots),
  }
}

let n = 0
const promise = (mode: DueTimeMode, fill: boolean, body: Record<string, unknown> = {}) =>
  handleRequestsApi("POST", "/requests", { agentId: "writer", action: "promise", owedTo: "owner", text: `Write the summary ${++n}`, ...body }, deps(mode, fill))

function ownerRequest(id: string) {
  tracker.taskStarted({
    agentId: "writer", channel: "telegram", chatId: "chat-writer", taskId: id, messagePreview: "Send the offer", fullMessage: "Send the offer",
    at: "", humanRoot: true, sender: { id: "4242" },
  } as any)
  return `req-${id}`
}

const accept = (mode: DueTimeMode, fill: boolean, id: string, body: Record<string, unknown> = {}) =>
  handleRequestsApi("POST", "/requests", { agentId: "writer", action: "accept", work: "ops", id, ...body }, deps(mode, fill))

describe("fillMissing in shadow", () => {
  it("a promise with no due gets the daemon's time", () => {
    const res = promise("shadow", true, { estimateMinutes: 20 })
    expect(res.status).toBe(200)
    const r = (res.body as any).request
    expect(r.dueAt).toBe(T0 + 20 * MIN)
    expect((res.body as any).due).toMatchObject({ dueAt: T0 + 20 * MIN, source: "daemon" })
    expect(slots.get(r.id)).toMatchObject({ mode: "shadow", givenDue: T0 + 20 * MIN })
  })

  it("an accept with no due on a request with none gets the daemon's time", () => {
    const id = ownerRequest("a1")
    expect(accept("shadow", true, id, { estimateMinutes: 45 }).status).toBe(200)
    expect(store.get(id)?.dueAt).toBe(T0 + 45 * MIN)
  })

  it("with no estimate and no usual length it is refused, never given the default minutes", () => {
    const res = promise("shadow", true)
    expect(res.status).toBe(400)
    expect((res.body as any).error).toBe(NO_ESTIMATE_REFUSAL)
    expect(store.listOpen()).toHaveLength(0)
  })

  it("a due the agent wrote is kept as before", () => {
    const due = T0 + 4 * 60 * MIN
    const res = promise("shadow", true, { due: new Date(due).toISOString() })
    expect(res.status).toBe(200)
    expect((res.body as any).request.dueAt).toBe(due)
  })

  it("an accept on a request that already has a due time keeps it", () => {
    const id = ownerRequest("a2")
    const due = T0 + 3 * 60 * MIN
    expect(accept("shadow", true, id, { estimateMinutes: 20, due: new Date(due).toISOString() }).status).toBe(200)
    expect(accept("shadow", true, id, { estimateMinutes: 20 }).status).toBe(200)
    expect(store.get(id)?.dueAt).toBe(due)
  })

  it("switched off, shadow changes nothing: no due is stored", () => {
    const res = promise("shadow", false)
    expect(res.status).toBe(200)
    expect((res.body as any).request.dueAt).toBeNull()
  })
})

describe("fillMissing in on", () => {
  it("refuses work with no estimate instead of the default minutes", () => {
    expect(promise("on", true).status).toBe(400)
    expect(promise("on", false).status).toBe(200)
  })
})

describe("the back-fill in the requests check", () => {
  const settings = (fillMissing: boolean): RequestSettings => ({ ...base, dueTimes: { fillMissing } })
  const sweep = (fillMissing: boolean, now: number) => runRequestsSweep({
    store, settings: settings(fillMissing), now, log: () => {},
    hasAgent: () => true,
    tellAgent: async (agentId, text, r) => { woken.push({ agentId, text, id: r.id }) },
  })
  const openNoDue = (count: number) => {
    const ids: string[] = []
    for (let i = 0; i < count; i++) ids.push((promise("off", false, {}).body as any).request.id)
    return ids
  }

  it("asks each open item with no due time once, a few per check, until none is left unasked", async () => {
    const ids = openNoDue(NO_DUE_ASKS_PER_CHECK + 2)
    const later = T0 + NO_DUE_GRACE_MS + MIN
    const first = await sweep(true, later)
    expect(first.dueAsked).toBe(NO_DUE_ASKS_PER_CHECK)
    const second = await sweep(true, later + MIN)
    expect(second.dueAsked).toBe(2)
    expect((await sweep(true, later + 2 * MIN)).dueAsked).toBe(0)
    expect(woken.map((w) => w.id).sort()).toEqual([...ids].sort())
    expect(woken[0].text).toMatch(/^\[agentx:request-no-due id=\S+\] It is open and has no due time/)
    expect(woken[0].text).toContain('{action:"accept", id:"')
  })

  it("the agent's accept with an estimate leaves 0 open items with due_at NULL", async () => {
    const ids = openNoDue(2)
    await sweep(true, T0 + NO_DUE_GRACE_MS + MIN)
    for (const id of ids) expect(accept("shadow", true, id, { estimateMinutes: 30 }).status).toBe(200)
    const left = db.prepare("SELECT COUNT(*) AS n FROM requests WHERE state IN ('in_progress','waiting_owner','waiting_other','needs_attention') AND due_at IS NULL").get() as { n: number }
    expect(left.n).toBe(0)
  })

  it("leaves a new item its grace time, and does nothing while switched off", async () => {
    openNoDue(1)
    expect((await sweep(true, T0 + NO_DUE_GRACE_MS - MIN)).dueAsked).toBe(0)
    expect((await sweep(false, T0 + NO_DUE_GRACE_MS + MIN)).dueAsked).toBe(0)
    expect(woken).toHaveLength(0)
  })
})
