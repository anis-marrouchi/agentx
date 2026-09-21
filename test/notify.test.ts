import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { dirname } from "path"
import { tmpdir } from "os"
import { join } from "path"
import { readFocus, focusLabel } from "../src/notify/focus"
import { NotificationQueue, digest } from "../src/notify/queue"
import { notify, flushHeld } from "../src/notify"

// Not interrupting someone who asked not to be interrupted.
//
// The asymmetry that shapes all of this: an interruption during Focus
// costs a moment's attention, while a silently dropped message costs the
// thing it was about — the agent that sent it has moved on and will not
// send it again. So Focus HOLDS, it never discards, and every unexpected
// condition resolves toward delivering.

let dir: string
const prevCwd = process.cwd()

describe("readFocus", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-focus-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const write = (obj: unknown) => {
    const p = join(dir, "Assertions.json")
    writeFileSync(p, JSON.stringify(obj))
    return p
  }

  it("reads an active Focus from an assertion record", () => {
    // Shape verified against the real file with a Focus switched on.
    const p = write({
      data: [{
        storeAssertionRecords: [{
          assertionDetails: { assertionDetailsModeIdentifier: "com.apple.sleep.sleep-mode" },
        }],
      }],
    })
    const state = readFocus(p)
    expect(state.active).toBe(true)
    expect(state.mode).toBe("com.apple.sleep.sleep-mode")
    expect(focusLabel(state)).toBe("in sleep mode")
  })

  it("reads Focus as OFF when only invalidation records are present", () => {
    // This is what the real file holds moments after a Focus is switched
    // off — the key is absent rather than empty, which an `?? []` would
    // have quietly got right and a `.length === 0` check on a missing
    // parent would have thrown on.
    const p = write({
      data: [{ storeInvalidationRecords: [{}], storeInvalidationRequestRecords: [{}] }],
    })
    expect(readFocus(p).active).toBe(false)
  })

  it("fails toward NOT in focus when the file is missing or malformed", () => {
    // An OS update that moves this file must not silently swallow every
    // notification forever. Arriving during Focus is a small annoyance; a
    // permanently broken channel is not.
    expect(readFocus(join(dir, "nope.json")).active).toBe(false)
    const bad = join(dir, "bad.json")
    writeFileSync(bad, "{not json")
    expect(readFocus(bad).active).toBe(false)
  })
})

describe("notify", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-notify-"))
    process.chdir(dir)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  })

  const focusOn = { active: true, mode: "com.apple.donotdisturb", reason: "test" }
  const focusOff = { active: false, mode: null, reason: "test" }

  it("delivers when the person is not in Focus", async () => {
    const send = vi.fn(async () => {})
    const r = await notify({ message: "build finished" }, send, { focus: focusOff, sound: false })
    expect(r.delivered).toBe(true)
    expect(send).toHaveBeenCalledOnce()
  })

  it("holds rather than dropping when in Focus", async () => {
    const send = vi.fn(async () => {})
    const queue = new NotificationQueue()
    const r = await notify({ message: "a client replied", from: "cx" }, send,
      { focus: focusOn, queue, sound: false })

    expect(r.held).toBe(true)
    expect(send).not.toHaveBeenCalled()
    const waiting = queue.list()
    expect(waiting).toHaveLength(1)
    expect(waiting[0].message).toBe("a client replied")
    expect(waiting[0].from).toBe("cx")
  })

  it("lets something genuinely urgent through Focus", async () => {
    const send = vi.fn(async () => {})
    const r = await notify({ message: "production is down", urgent: true }, send,
      { focus: focusOn, sound: false })
    expect(r.delivered).toBe(true)
    expect(send).toHaveBeenCalledOnce()
  })

  it("folds a backlog into ONE message when Focus ends", async () => {
    // Firing four pings the moment Focus ends recreates exactly the
    // interruption Focus existed to prevent.
    const queue = new NotificationQueue()
    const send = vi.fn(async () => {})
    for (const m of ["one", "two", "three"]) {
      await notify({ message: m, from: "cx" }, send, { focus: focusOn, queue, sound: false })
    }
    expect(send).not.toHaveBeenCalled()

    const n = await flushHeld(send, { queue, sound: false })
    expect(n).toBe(3)
    expect(send).toHaveBeenCalledOnce()
    const sent = send.mock.calls[0][0] as any
    expect(sent.title).toContain("3")
    expect(sent.message).toContain("one")
    expect(sent.message).toContain("three")
    // Drained, so the next flush has nothing to say.
    expect(await flushHeld(send, { queue, sound: false })).toBe(0)
  })

  it("keeps the backlog when delivery fails", async () => {
    // The order matters: draining before sending is the obvious
    // implementation and it loses the entire backlog on a transient
    // network error — exactly the loss the queue exists to prevent.
    const queue = new NotificationQueue()
    const held = vi.fn(async () => {})
    await notify({ message: "still important", from: "cx" }, held,
      { focus: focusOn, queue, sound: false })

    const failing = vi.fn(async () => { throw new Error("network down") })
    await expect(flushHeld(failing, { queue, sound: false })).rejects.toThrow("network down")
    expect(queue.list()).toHaveLength(1)

    // And the next attempt still has it.
    const working = vi.fn(async () => {})
    expect(await flushHeld(working, { queue, sound: false })).toBe(1)
    expect(queue.list()).toHaveLength(0)
  })

  it("passes a lone held message through unchanged", async () => {
    // A digest wrapper around a single item is noise.
    const entries = [{
      id: "1", at: new Date().toISOString(), from: "cx",
      title: "Secretary", message: "one thing", heldBecause: "in Focus",
    }]
    expect(digest(entries)).toEqual({ title: "Secretary", message: "one thing" })
    expect(digest([])).toBeNull()
  })

  it("survives a corrupt queue rather than refusing to notify", async () => {
    const queue = new NotificationQueue()
    mkdirSync(dirname(queue.path), { recursive: true })
    writeFileSync(queue.path, "{{{")
    // Losing a held notification is bad; refusing to send any new one
    // because the file on disk is broken is worse.
    expect(queue.list()).toEqual([])
  })
})
