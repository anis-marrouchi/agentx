import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { RequestTracker, firstLink, type RequestSettings } from "../src/requests/tracker"
import { runRequestsSweep } from "../src/requests/sweep"
import { requestsConfigSchema } from "../src/daemon/config"

// --- A request settles when its handed work comes back done (#1138) ---

const HOUR = 3_600_000
const ON: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker
let settings: RequestSettings
let clock: number
let logs: string[]

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-settle-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  settings = { ...ON }
  clock = 1_000_000
  logs = []
  tracker = new RequestTracker(store, () => settings, (m) => logs.push(m), () => clock)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function start(taskId: string) {
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId,
    messagePreview: "build the report", fullMessage: "build the report and deploy it",
    at: new Date(clock).toISOString(), humanRoot: true, sender: { name: "Owner", id: "4242" },
  } as any)
}

function end(taskId: string) {
  tracker.taskCompleted({ agentId: "coder", channel: "telegram", chatId: "chat-1", taskId, durationMs: 10, at: new Date(clock).toISOString() } as any)
}

const dlg = (id: string) => ({ id, caller: "coder", callee: "devops", origin: { channel: "telegram", chatId: "chat-1" } })

/** A request whose turn handed work to `ids`, then ended. */
function handedOff(...ids: string[]) {
  start("t1")
  for (const id of ids) tracker.delegationStarted(dlg(id))
  end("t1")
}

const sweep = (over: Partial<Parameters<typeof runRequestsSweep>[0]> = {}) => {
  const told: string[] = []
  return runRequestsSweep({
    store, settings, log: (m) => logs.push(m), now: clock,
    notify: async (title) => { told.push(title) },
    ...over,
  }).then((result) => ({ result, told }))
}

describe("firstLink", () => {
  it("finds the first web link and drops the punctuation that ends a sentence", () => {
    expect(firstLink("Deployed, see https://example.test/pr/7. Then https://example.test/b")).toBe("https://example.test/pr/7")
    expect(firstLink("(merged in https://example.test/mr/3)")).toBe("https://example.test/mr/3")
    expect(firstLink("all good")).toBeNull()
  })
})

describe("the delegation's end is kept on its link", () => {
  it("records the outcome, and the first link of a done answer", () => {
    handedOff("dlg-1", "dlg-2")
    tracker.delegationDone(dlg("dlg-1"), "done", "Merged: https://example.test/pr/1")
    tracker.delegationDone(dlg("dlg-2"), "error", "crashed at https://example.test/log/9")
    const links = store.links("req-t1").filter((l) => l.kind === "delegation")
    expect(links.map((l) => [l.ref, l.outcome, l.proof])).toEqual([
      ["dlg-1", "done", "https://example.test/pr/1"],
      ["dlg-2", "error", undefined],
    ])
  })

  it("a delegation that waited, then came back done, ends done", () => {
    handedOff("dlg-1")
    tracker.delegationDone(dlg("dlg-1"), "waiting", "build started")
    tracker.delegationDone(dlg("dlg-1"), "done", "built https://example.test/build/2")
    expect(store.links("req-t1").find((l) => l.ref === "dlg-1")).toMatchObject({ outcome: "done", proof: "https://example.test/build/2" })
  })
})

