import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import { RunStore, WorkflowDispatcher, WorkflowStore, workflowSchema, type AgentExecuteResponse } from "../src/workflows"
import { TimerService } from "../src/workflows/timers"
import { parseWorkActivity, wakeConfig, wakeTarget, WAKE_SELF_MARK, type WorkActivity } from "../src/workflows/wake"
import { GitLabAdapter } from "../src/channels/gitlab"
import { STATUS_TAG } from "../src/requests/status"

const TEST_DIR = resolve(__dirname, "../.test-workflow-wake")
const HOUR = 3_600_000

describe("wake config and timing", () => {
  it("renders refs from a comma list or an array, drops what is not a ref", () => {
    expect(wakeConfig({ refs: "acme/web#1, ,Acme/Web!2,nonsense,acme/web#1" })).toEqual({ on: ["note", "label"], refs: ["acme/web#1", "acme/web!2"], minGapSec: 60 })
    expect(wakeConfig({ on: ["note"], refs: ["acme/web#1"], minGapSec: 0 })).toEqual({ on: ["note"], refs: ["acme/web#1"], minGapSec: 0 })
    expect(wakeConfig({ refs: "" })).toBeUndefined()
    expect(wakeConfig({ on: ["merge"], refs: "acme/web#1" })).toBeUndefined()
    expect(wakeConfig(undefined)).toBeUndefined()
    expect(wakeConfig({ refs: "acme/web#1", self: "Acme/Web#1 +To Do, acme/web#1 -Doing, junk, acme/web#1 Review" })?.selfLabels).toEqual(["acme/web#1 +to do", "acme/web#1 -doing"])
  })

  it("moves to now, or to the end of the gap after the last wake, never later than the timer", () => {
    const now = Date.parse("2026-11-10T10:00:00Z")
    const fireAt = "2026-11-10T10:30:00Z"
    expect(wakeTarget({ nowMs: now, minGapSec: 60, fireAt })).toEqual({ fireAt: "2026-11-10T10:00:00.000Z", result: "woke" })
    expect(wakeTarget({ nowMs: now, lastWakeAt: "2026-11-10T09:59:30Z", minGapSec: 60, fireAt })).toEqual({ fireAt: "2026-11-10T10:00:30.000Z", result: "debounced" })
    expect(wakeTarget({ nowMs: now, lastWakeAt: "2026-11-10T09:58:00Z", minGapSec: 60, fireAt })?.result).toBe("woke")
    expect(wakeTarget({ nowMs: now, lastWakeAt: "2026-11-10T09:59:30Z", minGapSec: 60, fireAt: "2026-11-10T10:00:10Z" })).toBeNull()
  })

  it("accepts only a well-formed wake body", () => {
    expect(parseWorkActivity({ ref: "Acme/Web!2", on: "note", selfMarked: true })).toEqual({ ref: "acme/web!2", on: "note", selfMarked: true })
    expect(parseWorkActivity({ ref: "acme/web", on: "note" })).toBeNull()
    expect(parseWorkActivity({ ref: "acme/web#1", on: "merge" })).toBeNull()
    expect(parseWorkActivity({ ref: "acme/web#1", on: "label", labels: ["+Review", "x", 3], byAgentx: true })).toEqual({ ref: "acme/web#1", on: "label", selfMarked: false, labels: ["+Review"], byAgentx: true })
    expect(parseWorkActivity(null)).toBeNull()
  })
})

