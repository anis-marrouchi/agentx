import { describe, expect, it } from "vitest"
import { RECENT_RUNS_CAP, RecentRuns, WORKERS_PER_RUN, parentRunOf, withWorkers, workersByRun, type HandoffEntry, type RunLike } from "../src/agents/run-workers"
import { withParentRun } from "../src/actions/builtin/parent-run"
import { agentCall } from "../src/actions/builtin/agent"
import { meshDelegate } from "../src/actions/builtin/mesh"
import { resetAgentRegistryForTesting, setAgentRegistry } from "../src/agents/registry-instance"
import { _resetMeshForTesting, setMesh } from "../src/a2a/mesh-instance"

// #2145: the Hub lists, under each agent run, the workers that run started:
// hand-offs, workflows it started and sub-runs of its workflow run. GET
// /agents carries them on the parent's runningTasks entry.

const NOW = Date.parse("2026-11-23T12:00:00Z")
const ago = (ms: number) => NOW - ms
const iso = (ms: number) => new Date(NOW - ms).toISOString()

const TASKS = [
  { id: "run-1" },
  { id: "run-2", workflow: { runId: "wf-parent" } },
]

describe("parentRunOf", () => {
  it("reads a well-formed parent link and drops anything else", () => {
    expect(parentRunOf({ parentRun: { taskId: "run-1", agentId: "front", node: "mac" } })).toEqual({ taskId: "run-1", agentId: "front", node: "mac" })
    expect(parentRunOf({ parentRun: { taskId: "run-1", agentId: "front" } })).toEqual({ taskId: "run-1", agentId: "front" })
    expect(parentRunOf({ parentRun: { taskId: "", agentId: "front" } })).toBeUndefined()
    expect(parentRunOf({ parentRun: { taskId: 3, agentId: "front" } })).toBeUndefined()
    expect(parentRunOf({ parentRun: "run-1" })).toBeUndefined()
    expect(parentRunOf({})).toBeUndefined()
    expect(parentRunOf(undefined)).toBeUndefined()
    expect(parentRunOf({ parentRun: { taskId: "x".repeat(500), agentId: "a" } })!.taskId).toHaveLength(80)
  })
})

describe("workersByRun", () => {
  const handoffs: HandoffEntry[] = [
    { id: "dlg-a", callee: "worker", status: "running", startedAt: ago(60_000), callerRun: "run-1", calleeRun: "callee-1", request: "Check the build\nsecond line" },
    { id: "dlg-b", callee: "atlas", peer: "clawd", status: "done", startedAt: ago(20 * 60_000), endedAt: ago(10 * 60_000), callerRun: "run-1", request: "Ask Atlas" },
    { id: "dlg-c", callee: "worker", status: "timeout", startedAt: ago(30 * 60_000), endedAt: ago(5 * 60_000), callerRun: "run-1" },
    { id: "dlg-d", callee: "worker", status: "waiting", startedAt: ago(3 * 3_600_000), endedAt: ago(2 * 3_600_000), callerRun: "run-1", request: "Waits on CI" },
    // Ended over an hour ago: gone.
    { id: "dlg-old", callee: "worker", status: "done", startedAt: ago(3 * 3_600_000), endedAt: ago(2 * 3_600_000), callerRun: "run-1" },
    // Asked by a run that is not running here.
    { id: "dlg-other", callee: "worker", status: "running", startedAt: ago(1000), callerRun: "run-9" },
  ]
  const runs: RunLike[] = [
    { id: "wf-1", workflowId: "deploy", status: "running", createdAt: iso(120_000), updatedAt: iso(1000), meta: { title: "Deploy the site", startedBy: "front", startedByRun: "run-1" } },
    { id: "wf-child", workflowId: "review", status: "paused", parentRunId: "wf-parent", createdAt: iso(90_000), updatedAt: iso(80_000) },
    { id: "wf-failed", workflowId: "lint", status: "failed", createdAt: iso(300_000), updatedAt: iso(200_000), meta: { startedByRun: "run-2" } },
    { id: "wf-stranger", workflowId: "x", status: "running", createdAt: iso(1000), updatedAt: iso(1000), meta: { startedByRun: "run-9" } },
  ]
  const by = workersByRun(TASKS, handoffs, runs, NOW)

  it("lists a run's hand-offs and workflows with their state in four words", () => {
    const w = by.get("run-1")!
    expect(w.map((x) => [x.id, x.status])).toEqual([
      ["dlg-a", "working"], ["wf-1", "working"], ["dlg-b", "done"], ["dlg-c", "failed"], ["dlg-d", "waiting"],
    ])
    const a = w.find((x) => x.id === "dlg-a")!
    expect(a).toMatchObject({ kind: "handoff", title: "Check the build", agentId: "worker", taskId: "callee-1" })
    expect(w.find((x) => x.id === "dlg-b")).toMatchObject({ peer: "clawd", endedAt: iso(10 * 60_000) })
    expect(w.find((x) => x.id === "dlg-c")!.title).toBe("Work for worker")
    expect(w.find((x) => x.id === "wf-1")).toMatchObject({ kind: "workflow", title: "Deploy the site", workflowId: "deploy", agentId: "front" })
  })
  it("puts a sub-run of the workflow run a task works in under that task", () => {
    expect(by.get("run-2")!.map((x) => [x.id, x.status, x.title])).toEqual([
      ["wf-child", "waiting", "review"], ["wf-failed", "failed", "lint"],
    ])
  })
  it("leaves out old ended workers and runs not running here", () => {
    const all = [...by.values()].flat().map((x) => x.id)
    expect(all).not.toContain("dlg-old")
    expect(all).not.toContain("dlg-other")
    expect(all).not.toContain("wf-stranger")
    expect(by.has("run-9")).toBe(false)
  })
  it("keeps the newest few per run", () => {
    const many: HandoffEntry[] = Array.from({ length: 12 }, (_, i) => ({ id: "d" + i, callee: "w", status: "running", startedAt: ago(i * 1000), callerRun: "run-1" }))
    const list = workersByRun(TASKS, many, [], NOW).get("run-1")!
    expect(list).toHaveLength(WORKERS_PER_RUN)
    expect(list[0].id).toBe("d0")
  })
})

