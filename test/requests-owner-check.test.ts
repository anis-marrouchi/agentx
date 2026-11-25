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

  // #2056: a close met again by the same proof looped 7 times.
  it("reopens at most maxReopens times, then keeps the close and tells the owner once", async () => {
    const told: Array<{ id: string; title: string; text: string }> = []
    const c = new OwnerWordsCheck({
      store,
      settings: () => ({ ...DEFAULT_OWNER_CHECK, enabled: true, maxReopens: 2 }),
      generate: async () => '{"verdict":"mismatch","why":"The note is not the review you asked for."}',
      tellOwner: (r, title, text) => { told.push({ id: r.id, title, text }) },
      now: () => t,
    })
    // Rounds 11 minutes apart: one signal per request per 10 minutes.
    let t = 10_000
    const round = 11 * 60_000
    const signals = () => (db.prepare("SELECT detail FROM improve_signals WHERE kind = 'owner_check_mismatch' AND ref = ? ORDER BY rowid").all(ID) as Array<{ detail: string }>).map((s) => s.detail)
    // beforeEach declined it once; reopen, close again, twice.
    expect((await c.run()).reopened).toEqual([ID])
    t += round
    store.close(ID, "done", "https://example.com/mr/1", t - 1, null, "check")
    expect((await c.run()).reopened).toEqual([ID])
    expect(store.get(ID)?.ownerReopens).toBe(2)
    t += round
    store.close(ID, "done", "https://example.com/mr/1", t - 1, null, "check")
    // Third mismatch: not reopened, owner told once.
    expect((await c.run()).reopened).toEqual([])
    expect(store.get(ID)).toMatchObject({ state: "done", ownerCheck: "mismatch", ownerReopens: 2 })
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ id: ID, title: expect.stringContaining("not reopened again") })
    expect(told[0].text).toContain("already reopened 2 times")
    expect(told[0].text).toContain("not the review you asked for")
    // Not judged again, not told again.
    expect((await c.run()).checked).toBe(0)
    expect(told).toHaveLength(1)
    expect(signals()).toEqual([
      expect.stringMatching(/^reopen 1: /),
      expect.stringMatching(/^reopen 2: /),
      expect.stringMatching(/^kept closed after 2 reopens: /),
    ])
  })

  it("maxReopens 0 never reopens", async () => {
    const { c } = checker('{"verdict":"mismatch","why":"x"}', { maxReopens: 0 })
    expect((await c.run()).reopened).toEqual([])
    expect(store.get(ID)).toMatchObject({ state: "declined", ownerCheck: "mismatch" })
  })

  it("does nothing when off, and leaves old closes alone", async () => {
    expect((await checker("{}", { enabled: false }).c.run()).checked).toBe(0)
    expect((await checker('{"verdict":"mismatch","why":"x"}', { maxAgeHours: 0.0001 }).c.run()).checked).toBe(0)
  })
})

describe("readVerdict / prompt", () => {
  it("reads a verdict wrapped in prose and refuses others", () => {
    expect(readVerdict('Sure: {"verdict":"Mismatch","why":"  narrowed  "}')).toEqual({ verdict: "mismatch", why: "narrowed", uncovered: [] })
    expect(readVerdict('{"verdict":"maybe"}')).toBeNull()
    expect(readVerdict("no json")).toBeNull()
  })
  it("names how it was closed", () => {
    store.progress(ID, 5_500)
    store.close(ID, "done", "https://example.com/mr/2", 6_000, null, "plan")
    expect(ownerCheckPrompt(store.get(ID)!)).toContain("Closed as DONE by plan. Evidence given: https://example.com/mr/2")
  })
})

// retro:01M7RHM4763Q09HY7ATFT77DX1 — KSI 562 was reopened 3 times: each
// check was shown the proof links of an earlier close beside the new ones.
describe("the owner-words check judges the latest close's proofs only", () => {
  const LINK_A = "https://git.example.test/other/pipeline/-/merge_requests/9"
  const LINK_B = "https://git.example.test/example/app/-/merge_requests/4"
  const MISMATCH = '{"verdict":"mismatch","why":"the link is from another project"}'

  beforeEach(() => {
    store.progress(ID, 5_500)
    store.setDeliverables(ID, ["the switch", "the deploy"])
  })

  async function closeAMismatch() {
    expect(api({ action: "done", id: ID, evidence: `done ${LINK_A}`, proofs: [{ deliverable: 1, link: LINK_A }] }).status).toBe(200)
    expect((await checker(MISMATCH).c.run()).reopened).toEqual([ID])
  }

  it("close with link A, mismatch reopen, close with link B: the prompt has B and not A", async () => {
    await closeAMismatch()
    expect(store.get(ID)!.deliverableProofs).toEqual([])
    expect(api({ action: "done", id: ID, evidence: `done ${LINK_B}`, proofs: [{ deliverable: 1, link: LINK_B }] }).status).toBe(200)
    const { c, prompts } = checker('{"verdict":"match","why":"ok"}')
    await c.run()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(LINK_B)
    expect(prompts[0]).not.toContain(LINK_A)
    expect(ownerCheckPrompt(store.get(ID)!)).not.toContain(LINK_A)
  })

  it("keeps a link given by step after the reopen when the done carries none", async () => {
    await closeAMismatch()
    expect(api({ action: "step", id: ID, proofs: [{ deliverable: 1, link: LINK_B }] }).status).toBe(200)
    expect(api({ action: "done", id: ID, evidence: "both done, see the step link" }).status).toBe(200)
    const p = ownerCheckPrompt(store.get(ID)!)
    expect(p).toContain(LINK_B)
    expect(p).not.toContain(LINK_A)
  })
})

// A plan that closed too early wakes its agent (#1908): the flag alone woke nobody.
describe("a plan's close judged a mismatch", () => {
  const MISMATCH = '{"verdict":"mismatch","why":"the review you asked for by noon was never posted"}'

  function withWake(answer: string, over: Partial<typeof DEFAULT_OWNER_CHECK> = {}) {
    const woken: Array<{ id: string; agentId: string; text: string }> = []
    const lines: string[] = []
    const c = new OwnerWordsCheck({
      store,
      settings: () => ({ ...DEFAULT_OWNER_CHECK, enabled: true, ...over }),
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

  // The switch (#1912): `ownerCheck.wakeOnPlanMismatch`.
  it("with the wake off, reopens it for the owner and wakes nobody", async () => {
    store.progress(ID, 5_500)
    expect(store.close(ID, "done", "plan: 2 of 2 steps finished", 6_000, null, PLAN_BY)).toBe(true)
    const { c, woken } = withWake(MISMATCH, { wakeOnPlanMismatch: false })
    const out = await c.run()
    expect(out).toMatchObject({ checked: 1, reopened: [ID], woken: [] })
    expect(store.get(ID)).toMatchObject({ state: "needs_attention", ownerCheck: "mismatch", closedAt: null })
    expect(store.get(ID)!.attentionReason).toContain("the review you asked for by noon was never posted")
    expect(woken).toEqual([])
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