describe("dispatcher.wake", () => {
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  // trigger → wait ⇄ check. The wait watches the request issue from the
  // start and the merge request once `check` has run.
  function setup(opts: { minGapSec?: number; tickMs?: number; self?: string } = {}) {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    store.save(workflowSchema.parse({
      id: "wake-demo", version: 2, title: "wake", priority: 0, fanOut: false,
      envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "wait", type: "timer.boundary", config: { after: "PT1H", wake: { on: ["note", "label"], refs: "acme/web#1,{{check.watch}}", minGapSec: opts.minGapSec ?? 60, ...(opts.self ? { self: opts.self } : {}) } } },
        { id: "check", type: "transform", config: { template: { watch: "acme/web!2" } } },
        // Stands in for the check's child run: the wait is re-entered from
        // a new walk, as in a real loop.
        { id: "hop", type: "timer.boundary", config: { after: "PT1S" } },
      ],
      edges: [
        { from: "trigger", to: "wait" },
        { from: "wait", to: "check" },
        { from: "check", to: "hop" },
        { from: "hop", to: "wait" },
      ],
    }))
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const timers = new TimerService({ baseDir: resolve(TEST_DIR, "_timer-base"), tickIntervalMs: opts.tickMs ?? 20 })
    const logs: string[] = []
    const dispatcher = new WorkflowDispatcher({
      store, runs, nodeId: "node-a", timers, log: (m: string) => logs.push(m),
      channels: {}, agents: { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) },
    } as any)
    const timerFiles = () => readdirSync(timers.baseDir).filter((f) => f.endsWith(".json"))
    const timerOf = () => JSON.parse(readFileSync(resolve(timers.baseDir, timerFiles()[0]), "utf-8"))
    return { runs, timers, dispatcher, logs, timerFiles, timerOf }
  }

  async function start(d: WorkflowDispatcher, runs: RunStore) {
    await d.dispatch({ trigger: { source: "manual" }, entityRef: { backend: "manual", id: "e1" }, event: { id: "evt-1", payload: {} } })
    await new Promise((r) => setTimeout(r, 30))
    const run = runs.list()[0]
    expect(run.status).toBe("paused")
    return run
  }

  const note = (ref: string, selfMarked = false): WorkActivity => ({ ref, on: "note", selfMarked })
  const wakeLines = (logs: string[]) => logs.filter((l) => l.includes(" wake "))

  it("woke: moves the same timer file to now and writes fireAt to pausedAt", async () => {
    const { runs, dispatcher, timerFiles, timerOf, logs } = setup()
    const run = await start(dispatcher, runs)
    expect(run.pausedAt).toMatchObject({ kind: "timerWait", wake: { refs: ["acme/web#1"] } })
    const before = timerOf()
    expect(Date.parse(before.fireAt) - Date.now()).toBeGreaterThan(HOUR - 60_000)

    expect(await dispatcher.wake(note("acme/web#1"))).toEqual([{ runId: run.id, nodeId: "wait", result: "woke" }])
    const after = timerOf()
    expect(timerFiles()).toHaveLength(1)
    expect(after.id).toBe(before.id)
    expect(Date.parse(after.fireAt)).toBeLessThanOrEqual(Date.now())
    const fresh = runs.get(run.id)!
    expect(fresh.pausedAt).toMatchObject({ kind: "timerWait", fireAt: after.fireAt })
    expect(fresh.meta?.lastWakeAt).toBeTruthy()
    expect(wakeLines(logs)).toEqual([`[workflow:wake-demo] wake run=${run.id} node=wait event=note:acme/web#1 result=woke`])
  })

  it("debounced: a second event inside the gap moves the timer to the end of the gap", async () => {
    const { runs, dispatcher, timerOf, logs } = setup()
    const run = await start(dispatcher, runs)
    // An earlier wake 30 s ago, timer still an hour out.
    runs.patch(run.id, { meta: { lastWakeAt: new Date(Date.now() - 30_000).toISOString() } })
    expect((await dispatcher.wake(note("acme/web#1")))[0].result).toBe("debounced")
    const due = Date.parse(timerOf().fireAt) - Date.now()
    expect(due).toBeGreaterThan(20_000)
    expect(due).toBeLessThanOrEqual(30_000)
    // A third inside the gap leaves the trailing tick where it is.
    expect((await dispatcher.wake(note("acme/web#1")))[0].result).toBe("debounced")
    expect(wakeLines(logs).at(-1)).toMatch(/result=debounced$/)
  })

  it("self: a self-marked note logs and leaves the timer", async () => {
    const { runs, dispatcher, timerOf, logs } = setup()
    const run = await start(dispatcher, runs)
    const before = timerOf().fireAt
    expect(await dispatcher.wake(note("acme/web#1", true))).toEqual([{ runId: run.id, nodeId: "wait", result: "self" }])
    expect(timerOf().fireAt).toBe(before)
    expect(wakeLines(logs)).toEqual([`[workflow:wake-demo] wake run=${run.id} node=wait event=note:acme/web#1 result=self`])
  })

  // Hakim's review of #1824 (noqta#655 n142331): the run's own label
  // write must not wake it; another agent's label on the same ref must,
  // even from the same bot account.
  const label = (ref: string, labels: string[], byAgentx = true): WorkActivity => ({ ref, on: "label", selfMarked: false, labels, byAgentx })

  it("self label: the run sets a label, then waits — its own webhook does not wake it", async () => {
    const { runs, dispatcher, timerOf, logs } = setup({ self: "acme/web#1 +Doing, acme/web#1 -To Do" })
    const run = await start(dispatcher, runs)
    expect(run.pausedAt).toMatchObject({ wake: { selfLabels: ["acme/web#1 +doing", "acme/web#1 -to do"] } })
    const before = timerOf().fireAt
    expect(await dispatcher.wake(label("acme/web#1", ["+Doing", "-To Do"]))).toEqual([{ runId: run.id, nodeId: "wait", result: "self" }])
    expect(timerOf().fireAt).toBe(before)
    expect(wakeLines(logs)).toEqual([`[workflow:wake-demo] wake run=${run.id} node=wait event=label:acme/web#1 result=self`])
    // Used once: the record is empty, the same change again wakes.
    expect(runs.get(run.id)!.pausedAt).toMatchObject({ wake: { selfLabels: [] } })
    expect((await dispatcher.wake(label("acme/web#1", ["+Doing"])))[0].result).toBe("woke")
  })

  it("other agent's label: another change on the same ref wakes the run, bot account or not", async () => {
    const { runs, dispatcher, timerOf } = setup({ self: "acme/web#1 +Doing" })
    const run = await start(dispatcher, runs)
    // Coder sets Review (an AgentX account), not in the run's record.
    expect((await dispatcher.wake(label("acme/web#1", ["+Review", "-Doing"])))[0].result).toBe("woke")
    expect(Date.parse(timerOf().fireAt)).toBeLessThanOrEqual(Date.now())
    // The record is kept for the run's own webhook, still to come.
    expect(runs.get(run.id)!.pausedAt).toMatchObject({ wake: { selfLabels: ["acme/web#1 +doing"] } })
  })

  it("a recorded change made by a person (not an AgentX account) still wakes", async () => {
    const { runs, dispatcher } = setup({ self: "acme/web#1 +Doing" })
    await start(dispatcher, runs)
    expect((await dispatcher.wake(label("acme/web#1", ["+Doing"], false)))[0].result).toBe("woke")
  })

  it("burst: 5 notes in 10 s give one wake and at most one trailing tick", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(Date.parse("2026-11-10T10:00:00Z"))
      const { runs, dispatcher, timerOf } = setup()
      await start(dispatcher, runs)
      const results: string[] = []
      const fireTimes = new Set<string>()
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(Date.parse("2026-11-10T10:00:00Z") + i * 2_500)
        results.push(...(await dispatcher.wake(note("acme/web#1"))).map((r) => r.result))
        fireTimes.add(timerOf().fireAt)
      }
      expect(results.filter((r) => r === "woke")).toHaveLength(1)
      expect(results[0]).toBe("woke")
      // The timer was moved once, to now; the rest are inside the gap and
      // leave it there (it already fires before the gap ends).
      expect([...fireTimes]).toEqual(["2026-11-10T10:00:00.000Z"])

      // The run goes back to waiting after its tick, still inside the gap:
      // the next notes give one trailing tick at the end of the gap, no more.
      const run = runs.list()[0]
      runs.patch(run.id, { pausedAt: { ...(run.pausedAt as any), fireAt: "2026-11-10T11:00:00.000Z" } })
      const t = timerOf()
      writeFileSync(resolve(TEST_DIR, "_timer-base", `${t.id}.json`), JSON.stringify({ ...t, fireAt: "2026-11-10T11:00:00.000Z" }))
      const trailing = new Set<string>()
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(Date.parse("2026-11-10T10:00:12Z") + i * 1_000)
        expect((await dispatcher.wake(note("acme/web#1")))[0].result).not.toBe("woke")
        trailing.add(timerOf().fireAt)
      }
      expect([...trailing]).toEqual(["2026-11-10T10:01:00.000Z"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("no-run: an event nobody watches, or of a kind the wait ignores, changes nothing", async () => {
    const { runs, dispatcher, timerOf, logs } = setup()
    await start(dispatcher, runs)
    const before = timerOf().fireAt
    expect(await dispatcher.wake(note("acme/web#9"))).toEqual([])
    expect(timerOf().fireAt).toBe(before)
    expect(wakeLines(logs)).toEqual(["[workflows] wake event=note:acme/web#9 result=no-run"])
  })

  it("stale: the timer already fired (unlinked before its callback) — no new timer is made", async () => {
    const { runs, timers, dispatcher, timerFiles, logs } = setup()
    const run = await start(dispatcher, runs)
    // tick() marks the id fired and unlinks the file, then calls back; the
    // resume waits behind commit(). A wake listing timers just before the
    // unlink must not bring the timer back.
    const pending = timers.list()
    unlinkSync(resolve(timers.baseDir, `${pending[0].id}.json`))
    vi.spyOn(timers, "list").mockReturnValueOnce(pending)
    expect(await dispatcher.wake(note("acme/web#1"))).toEqual([{ runId: run.id, nodeId: "wait", result: "stale" }])
    expect(timerFiles()).toHaveLength(0)
    expect(runs.get(run.id)!.meta?.lastWakeAt).toBeUndefined()
    expect(wakeLines(logs).at(-1)).toMatch(/result=stale$/)
  })

  it("stale: the run left the wait between listing and commit", async () => {
    const { runs, timers, dispatcher, timerFiles } = setup()
    const run = await start(dispatcher, runs)
    const pending = timers.list()
    runs.setStatus(run.id, "running")
    vi.spyOn(timers, "list").mockReturnValueOnce(pending)
    expect((await dispatcher.wake(note("acme/web#1")))[0].result).toBe("stale")
    expect(timerFiles()).toHaveLength(1)
  })

  it("re-renders refs on every pause, so a merge request that appears later wakes the run", async () => {
    const { runs, timers, dispatcher, timerFiles } = setup({ minGapSec: 0 })
    const run = await start(dispatcher, runs)
    // First pause: `check` has not run, only the issue is watched.
    expect(runs.get(run.id)!.pausedAt).toMatchObject({ wake: { refs: ["acme/web#1"] } })
    expect(await dispatcher.wake(note("acme/web!2"))).toEqual([])

    timers.start()
    try {
      expect((await dispatcher.wake(note("acme/web#1")))[0].result).toBe("woke")
      // Fires on the next tick → check → back to the wait.
      await vi.waitFor(() => {
        const p = runs.get(run.id)!.pausedAt
        expect(p).toMatchObject({ kind: "timerWait", wake: { refs: ["acme/web#1", "acme/web!2"] } })
      }, { timeout: 3000, interval: 20 })
      expect(timerFiles()).toHaveLength(1)
      const fireAt = runs.get(run.id)!.pausedAt
      expect(Date.parse((fireAt as { fireAt: string }).fireAt) - Date.now()).toBeGreaterThan(HOUR - 60_000)
      expect((await dispatcher.wake({ ref: "acme/web!2", on: "label", selfMarked: false }))[0].result).toBe("woke")
    } finally {
      timers.stop()
    }
  })
})

