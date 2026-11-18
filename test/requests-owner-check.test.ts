import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { OWNER_BY, RequestStore } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsApi } from "../src/requests/daemon-api"
import { DEFAULT_OWNER_CHECK, MISMATCH_PREFIX, OwnerWordsCheck, PLAN_BY, ownerCheckPrompt, planMismatchText, readVerdict } from "../src/requests/owner-check"

const SAID = "yes, switch the production step on and deploy it, you have my approval, no need to wait for the tester"
const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }

let tmp: string
let db: Database.Database
let store: RequestStore
let tracker: RequestTracker

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-owner-check-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  tracker = new RequestTracker(store, () => settings, () => {}, () => 5_000)
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "t1", messagePreview: SAID, fullMessage: SAID,
    at: "", humanRoot: true, sender: { id: "4242" },
  } as any)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ID = "req-t1"
const api = (body: Record<string, unknown>) =>
  handleRequestsApi("POST", "/requests", { agentId: "coder", ...body }, {
    store, tracker, enabled: true, hasAgent: (id) => id === "coder", now: 6_000,
    runningTurn: (agentId) => (agentId === "coder" ? { channel: "telegram", chatId: "chat-1" } : null),
  }, { taskId: "t1" })

function checker(answer: string | (() => Promise<string>), over: Partial<typeof DEFAULT_OWNER_CHECK> = {}) {
  const prompts: string[] = []
  const lines: string[] = []
  const c = new OwnerWordsCheck({
    store,
    settings: () => ({ ...DEFAULT_OWNER_CHECK, enabled: true, ...over }),
    generate: async (p) => { prompts.push(p); return typeof answer === "string" ? answer : answer() },
    log: (l) => lines.push(l),
    now: () => 10_000,
  })
  return { c, prompts, lines }
}

describe("who closed a request", () => {
  it("marks an agent's close for the check, and leaves the owner's alone", () => {
    store.progress(ID, 5_500)
    expect(api({ action: "decline", id: ID, reason: "prod waits on the tester's pass" }).status).toBe(200)
    expect(store.get(ID)).toMatchObject({ state: "declined", closedBy: "coder", ownerCheck: "pending" })
  })

  it("does not check a close the owner made", () => {
    store.progress(ID, 5_500)
    store.close(ID, "dropped", "not needed any more", 6_000, null, OWNER_BY)
    expect(store.get(ID)).toMatchObject({ closedBy: OWNER_BY, ownerCheck: null })
  })

  it("checks a settle and a met check, which no person made", () => {
    store.progress(ID, 5_500)
    expect(store.settle(ID, "https://example.com/pr/1", "handed work came back", 6_000)).toBe(true)
    expect(store.get(ID)).toMatchObject({ closedBy: "settle", ownerCheck: "pending" })
  })
})

describe("OwnerWordsCheck", () => {
  beforeEach(() => {
    store.progress(ID, 5_500)
    api({ action: "decline", id: ID, reason: "prod run waits on the tester's pass" })
  })

  it("reopens a close that goes against the owner's words, with the reason", async () => {
    const { c, prompts } = checker('{"verdict":"mismatch","why":"You removed the tester step and approved the deploy."}')
    const out = await c.run()
    expect(out.reopened).toEqual([ID])
    expect(prompts[0]).toContain(SAID)
    expect(prompts[0]).toContain("DECLINED by coder")
    const r = store.get(ID)!
    expect(r.state).toBe("needs_attention")
    expect(r.closedAt).toBeNull()
    expect(r.attentionReason).toContain(MISMATCH_PREFIX)
    expect(r.attentionReason).toContain("removed the tester step")
    expect(store.awaitingNotice().map((x) => x.id)).toEqual([ID])
    expect(r.ownerCheck).toBe("mismatch")
  })

  it("records a match and leaves the close standing", async () => {
    const { c } = checker('{"verdict":"match","why":"Done as asked."}')
    await c.run()
    expect(store.get(ID)).toMatchObject({ state: "declined", ownerCheck: "match", ownerCheckNote: "Done as asked." })
    expect((await c.run()).checked).toBe(0)
  })

  it("never bothers the owner on unclear", async () => {
    const { c } = checker('{"verdict":"unclear","why":"Cannot tell."}')
    await c.run()
    expect(store.get(ID)).toMatchObject({ state: "declined", ownerCheck: "unclear" })
  })

  it("tries a failed call again, then gives up as unclear", async () => {
    const { c } = checker(async () => { throw new Error("provider down") })
    await c.run(); await c.run()
    expect(store.get(ID)?.ownerCheck).toBe("pending")
    await c.run()
    expect(store.get(ID)?.ownerCheck).toBe("unclear")
  })

  it("does nothing when off, and leaves old closes alone", async () => {
    expect((await checker("{}", { enabled: false }).c.run()).checked).toBe(0)
    expect((await checker('{"verdict":"mismatch","why":"x"}', { maxAgeHours: 0.0001 }).c.run()).checked).toBe(0)
  })
})

