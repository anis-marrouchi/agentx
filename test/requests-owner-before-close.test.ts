import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { RequestStore, type RequestRecord } from "../src/requests/store"
import { RequestTracker, type RequestSettings } from "../src/requests/tracker"
import { handleRequestsCall, type RequestsApiDeps } from "../src/requests/daemon-api"
import { DEFAULT_OWNER_CHECK, OwnerWordsCheck, readVerdict } from "../src/requests/owner-check"
import { BEFORE_CLOSE_CALL_MS, judgeBudget, warnText, type BeforeCloseCtx } from "../src/requests/before-close"
import { DONE_TIMEOUT_MS, runRequestTool } from "../src/requests/tool"
import { PlanStore } from "../src/requests/plan-store"
import { DEFAULT_PLAN_SETTINGS, parseSteps } from "../src/requests/plans"
import { PLAN_HELD, runPlansSweep } from "../src/requests/plan-sweep"
import { requestsConfigSchema } from "../src/daemon/config"
import type { CheckResult } from "../src/requests/checkers"

// retro:01M7VXKHCDJMX90PCDN6JT04WN (#2047): the owner-words check runs
// inside done, before the close is written.

const SAID = "merge the fix, deploy it to CX, and close every open MR on it"
const settings: RequestSettings = { enabled: true, channels: [], from: ["telegram:4242"], staleAfterHours: 24, retentionDays: 90 }
const ID = "req-t1"
const MISMATCH = JSON.stringify({ verdict: "mismatch", why: "Only the merge is shown.", uncovered: ["deployed to CX", "all open MRs closed"] })
const MATCH = JSON.stringify({ verdict: "match", why: "Merged, deployed and closed.", uncovered: [] })

let tmp: string
let db: Database.Database
let store: RequestStore
let plans: PlanStore
let tracker: RequestTracker
let calls: Array<{ r: RequestRecord; ms: number }>
let answer: () => Promise<string>
let wall: number
let lines: string[]
let check: OwnerWordsCheck

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-before-close-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  store = new RequestStore(db)
  plans = new PlanStore(db)
  tracker = new RequestTracker(store, () => settings, () => {}, () => 5_000)
  tracker.taskStarted({
    agentId: "coder", channel: "telegram", chatId: "chat-1", taskId: "t1", messagePreview: SAID, fullMessage: SAID,
    at: "", humanRoot: true, sender: { id: "4242" },
  } as any)
  store.progress(ID, 5_500)
  calls = []
  answer = async () => MISMATCH
  wall = 1_000_000
  lines = []
  check = new OwnerWordsCheck({
    store,
    settings: () => ({ ...DEFAULT_OWNER_CHECK, enabled: true }),
    generate: async () => answer(),
    log: (l) => lines.push(l),
    now: () => 10_000,
  })
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function ctx(mode: BeforeCloseCtx["mode"], over: Partial<BeforeCloseCtx> = {}): BeforeCloseCtx {
  return {
    mode, seconds: 20, clock: () => wall,
    judge: (r, ms) => { calls.push({ r, ms }); return check.judgeBeforeClose(r, ms) },
    judgeLater: (r, ms) => { calls.push({ r, ms }); return check.judgeLater(r, ms) },
    willReopen: (id) => check.willReopen(id),
    keep: (id, v, now) => check.keepBeforeClose(id, v, now),
    log: (l) => lines.push(l),
    ...over,
  }
}

const deps = (over: Partial<RequestsApiDeps & { check: () => Promise<CheckResult> }> = {}) => ({
  store, tracker, enabled: true, hasAgent: (id: string) => id === "coder", now: 6_000,
  runningTurn: (agentId: string) => (agentId === "coder" ? { channel: "telegram", chatId: "chat-1" } : null),
  ...over,
})

const done = (mode: BeforeCloseCtx["mode"], over: Partial<RequestsApiDeps & { check: () => Promise<CheckResult> }> = {}) =>
  handleRequestsCall("POST", "/requests", { agentId: "coder", action: "done", id: ID, evidence: "https://example.com/mr/7 merged" },
    deps({ ownerBeforeClose: ctx(mode), ...over }), { taskId: "t1" })