describe("GitLab work activity", () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const BOT = "agentx_bot"

  function makeGitLab() {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" })))
    const gl = new GitLabAdapter({
      webhookPort: 0, host: "https://gitlab.example.test", token: "global", routes: [],
      agentMappings: [{ agentId: "reviewer-agent", gitlabUsernames: [BOT], keywords: [] }],
    } as any, () => {})
    const seen: WorkActivity[] = []
    gl.onWorkActivity((a) => seen.push(a))
    return { gl, seen }
  }
  const res = () => ({ writeHead: vi.fn(), end: vi.fn() })
  const note = (body: string, extra: { username?: string; action?: string; type?: string } = {}) => ({
    object_kind: "note",
    object_attributes: { id: 1, note: body, noteable_type: extra.type ?? "Issue", action: extra.action },
    project: { path_with_namespace: "Acme/Web" },
    user: { username: extra.username ?? "sam", name: "Sam" },
    issue: { iid: 4, title: "t" },
    merge_request: extra.type === "MergeRequest" ? { iid: 7, title: "t" } : undefined,
  })

  it("reports a new note before the mention filters, with no handler set", async () => {
    const { gl, seen } = makeGitLab()
    await (gl as any).handleNote(note("Result: Pass"), res())
    await (gl as any).handleNote(note("approved abc", { type: "MergeRequest", username: BOT }), res())
    expect(seen).toEqual([
      { ref: "acme/web#4", on: "note", selfMarked: false },
      { ref: "acme/web!7", on: "note", selfMarked: false },
    ])
  })

  it("skips note edits and AgentX status notes", async () => {
    const { gl, seen } = makeGitLab()
    await (gl as any).handleNote(note("typo", { action: "update" }), res())
    await (gl as any).handleNote(note(`Request status: done\n${STATUS_TAG}`, { username: BOT }), res())
    expect(seen).toEqual([])
  })

  it("honours the no-wake mark only from an account AgentX posts with", async () => {
    const { gl, seen } = makeGitLab()
    await (gl as any).handleNote(note(`Stage moved ${WAKE_SELF_MARK}`, { username: BOT }), res())
    await (gl as any).handleNote(note(`Pass ${WAKE_SELF_MARK}`, { username: "sam" }), res())
    expect(seen.map((a) => a.selfMarked)).toEqual([true, false])
  })

  it("reports label changes on issues and merge requests, nothing else", async () => {
    const { gl, seen } = makeGitLab()
    const labels = { previous: [{ title: "Doing" }], current: [{ title: "Review" }] }
    const base = { user: { username: BOT, name: "b" }, project: { path_with_namespace: "acme/web" } }
    await (gl as any).handleIssue({ ...base, object_kind: "issue", object_attributes: { iid: 4, action: "update" }, changes: { labels } }, res())
    await (gl as any).handleIssue({ ...base, object_kind: "issue", object_attributes: { iid: 4, action: "update" }, changes: { title: { previous: "a", current: "b" } } }, res())
    await (gl as any).handleMR({ ...base, object_kind: "merge_request", object_attributes: { iid: 7, action: "update" }, changes: { labels } }, res())
    await (gl as any).handleMR({ ...base, object_kind: "merge_request", object_attributes: { iid: 7, action: "merge" } }, res())
    expect(seen).toEqual([
      { ref: "acme/web#4", on: "label", selfMarked: false, labels: ["+Review", "-Doing"], byAgentx: true },
      { ref: "acme/web!7", on: "label", selfMarked: false, labels: ["+Review", "-Doing"], byAgentx: true },
    ])
  })

  it("marks a label change from another account as not AgentX's", async () => {
    const { gl, seen } = makeGitLab()
    const labels = { previous: [], current: [{ title: "Review" }] }
    await (gl as any).handleIssue({ user: { username: "sam", name: "Sam" }, project: { path_with_namespace: "acme/web" }, object_kind: "issue", object_attributes: { iid: 4, action: "update" }, changes: { labels } }, res())
    expect(seen).toEqual([{ ref: "acme/web#4", on: "label", selfMarked: false, labels: ["+Review"], byAgentx: false }])
  })
})
