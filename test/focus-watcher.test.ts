import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { attachFocusWatcher } from "../src/daemon/focus-watcher"
import { NotificationQueue, type PendingNotification } from "../src/notify/queue"
import { flushHeld, type FocusState } from "../src/notify"

// #1668: a call hold can open and close between two watcher polls. The
// message `agentx notify` held in that window must still go out on the next
// tick, though the watcher never saw the hold.

const FREE: FocusState = { active: false, mode: null, reason: "not in a call" }
const CALL: FocusState = { active: true, mode: "call", reason: "in a call" }

const entry = (id: string, message = `msg ${id}`): PendingNotification => ({
  id, at: new Date().toISOString(), from: "test", title: "T", message, heldBecause: "in a call",
})

let dir: string
let queue: NotificationQueue

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), "agentx-watcher-"))
  queue = new NotificationQueue(join(dir, "pending.json"))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe("attachFocusWatcher", () => {
  it("delivers an item held while its last reading was free, on the next tick", async () => {
    const send = vi.fn(async () => {})
    const stop = attachFocusWatcher(send, () => {}, { queue, alert: false, pollMs: 1000, hold: () => FREE })
    queue.add(entry("a")) // held by a short hold the watcher never saw
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).toHaveBeenCalledTimes(1)
    expect(queue.list()).toEqual([])
    stop()
  })

  it("sends nothing twice: an empty queue is a no-op", async () => {
    const send = vi.fn(async () => {})
    const stop = attachFocusWatcher(send, () => {}, { queue, alert: false, pollMs: 1000, hold: () => FREE })
    queue.add(entry("a"))
    await vi.advanceTimersByTimeAsync(5000)
    expect(send).toHaveBeenCalledTimes(1)
    stop()
  })

  it("holds while the hold is on, and delivers when it ends", async () => {
    let state = CALL
    const send = vi.fn(async () => {})
    const log = vi.fn()
    const stop = attachFocusWatcher(send, log, { queue, alert: false, pollMs: 1000, hold: () => state })
    queue.add(entry("a"))
    await vi.advanceTimersByTimeAsync(3000)
    expect(send).not.toHaveBeenCalled()
    state = FREE
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining("delivered 1"))
    stop()
  })

  it("retries a failed send on a later tick and logs the same failure once", async () => {
    let fail = true
    const send = vi.fn(async () => { if (fail) throw new Error("network down") })
    const log = vi.fn()
    const stop = attachFocusWatcher(send, log, { queue, alert: false, pollMs: 1000, hold: () => FREE })
    queue.add(entry("a"))
    await vi.advanceTimersByTimeAsync(3000)
    expect(log.mock.calls.filter(([m]) => String(m).includes("network down"))).toHaveLength(1)
    expect(queue.list()).toHaveLength(1)
    fail = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(queue.list()).toEqual([])
    stop()
  })
})

describe("flushHeld clears only what it sent", () => {
  it("keeps a message held while the send was in flight", async () => {
    queue.add(entry("a"))
    const send = vi.fn(async () => { queue.add(entry("b")) })
    expect(await flushHeld(send, { queue, alert: false })).toBe(1)
    expect(queue.list().map((e) => e.id)).toEqual(["b"])
  })

  it("does not resend a destination already delivered when a later one fails", async () => {
    queue.add({ ...entry("a"), channel: "ntfy" })
    queue.add({ ...entry("b"), channel: "telegram", chatId: "1" })
    const send = vi.fn(async (m: { channel?: string }) => {
      if (m.channel === "telegram") throw new Error("telegram down")
    })
    await expect(flushHeld(send, { queue, alert: false })).rejects.toThrow("telegram down")
    expect(queue.list().map((e) => e.id)).toEqual(["b"])
  })

  it("clears an entry a hand edit left without an id", async () => {
    const { id: _id, ...noId } = entry("a")
    queue.add(noId as PendingNotification)
    await flushHeld(vi.fn(async () => {}), { queue, alert: false })
    expect(queue.list()).toEqual([])
  })
})

describe("NotificationQueue.drop", () => {
  it("drops one entry by id or unique prefix, and nothing on no match or an ambiguous prefix", () => {
    queue.add(entry("100-aaa"))
    queue.add(entry("100-bbb"))
    queue.add(entry("200-ccc"))
    expect(queue.drop("100")).toBeNull()
    expect(queue.drop("nope")).toBeNull()
    expect(queue.drop("200")?.id).toBe("200-ccc")
    expect(queue.drop("100-aaa")?.id).toBe("100-aaa")
    expect(queue.list().map((e) => e.id)).toEqual(["100-bbb"])
  })
})
