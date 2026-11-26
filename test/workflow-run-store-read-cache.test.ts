import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appendFileSync, mkdtempSync, rmSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { RunStore } from "../src/workflows"

// #2319: open runs are re-read every few seconds, and some run logs are
// 10-20 MB. A repeat read parses only what was appended since; it must
// give the same run a fresh full read gives.

let dir: string
const entity = { backend: "manual", id: "e-1" } as const
const entry = (i: number) => ({ nodeId: `n${i}`, at: new Date(1_800_000_000_000 + i * 1000).toISOString(), idempotencyKey: `k${i}`, output: { i } }) as any

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "run-cache-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("RunStore read cache (#2319)", () => {
  it("gives the same run as a fresh full read after many appends", () => {
    const store = new RunStore({ baseDir: dir, nodeId: "mac" })
    const run = store.create({ workflowId: "wf", initialPending: ["n0"], entityRef: entity })
    for (let i = 0; i < 30; i++) {
      store.recordExecution({ runId: run.id, entry: entry(i), nextPending: [`n${i + 1}`], context: { [`n${i}`]: { i } } })
      expect(store.get(run.id)).toEqual(new RunStore({ baseDir: dir, nodeId: "mac" }).get(run.id))
    }
    store.recordExecution({ runId: run.id, entry: entry(30), nextPending: [], status: "paused", pausedAt: { kind: "timerWait", nodeId: "n30", fireAt: "2027-01-01T00:00:00.000Z" } as any })
    const fresh = new RunStore({ baseDir: dir, nodeId: "mac" }).get(run.id)
    expect(store.get(run.id)).toEqual(fresh)
    expect(fresh?.history).toHaveLength(31)
    expect(fresh?.status).toBe("paused")
  })

  it("a caller changing the returned run does not change the next read", () => {
    const store = new RunStore({ baseDir: dir, nodeId: "mac" })
    const run = store.create({ workflowId: "wf", initialPending: ["n0"], entityRef: entity })
    const got = store.get(run.id)!
    got.history.push(entry(99))
    got.status = "failed"
    expect(store.get(run.id)?.history).toHaveLength(0)
    expect(store.get(run.id)?.status).toBe("running")
  })

  it("reads a line still being written only once it is whole", () => {
    const store = new RunStore({ baseDir: dir, nodeId: "mac" })
    const run = store.create({ workflowId: "wf", initialPending: ["n0"], entityRef: entity })
    store.get(run.id)
    const file = join(dir, "_runs", `${run.id}.jsonl`)
    const line = JSON.stringify({ v: 2, kind: "exec", runId: run.id, entry: entry(1), pending: [] })
    appendFileSync(file, line.slice(0, 20))
    expect(store.get(run.id)?.history).toHaveLength(0)
    appendFileSync(file, line.slice(20) + "\n")
    expect(store.get(run.id)?.history).toHaveLength(1)
    expect(store.get(run.id)).toEqual(new RunStore({ baseDir: dir, nodeId: "mac" }).get(run.id))
  })

  it("forgets a run whose file is gone", () => {
    const store = new RunStore({ baseDir: dir, nodeId: "mac" })
    const run = store.create({ workflowId: "wf", initialPending: ["n0"], entityRef: entity })
    expect(store.get(run.id)).not.toBeNull()
    unlinkSync(join(dir, "_runs", `${run.id}.jsonl`))
    expect(store.get(run.id)).toBeNull()
  })
})
