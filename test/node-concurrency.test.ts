import { describe, expect, it } from "vitest"
import { nodeConcurrencyGate, nodeKey } from "../src/workflows/node-concurrency"

describe("nodeConcurrencyGate", () => {
  it("admits up to N concurrent acquires, then queues", async () => {
    const key = nodeKey("wf-test-cap", "node-cap")
    await nodeConcurrencyGate.acquire(key, 2)
    await nodeConcurrencyGate.acquire(key, 2)
    expect(nodeConcurrencyGate.stats(key).active).toBe(2)

    let third = false
    const p = nodeConcurrencyGate.acquire(key, 2).then(() => { third = true })
    // Yield to event loop — third should still be queued.
    await new Promise((r) => setImmediate(r))
    expect(third).toBe(false)
    expect(nodeConcurrencyGate.stats(key).waiting).toBe(1)

    nodeConcurrencyGate.release(key)
    await p
    expect(third).toBe(true)
    expect(nodeConcurrencyGate.stats(key).active).toBe(2)
    nodeConcurrencyGate.release(key)
    nodeConcurrencyGate.release(key)
    expect(nodeConcurrencyGate.stats(key).active).toBe(0)
  })

  it("FIFO order: earliest waiter resumes first", async () => {
    const key = nodeKey("wf-test-fifo", "node-fifo")
    await nodeConcurrencyGate.acquire(key, 1)

    const order: string[] = []
    const a = nodeConcurrencyGate.acquire(key, 1).then(() => order.push("a"))
    const b = nodeConcurrencyGate.acquire(key, 1).then(() => order.push("b"))
    const c = nodeConcurrencyGate.acquire(key, 1).then(() => order.push("c"))

    nodeConcurrencyGate.release(key)
    await a
    nodeConcurrencyGate.release(key)
    await b
    nodeConcurrencyGate.release(key)
    await c
    nodeConcurrencyGate.release(key)
    expect(order).toEqual(["a", "b", "c"])
  })

  it("different keys are independent", async () => {
    const k1 = nodeKey("wf-test-iso", "node-x")
    const k2 = nodeKey("wf-test-iso", "node-y")
    await nodeConcurrencyGate.acquire(k1, 1)
    await nodeConcurrencyGate.acquire(k2, 1)
    expect(nodeConcurrencyGate.stats(k1).active).toBe(1)
    expect(nodeConcurrencyGate.stats(k2).active).toBe(1)
    nodeConcurrencyGate.release(k1)
    nodeConcurrencyGate.release(k2)
  })

  it("release on an over-released key never goes negative", () => {
    const key = nodeKey("wf-test-neg", "node-neg")
    nodeConcurrencyGate.release(key)
    nodeConcurrencyGate.release(key)
    expect(nodeConcurrencyGate.stats(key).active).toBe(0)
  })
})
