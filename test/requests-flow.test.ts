import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { describeFlow, flowReport } from "../src/requests/flow"
import { handleRequestsApi } from "../src/requests/daemon-api"
import { runRequestTool } from "../src/requests/tool"

// The daily flow rate (#1542): requests closed out of those asked, per day
// of the owner's time zone.

// 2030-03-02 14:00 in Tunis (UTC+1).
const NOW = Date.parse("2030-03-02T13:00:00Z")

let tmp: string
let db: Database.Database
let store: RequestStore
let n = 0

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-flow-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  n = 0
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** A request asked at `at`, left in `state`. */
function asked(at: string, state: "candidate" | "in_progress" | "waiting_other" | "waiting_owner" | "needs_attention" | "done" | "declined" | "dropped", reason = "") {
  const id = `req-${++n}`
  const now = Date.parse(at)
  store.addCandidate({ id, runId: `run-${n}`, channel: "telegram", chatId: "c", agentId: "coder", text: "do it", now })
  if (state === "candidate") return id
  if (state === "in_progress" || state === "waiting_other") store.progress(id, now, state)
  else if (state === "waiting_owner") store.waitOnOwner(id, "which one?", now)
  else if (state === "needs_attention") store.needsAttention(id, "coder failed", now)
  else store.close(id, state, state === "done" ? "https://example.test/pull/1" : reason, now)
  return id
}

describe("flow rate", () => {
  it("counts each state of the requests asked today, and the rate", () => {
    asked("2030-03-02T08:00:00Z", "done")
    asked("2030-03-02T08:10:00Z", "done")
    asked("2030-03-02T08:20:00Z", "dropped", "a retry of req-1")
    asked("2030-03-02T08:30:00Z", "declined", "out of scope")
    asked("2030-03-02T08:40:00Z", "in_progress")
    asked("2030-03-02T08:50:00Z", "waiting_other")
    asked("2030-03-02T09:00:00Z", "waiting_owner")
    asked("2030-03-02T09:10:00Z", "needs_attention")
    asked("2030-03-02T09:20:00Z", "candidate")
    const f = flowReport(store, { days: 1, zone: "Africa/Tunis", now: NOW })
    expect(f.days).toHaveLength(1)
    expect(f.today).toMatchObject({ day: "2030-03-02", asked: 8, done: 2, dropped: 2, moving: 2, waiting: 1, stuck: 1, rate: 0.5, moreReasons: 0 })
    expect(f.today.dropReasons).toEqual([{ reason: "a retry of req-1", count: 1 }, { reason: "out of scope", count: 1 }])
  })

  it("puts a request on the owner's day, across midnight", () => {
    // 23:30 UTC on the 1st is 00:30 on the 2nd in Tunis.
    asked("2030-03-01T23:30:00Z", "done")
    asked("2030-03-01T22:30:00Z", "needs_attention")
    const f = flowReport(store, { days: 2, zone: "Africa/Tunis", now: NOW })
    expect(f.days.map((d) => [d.day, d.asked, d.done, d.stuck])).toEqual([["2030-03-01", 1, 0, 1], ["2030-03-02", 1, 1, 0]])
    // In UTC both are on the 1st.
    const utc = flowReport(store, { days: 2, zone: "UTC", now: NOW })
    expect(utc.days.map((d) => [d.day, d.asked])).toEqual([["2030-03-01", 2], ["2030-03-02", 0]])
  })

  it("has no rate on a day nothing was asked, and leaves out what is older than the days asked for", () => {
    asked("2030-02-20T10:00:00Z", "done")
    const f = flowReport(store, { days: 7, zone: "Africa/Tunis", now: NOW })
    expect(f.days).toHaveLength(7)
    expect(f.days[0].day).toBe("2030-02-24")
    expect(f.days.every((d) => d.asked === 0 && d.rate === null)).toBe(true)
    expect(describeFlow(f)).toContain("nothing asked yet")
  })

  it("counts the resent ones, and those of them done", () => {
    const a = asked("2030-03-02T08:00:00Z", "needs_attention")
    const b = asked("2030-03-02T08:10:00Z", "needs_attention")
    store.requestPickup(a, NOW, { resend: true })
    store.requestPickup(b, NOW, { resend: true })
    store.close(a, "done", "https://example.test/pull/2", NOW)
    const f = flowReport(store, { days: 1, zone: "Africa/Tunis", now: NOW })
    expect(f.today).toMatchObject({ resent: 2, resentDone: 1, done: 1, moving: 1 })
    expect(describeFlow(f)).toContain("2 resent once on its own, 1 of them done")
  })

  it("is served at GET /requests/flow and through agentx_request", async () => {
    asked("2030-03-02T08:00:00Z", "done")
    asked("2030-03-02T08:10:00Z", "needs_attention")
    const deps = { store, tracker: {} as any, enabled: true, hasAgent: () => true, runningTurn: () => null, now: NOW, flow: { timeZone: "Africa/Tunis", days: 3 } }
    const r = handleRequestsApi("GET", "/requests/flow", undefined, { ...deps, query: new URLSearchParams() })
    expect(r.status).toBe(200)
    expect((r.body as any).days).toHaveLength(3)
    expect((r.body as any).today).toMatchObject({ asked: 2, done: 1, stuck: 1, rate: 0.5 })
    expect(handleRequestsApi("GET", "/requests/flow", undefined, { ...deps, query: new URLSearchParams("days=0") }).status).toBe(400)
    expect(handleRequestsApi("GET", "/requests/flow", undefined, { ...deps, query: new URLSearchParams("days=91") }).status).toBe(400)

    const urls: string[] = []
    const text = await runRequestTool({ action: "flow", days: 1 }, {
      daemonUrl: "http://daemon.test",
      fetch: (async (url: string) => {
        urls.push(url)
        const q = new URLSearchParams(url.split("?")[1] ?? "")
        const res = handleRequestsApi("GET", "/requests/flow", undefined, { ...deps, query: q })
        return new Response(JSON.stringify(res.body), { status: res.status })
      }) as any,
    })
    expect(urls).toEqual(["http://daemon.test/requests/flow?days=1"])
    expect(text).toContain("Today (2030-03-02, Africa/Tunis): 1 of 2 closed, 50%.")
    expect(text).toContain("1 done, 0 dropped, 0 moving, 0 waiting on the owner, 1 stuck.")
  })
})
