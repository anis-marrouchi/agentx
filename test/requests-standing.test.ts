import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { OWNER_BY, RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsCall, type RequestsApiDeps } from "../src/requests/daemon-api"
import { DEFAULT_PROMISE_SETTINGS } from "../src/requests/promise"
import { parseStanding, readStanding, standingRefusal } from "../src/requests/standing"
import { NumberStore } from "../src/numbers/store"

// Standing orders (noqta#807, rule R5): "every day" from the owner is a
// recurring job with a number that proves it; only the owner ends it.
// TC noqta#808: standing job made; close as done refused; its number shown.

const AGENTS = new Set(["marketing", "devops"])

let tmp: string
let db: Database.Database
let store: RequestStore
let numbers: NumberStore
let tracker: RequestTracker
let settings: RequestSettings
let clock: number

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-standing-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  numbers = new NumberStore(db)
  clock = Date.parse("2030-03-01T12:00:00Z")
  settings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90, promises: { ...DEFAULT_PROMISE_SETTINGS } }
  tracker = new RequestTracker(store, () => settings, () => {}, () => clock)
  numbers.upsert({ id: "posts-per-day", name: "Posts published", rhythm: "daily", ownerAgent: "marketing", origin: "agent", target: { value: 2, direction: "up" } }, clock)
  store.addCandidate({ id: "req-daily", runId: "run-1", channel: "telegram", chatId: "chat-1", sender: "4242", agentId: "marketing", text: "Publish two posts every day", now: clock })
  store.progress("req-daily", clock)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const deps = (over: Partial<RequestsApiDeps> = {}): RequestsApiDeps => ({
  store, tracker, enabled: true, hasAgent: (id) => AGENTS.has(id), now: clock,
  runningTurn: (agentId) => (AGENTS.has(agentId) ? { channel: "telegram", chatId: "chat-1" } : null),
  numbers, ...over,
})
const post = (body: Record<string, unknown>, over: Partial<RequestsApiDeps> = {}) => handleRequestsCall("POST", "/requests", body, deps(over))
const markStanding = (extra: Record<string, unknown> = {}) =>
  post({ action: "standing", agentId: "marketing", id: "req-daily", number: "posts-per-day", cron: "marketing-daily-posts", ...extra })

describe("marking a standing order", () => {
  it("links the number and the cron, takes the number's rhythm, and keeps the request open", async () => {
    const res = await markStanding()
    expect(res.status).toBe(200)
    const r = store.get("req-daily")!
    expect(r.state).toBe("in_progress")
    expect(r.standing).toEqual({ rhythm: "daily", numberId: "posts-per-day", cronId: "marketing-daily-posts", since: clock })
  })

  it("refuses a number that is not tracked, or a rhythm that is not the number's", async () => {
    expect((await markStanding({ number: "nope" })).status).toBe(400)
    const wrong = await markStanding({ rhythm: "weekly" })
    expect(wrong.status).toBe(400)
    expect((wrong.body as any).error).toMatch(/not the number's \(daily\)/)
    numbers.archive("posts-per-day", clock)
    expect((await markStanding()).status).toBe(400)
    expect(store.get("req-daily")!.standing).toBeNull()
  })

  it("is the request's own agent's to mark, once", async () => {
    expect((await markStanding({ agentId: "devops" })).status).toBe(403)
    expect((await markStanding()).status).toBe(200)
    expect((await markStanding()).status).toBe(409)
  })

  it("without the numbers store, needs the rhythm", async () => {
    const res = await post({ action: "standing", agentId: "marketing", id: "req-daily", number: "posts-per-day" }, { numbers: undefined })
    expect(res.status).toBe(400)
    const ok = await post({ action: "standing", agentId: "marketing", id: "req-daily", number: "posts-per-day", rhythm: "weekly" }, { numbers: undefined })
    expect(ok.status).toBe(200)
    expect(store.get("req-daily")!.standing!.rhythm).toBe("weekly")
  })
})

describe("only the owner ends a standing order", () => {
  beforeEach(async () => { expect((await markStanding()).status).toBe(200) })

  it("refuses its agent's done and decline, and says to report the number", async () => {
    for (const body of [
      { action: "done", agentId: "marketing", id: "req-daily", evidence: "https://example.com/post/1" },
      { action: "decline", agentId: "marketing", id: "req-daily", reason: "busy" },
    ]) {
      const res = await post(body)
      expect(res.status).toBe(409)
      expect((res.body as any).standing).toBe(true)
      expect((res.body as any).error).toMatch(/only the owner ends it.*posts-per-day/)
    }
    expect(store.get("req-daily")!.state).toBe("in_progress")
  })

  it("refuses every close the store makes on its own: agent, plan, check, settle, no closer", () => {
    expect(store.close("req-daily", "done", "https://example.com/x", clock, null, "marketing")).toBe(false)
    expect(store.close("req-daily", "done", "plan steps done", clock, null, "plan")).toBe(false)
    expect(store.close("req-daily", "dropped", "card expired", clock, null, "card-expired")).toBe(false)
    expect(store.close("req-daily", "done", "goal met", clock)).toBe(false)
    expect(store.closeVerified("req-daily", "check met", clock)).toBe(false)
    expect(store.settle("req-daily", "https://example.com/x", "handed back", clock)).toBe(false)
    expect(store.get("req-daily")!.state).toBe("in_progress")
  })

  it("closes when the owner ends it", () => {
    expect(store.close("req-daily", "dropped", "no longer needed", clock, null, OWNER_BY)).toBe(true)
    expect(store.get("req-daily")!.state).toBe("dropped")
  })

  it("leaves ordinary requests closable as before", () => {
    store.addCandidate({ id: "req-once", runId: "run-2", channel: "telegram", chatId: "chat-1", sender: "4242", agentId: "marketing", text: "Publish one post", now: clock })
    store.progress("req-once", clock)
    expect(store.close("req-once", "done", "https://example.com/post/2", clock, null, "marketing")).toBe(true)
  })

  it("shows the standing order on the request read", async () => {
    const res = await handleRequestsCall("GET", "/requests/req-daily", undefined, deps())
    expect((res.body as any).request.standing.numberId).toBe("posts-per-day")
  })
})

describe("standing helpers", () => {
  it("reads back what it wrote, and nothing from junk", () => {
    const s = parseStanding({ number: "posts-per-day", rhythm: "daily" }, null, 5)
    expect(typeof s).toBe("object")
    expect(readStanding(JSON.stringify(s))).toEqual(s)
    expect(readStanding("{")).toBeNull()
    expect(readStanding(JSON.stringify({ rhythm: "hourly", numberId: "x", since: 1 }))).toBeNull()
    expect(standingRefusal(s as any)).toMatch(/standing order \(daily\)/)
  })

  it("refuses a bad cron id", () => {
    expect(parseStanding({ number: "n", rhythm: "daily", cron: "a b" }, null, 1)).toMatch(/^cron:/)
  })
})