describe("an agent's done", () => {
  it("warn: a part-proof close goes through and the caller is told what is not shown", async () => {
    const res = await done("warn")
    expect(res.status).toBe(200)
    expect(store.get(ID)).toMatchObject({ state: "done", closedBy: "coder", ownerCheck: "pending" })
    expect((res.body as any).ownerWords).toEqual({ mode: "warn", verdict: "mismatch", why: "Only the merge is shown.", uncovered: ["deployed to CX", "all open MRs closed"], reopens: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].r).toMatchObject({ id: ID, state: "done", closedBy: "coder", evidence: "https://example.com/mr/7 merged" })
    expect(lines.some((l) => l.includes("owner-words before close (warn)"))).toBe(true)
  })

  it("warn: the after-close sweep reopens it without judging the same close again", async () => {
    let generated = 0
    answer = async () => { generated++; return MISMATCH }
    await done("warn")
    expect(generated).toBe(1)
    const out = await check.run()
    expect(generated).toBe(1)
    expect(out.reopened).toEqual([ID])
    expect(store.get(ID)?.state).toBe("needs_attention")
  })

  it("block: a part-proof close is refused with the uncovered parts, nothing closed", async () => {
    const res = await done("block")
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ ownerWordsBlocked: true, uncovered: ["deployed to CX", "all open MRs closed"] })
    expect((res.body as any).error).toMatch(/deployed to CX; all open MRs closed/)
    expect(store.get(ID)).toMatchObject({ state: "in_progress", closedBy: null, ownerCheck: null })
  })

  it("a full-proof close passes, is kept as a match, and the sweep does not judge it", async () => {
    answer = async () => MATCH
    const res = await done("block")
    expect(res.status).toBe(200)
    expect((res.body as any).ownerWords).toBeUndefined()
    expect(store.get(ID)).toMatchObject({ state: "done", ownerCheck: "match" })
    expect((await check.run()).checked).toBe(0)
  })

  it.each(["warn", "block"] as const)("%s: a model error or timeout never blocks; the sweep judges it later", async (mode) => {
    answer = async () => { throw new Error("aborted") }
    const res = await done(mode)
    expect(res.status).toBe(200)
    expect(store.get(ID)).toMatchObject({ state: "done", ownerCheck: "pending" })
    expect(lines.some((l) => l.includes("gave no answer"))).toBe(true)
  })

  it("off: no model call, closes as before", async () => {
    const res = await done("off")
    expect(res.status).toBe(200)
    expect(calls).toEqual([])
    expect(store.get(ID)).toMatchObject({ state: "done", ownerCheck: "pending" })
  })

  it("the judge gets only the time left on the call; too little left, it is skipped and the close goes through", async () => {
    const slow = async () => { wall += 38_000; return { verdict: "met", detail: "merged" } as CheckResult }
    // A done on a request without a check: the full budget.
    await done("block", { ownerBeforeClose: ctx("block", { seconds: 40 }) })
    expect(calls[0].ms).toBe(BEFORE_CLOSE_CALL_MS - 5_000)
    // A slow check used up the call: skipped, closed, judged by the sweep.
    db.prepare("UPDATE requests SET state = 'in_progress', closed_at = NULL, closed_by = NULL, owner_check = NULL, close_when = ? WHERE id = ?")
      .run(JSON.stringify({ kind: "url", url: "https://example.com/v" }), ID)
    calls = []
    const res = await done("block", { check: slow })
    expect(res.status).toBe(200)
    expect(calls).toEqual([])
    expect(store.get(ID)).toMatchObject({ state: "done", closedBy: "check", ownerCheck: "pending" })
    expect(lines.some((l) => l.includes("too little time left"))).toBe(true)
  })

  it("a done on a met check is judged after the check, before closeByCheckNow", async () => {
    db.prepare("UPDATE requests SET close_when = ? WHERE id = ?").run(JSON.stringify({ kind: "url", url: "https://example.com/v" }), ID)
    const res = await done("block", { check: async () => ({ verdict: "met", detail: "https://example.com/v answered" }) })
    expect(res.status).toBe(409)
    expect(calls[0].r).toMatchObject({ closedBy: "check" })
    expect(store.get(ID)?.state).toBe("in_progress")
  })
})

