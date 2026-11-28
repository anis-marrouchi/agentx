import { describe, expect, it } from "vitest"
import {
  followupNote, isRunning, recordOutput, requestRuns, runActionUrl, runHash, runNodeUrl, runRecordUrl, runState, runTook, runView,
  addressRun, runningTaskIds, stopNote, type RequestRun,
} from "../src/hub/task/runs"
import type { TaskEvent } from "../src/hub/task/task-data"

const ev = (over: Partial<TaskEvent>): TaskEvent => ({ at: 1, kind: "run", who: "coder", text: "", ...over })
const run = (taskId: string, at: number, status: string | null = "ok"): RequestRun => ({ taskId, agentId: "coder", status, at, durationMs: null, text: "" })

describe("requestRuns", () => {
  it("keeps run events with a task and an agent, once each, oldest first", () => {
    const runs = requestRuns([
      ev({ ref: "t2", at: 20, status: "in-flight", durationMs: 5 }),
      ev({ kind: "comment", ref: "c1", at: 5 }),
      ev({ ref: "t1", at: 10, text: "Done it" }),
      ev({ ref: "t1", at: 11 }),
      ev({ ref: "t3", who: null, at: 30 }),
      ev({ at: 40 }),
    ])
    expect(runs).toEqual([
      { taskId: "t1", agentId: "coder", status: null, at: 10, durationMs: null, text: "Done it" },
      { taskId: "t2", agentId: "coder", status: "in-flight", at: 20, durationMs: 5, text: "" },
    ])
  })
})

describe("what runs now", () => {
  const live = { nodes: [{ name: "here", url: "http://here", agents: [{ id: "coder", runningTasks: [{ id: "t2" }] }] }, { name: "far", url: "http://far", agents: [{ id: "qa" }] }] }
  it("reads the running task ids off every node, or none without a snapshot", () => {
    expect([...runningTaskIds(live)!]).toEqual(["t2"])
    expect(runningTaskIds(undefined)).toBeNull()
  })
  it("trusts the snapshot over a trace a restart left in-flight", () => {
    const ids = runningTaskIds(live)
    expect(isRunning(run("t2", 0, "ok"), ids)).toBe(true)
    expect(isRunning(run("t1", 0, "in-flight"), ids)).toBe(false)
    expect(isRunning(run("t1", 0, "in-flight"), null)).toBe(true)
  })
  it("finds the node of the runs: the request's own, else this one", () => {
    expect(runNodeUrl({ peer: "http://far" }, live)).toBe("http://far")
    expect(runNodeUrl({ daemonUrl: "http://d", peer: "http://far" }, live)).toBe("http://d")
    expect(runNodeUrl({ name: "here" }, live)).toBe("http://here")
    expect(runNodeUrl(null, undefined)).toBe("")
  })
})

describe("runView", () => {
  const runs = [run("t1", 10), run("t2", 20, "in-flight"), run("t3", 30)]
  it("shows the newest run going now live, the others newest first", () => {
    const v = runView(runs, null, new Set(["t2"]))
    expect(v.live?.taskId).toBe("t2")
    expect(v.past.map((r) => r.taskId)).toEqual(["t3", "t1"])
    expect(v.opened).toBeNull()
  })
  it("opens the run the address names: live while it goes, in place once ended", () => {
    expect(runView(runs, "t2", new Set(["t2"])).live?.taskId).toBe("t2")
    const v = runView(runs, "t1", new Set(["t2"]))
    expect(v.live?.taskId).toBe("t2")
    expect(v.opened).toBe("t1")
    expect(runView(runs, "nope", new Set()).opened).toBeNull()
  })
  it("keeps the watched run in the live place once it ended", () => {
    const v = runView(runs, null, new Set(), "t2")
    expect(v.live?.taskId).toBe("t2")
    expect(v.past.map((r) => r.taskId)).toEqual(["t3", "t1"])
    expect(runView(runs, null, new Set()).live).toBeNull()
  })
})