describe("withWorkers", () => {
  it("puts the workers on their parent's runningTasks entry, and leaves the rest alone", () => {
    const agents = [
      { id: "front", runningTasks: [{ id: "run-1", channel: "telegram" }, { id: "run-3", channel: "app" }] },
      { id: "idle", runningTasks: [] as Array<{ id: string }> },
    ]
    const out = withWorkers(agents, [{ id: "dlg-a", callee: "worker", status: "running", startedAt: ago(1000), callerRun: "run-1" }], [], NOW)
    expect(out[0].runningTasks[0]).toMatchObject({ id: "run-1", channel: "telegram", workers: [{ id: "dlg-a" }] })
    expect(out[0].runningTasks[1]).toEqual({ id: "run-3", channel: "app" })
    expect(out[1]).toBe(agents[1])
    // Nothing to add: the same list.
    expect(withWorkers(agents, [], [], NOW)).toBe(agents)
  })
})

describe("RecentRuns", () => {
  it("reads the runs at most once per ttl, from an hour back", () => {
    let t = NOW
    const asked: number[] = []
    const cache = new RecentRuns((since) => { asked.push(since); return [] }, () => [], () => null, 10_000, () => t)
    cache.get(); cache.get()
    t += 9_000; cache.get()
    t += 2_000; cache.get()
    expect(asked).toEqual([NOW - 3_600_000, NOW + 11_000 - 3_600_000])
  })
  it("answers no runs when the list fails", () => {
    expect(new RecentRuns(() => { throw new Error("disk") }).get()).toEqual([])
  })
  it("keeps a workflow waiting on the owner for more than an hour under its parent", () => {
    const old: RunLike = {
      id: "wf-old", workflowId: "approve-invoice", status: "paused",
      createdAt: iso(5 * 3_600_000), updatedAt: iso(3 * 3_600_000), meta: { startedByRun: "run-1" },
    }
    const done: RunLike = {
      id: "wf-done", workflowId: "report", status: "completed",
      createdAt: iso(20 * 60_000), updatedAt: iso(10 * 60_000), meta: { startedByRun: "run-1" },
    }
    // The recent read skips files older than the window, as the store does.
    const all = [old, done]
    const cache = new RecentRuns(
      (since) => all.filter((r) => Date.parse(r.updatedAt) >= since),
      () => all.filter((r) => r.status === "running" || r.status === "paused"),
      () => null, 10_000, () => NOW,
    )
    const runs = cache.get()
    expect(runs.map((r) => r.id)).toEqual(["wf-old", "wf-done"])
    const w = workersByRun(TASKS, [], runs, NOW).get("run-1")!
    expect(w.map((x) => [x.id, x.status])).toEqual([["wf-done", "done"], ["wf-old", "waiting"]])
  })
  it("reads open runs first, once each, and caps the total", () => {
    const run = (id: string, status: string): RunLike => ({ id, workflowId: "w", status, createdAt: iso(0), updatedAt: iso(0) })
    const open = Array.from({ length: 150 }, (_, i) => run(`o${i}`, "running"))
    const recent = [run("o0", "running"), ...Array.from({ length: 150 }, (_, i) => run(`r${i}`, "completed"))]
    const runs = new RecentRuns(() => recent, () => open, () => null, 10_000, () => NOW).get()
    expect(runs).toHaveLength(RECENT_RUNS_CAP)
    expect(runs.slice(0, 150).every((r) => r.id.startsWith("o"))).toBe(true)
    expect(new Set(runs.map((r) => r.id)).size).toBe(RECENT_RUNS_CAP)
  })
  it("still reads the recent runs when the open read fails", () => {
    const r: RunLike = { id: "a", workflowId: "w", status: "completed", createdAt: iso(0), updatedAt: iso(0) }
    expect(new RecentRuns(() => [r], () => { throw new Error("disk") }, () => null, 10_000, () => NOW).get()).toEqual([r])
  })
  it("reads every open run once, then only changed files and the known open runs (B1)", () => {
    let t = NOW
    const run = (id: string, status: string, ago = 0): RunLike => ({ id, workflowId: "w", status, createdAt: iso(ago), updatedAt: iso(ago) })
    const files = new Map<string, RunLike>([["old", run("old", "paused", 5 * 3_600_000)]])
    let fullReads = 0
    const asked: number[] = []
    const byIdAsked: string[] = []
    const cache = new RecentRuns(
      (since) => { asked.push(since); return [...files.values()].filter((r) => Date.parse(r.updatedAt) >= since) },
      () => { fullReads++; return [...files.values()].filter((r) => r.status === "running" || r.status === "paused") },
      (id) => { byIdAsked.push(id); return files.get(id) ?? null },
      10_000, () => t,
    )
    expect(cache.get().map((r) => r.id)).toEqual(["old"])
    // A new run opens; the next read sees it from the changed files.
    t += 10_000
    files.set("new", { ...run("new", "running"), updatedAt: new Date(t).toISOString() })
    expect(cache.get().map((r) => r.id).sort()).toEqual(["new", "old"])
    expect(asked[1]).toBe(NOW + 10_000 - 3_600_000) // the window: the last read is inside it
    // Hours later, with no read in between: both are still kept, read by id.
    t += 3 * 3_600_000
    const before = t - 3 * 3_600_000
    expect(cache.get().map((r) => r.id).sort()).toEqual(["new", "old"])
    expect(asked[2]).toBe(before) // files changed since the last read, not just the window
    expect(byIdAsked).toContain("old")
    // "old" ends: it drops out of the open set and, ended long ago, out of the list.
    files.set("old", { ...run("old", "completed", 5 * 3_600_000) })
    t += 10_000
    expect(cache.get().map((r) => r.id)).toEqual(["new"])
    t += 10_000
    byIdAsked.length = 0
    cache.get()
    expect(byIdAsked).toEqual(["new"])
    expect(fullReads).toBe(1)
  })
  it("retries the full open read until the store answers", () => {
    let t = NOW
    let ready = false
    let fullReads = 0
    const open: RunLike = { id: "o", workflowId: "w", status: "paused", createdAt: iso(9 * 3_600_000), updatedAt: iso(9 * 3_600_000) }
    const cache = new RecentRuns(() => [], () => { fullReads++; return ready ? [open] : null }, () => open, 10_000, () => t)
    expect(cache.get()).toEqual([])
    ready = true; t += 10_000
    expect(cache.get()).toEqual([open])
    t += 10_000
    expect(cache.get()).toEqual([open])
    expect(fullReads).toBe(2)
  })
})