describe("review fixes on an agent's done", () => {
  it("B1: refused, then proofs added, then judged again (the memo keys on the whole prompt)", async () => {
    let generated = 0
    answer = async () => { generated++; return generated === 1 ? MISMATCH : MATCH }
    expect((await done("block")).status).toBe(409)
    db.prepare("UPDATE requests SET deliverable_proofs = ? WHERE id = ?")
      .run(JSON.stringify([{ deliverable: "2", link: "https://example.com/cx/deploy", at: 6_500 }]), ID)
    const res = await done("block")
    expect(generated).toBe(2)
    expect(res.status).toBe(200)
    expect(store.get(ID)).toMatchObject({ state: "done", ownerCheck: "match" })
  })

  it("B1: the same prompt is judged once", async () => {
    let generated = 0
    answer = async () => { generated++; return MISMATCH }
    await done("block")
    await done("block")
    expect(generated).toBe(1)
  })

  it("N1: a met check refused by the proof gate is not judged", async () => {
    db.prepare("UPDATE requests SET close_when = ? WHERE id = ?").run(JSON.stringify({ kind: "url", url: "https://example.com/v" }), ID)
    const res = await done("block", {
      check: async () => ({ verdict: "met", detail: "https://example.com/v answered" }),
      closeProof: { mode: "block", ownerCheckOn: true, read: async () => {} } as any,
    })
    expect(res.status).toBe(202)
    expect((res.body as any).verify).toBe("reading")
    expect(calls).toEqual([])
  })

  it("N2: past the reopen limit the caller is not told it will reopen", async () => {
    db.prepare("UPDATE requests SET owner_reopens = 2 WHERE id = ?").run(ID)
    const res = await done("warn")
    expect((res.body as any).ownerWords.reopens).toBe(false)
  })
})

describe("the time budget", () => {
  it("is the smaller of the setting and what is left of the 45 s call, minus a margin", () => {
    expect(BEFORE_CLOSE_CALL_MS).toBe(DONE_TIMEOUT_MS)
    expect(judgeBudget({ seconds: 20, clock: () => 1_000 }, 1_000)).toBe(20_000)
    expect(judgeBudget({ seconds: 20, clock: () => 31_000 }, 1_000)).toBe(10_000)
    expect(judgeBudget({ seconds: 20, clock: () => 39_000 }, 1_000)).toBe(0)
  })

  it("is set under ownerCheck, warn by default", () => {
    const s = requestsConfigSchema.parse({}).ownerCheck
    expect(s).toMatchObject({ beforeClose: "warn", beforeCloseSeconds: 20 })
    expect(() => requestsConfigSchema.parse({ ownerCheck: { beforeCloseSeconds: 60 } })).toThrow()
  })
})

describe("the judge's answer", () => {
  it("reads the uncovered parts, clipped, and treats a missing list as none", () => {
    const long = "x".repeat(300)
    const v = readVerdict(JSON.stringify({ verdict: "mismatch", why: "w", uncovered: ["a", "", 3, long, "b", "c", "d", "e", "f"] }))
    expect(v?.uncovered).toEqual(["a", "x".repeat(120), "b", "c", "d", "e"])
    expect(readVerdict('{"verdict":"match","why":"ok"}')).toEqual({ verdict: "match", why: "ok", uncovered: [] })
  })
})

