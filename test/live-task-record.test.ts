import { describe, expect, it, vi } from "vitest"
import { liveTaskRecord, type LiveTaskSource } from "../src/daemon/live-task-record"

const run = { id: "t1", messagePreview: "Fix it", message: "Fix it", channel: "a2a", sender: "pm-agent", startedAt: new Date("2026-11-27T11:00:00Z") }

function source(output: { initial: string; done: boolean } | null): LiveTaskSource & { unsub: ReturnType<typeof vi.fn> } {
  const unsub = vi.fn()
  return {
    unsub,
    list: () => [{ id: "cx", runningTasks: [run as never] }],
    subscribeToTaskOutput: () => output ? { ...output, unsubscribe: unsub } : null,
  }
}

describe("liveTaskRecord (#2101 R17b)", () => {
  it("reads a running task as a record with its output so far, and lets go of the output", () => {
    const src = source({ initial: "→ Read(a.md)", done: false })
    expect(liveTaskRecord(src, "cx", "t1")).toEqual({
      live: true, id: "t1", agentId: "cx", message: "Fix it", sender: "pm-agent", channel: "a2a",
      startedAt: "2026-11-27T11:00:00.000Z", transcript: "→ Read(a.md)", responseText: "",
    })
    expect(src.unsub).toHaveBeenCalledOnce()
  })

  it("is null for a task that is not this agent's running task", () => {
    const src = source({ initial: "x", done: false })
    expect(liveTaskRecord(src, "other", "t1")).toBeNull()
    expect(liveTaskRecord(src, "cx", "t2")).toBeNull()
  })

  it("is null when the output is gone", () => {
    expect(liveTaskRecord(source(null), "cx", "t1")).toBeNull()
  })
})