describe("agent.call and mesh.delegate name their calling run (withParentRun)", () => {
  it("puts the proven turn on the body and drops one the caller sent", () => {
    expect(withParentRun("agent.call", { agentId: "w", message: "m", parentRun: { taskId: "forged", agentId: "x" } }, { agentId: "front", taskId: "run-1" }, "mac"))
      .toEqual({ agentId: "w", message: "m", parentRun: { taskId: "run-1", agentId: "front", node: "mac" } })
    expect(withParentRun("mesh.delegate", { peer: "p", message: "m", parentRun: { taskId: "forged", agentId: "x" } }, null))
      .toEqual({ peer: "p", message: "m" })
    // Other built-ins are left as they are.
    const body = { url: "x", parentRun: 1 }
    expect(withParentRun("http.fetch", body, { agentId: "front", taskId: "run-1" })).toBe(body)
  })
  it("both schemas keep the parent link", () => {
    const p = { taskId: "run-1", agentId: "front", node: "mac" }
    expect(agentCall.inputSchema.parse({ agentId: "w", message: "m", parentRun: p }).parentRun).toEqual(p)
    expect(meshDelegate.inputSchema.parse({ peer: "clawd", message: "m", parentRun: p }).parentRun).toEqual(p)
  })
  it("hands the link to the callee's run: in its context here, in the forwarded context to a peer", async () => {
    const p = { taskId: "run-1", agentId: "front", node: "mac" }
    const runs: any[] = []
    setAgentRegistry({ execute: async (t: any) => { runs.push(t); return { content: "ok" } } } as any)
    const sends: any[] = []
    setMesh({ sendTask: async (...args: any[]) => { sends.push(args); return "fine" } } as any)
    try {
      await agentCall.handler(agentCall.inputSchema.parse({ agentId: "w", message: "m", parentRun: p }))
      expect(runs[0].context).toMatchObject({ channel: "api", parentRun: p })
      await meshDelegate.handler(meshDelegate.inputSchema.parse({ peer: "clawd", message: "m", parentRun: p }))
      expect(sends[0][3]).toMatchObject({ context: { parentRun: p } })
      // No link: no context, the classic A2A call.
      await meshDelegate.handler(meshDelegate.inputSchema.parse({ peer: "clawd", message: "m" }))
      expect(sends[1][3].context).toBeUndefined()
    } finally {
      resetAgentRegistryForTesting()
      _resetMeshForTesting()
    }
  })
})
