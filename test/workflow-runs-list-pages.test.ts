import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, rmSync } from "fs"
import { resolve } from "path"
import { RunStore, type WorkflowRun } from "../src/workflows"
import { slimRun } from "../src/workflows/follow-up"

// A slow board over a remote link: the run list pages by updatedAt, the follow-ups
// column asks for running and paused runs only, and the list shape drops
// each step's output.

const TEST_DIR = resolve(__dirname, "../.test-workflow-runs-list-pages")

beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
afterEach(() => { vi.useRealTimers(); rmSync(TEST_DIR, { recursive: true, force: true }) })

function seed(): RunStore {
  const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
  vi.useFakeTimers({ toFake: ["Date"] })
  for (const [i, id] of ["r1", "r2", "r3"].entries()) {
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 5, 10, i)))
    runs.create({ id, workflowId: "wf", initialPending: [], entityRef: { backend: "channel", id } })
  }
  vi.setSystemTime(new Date(Date.UTC(2026, 10, 5, 10, 5)))
  runs.setStatus("r2", "completed")
  vi.useRealTimers()
  return runs
}

describe("RunStore.list paging and active", () => {
  it("before keeps only runs last updated earlier than it", () => {
    const runs = seed()
    const ids = (list: WorkflowRun[]) => list.map((r) => r.id).sort()
    expect(ids(runs.list({ before: "2026-11-05T10:02:00.000Z" }))).toEqual(["r1"])
    expect(ids(runs.list({ before: "2026-11-05T10:05:00.000Z" }))).toEqual(["r1", "r3"])
    expect(ids(runs.list({}))).toEqual(["r1", "r2", "r3"])
  })

  it("active keeps running and paused runs", () => {
    const runs = seed()
    expect(runs.list({ active: true }).map((r) => r.id).sort()).toEqual(["r1", "r3"])
  })
})

describe("slimRun", () => {
  it("drops step outputs, input keys and context, keeps the last five steps", () => {
    const step = (n: number) => ({
      at: `2026-11-05T10:0${n}:00.000Z`, nodeId: `s${n}`, inputKeys: ["x"], status: "ok" as const,
      output: { big: "x".repeat(5000) }, idempotencyKey: `k${n}`, durationMs: n,
      ...(n === 6 ? { note: "n".repeat(400) } : {}),
    })
    const run = {
      id: "r", workflowId: "wf", workflowVersion: 2, homeNode: "node-a", status: "failed", pending: [],
      entityRef: { backend: "channel", id: "r" }, context: { trigger: { body: "y".repeat(5000) } },
      history: [1, 2, 3, 4, 5, 6].map(step), parentRunId: null, parentNodeId: null, rootRunId: "r", depth: 0,
      joinCounters: {}, createdAt: "2026-11-05T10:00:00.000Z", updatedAt: "2026-11-05T10:06:00.000Z",
    } as unknown as WorkflowRun
    const slim = slimRun(run)
    expect(slim.history.map((h) => h.nodeId)).toEqual(["s2", "s3", "s4", "s5", "s6"])
    expect(slim.history[0]).toEqual({ at: "2026-11-05T10:02:00.000Z", nodeId: "s2", status: "ok", durationMs: 2 })
    expect(slim.history[4].note).toHaveLength(301)
    expect("context" in slim).toBe(false)
    expect(JSON.stringify(slim).length).toBeLessThan(1500)
    // Slimming a slim run changes nothing: the board slims what nodes sent.
    expect(slimRun(slim)).toEqual(slim)
  })
})