describe("the requests check settles handed-back requests", () => {
  it("closes a quiet request as done, with the delegate's link as evidence, and tells no one", async () => {
    handedOff("dlg-1")
    tracker.delegationDone(dlg("dlg-1"), "done", "Deployed: https://example.test/deploy/5")
    clock += 25 * HOUR
    const { result, told } = await sweep()
    expect(result).toMatchObject({ settled: 1, quiet: 0, notified: 0 })
    expect(told).toEqual([])
    const r = store.get("req-t1")!
    expect(r).toMatchObject({ state: "done", evidence: "https://example.test/deploy/5", verifyState: null })
    expect(r.verifyDetail).toContain("came back done")
    expect(logs.join("\n")).toContain("req-t1 settled")
  })

  it("marks one with no link unproven, and says so", async () => {
    handedOff("dlg-1")
    tracker.delegationDone(dlg("dlg-1"), "done", "all good")
    clock += 25 * HOUR
    expect((await sweep()).result.settled).toBe(1)
    const r = store.get("req-t1")!
    expect(r.state).toBe("done")
    expect(r.verifyState).toBe("unverified")
    expect(r.verifyDetail).toContain("no link")
    expect(r.evidence).toContain("unproven")
  })

  it("needs every delegation done, and uses the first link any of them gave", async () => {
    handedOff("dlg-1", "dlg-2")
    tracker.delegationDone(dlg("dlg-1"), "done", "nothing to link")
    tracker.delegationDone(dlg("dlg-2"), "done", "see https://example.test/pr/8")
    clock += 25 * HOUR
    expect((await sweep()).result.settled).toBe(1)
    expect(store.get("req-t1")).toMatchObject({ state: "done", evidence: "https://example.test/pr/8" })
    expect(store.get("req-t1")!.verifyDetail).toContain("All 2 pieces of work")
  })

  it("waits for the quiet time", async () => {
    handedOff("dlg-1")
    tracker.delegationDone(dlg("dlg-1"), "done", "ok")
    clock += 24 * HOUR - 1
    expect((await sweep()).result.settled).toBe(0)
    expect(store.get("req-t1")!.state).toBe("in_progress")
  })

  it("leaves a request with a delegation still out: it comes back as before", async () => {
    handedOff("dlg-1", "dlg-2")
    tracker.delegationDone(dlg("dlg-1"), "done", "ok")
    clock += 25 * HOUR
    const { result } = await sweep()
    expect(result).toMatchObject({ settled: 0, quiet: 1 })
    expect(store.get("req-t1")!.state).toBe("needs_attention")
  })

  it("leaves a request whose delegation is waiting", async () => {
    handedOff("dlg-1")
    tracker.delegationDone(dlg("dlg-1"), "waiting", "build started")
    clock += 25 * HOUR
    expect((await sweep()).result.settled).toBe(0)
    expect(store.get("req-t1")!.state).toBe("needs_attention")
  })

  it("leaves a request with no delegation at all", async () => {
    start("t1")
    store.progress("req-t1", clock)
    end("t1")
    clock += 25 * HOUR
    expect((await sweep()).result.settled).toBe(0)
  })

  it("never touches one that failed, even after a later delegation came back done", async () => {
    handedOff("dlg-1", "dlg-2")
    tracker.delegationDone(dlg("dlg-1"), "error", "crashed")
    tracker.delegationDone(dlg("dlg-2"), "done", "ok")
    clock += 25 * HOUR
    expect((await sweep()).result.settled).toBe(0)
    expect(store.get("req-t1")!.state).toBe("needs_attention")
  })

  it("leaves a request already waiting for attention", async () => {
    handedOff("dlg-1")
    tracker.delegationDone(dlg("dlg-1"), "done", "ok")
    store.needsAttention("req-t1", "raised earlier", clock)
    clock += 25 * HOUR
    expect((await sweep()).result.settled).toBe(0)
    expect(store.get("req-t1")!.attentionReason).toBe("raised earlier")
  })

  it("leaves a loop with a checker or a due time", async () => {
    handedOff("dlg-1")
    tracker.delegationDone(dlg("dlg-1"), "done", "ok")
    store.setLoop("req-t1", { closeWhen: { kind: "url", url: "https://example.test/health" } as any }, clock)
    clock += 25 * HOUR
    expect((await sweep()).result.settled).toBe(0)
    store.setLoop("req-t1", { closeWhen: null, dueAt: clock + HOUR }, clock - 25 * HOUR)
    expect((await sweep()).result.settled).toBe(0)
  })

  it("leaves a promise", async () => {
    store.addPromise({ id: "p1", channel: "telegram", chatId: "chat-1", agentId: "coder", text: "ship it", owedTo: "owner", now: clock })
    store.link("p1", "delegation", "dlg-p", clock)
    store.endLink("delegation", "dlg-p", "done", "https://example.test/pr/1")
    clock += 25 * HOUR
    expect((await sweep()).result.settled).toBe(0)
  })

  it("leaves a request in an active plan", async () => {
    handedOff("dlg-1")
    tracker.delegationDone(dlg("dlg-1"), "done", "ok")
    clock += 25 * HOUR
    expect((await sweep({ inPlan: (id) => id === "req-t1" })).result.settled).toBe(0)
    expect(store.get("req-t1")!.state).not.toBe("done")
  })

  it("is on by default, and off keeps today's behaviour", async () => {
    expect(requestsConfigSchema.parse({}).settleHandedBack).toBe(true)
    settings.settleHandedBack = false
    handedOff("dlg-1")
    tracker.delegationDone(dlg("dlg-1"), "done", "ok")
    clock += 25 * HOUR
    const { result, told } = await sweep()
    expect(result).toMatchObject({ settled: 0, quiet: 1, notified: 1 })
    expect(told[0]).toMatch(/^Not finished/)
  })
})