describe("readVerdict / prompt", () => {
  it("reads a verdict wrapped in prose and refuses others", () => {
    expect(readVerdict('Sure: {"verdict":"Mismatch","why":"  narrowed  "}')).toEqual({ verdict: "mismatch", why: "narrowed" })
    expect(readVerdict('{"verdict":"maybe"}')).toBeNull()
    expect(readVerdict("no json")).toBeNull()
  })
  it("names how it was closed", () => {
    store.progress(ID, 5_500)
    store.close(ID, "done", "https://example.com/mr/2", 6_000, null, "plan")
    expect(ownerCheckPrompt(store.get(ID)!)).toContain("Closed as DONE by plan. Evidence given: https://example.com/mr/2")
  })
})

// A plan that closed too early wakes its agent (#1908): the flag alone woke nobody.
describe("a plan's close judged a mismatch", () => {
  const MISMATCH = '{"verdict":"mismatch","why":"the review you asked for by noon was never posted"}'

  function withWake(answer: string) {
    const woken: Array<{ id: string; agentId: string; text: string }> = []
    const lines: string[] = []
    const c = new OwnerWordsCheck({
      store,
      settings: () => ({ ...DEFAULT_OWNER_CHECK, enabled: true }),
      generate: async () => answer,
      wake: (r, text) => { woken.push({ id: r.id, agentId: r.agentId, text }) },
      log: (l) => lines.push(l),
      now: () => 10_000,
    })
    return { c, woken, lines }
  }

  it("reopens the request and wakes the agent that owns it, with why", async () => {
    store.progress(ID, 5_500)
    expect(store.close(ID, "done", "plan: 2 of 2 steps finished", 6_000, null, PLAN_BY)).toBe(true)
    expect(store.get(ID)).toMatchObject({ state: "done", closedBy: "plan", ownerCheck: "pending" })
    const { c, woken } = withWake(MISMATCH)
    const out = await c.run()
    expect(out).toMatchObject({ checked: 1, reopened: [ID], woken: [ID] })
    expect(store.get(ID)).toMatchObject({ state: "needs_attention", ownerCheck: "mismatch", closedAt: null })
    expect(woken).toHaveLength(1)
    expect(woken[0]).toMatchObject({ id: ID, agentId: "coder" })
    expect(woken[0].text).toContain("the review you asked for by noon was never posted")
    expect(woken[0].text).toContain(SAID)
    expect(woken[0].text).toContain(`id:"${ID}"`)
    // Once: the next check has nothing left to judge.
    expect((await c.run()).woken).toEqual([])
    expect(woken).toHaveLength(1)
  })

  it("wakes nobody when the plan's close matches, or when an agent closed it by hand", async () => {
    store.progress(ID, 5_500)
    store.close(ID, "done", "plan: 2 of 2 steps finished", 6_000, null, PLAN_BY)
    const ok = withWake('{"verdict":"match","why":"it did what was asked"}')
    expect((await ok.c.run()).woken).toEqual([])
    expect(ok.woken).toEqual([])
    expect(store.get(ID)?.state).toBe("done")
  })

  it("keeps the request reopened when the wake fails", async () => {
    store.progress(ID, 5_500)
    store.close(ID, "done", "plan: 2 of 2 steps finished", 6_000, null, PLAN_BY)
    const lines: string[] = []
    const c = new OwnerWordsCheck({
      store, settings: () => ({ ...DEFAULT_OWNER_CHECK, enabled: true }), generate: async () => MISMATCH,
      wake: () => { throw new Error("agent gone") }, log: (l) => lines.push(l), now: () => 10_000,
    })
    expect(await c.run()).toMatchObject({ reopened: [ID], woken: [] })
    expect(store.get(ID)?.state).toBe("needs_attention")
    expect(lines.join("\n")).toContain("agent gone")
  })

  it("tells the agent what is missing and how to close it", () => {
    const text = planMismatchText(store.get(ID)!, "only step one was done")
    expect(text).toContain("only step one was done")
    expect(text).toContain("agentx_request")
  })
})
