import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DelegationManager, type DelegationDeps, type CallerTurn, type InjectedTurn } from "../src/a2a/delegation"

// A person on a chat channel asked "front"; front delegates to "worker".
const HUMAN_TURN: CallerTurn = {
  agentId: "front",
  taskId: "run-1",
  context: { channel: "telegram", chatId: "chat-1", sender: "Sam", conversationHistory: [{ role: "user", content: "old" }] },
}
const CRON_TURN: CallerTurn = { agentId: "front", taskId: "run-2", context: { channel: "cron", chatId: "daily", sender: "cron:daily" } }
const DELEGATED_TURN: CallerTurn = {
  agentId: "middle",
  taskId: "run-3",
  context: { channel: "a2a", chatId: "a2a:front:middle:x", sender: "agent:front", initiator: { kind: "human", channel: "telegram", chatId: "chat-1" } },
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function harness(over: Partial<DelegationDeps> = {}) {
  const local = deferred<{ content: string; error?: string }>()
  const peer = deferred<string>()
  const injected: InjectedTurn[] = []
  const delivered: Array<{ channel: string; chatId: string; text: string; agentId: string; record: boolean }> = []
  const logs: string[] = []
  const calls = { runLocal: [] as any[], runPeer: [] as any[], cancel: [] as string[] }
  const deps: DelegationDeps = {
    timeoutMs: 60_000,
    pollMs: 1,
    runLocal: (callee, message, context, opts) => {
      calls.runLocal.push({ callee, message, context, opts })
      opts.onStart("callee-run-1")
      return local.promise
    },
    runPeer: (p, callee, message, context, opts) => {
      calls.runPeer.push({ peer: p, callee, message, context, opts })
      return peer.promise
    },
    cancelLocal: (runId) => { calls.cancel.push(runId) },
    injectTurn: async (turn) => { injected.push(turn); return { content: `summary for ${turn.agentId}` } },
    isChatBusy: () => false,
    canDeliver: (channel) => channel === "telegram",
    deliver: async (msg) => { delivered.push(msg) },
    log: (m) => logs.push(m),
    ...over,
  }
  const mgr = new DelegationManager(deps)
  return { mgr, local, peer, injected, delivered, logs, calls }
}

/** Let queued promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 5))

afterEach(() => { vi.useRealTimers() })

describe("when a delegation calls back", () => {
  it("goes async for a turn a person started, when the reply can reach them", () => {
    const { mgr } = harness()
    expect(mgr.shouldCallback(HUMAN_TURN)).toBe(true)
    expect(mgr.shouldCallback({ ...HUMAN_TURN, context: { channel: "app", chatId: "p1" } })).toBe(false) // no route to "app" here
  })

  it("keeps cron, delegated and unnamed callers synchronous", () => {
    const { mgr } = harness()
    expect(mgr.shouldCallback(CRON_TURN)).toBe(false)
    expect(mgr.shouldCallback(DELEGATED_TURN)).toBe(false)
    expect(mgr.shouldCallback(null)).toBe(false)
    expect(mgr.shouldCallback(null, true)).toBe(false)
  })

  it("honours an explicit async flag either way", () => {
    const { mgr } = harness()
    expect(mgr.shouldCallback(CRON_TURN, true)).toBe(true)
    expect(mgr.shouldCallback(HUMAN_TURN, false)).toBe(false)
  })

  it("can be switched off for person-started turns", () => {
    const { mgr } = harness({ asyncWhenHuman: false })
    expect(mgr.shouldCallback(HUMAN_TURN)).toBe(false)
    expect(mgr.shouldCallback(HUMAN_TURN, true)).toBe(true)
  })
})

describe("human-initiated delegation to a local agent", () => {
  it("returns at once, then the answer comes back as a new turn in the caller's chat", async () => {
    const h = harness()
    const { taskId } = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Check the build" })

    // Returned before the callee finished.
    expect(taskId).toMatch(/^dlg-/)
    expect(h.mgr.isPending(taskId)).toBe(true)
    expect(h.injected).toHaveLength(0)

    // The callee runs with the a2a context and the person as the root.
    const run = h.calls.runLocal[0]
    expect(run.callee).toBe("worker")
    expect(run.context).toMatchObject({
      channel: "a2a",
      sender: "agent:front",
      initiator: { kind: "human", channel: "telegram", chatId: "chat-1", agentId: "front" },
    })

    h.local.resolve({ content: "Build is green." })
    await flush()

    expect(h.injected).toHaveLength(1)
    const turn = h.injected[0]
    expect(turn.agentId).toBe("front")
    expect(turn.context).toMatchObject({
      channel: "telegram",
      chatId: "chat-1",
      sender: "agent:worker",
      delegation: { taskId, from: "worker", status: "done" },
    })
    // Bulky one-off context stays behind.
    expect(turn.context.conversationHistory).toBeUndefined()
    expect(turn.message).toContain(`task=${taskId}`)
    expect(turn.message).toContain("Check the build")
    expect(turn.message).toContain("Build is green.")

    // The caller's own reply goes to the person; the registry already put
    // it in the session.
    expect(h.delivered).toEqual([{ channel: "telegram", chatId: "chat-1", text: "summary for front", agentId: "front", accountId: undefined, record: false }])
    expect(h.mgr.isPending(taskId)).toBe(false)
  })

  it("waits for the caller's chat to be free before calling back", async () => {
    let busy = 3
    const h = harness({ isChatBusy: () => busy-- > 0 })
    h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    h.local.resolve({ content: "done" })
    await flush()
    await flush()
    expect(busy).toBeLessThan(0)
    expect(h.injected).toHaveLength(1)
  })

  it("runs two callbacks for the same chat one after the other", async () => {
    const order: string[] = []
    let running = 0
    let overlap = false
    const h = harness({
      injectTurn: async (turn) => {
        running++
        if (running > 1) overlap = true
        await new Promise((r) => setTimeout(r, 5))
        order.push((turn.context.delegation as any).taskId)
        running--
        return { content: "ok" }
      },
    })
    const a = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "a" })
    const b = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "b" })
    await Promise.all([h.mgr.complete(a.taskId, { status: "done", text: "A" }), h.mgr.complete(b.taskId, { status: "done", text: "B" })])
    expect(overlap).toBe(false)
    expect(order).toEqual([a.taskId, b.taskId])
  })
})

describe("human-initiated delegation to a mesh peer", () => {
  it("holds the peer call in the background and calls back the same way", async () => {
    const h = harness()
    const { taskId } = h.mgr.start({ caller: HUMAN_TURN, callee: "builder", peer: "vps", message: "Fix CI" })
    expect(h.calls.runLocal).toHaveLength(0)
    const call = h.calls.runPeer[0]
    expect(call).toMatchObject({ peer: "vps", callee: "builder", message: "Fix CI", opts: { senderAgentId: "front", timeoutMs: 60_000 } })
    // The root travels with the context to the peer.
    expect(call.context.initiator).toMatchObject({ kind: "human", channel: "telegram" })

    h.peer.resolve("CI fixed in MR 12.")
    await flush()
    expect(h.injected[0].message).toContain("builder on vps")
    expect(h.injected[0].message).toContain("CI fixed in MR 12.")
    expect(h.injected[0].context.delegation).toMatchObject({ taskId, from: "builder", peer: "vps", status: "done" })
    expect(h.delivered[0].text).toBe("summary for front")
  })

  it("keeps the caller's own context fields for the callee when given", () => {
    const h = harness()
    h.mgr.start({ caller: HUMAN_TURN, callee: "builder", peer: "vps", message: "x", calleeContext: { channel: "mcp", chatId: "mcp:front:builder:1", initiator: { kind: "agent", channel: "cron" } } })
    const ctx = h.calls.runPeer[0].context
    expect(ctx.channel).toBe("mcp")
    expect(ctx.chatId).toBe("mcp:front:builder:1")
    // A caller cannot claim a different root.
    expect(ctx.initiator.kind).toBe("human")
  })
})

describe("errors, timeouts and duplicates", () => {
  it("reports a callee error back to the caller", async () => {
    const h = harness()
    h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    h.local.resolve({ content: "", error: "worker is not signed in" })
    await flush()
    expect(h.injected[0].message).toContain("status=error")
    expect(h.injected[0].message).toContain("worker is not signed in")
    expect(h.injected[0].context.delegation).toMatchObject({ status: "error" })
  })

  it("reports a peer that throws", async () => {
    const h = harness()
    h.mgr.start({ caller: HUMAN_TURN, callee: "builder", peer: "vps", message: "x" })
    h.peer.reject(new Error('Peer "vps" is not healthy'))
    await flush()
    expect(h.injected[0].message).toContain("status=error")
    expect(h.injected[0].message).toContain("not healthy")
  })

  it("sends the plain result when the caller cannot write a reply", async () => {
    const h = harness({ injectTurn: async () => ({ content: "", error: "caller overloaded" }) })
    h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    h.local.resolve({ content: "Build is green." })
    await flush()
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].text).toContain("worker finished")
    expect(h.delivered[0].text).toContain("Build is green.")
    // Not produced by a turn, so it is added to the session.
    expect(h.delivered[0].record).toBe(true)
  })

  it("leaves delivery to the registry queue when the callback was queued", async () => {
    const h = harness({ injectTurn: async () => ({ content: "", error: "__queued__:collect:1" }) })
    h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    h.local.resolve({ content: "ok" })
    await flush()
    expect(h.delivered).toHaveLength(0)
  })

  it("times out, stops the local run, and drops the late answer", async () => {
    vi.useFakeTimers()
    const h = harness({ timeoutMs: 1000 })
    const { taskId } = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    await vi.advanceTimersByTimeAsync(1001)
    expect(h.calls.cancel).toEqual(["callee-run-1"])
    expect(h.injected).toHaveLength(1)
    expect(h.injected[0].message).toContain("status=timeout")

    // The callee answers after all: suppressed by task id.
    h.local.resolve({ content: "late" })
    await vi.advanceTimersByTimeAsync(10)
    expect(h.injected).toHaveLength(1)
    expect(h.logs.some((l) => l.includes(taskId) && l.includes("duplicate"))).toBe(true)
  })

  it("suppresses a duplicate completion for the same task id", async () => {
    const h = harness()
    const { taskId } = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    expect(await h.mgr.complete(taskId, { status: "done", text: "first" })).toBe(true)
    expect(await h.mgr.complete(taskId, { status: "done", text: "second" })).toBe(false)
    expect(await h.mgr.complete("dlg-unknown", { status: "done", text: "?" })).toBe(false)
    expect(h.injected).toHaveLength(1)
    expect(h.injected[0].message).toContain("first")
  })

  it("does not send anywhere when the chat has no route", async () => {
    const h = harness()
    h.mgr.start({ caller: CRON_TURN, callee: "worker", message: "x" })
    h.local.resolve({ content: "ok" })
    await flush()
    expect(h.injected).toHaveLength(1)
    expect(h.injected[0].context.channel).toBe("cron")
    expect(h.delivered).toHaveLength(0)
  })
})

describe("after a restart", () => {
  it("reports delegations that never finished as lost, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-dlg-"))
    try {
      const logPath = join(dir, "delegations.jsonl")
      const before = harness({ logPath })
      const { taskId } = before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Long job" })
      const finished = before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Short job" })
      await before.mgr.complete(finished.taskId, { status: "done", text: "ok" })
      before.mgr.stop()

      // New process, same log.
      const after = harness({ logPath })
      expect(after.mgr.isPending(taskId)).toBe(true)
      expect(after.mgr.isPending(finished.taskId)).toBe(false)
      expect(await after.mgr.recover()).toBe(1)
      expect(after.injected).toHaveLength(1)
      expect(after.injected[0].message).toContain("status=lost")
      expect(after.injected[0].message).toContain("Long job")
      expect(after.delivered[0]).toMatchObject({ channel: "telegram", chatId: "chat-1", agentId: "front" })

      // The old run's answer, or a second recovery, changes nothing.
      expect(await after.mgr.complete(taskId, { status: "done", text: "late" })).toBe(false)
      const again = harness({ logPath })
      expect(await again.mgr.recover()).toBe(0)
      expect(readFileSync(logPath, "utf-8")).not.toContain('"type":"start"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