describe("the tool", () => {
  it("says what the proof does not show on a warn close", async () => {
    const fake = (async (_url: string, init: any) => {
      const reply = await handleRequestsCall("POST", "/requests", JSON.parse(init.body), deps({ ownerBeforeClose: ctx("warn") }), { taskId: "t1" })
      return new Response(JSON.stringify(reply.body), { status: reply.status })
    }) as unknown as typeof fetch
    const text = await runRequestTool(
      { action: "done", id: ID, evidence: "https://example.com/mr/7 merged" },
      { daemonUrl: "http://127.0.0.1:1", fetch: fake, env: { AGENTX_AGENT_ID: "coder", AGENTX_TASK_ID: "t1" } as any },
    )
    expect(text).toMatch(/Closed, but the proof does not show: deployed to CX; all open MRs closed\. The owner-words check will reopen it/)
  })

  it("N2: an empty list says why, and past the limit it does not promise a reopen", () => {
    expect(warnText({ why: "Only the merge.", uncovered: [], reopens: false })).toBe(
      "Closed, but the proof does not show: Only the merge.. It stays closed (reopen limit reached) and the owner is told; do what is missing.")
    expect(warnText({ why: "", uncovered: [], reopens: true })).toMatch(/does not show: the close does not match the owner's words\./)
  })
})

describe("a plan's close", () => {
  let told: Array<{ agentId: string; text: string }>
  beforeEach(() => {
    told = []
    const parsed = parseSteps([{ name: "Merge", done: "MR merged" }, { name: "Deploy", done: "live on CX" }], { createdBy: "coder", hasAgent: () => true, settings: DEFAULT_PLAN_SETTINGS })
    if (!parsed.ok) throw new Error(parsed.error)
    plans.create(ID, "coder", parsed.steps, 6_000)
    for (const s of plans.steps(ID)) plans.updateStep(ID, s.idx, { state: "done", evidence: "https://example.com/mr/7", updatedAt: 6_000 })
  })
  const sweepOnce = (mode: BeforeCloseCtx["mode"], notify?: (title: string) => void) => runPlansSweep({
    requests: store, plans, settings: { ...DEFAULT_PLAN_SETTINGS, enabled: true }, beforeClose: ctx(mode),
    tellAgent: async (agentId, text) => { told.push({ agentId, text }) },
    ...(notify ? { notify: async (title: string) => notify(title) } : {}),
    log: (l) => lines.push(l), now: 7_000,
  })
  // The first sweep starts the judge, a later one reads it (review B2).
  const sweep = async (mode: BeforeCloseCtx["mode"]) => {
    await sweepOnce(mode)
    await check.settled()
    return sweepOnce(mode)
  }

  it("B2: the sweep does not wait for the judge", async () => {
    let release!: (t: string) => void
    answer = () => new Promise<string>((res) => { release = res })
    const first = await sweepOnce("warn")
    expect(first.finished).toBe(0)
    expect(plans.get(ID)?.state).toBe("active")
    expect((await sweepOnce("warn")).finished).toBe(0)
    expect(calls).toHaveLength(2)
    release(MATCH)
    await check.settled()
    expect((await sweepOnce("warn")).finished).toBe(1)
    expect(store.get(ID)).toMatchObject({ state: "done", closedBy: "plan", ownerCheck: "match" })
  })

  it("B3: a request dropped while the judge ran ends the plan as closed, no Plan finished", async () => {
    let release!: (t: string) => void
    answer = () => new Promise<string>((res) => { release = res })
    const titles: string[] = []
    await sweepOnce("warn", (t) => titles.push(t))
    expect(store.close(ID, "dropped", "owner dropped it", 7_500, null, "owner")).toBe(true)
    release(MATCH)
    await check.settled()
    const res = await sweepOnce("warn", (t) => titles.push(t))
    expect(res.finished).toBe(0)
    expect(plans.get(ID)?.state).toBe("closed")
    expect(store.get(ID)?.state).toBe("dropped")
    expect(titles.some((t) => /finished/i.test(t))).toBe(false)
  })

  it("warn: closes, records what is not shown, and hands the mismatch to the sweep", async () => {
    const res = await sweep("warn")
    expect(res.finished).toBe(1)
    expect(calls[0].r).toMatchObject({ closedBy: "plan", state: "done" })
    expect(store.get(ID)).toMatchObject({ state: "done", closedBy: "plan" })
    expect(plans.events(ID).find((e) => e.kind === "owner-words-warn")?.detail).toBe("deployed to CX; all open MRs closed")
  })

  it("block: holds the plan, the request needs attention, its agent is woken once, one model call", async () => {
    let generated = 0
    answer = async () => { generated++; return MISMATCH }
    await sweep("block")
    await sweep("block")
    expect(generated).toBe(1)
    expect(plans.get(ID)?.state).toBe("active")
    const r = store.get(ID)!
    expect(r.state).toBe("needs_attention")
    expect(r.attentionReason).toMatch(new RegExp(`^${PLAN_HELD}: the proof does not show deployed to CX`))
    expect(told).toHaveLength(1)
    expect(told[0].text).toMatch(/close is held/)
    expect(plans.events(ID).filter((e) => e.kind === "owner-words-held")).toHaveLength(1)
  })

  it("a model error closes the plan as before", async () => {
    answer = async () => { throw new Error("down") }
    const res = await sweep("block")
    expect(res.finished).toBe(1)
    expect(store.get(ID)).toMatchObject({ state: "done", ownerCheck: "pending" })
  })
})