describe("runState", () => {
  const none = new Set<string>()
  it("uses the one state set, with a reason when the word is not all", () => {
    expect(runState(run("t", 0, "ok"), none)).toEqual({ icon: "circle-check", word: "Done", tone: "done" })
    expect(runState(run("t", 0, "error"), none).word).toBe("Failed")
    expect(runState(run("t", 0, "timeout"), none)).toMatchObject({ word: "Failed", reason: "timed out" })
    expect(runState(run("t", 0, "cancelled"), none)).toMatchObject({ icon: "ban", word: "Cancelled" })
    expect(runState(run("t", 0, "in-flight"), none)).toMatchObject({ word: "Failed", reason: "cut off" })
    expect(runState(run("t", 0, "in-flight"), new Set(["t"]))).toMatchObject({ icon: "loader-circle", word: "Working" })
    expect(runState(run("t", 0, null), none)).toMatchObject({ icon: "circle", word: "Idle", reason: "no record" })
    // A run only its address names (#2101 T3): over, how it ended is in its record.
    expect(runState(run("t", 0, "ended"), none)).toEqual({ icon: "circle", word: "Ended", tone: "idle" })
    expect(runState(run("t", 0, "ended"), new Set(["t"]))).toMatchObject({ word: "Working" })
  })
  it("says how long a run took", () => {
    expect([runTook(null), runTook(45_000), runTook(180_000), runTook(80 * 60_000)]).toEqual(["", "45 s", "3 min", "1 h 20 min"])
  })
})

describe("addresses and calls", () => {
  it("sets or drops run= and keeps the rest of the address", () => {
    expect(runHash("#page=task&id=req-1", "t9")).toBe("#page=task&id=req-1&run=t9")
    expect(runHash("#page=task&id=req-1&run=t9", null)).toBe("#page=task&id=req-1")
  })
  it("reads and writes through the old run page's endpoints", () => {
    expect(runRecordUrl("http://n", "coder", "t 1")).toBe("/api/task/history?node=http%3A%2F%2Fn&agent=coder&task=t+1")
    expect(runActionUrl("http://n", "t1", "cancel")).toBe("/api/task/action?node=http%3A%2F%2Fn&task=t1&kind=cancel")
    expect(runActionUrl("http://n", "t1", "followup")).toBe("/api/task/action?node=http%3A%2F%2Fn&task=t1&kind=followup")
  })
})

describe("recordOutput", () => {
  it("adds the final reply only when the transcript lacks it, then the error, stamped at the end", () => {
    const end = "2026-11-26T12:00:00.000Z"
    expect(recordOutput({ transcript: "→ Read({})\nAll good", responseText: "All good" }).raw).toBe("→ Read({})\nAll good")
    const o = recordOutput({ transcript: "→ Read({})\n", responseText: "Fixed", error: "late", endedAt: end, transcriptStamps: [[0, 1]] })
    expect(o.raw).toBe("→ Read({})\n\n\nFixed\n\n[error] late")
    expect(o.stamps[0]).toEqual([0, 1])
    expect(o.stamps.length).toBeGreaterThan(1)
    expect(recordOutput({}).raw).toBe("")
  })
})

describe("what a steer or Stop said back", () => {
  it("says it as the old run page did", () => {
    expect(followupNote({ error: "gone" })).toEqual({ text: "Not sent: gone", err: true })
    expect(followupNote({ resumed: true, taskId: "t2" }).text).toBe("Sent: it continues as a new run, shown here.")
    expect(followupNote({ resumed: true, answeredBy: "attached" }).text).toBe("Answered by the attached session: no new run here.")
    expect(followupNote({ resumed: true }).text).toBe("The agent is busy: queued as the next turn in this chat.")
    expect(followupNote({})).toEqual({ text: "Queued: it goes in as the next turn.", err: false })
    expect(stopNote({})).toEqual({ text: "Stop asked: the turn ends now.", err: false })
    expect(stopNote({ error: "no run" })).toEqual({ text: "Not stopped: no run", err: true })
  })
})

describe("a run no request tracks (#2101 T3)", () => {
  it("is the run its address names, opened on its own", () => {
    const r = addressRun({ task: "t1", agent: "ops" })!
    expect(r).toEqual({ taskId: "t1", agentId: "ops", status: "ended", at: 0, durationMs: null, text: "" })
    // Asked for, and over: it opens in place; going now, it is the live run.
    expect(runView([r], "t1", new Set())).toEqual({ live: null, past: [r], opened: "t1" })
    expect(runView([r], "t1", new Set(["t1"])).live).toBe(r)
  })
  it("needs the run and its agent", () => {
    expect(addressRun({ task: "t1", agent: null })).toBeNull()
    expect(addressRun({ task: null, agent: "ops" })).toBeNull()
  })
})
