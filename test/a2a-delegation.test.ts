import { describe, it, expect, vi, afterEach, onTestFinished } from "vitest"
import Database from "better-sqlite3"
import { readSignals, setSignalDb } from "../src/improve/signals"
import { mkdtempSync, rmSync, appendFileSync, existsSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DelegationManager, buildCallbackMessage, fallbackReply, resultOfRun, repeatsWritten, MAX_SEND_DEPTH, DELEGATION_RESULT_MARKER, callbackDepthOf, contextWithSendDepth, delegationIdOfChat, isDelegationRelay, stoppedByRestart, type DelegationDeps, type CallerTurn, type InjectedTurn } from "../src/a2a/delegation"
import { HandoffStore, importDelegationLog } from "../src/a2a/handoff-store"

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

// The turn a callback runs as: the person's chat, marked as a callback.
const CALLBACK_TURN: CallerTurn = {
  agentId: "front",
  taskId: "run-4",
  context: { channel: "telegram", chatId: "chat-1", sender: "agent:worker", delegation: { taskId: "dlg-1", from: "worker", status: "done" } },
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function harness(over: Partial<DelegationDeps> = {}) {
  const local = deferred<import("../src/a2a/delegation").CalleeRun>()
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

/** One node's hand-off journal (#1861): the jobs database. `journal()` is
 *  what one daemon process gets at start, as createDelegations builds it:
 *  a leftover old file (`logPath`) is imported once, then renamed (#1961).
 *  A new process on the same database is a restart. */
function node() {
  const dir = mkdtempSync(join(tmpdir(), "agentx-dlg-"))
  const db = new Database(":memory:")
  onTestFinished(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const logPath = join(dir, "delegations.jsonl")
  const journal = () => {
    const store = new HandoffStore(db)
    importDelegationLog(store, logPath, () => {})
    return { store }
  }
  /** Nothing is written where the old file was, nor beside it. */
  const noFile = () => !existsSync(logPath) && !existsSync(`${logPath}.imported`)
  return { db, logPath, noFile, store: () => new HandoffStore(db), journal }
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

  it("never goes async inside a delegation, even when asked to", () => {
    const { mgr } = harness()
    expect(mgr.shouldCallback(CALLBACK_TURN, true)).toBe(false)
    expect(mgr.shouldCallback(DELEGATED_TURN, true)).toBe(false)
    expect(mgr.shouldCallback(CALLBACK_TURN)).toBe(false)
  })

  it("does not let a callback turn start another callback", async () => {
    const h = harness()
    h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    h.local.resolve({ content: "done" })
    await flush()
    // The caller, in its callback turn, asks again with async:true.
    const callbackTurn: CallerTurn = { agentId: "front", taskId: "run-9", context: h.injected[0].context }
    expect(h.mgr.shouldCallback(callbackTurn, true)).toBe(false)
    expect(h.mgr.shouldCallback(callbackTurn)).toBe(false)
  })

  it("honours an explicit async flag either way", () => {
    const { mgr } = harness()
    expect(mgr.shouldCallback(CRON_TURN, true)).toBe(true)
    expect(mgr.shouldCallback(HUMAN_TURN, false)).toBe(false)
  })

  it("keeps delegated hops and callback turns synchronous even with async:true", () => {
    const { mgr } = harness()
    const CALLBACK_TURN: CallerTurn = {
      agentId: "front",
      taskId: "run-4",
      context: { channel: "telegram", chatId: "chat-1", sender: "agent:worker", delegation: { taskId: "dlg-1", from: "worker", status: "done" } },
    }
    expect(mgr.shouldCallback(CALLBACK_TURN, true)).toBe(false)
    expect(mgr.shouldCallback(DELEGATED_TURN, true)).toBe(false)
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
    expect(h.delivered).toEqual([{ channel: "telegram", chatId: "chat-1", text: "summary for front", agentId: "front", accountId: undefined, record: false, taskId, outcome: "done", countsAsReply: true }])
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
    const first = h.mgr.complete(a.taskId, { status: "done", text: "A" })
    await new Promise((r) => setTimeout(r, 1))
    // B comes back while A's callback turn is running: it gets the next one.
    await Promise.all([first, h.mgr.complete(b.taskId, { status: "done", text: "B" })])
    expect(overlap).toBe(false)
    expect(order).toEqual([a.taskId, b.taskId])
  })
})

describe("answers for one chat come back as one turn (#1749)", () => {
  function many(over: Partial<DelegationDeps> = {}) {
    const runs: Array<{ resolve: (v: { content: string; error?: string }) => void }> = []
    const calls: any[] = []
    const h = harness({
      runLocal: (callee, message, context, opts) => {
        calls.push({ callee, message, context, opts })
        opts.onStart(`run-${calls.length}`)
        const d = deferred<{ content: string; error?: string }>()
        runs.push(d)
        return d.promise
      },
      ...over,
    })
    return { h, runs, calls }
  }

  it("joins answers that are in before the callback starts", async () => {
    const h = harness()
    const a = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Check the build" })
    const b = h.mgr.start({ caller: HUMAN_TURN, callee: "tester", message: "Run the tests" })
    await Promise.all([h.mgr.complete(a.taskId, { status: "done", text: "Build green." }), h.mgr.complete(b.taskId, { status: "error", text: "2 failed" })])
    expect(h.injected).toHaveLength(1)
    const turn = h.injected[0]
    expect(isDelegationRelay(turn.message)).toBe(true)
    expect(turn.message).toContain("Build green.")
    expect(turn.message).toContain("2 failed")
    expect(turn.message).toContain("2 pieces of work you handed out came back together")
    expect(turn.context.delegation).toMatchObject({ taskId: a.taskId, taskIds: [a.taskId, b.taskId] })
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toMatchObject({ taskId: b.taskId, outcome: "done" })
  })

  it("waits for the other delegations from the same chat, up to coalesceMs", async () => {
    const { h, runs } = many({ coalesceMs: 10_000 })
    h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "one" })
    h.mgr.start({ caller: HUMAN_TURN, callee: "tester", message: "two" })
    runs[0].resolve({ content: "first" })
    await flush()
    expect(h.injected).toHaveLength(0)
    runs[1].resolve({ content: "second" })
    await flush()
    await flush()
    expect(h.injected).toHaveLength(1)
    expect(h.injected[0].message).toContain("first")
    expect(h.injected[0].message).toContain("second")
  })

  it("does not wait past coalesceMs for a delegation still running", async () => {
    let now = 1_000_000
    const { h, runs } = many({ coalesceMs: 50, now: () => now })
    h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "quick" })
    h.mgr.start({ caller: HUMAN_TURN, callee: "tester", message: "slow" })
    runs[0].resolve({ content: "quick answer" })
    await flush()
    expect(h.injected).toHaveLength(0)
    now += 100
    await flush()
    expect(h.injected).toHaveLength(1)
    expect(h.injected[0].message).toContain("quick answer")
  })

  it("does not wait for delegations from another chat or another kind", async () => {
    const { h, runs } = many({ coalesceMs: 10_000 })
    h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "mine" })
    h.mgr.start({ caller: { ...HUMAN_TURN, context: { ...HUMAN_TURN.context, chatId: "chat-2" } }, callee: "tester", message: "other chat" })
    runs[0].resolve({ content: "done here" })
    await flush()
    expect(h.injected).toHaveLength(1)
  })

  it("holds each answer of a joined turn a restart stopped", async () => {
    const n = node()
    const STOPPED = { content: "", error: "stopped mid-turn (registry-stop)" }
    const h = harness({ ...n.journal(), injectTurn: async () => STOPPED })
    const a = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "a" })
    const b = h.mgr.start({ caller: HUMAN_TURN, callee: "tester", message: "b" })
    await Promise.all([h.mgr.complete(a.taskId, { status: "done", text: "A" }), h.mgr.complete(b.taskId, { status: "done", text: "B" })])
    expect(n.store().held().map((r) => [r.record.id, r.attempt]).sort()).toEqual([[a.taskId, 1], [b.taskId, 1]].sort())
    // In the table only: no file is written (#1961).
    expect(n.noFile()).toBe(true)
  })

  it("carries the root, so work handed on from the callback keeps it", async () => {
    const h = harness()
    const a = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    await h.mgr.complete(a.taskId, { status: "done", text: "ok" })
    const callbackTurn: CallerTurn = { agentId: "front", taskId: "run-7", context: h.injected[0].context }
    // A send from the callback turn: its callee runs under the person's root.
    h.mgr.start({ caller: callbackTurn, callee: "tester", message: "follow up", kind: "send" })
    expect(h.calls.runLocal[1].context.initiator).toMatchObject({ kind: "human", channel: "telegram", chatId: "chat-1" })
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
    expect(h.delivered[0].outcome).toBe("done")
  })

  it("marks the plain report of a failed delegation as an error", async () => {
    const h = harness({ injectTurn: async () => ({ content: "", error: "caller overloaded" }) })
    h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    h.local.resolve({ content: "", error: "worker is not signed in" })
    await flush()
    expect(h.delivered[0]).toMatchObject({ outcome: "error", record: true })
    expect(h.delivered[0].text).toContain("did not complete")
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

describe("the log", () => {
  it("writes no file, and a new process still suppresses old ids from the table (#1961)", async () => {
    const n = node()
    const h = harness({ ...n.journal(), injectTurn: async () => ({ content: "", error: "stopped mid-turn (registry-stop)" }) })
    const a = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "a" })
    await h.mgr.complete(a.taskId, { status: "timeout", text: "slow" })
    for (let i = 0; i < 20; i++) {
      const t = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: `m${i}` })
      await h.mgr.complete(t.taskId, { status: i % 2 ? "error" : "done", text: "x" })
    }
    // Starts, ends and held callbacks: none of it reaches a file.
    expect(n.store().held().length).toBeGreaterThan(0)
    expect(n.noFile()).toBe(true)

    const again = harness(n.journal())
    expect(await again.mgr.complete(a.taskId, { status: "done", text: "late" })).toBe(false)
    expect(again.logs.some((l) => l.includes(a.taskId) && l.includes("duplicate"))).toBe(true)
    expect(n.store().statusOf(a.taskId)).toBe("timeout")
  })

  it("suppresses a duplicate for as long as the row is kept, not only the last 2,000 ids", async () => {
    const n = node()
    const s = n.store()
    s.insert({ id: "dlg-old", caller: "front", callee: "worker", request: "x", origin: { channel: "telegram", chatId: "chat-1" }, root: { kind: "human" } as any, startedAt: 1 }, 1)
    s.end("dlg-old", "done", 2)
    const h = harness(n.journal())
    expect(await h.mgr.complete("dlg-old", { status: "done", text: "late" })).toBe(false)
    expect(h.logs.join("\n")).toContain("[delegation dlg-old] duplicate done suppressed")
    expect(await h.mgr.complete("dlg-never", { status: "done", text: "?" })).toBe(false)
    expect(h.logs.join("\n")).toContain("for an unknown task ignored")
  })
})

describe("after a restart", () => {
  it("reports delegations that never finished as lost, once", async () => {
    const n = node()
    const logPath = n.logPath
    {
      const before = harness(n.journal())
      const { taskId } = before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Long job" })
      const finished = before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Short job" })
      await before.mgr.complete(finished.taskId, { status: "done", text: "ok" })
      before.mgr.stop()

      // New process, same database.
      const after = harness(n.journal())
      expect(after.mgr.isPending(taskId)).toBe(true)
      expect(after.mgr.isPending(finished.taskId)).toBe(false)
      expect(await after.mgr.recover()).toBe(1)
      expect(after.injected).toHaveLength(1)
      expect(after.injected[0].message).toContain("status=lost")
      expect(after.injected[0].message).toContain("Long job")
      expect(after.delivered[0]).toMatchObject({ channel: "telegram", chatId: "chat-1", agentId: "front" })

      // The old run's answer, or a second recovery, changes nothing.
      expect(await after.mgr.complete(taskId, { status: "done", text: "late" })).toBe(false)
      const again = harness(n.journal())
      expect(await again.mgr.recover()).toBe(0)
      expect(existsSync(logPath)).toBe(false)
      expect(n.store().statusOf(taskId)).toBe("lost")
    }
  })

  it("keeps the answer's way home across the restart", async () => {
    const n = node()
    const before = harness(n.journal())
    const turn: CallerTurn = { agentId: "front", context: { channel: "telegram", chatId: "chat-9", accountId: "acct-2", channelMeta: { thread: 4 }, sender: "Sam" } }
    before.mgr.start({ caller: turn, callee: "builder", peer: "vps", message: "Long job" })
    before.mgr.stop()
    const after = harness(n.journal())
    await after.mgr.recover()
    expect(after.injected[0].context).toMatchObject({ channel: "telegram", chatId: "chat-9", accountId: "acct-2", channelMeta: { thread: 4 } })
    expect(after.injected[0].message).toContain("builder on vps")
    expect(after.delivered[0]).toMatchObject({ channel: "telegram", chatId: "chat-9", accountId: "acct-2", agentId: "front" })
  })

  it("reports each lost hand-off once when two processes share one database", async () => {
    const n = node()
    const before = harness(n.journal())
    before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Long job" })
    before.mgr.stop()
    const one = harness(n.journal())
    const two = harness(n.journal())
    await Promise.all([one.mgr.recover(), two.mgr.recover()])
    expect(one.injected.length + two.injected.length).toBe(1)
    expect(one.delivered.length + two.delivered.length).toBe(1)
  })

  it("keeps hand-offs in memory only on a node with no database, and writes no file", async () => {
    const n = node()
    const before = harness()
    before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Long job" })
    before.mgr.stop()
    expect(n.noFile()).toBe(true)
    const after = harness()
    expect(await after.mgr.recover()).toBe(0)
    expect(after.injected).toHaveLength(0)
  })

  it("imports a leftover old file at start, once, by id, then renames it", async () => {
    const n = node()
    // A file only an older daemon wrote: one hand-off still out.
    appendFileSync(n.logPath, JSON.stringify({ type: "start", ts: 1, id: "dlg-file", caller: "front", callee: "worker", request: "From the file", origin: { channel: "telegram", chatId: "chat-1" }, root: { kind: "human", channel: "telegram", chatId: "chat-1" }, startedAt: 1 }) + "\n")
    const after = harness(n.journal())
    expect(after.mgr.isPending("dlg-file")).toBe(true)
    // Imported once, then renamed: never read again (#1961).
    expect(existsSync(n.logPath)).toBe(false)
    expect(existsSync(`${n.logPath}.imported`)).toBe(true)
    await after.mgr.recover()
    expect(after.injected).toHaveLength(1)
    expect(after.injected[0].message).toContain("From the file")
    // The next start reads the table alone: it stays ended.
    const again = harness(n.journal())
    expect(await again.mgr.recover()).toBe(0)
    expect(n.store().statusOf("dlg-file")).toBe("lost")
  })
})

describe("review fixes on #1962", () => {
  const STOPPED = { content: "", error: "stopped mid-turn (registry-stop)" }

  it("HIGH 1: a held reply leaves its hand-off out, so a restart reports it lost", async () => {
    const n = node()
    const before = harness({ ...n.journal(), injectTurn: async (turn) => { before.injected.push(turn); return STOPPED } })
    const { taskId, record } = before.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "x", kind: "send" })
    before.mgr.relayReply(record, "Halfway there.")
    await flush()
    before.mgr.stop()
    const after = harness(n.journal())
    expect(after.mgr.isPending(taskId)).toBe(true)
    expect(await after.mgr.recover()).toBe(1)
    expect(after.injected.some((t) => t.message.includes("status=lost"))).toBe(true)
  })

  it("HIGH 1: the real end after a held reply still ends it and tells listeners", async () => {
    const n = node()
    const done: string[] = []
    const h = harness({ ...n.journal(), injectTurn: async (turn) => { h.injected.push(turn); return STOPPED }, onDone: (rec, r) => { done.push(`${rec.id}:${r.status}`) } })
    const { taskId, record } = h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "x", kind: "send" })
    h.mgr.relayReply(record, "Halfway there.")
    await flush()
    expect(await h.mgr.complete(taskId, { status: "done", text: "All tests pass and the branch is pushed." })).toBe(true)
    expect(done).toEqual([`${taskId}:done`])
    expect(h.logs.join("\n")).not.toContain("another process ended it already")
  })

  it("HIGH 2: an answer an older daemon passed on, then compacted away, is not passed on again", async () => {
    const n = node()
    const before = harness({ ...n.journal(), injectTurn: async (turn) => { before.injected.push(turn); return STOPPED } })
    const { taskId } = before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Find the report" })
    before.local.resolve({ content: "Here is the report" })
    await flush()
    before.mgr.stop()
    expect(n.store().held()).toHaveLength(1)
    // The older daemon re-ran and delivered it, then compacted its file:
    // only the done id is left, rewritten with the compaction's time.
    writeFileSync(n.logPath, JSON.stringify({ type: "done", id: taskId, status: "done", ts: Date.now() + 1000 }) + "\n")
    const back = harness(n.journal())
    await back.mgr.recover()
    expect(back.injected).toHaveLength(0)
    expect(back.delivered).toHaveLength(0)
    expect(existsSync(`${n.logPath}.imported`)).toBe(true)
  })

  it("an answer pending its callback is not re-run when re-runs are turned off", async () => {
    const n = node()
    let over = false
    onTestFinished(() => { over = true })
    const before = harness({ ...n.journal(), isChatBusy: () => !over, busyWaitMs: 60_000, pollMs: 5 })
    before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    before.local.resolve({ content: "answer" })
    await flush()
    before.mgr.stop()
    const after = harness({ ...n.journal(), requeueRelayOnRestart: false })
    await after.mgr.recover()
    expect(after.injected).toHaveLength(0)
    expect(n.noFile()).toBe(true)
    expect(n.store().held()).toEqual([])
  })

  it("keeps the 'already wrote' wording on a callback a restart stopped", async () => {
    const n = node()
    let calls = 0
    const before = harness({ ...n.journal(), injectTurn: async (turn) => { before.injected.push(turn); return ++calls === 1 ? { content: "ok" } : STOPPED } })
    const { taskId, record } = before.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "x", kind: "send" })
    before.mgr.relayReply(record, "On it.")
    await flush()
    await before.mgr.complete(taskId, { status: "done", text: "All tests pass and the branch is pushed." })
    before.mgr.stop()
    const after = harness(n.journal())
    await after.mgr.recover()
    expect(after.injected).toHaveLength(1)
    expect(after.injected[0].message).toContain("already wrote to you")
  })

  it("says whether hand-offs survive a restart", () => {
    expect(harness(node().journal()).mgr.journalMode()).toBe("database")
    expect(harness().mgr.journalMode()).toBe("memory-only")
  })
})

describe("rollback to a daemon from before the table (#1861)", () => {
  it("merges what the older daemon wrote when the new one comes back", async () => {
    const n = node()
    const first = harness(n.journal())
    const out = first.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "still out" })
    first.mgr.stop()
    // The older daemon: reports it lost, and starts one of its own.
    appendFileSync(n.logPath, [
      JSON.stringify({ type: "done", id: out.taskId, status: "lost", ts: Date.now() }),
      JSON.stringify({ type: "start", ts: Date.now(), id: "dlg-old-daemon", caller: "front", callee: "pm", request: "from the old one", origin: { channel: "telegram", chatId: "chat-1" }, root: { kind: "human", channel: "telegram", chatId: "chat-1" }, startedAt: Date.now() }),
    ].join("\n") + "\n")
    const back = harness(n.journal())
    expect(back.mgr.isPending(out.taskId)).toBe(false)
    expect(back.mgr.isPending("dlg-old-daemon")).toBe(true)
    expect(existsSync(n.logPath)).toBe(false)
    expect(await back.mgr.recover()).toBe(1)
    expect(back.injected[0].message).toContain("from the old one")
  })
})

describe("an answer back whose callback had not started (#1861)", () => {
  /** The caller's chat stays busy until the test ends: the callback turn
   *  of this process never starts (the restart comes first). */
  function busyChat(): Partial<DelegationDeps> {
    let over = false
    onTestFinished(() => { over = true })
    return { isChatBusy: () => !over, busyWaitMs: 60_000, pollMs: 5 }
  }

  it("is re-run once after a restart", async () => {
    const n = node()
    const before = harness({ ...n.journal(), ...busyChat() })
    const { taskId } = before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Find the report" })
    before.local.resolve({ content: "Here is the report" })
    await flush()
    expect(before.injected).toHaveLength(0)
    before.mgr.stop()
    expect(n.store().held()).toEqual([expect.objectContaining({ attempt: 1, pending: true })])
    expect(n.noFile()).toBe(true)

    const after = harness(n.journal())
    await after.mgr.recover()
    expect(after.injected).toHaveLength(1)
    expect(after.injected[0].message).toContain(`task=${taskId}`)
    expect(after.injected[0].message).toContain("Here is the report")
    expect(after.delivered).toEqual([expect.objectContaining({ channel: "telegram", chatId: "chat-1", text: "summary for front" })])

    const again = harness(n.journal())
    await again.mgr.recover()
    expect(again.injected).toHaveLength(0)
  })

  it("is not re-run once its callback turn started", async () => {
    const n = node()
    const before = harness(n.journal())
    before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    before.local.resolve({ content: "done" })
    await flush()
    expect(before.injected).toHaveLength(1)
    expect(n.store().held()).toEqual([])
    const after = harness(n.journal())
    await after.mgr.recover()
    expect(after.injected).toHaveLength(0)
  })

  it("keeps the 'already wrote' wording on its re-run", async () => {
    const n = node()
    const before = harness({ ...n.journal(), ...busyChat() })
    const { record } = before.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "x", kind: "send" })
    before.mgr.relayReply(record, "On it.")
    before.local.resolve({ content: "All the tests pass and the branch is pushed." })
    await flush()
    before.mgr.stop()
    const after = harness(n.journal())
    await after.mgr.recover()
    const end = after.injected.find((t) => t.message.includes("status=done"))
    expect(end?.message).toContain("already wrote to you")
  })
})

describe("a callback turn stopped by a restart (#846)", () => {
  const STOPPED = { content: "", error: "Claude Code was stopped mid-turn (registry-stop), before its time limit" }

  /** `journal()` is one daemon process on the node's database. */
  type Journal = () => { store: HandoffStore }
  function withLog<T>(fn: (journal: Journal, n: ReturnType<typeof node>) => Promise<T>): Promise<T> {
    const n = node()
    return fn(n.journal, n)
  }

  /** Before the restart: the callee answers, the callback turn is stopped. */
  async function stoppedRelay(journal: Journal, over: Partial<DelegationDeps> = {}) {
    const before = harness({ ...journal(), injectTurn: async (turn) => { before.injected.push(turn); return STOPPED }, ...over })
    const { taskId } = before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Find the report" })
    before.local.resolve({ content: "Here is the report" })
    await flush()
    before.mgr.stop()
    return { before, taskId }
  }

  it("holds the relay and runs it once more after the restart", async () => {
    await withLog(async (journal, n) => {
      const { before, taskId } = await stoppedRelay(journal)
      expect(before.injected).toHaveLength(1)
      expect(before.injected[0].message.startsWith(DELEGATION_RESULT_MARKER)).toBe(true)
      expect(before.delivered).toHaveLength(0) // nothing sent while the channels are down

      const after = harness(journal())
      await after.mgr.recover()
      expect(after.injected).toHaveLength(1)
      expect(after.injected[0].message).toContain(`task=${taskId}`)
      expect(after.injected[0].message).toContain("Here is the report")
      expect(after.delivered).toEqual([expect.objectContaining({ channel: "telegram", chatId: "chat-1", text: "summary for front", record: false })])

      // Relayed: a later start runs nothing more.
      const again = harness(journal())
      await again.mgr.recover()
      expect(again.injected).toHaveLength(0)
      expect(again.delivered).toHaveLength(0)
    })
  })

  it("keeps the callee's stated state on a held relay (#1861)", async () => {
    await withLog(async (journal, n) => {
      const before = harness({ ...journal(), injectTurn: async (turn) => { before.injected.push(turn); return STOPPED } })
      before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Ship it" })
      before.local.resolve({ content: "Tried.", jobState: { state: "blocked", why: "no token" } })
      await flush()
      before.mgr.stop()
      expect(n.store().held()[0].result).toMatchObject({ status: "error", state: { state: "blocked", why: "no token" } })

      const after = harness(journal())
      await after.mgr.recover()
      expect(after.injected).toHaveLength(1)
      expect(after.injected[0].message).toBe(before.injected[0].message)
    })
  })

  it("sends the notice and notes the request when the re-run fails too", async () => {
    await withLog(async (journal, n) => {
      const { taskId } = await stoppedRelay(journal)
      const failed: Array<{ id: string; reason: string }> = []
      const after = harness({
        ...journal(),
        injectTurn: async (turn) => { after.injected.push(turn); return { content: "", error: "provider down" } },
        onRelayFailed: (rec, _result, reason) => { failed.push({ id: rec.id, reason }) },
      })
      await after.mgr.recover()
      expect(after.injected).toHaveLength(1)
      expect(failed).toEqual([{ id: taskId, reason: expect.stringContaining("provider down") }])
      expect(after.delivered).toHaveLength(1)
      expect(after.delivered[0]).toMatchObject({ channel: "telegram", chatId: "chat-1", record: true, outcome: "error", taskId })
      expect(after.delivered[0].text).toContain(taskId)

      // No loop: nothing is re-run or re-sent on the next start.
      const again = harness(journal())
      await again.mgr.recover()
      expect(again.injected).toHaveLength(0)
      expect(again.delivered).toHaveLength(0)
    })
  })

  it("re-runs at most once: a re-run stopped by another restart gets the notice next time", async () => {
    await withLog(async (journal, n) => {
      const { taskId } = await stoppedRelay(journal)
      const second = harness({ ...journal(), injectTurn: async (turn) => { second.injected.push(turn); return STOPPED } })
      await second.mgr.recover()
      expect(second.injected).toHaveLength(1)
      expect(second.delivered).toHaveLength(0)

      const failed: string[] = []
      const third = harness({ ...journal(), onRelayFailed: (rec) => { failed.push(rec.id) } })
      await third.mgr.recover()
      expect(third.injected).toHaveLength(0)
      expect(failed).toEqual([taskId])
      expect(third.delivered).toEqual([expect.objectContaining({ taskId, outcome: "error", record: true })])
    })
  })

  it("does not hold a turn stopped for another reason, or with a reply", async () => {
    await withLog(async (journal, n) => {
      const { before } = await stoppedRelay(journal, {
        injectTurn: async (turn) => { before.injected.push(turn); return { content: "", error: "stopped mid-turn (turn deadline (30m))" } },
      })
      expect(before.delivered).toHaveLength(1) // the plain result, as before
      const after = harness(journal())
      await after.mgr.recover()
      expect(after.injected).toHaveLength(0)
    })
    expect(stoppedByRestart({ content: "partial answer", error: "stopped mid-turn (registry-stop)" })).toBe(false)
    expect(stoppedByRestart(STOPPED)).toBe(true)
  })

  it("can be turned off", async () => {
    await withLog(async (journal, n) => {
      await stoppedRelay(journal, { requeueRelayOnRestart: false })
      const after = harness(journal())
      await after.mgr.recover()
      expect(after.injected).toHaveLength(0)
    })
  })

  it("only treats delegation results as relays", () => {
    expect(isDelegationRelay(`${DELEGATION_RESULT_MARKER} task=dlg-1 from=worker status=done]\n...`)).toBe(true)
    expect(isDelegationRelay("What is the weather?")).toBe(false)
    expect(isDelegationRelay(null)).toBe(false)
  })
})

// #1100 — an agent's send no person waits on, from its own chat.
const AGENT_TURN: CallerTurn = {
  agentId: "planner",
  taskId: "run-9",
  context: { channel: "mcp", chatId: "mcp:lead:planner:work-1", sender: "agent:lead", initiator: { kind: "agent", channel: "cron", agentId: "lead" } },
}

describe("an agent's send calls its asker back (#1100)", () => {
  it("is allowed from an agent's turn, inside a delegation too, but not without a chat", () => {
    const h = harness()
    expect(h.mgr.shouldCallback(AGENT_TURN)).toBe(false)
    expect(h.mgr.shouldCallbackSend(AGENT_TURN)).toBe(true)
    expect(h.mgr.shouldCallbackSend(DELEGATED_TURN)).toBe(true)
    expect(h.mgr.shouldCallbackSend(null)).toBe(false)
    expect(h.mgr.shouldCallbackSend({ agentId: "x", context: { channel: "a2a" } })).toBe(false)
  })

  it("stops after MAX_SEND_DEPTH callback hops", () => {
    const h = harness()
    const deep = (depth: number): CallerTurn => ({ ...AGENT_TURN, context: { ...AGENT_TURN.context, delegation: { taskId: "dlg-x", from: "y", status: "done", depth } } })
    expect(h.mgr.shouldCallbackSend(deep(MAX_SEND_DEPTH - 1))).toBe(true)
    expect(h.mgr.shouldCallbackSend(deep(MAX_SEND_DEPTH))).toBe(false)
  })

  it("brings the answer back into the asker's own chat, one hop deeper, worded for an agent", async () => {
    const h = harness()
    const { taskId } = h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "Deploy 1.2", kind: "send", timeoutMs: 5_000 })
    h.local.resolve({ content: "Deployed, version 1.2 live." })
    await flush()
    expect(h.injected).toHaveLength(1)
    const turn = h.injected[0]
    expect(turn.agentId).toBe("planner")
    expect(turn.context).toMatchObject({ channel: "mcp", chatId: "mcp:lead:planner:work-1", delegation: { taskId, from: "builder", status: "done", depth: 1 } })
    expect(turn.message).toContain("Deployed, version 1.2 live.")
    expect(turn.message).toContain("Act on it here")
    expect(turn.message).not.toContain("Tell the person")
    // mcp has no route to a person: nothing is delivered anywhere.
    expect(h.delivered).toHaveLength(0)
  })

  it("uses its own time limit and, on a timeout, asks for resume, split or drop", async () => {
    vi.useFakeTimers()
    const h = harness({ timeoutMs: 1000 })
    h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "Long build", kind: "send", timeoutMs: 5000 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(h.injected).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(4000)
    expect(h.injected).toHaveLength(1)
    const msg = h.injected[0].message
    expect(msg).toContain("status=timeout")
    expect(msg).toMatch(/resume it .*split it .*drop it/)
  })

  it("routes the callee's own message to the asker into that chat, and does not call back twice", async () => {
    const h = harness()
    const { taskId, record } = h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "Review this", kind: "send" })
    const chatId = h.calls.runLocal[0].context.chatId
    expect(chatId).toBe(`a2a:planner:builder:${taskId}`)
    // Only the callee, from that chat, to the agent that asked.
    expect(h.mgr.replyTarget({ agentId: "builder", chatId }, "planner")).toBe(record)
    expect(h.mgr.replyTarget({ agentId: "builder", chatId }, "someone-else")).toBeNull()
    expect(h.mgr.replyTarget({ agentId: "intruder", chatId }, "planner")).toBeNull()
    expect(h.mgr.replyTarget({ agentId: "builder", chatId: "planner" }, "planner")).toBeNull()

    h.mgr.relayReply(record, "Verdict: changes needed.")
    await flush()
    expect(h.injected).toHaveLength(1)
    expect(h.injected[0].context).toMatchObject({ chatId: "mcp:lead:planner:work-1", delegation: { taskId, status: "reply" } })
    expect(h.injected[0].message).toContain("status=reply")
    expect(h.injected[0].message).toContain("Verdict: changes needed.")

    // Its end still comes back (the message may only have been progress),
    // said as such.
    h.local.resolve({ content: "Final result: approved after changes." })
    await flush()
    expect(h.injected).toHaveLength(2)
    expect(h.injected[1].message).toContain("status=done")
    expect(h.injected[1].message).toContain("already wrote to you during the work")
    expect(h.injected[1].message).toContain("Final result: approved after changes.")
  })

  it("does not call the asker back for an end that only repeats what the callee wrote", async () => {
    const sigDb = new Database(":memory:")
    setSignalDb(sigDb)
    onTestFinished(() => { setSignalDb(null); sigDb.close() })
    const h = harness()
    const { record } = h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "Deploy the fix", kind: "send" })
    h.mgr.relayReply(record, "Deployed bd4f to prod at 06:53Z. Read-back is fine, version endpoint answers 200, note posted on the issue.")
    await flush()
    expect(h.injected).toHaveLength(1)
    h.local.resolve({ content: "Done: deployed bd4f to prod at 06:53Z, read-back fine, version endpoint 200, note posted on the issue." })
    await flush()
    expect(h.injected).toHaveLength(1)
    expect(readSignals(sigDb, 0).map((r) => `${r.kind}:${r.agentId}`)).toEqual(["callback_repeat_skipped:builder"])
  })

  it("still calls back an end that fails, even after the callee wrote", async () => {
    const h = harness()
    const { record } = h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "Deploy the fix", kind: "send" })
    h.mgr.relayReply(record, "Deploying now.")
    await flush()
    h.local.resolve({ content: "", error: "Deploying now failed" })
    await flush()
    expect(h.injected).toHaveLength(2)
    expect(h.injected[1].message).toContain("status=error")
  })

  it("does not take a person-started delegation's callee message as a reply", () => {
    const h = harness()
    const { taskId } = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "x" })
    expect(h.mgr.replyTarget({ agentId: "worker", chatId: `a2a:front:worker:${taskId}` }, "front")).toBeNull()
  })

  it("never calls back into a person's chat, and never delivers to a person", async () => {
    const h = harness()
    // A callback turn in the person's chat: its sends stay plain.
    expect(h.mgr.shouldCallbackSend(CALLBACK_TURN)).toBe(false)
    expect(h.mgr.shouldCallbackSend({ agentId: "front", context: { channel: "voice", chatId: "v1", sender: "system:watcher" } })).toBe(false)
    // A send's callback reply is the asker's own work: not delivered even
    // where a route exists.
    const routed = harness({ canDeliver: () => true })
    routed.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "x", kind: "send" })
    routed.local.resolve({ content: "", error: "boom" })
    await flush()
    expect(routed.injected).toHaveLength(1)
    expect(routed.delivered).toHaveLength(0)
  })

  it("keeps a held reply worded as a reply after a restart", async () => {
    let stop = true
    const h = harness({
      injectTurn: async (turn) => {
        h.injected.push(turn)
        if (stop) { stop = false; return { content: "", error: "registry-stop" } }
        return { content: "ok" }
      },
    })
    const { record } = h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "x", kind: "send" })
    h.mgr.relayReply(record, "Halfway there.")
    await flush()
    await h.mgr.requeueRelays()
    await flush()
    expect(h.injected).toHaveLength(2)
    expect(h.injected[1].message).toContain("status=reply")
  })

  it("keeps a held reply worded as a reply across a real restart", async () => {
    const n = node()
    const before = harness({ ...n.journal(), injectTurn: async (turn) => { before.injected.push(turn); return { content: "", error: "registry-stop" } } })
    const { record } = before.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "x", kind: "send" })
    before.mgr.relayReply(record, "Halfway there.")
    await flush()
    before.mgr.stop()
    const after = harness(n.journal())
    await after.mgr.recover()
    const replies = after.injected.filter((t) => t.message.includes("status=reply"))
    expect(replies).toHaveLength(1)
    expect(replies[0].message).toContain("Halfway there.")
  })

  it("carries the hop count to the callee, so its own sends count on", () => {
    const h = harness()
    const deep: CallerTurn = { ...AGENT_TURN, context: { ...AGENT_TURN.context, delegation: { taskId: "dlg-x", from: "y", status: "done", depth: 2 } } }
    h.mgr.start({ caller: deep, callee: "builder", message: "x", kind: "send" })
    const ctx = h.calls.runLocal[0].context
    expect(ctx.sendDepth).toBe(3)
    expect(callbackDepthOf(ctx)).toBe(3)
    expect(h.mgr.shouldCallbackSend({ agentId: "builder", context: { ...ctx, sendDepth: MAX_SEND_DEPTH } })).toBe(false)
  })

  it("still calls back a failure after the callee wrote", async () => {
    const h = harness()
    const { record } = h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "x", kind: "send" })
    h.mgr.relayReply(record, "Starting now.")
    await flush()
    h.local.resolve({ content: "", error: "boom" })
    await flush()
    expect(h.injected).toHaveLength(2)
    expect(h.injected[1].message).toContain("status=error")
  })

  it("keeps the asker's chat for a delegation after it ended", async () => {
    const h = harness()
    const { taskId } = h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "x", kind: "send" })
    expect(h.mgr.originFor(taskId)).toEqual({ caller: "planner", origin: { channel: "mcp", chatId: "mcp:lead:planner:work-1" }, depth: 0 })
    h.local.resolve({ content: "ok" })
    await flush()
    expect(h.mgr.originFor(taskId)?.origin.chatId).toBe("mcp:lead:planner:work-1")
    expect(h.mgr.originFor("dlg-unknown")).toBeNull()
  })

  it("names the delegation of a callee chat", () => {
    expect(delegationIdOfChat("a2a:a:b:dlg-abc-12ef")).toBe("dlg-abc-12ef")
    expect(delegationIdOfChat("a2a:a:b")).toBeNull()
    expect(callbackDepthOf({ delegation: { depth: 2 } })).toBe(2)
    expect(callbackDepthOf({})).toBe(0)
  })

  it("keeps the asking turn's hop count for a delegation, running or ended", async () => {
    const h = harness()
    const deep: CallerTurn = { ...AGENT_TURN, context: { ...AGENT_TURN.context, delegation: { taskId: "dlg-x", from: "y", status: "done", depth: 2 } } }
    const { taskId } = h.mgr.start({ caller: deep, callee: "builder", message: "x", kind: "send" })
    expect(h.mgr.originFor(taskId)?.depth).toBe(2)
    h.local.resolve({ content: "ok" })
    await flush()
    expect(h.mgr.originFor(taskId)?.depth).toBe(2)
  })

  it("moves a peer's top-level hop count into the run's context", () => {
    expect(contextWithSendDepth({ message: "x", sendDepth: 3 })).toEqual({ sendDepth: 3 })
    expect(contextWithSendDepth({ context: { channel: "a2a", chatId: "c" }, sendDepth: 2 })).toEqual({ channel: "a2a", chatId: "c", sendDepth: 2 })
    // The larger count wins; junk is ignored.
    const ctx = { channel: "a2a", sendDepth: 4 }
    expect(contextWithSendDepth({ context: ctx, sendDepth: 1 })).toBe(ctx)
    expect(contextWithSendDepth({ sendDepth: "9" })).toBeUndefined()
  })
})

describe("one session per piece of work (#1100)", () => {
  function twoRuns(over: Partial<DelegationDeps> = {}) {
    const runs: Array<{ resolve: (v: { content: string; error?: string }) => void }> = []
    const calls: any[] = []
    const h = harness({
      runLocal: (callee, message, context, opts) => {
        calls.push({ callee, message, context, opts })
        opts.onStart(`run-${calls.length}`)
        const d = deferred<{ content: string; error?: string }>()
        runs.push(d)
        return d.promise
      },
      ...over,
    })
    return { h, runs, calls }
  }

  it("waits for the callee's run on the same home, then continues its session", async () => {
    const { h, runs, calls } = twoRuns()
    const a = h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "Draft the page", kind: "send", home: "team/site#7" })
    const b = h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "Use hero A instead", kind: "send", home: "Team/Site#7" })
    await flush()
    // The follow-up does not start beside the first one.
    expect(calls).toHaveLength(1)
    expect(calls[0].context.home).toBe("team/site#7")
    expect(b.record.home).toBe("team/site#7")
    runs[0].resolve({ content: "Draft done." })
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1].message).toBe("Use hero A instead")
    expect(calls[1].opts.resumeFrom).toEqual([{ channel: "a2a", chatId: `a2a:planner:writer:${a.taskId}` }])
    expect(h.logs.some((l) => l.includes("waits for it"))).toBe(true)
  })

  it("starts its clock only when it starts", async () => {
    vi.useFakeTimers()
    const { h, runs, calls } = twoRuns({ timeoutMs: 1000 })
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "one", home: "team/site#7", timeoutMs: 5000, kind: "send" })
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "two", home: "team/site#7", timeoutMs: 5000, kind: "send" })
    await vi.advanceTimersByTimeAsync(4000)
    runs[0].resolve({ content: "ok" })
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toHaveLength(2)
    // 4 s after the second asked, it has run for ~0 s: no timeout yet.
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.injected.filter((t) => t.message.includes("status=timeout"))).toHaveLength(0)
  })

  it("continues a recent session on the same home, not an old one or another agent's", async () => {
    let now = 1_000_000
    const { h, runs, calls } = twoRuns({ now: () => now, sameHomeMs: 60_000 })
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "one", home: "team/site#7", kind: "send" })
    runs[0].resolve({ content: "ok" })
    await flush()
    h.mgr.start({ caller: AGENT_TURN, callee: "reviewer", message: "other agent", home: "team/site#7", kind: "send" })
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "soon after", home: "team/site#7", kind: "send" })
    await flush()
    expect(calls[1].opts.resumeFrom).toBeUndefined()
    expect(calls[2].opts.resumeFrom?.[0].chatId).toContain("a2a:planner:writer:")
    runs[2].resolve({ content: "ok" })
    await flush()
    now += 120_000
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "much later", home: "team/site#7", kind: "send" })
    await flush()
    expect(calls[3].opts.resumeFrom).toBeUndefined()
  })

  it("does not wait past its own time limit for a run ahead that never settles", async () => {
    vi.useFakeTimers()
    const { h, calls } = twoRuns()
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "stuck", home: "team/site#7", kind: "send", timeoutMs: 60_000 })
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "next", home: "team/site#7", kind: "send", timeoutMs: 5_000 })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(calls).toHaveLength(2)
    expect(calls[1].message).toBe("next")
  })

  it("starts fresh, not on a session in use, when it stopped waiting for a run still going", async () => {
    vi.useFakeTimers()
    const { h, calls } = twoRuns()
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "long", home: "team/site#7", kind: "send", timeoutMs: 60_000 })
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "next", home: "team/site#7", kind: "send", timeoutMs: 5_000 })
    await vi.advanceTimersByTimeAsync(5_500)
    expect(calls).toHaveLength(2)
    expect(calls[1].opts.resumeFrom).toBeUndefined()
    expect(h.logs.some((l) => l.includes("starting a fresh session instead"))).toBe(true)
  })

  it("offers the older chats too, newest first, when a run ahead failed", async () => {
    const { h, runs, calls } = twoRuns()
    const a = h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "one", home: "team/site#7", kind: "send" })
    const b = h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "two", home: "team/site#7", kind: "send" })
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "three", home: "team/site#7", kind: "send" })
    runs[0].resolve({ content: "ok" })
    await flush()
    runs[1].resolve({ content: "", error: "refused" })
    await flush()
    expect(calls[2].opts.resumeFrom.map((c: any) => c.chatId)).toEqual([`a2a:planner:writer:${b.taskId}`, `a2a:planner:writer:${a.taskId}`])
  })

  it("runs work without a home beside a run still going from the same chat", async () => {
    const { h, calls } = twoRuns()
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "one", kind: "send" })
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "two", kind: "send" })
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1].opts.resumeFrom).toBeUndefined()
  })

  it("continues the callee's last run from the same chat for work without a home (#1749)", async () => {
    let now = 1_000_000
    const { h, runs, calls } = twoRuns({ now: () => now, sameChatMs: 60_000 })
    const a = h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "one", kind: "send" })
    runs[0].resolve({ content: "ok" })
    await flush()
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "two", kind: "send" })
    // Another chat of the same caller does not share it.
    h.mgr.start({ caller: { ...AGENT_TURN, context: { ...AGENT_TURN.context, chatId: "mcp:lead:planner:work-2" } }, callee: "writer", message: "elsewhere", kind: "send" })
    await flush()
    expect(calls[1].opts.resumeFrom).toEqual([{ channel: "a2a", chatId: `a2a:planner:writer:${a.taskId}` }])
    expect(calls[1].context.home).toBeUndefined()
    expect(calls[2].opts.resumeFrom).toBeUndefined()
    runs[1].resolve({ content: "ok" })
    await flush()
    now += 120_000
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "much later", kind: "send" })
    await flush()
    expect(calls[3].opts.resumeFrom).toBeUndefined()
  })
})

describe("topic sessions: one issue named in the message (#2010)", () => {
  const OTHER_CHAT: CallerTurn = { ...AGENT_TURN, context: { ...AGENT_TURN.context, chatId: "mcp:lead:planner:work-2" } }
  function topicRuns(over: Partial<DelegationDeps> = {}) {
    const runs: Array<{ resolve: (v: { content: string; error?: string }) => void }> = []
    const calls: any[] = []
    const h = harness({
      topicSessions: true,
      runLocal: (callee, message, context, opts) => {
        calls.push({ callee, message, context, opts })
        opts.onStart(`run-${calls.length}`)
        const d = deferred<{ content: string; error?: string }>()
        runs.push(d)
        return d.promise
      },
      ...over,
    })
    return { h, runs, calls }
  }

  it("continues the callee's last run on the same single ref from another chat, without making it a home", async () => {
    const { h, runs, calls } = topicRuns()
    const a = h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "Please review team/site!12", kind: "send" })
    runs[0].resolve({ content: "ok" })
    await flush()
    const b = h.mgr.start({ caller: OTHER_CHAT, callee: "writer", message: "Now fix the notes on Team/Site!12", kind: "send" })
    await flush()
    expect(calls[1].opts.resumeFrom).toEqual([{ channel: "a2a", chatId: `a2a:planner:writer:${a.taskId}` }])
    // Never a home: not on the record, not in the callee's context.
    expect(a.record.home).toBeUndefined()
    expect(b.record.home).toBeUndefined()
    expect(calls[1].context.home).toBeUndefined()
    expect(h.logs.some((l) => l.includes("its last run on team/site!12"))).toBe(true)
  })

  it("starts fresh on another ref, on two refs, and on another callee", async () => {
    const { h, runs, calls } = topicRuns()
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "Review team/site!12", kind: "send" })
    runs[0].resolve({ content: "ok" })
    await flush()
    h.mgr.start({ caller: OTHER_CHAT, callee: "writer", message: "Review team/site!13", kind: "send" })
    h.mgr.start({ caller: { ...AGENT_TURN, context: { ...AGENT_TURN.context, chatId: "c3" } }, callee: "writer", message: "Compare team/site!12 with team/site#4", kind: "send" })
    h.mgr.start({ caller: { ...AGENT_TURN, context: { ...AGENT_TURN.context, chatId: "c4" } }, callee: "reviewer", message: "Review team/site!12", kind: "send" })
    await flush()
    expect(calls[1].opts.resumeFrom).toBeUndefined()
    expect(calls[2].opts.resumeFrom).toBeUndefined()
    expect(calls[3].opts.resumeFrom).toBeUndefined()
  })

  it("starts fresh beside a run still going on the topic, never waits", async () => {
    const { h, calls } = topicRuns()
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "Review team/site!12", kind: "send" })
    h.mgr.start({ caller: OTHER_CHAT, callee: "writer", message: "Also check team/site!12", kind: "send" })
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1].opts.resumeFrom).toBeUndefined()
  })

  it("is warm-only: past the cache lifetime the run starts fresh", async () => {
    let now = 1_000_000
    const { h, runs, calls } = topicRuns({ now: () => now, topicWarmMs: 60_000 })
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "Review team/site!12", kind: "send" })
    runs[0].resolve({ content: "ok" })
    await flush()
    now += 120_000
    h.mgr.start({ caller: OTHER_CHAT, callee: "writer", message: "Again team/site!12", kind: "send" })
    await flush()
    expect(calls[1].opts.resumeFrom).toBeUndefined()
  })

  it("keeps the caller-chat key for a first run on a topic", async () => {
    const { h, runs, calls } = topicRuns()
    const a = h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "one", kind: "send" })
    runs[0].resolve({ content: "ok" })
    await flush()
    // First run on the topic, same caller chat: today's #1749 rule.
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "Review team/site!12", kind: "send" })
    await flush()
    expect(calls[1].opts.resumeFrom).toEqual([{ channel: "a2a", chatId: `a2a:planner:writer:${a.taskId}` }])
  })

  it("marks only a topic resume, so only it leaves a pointer to its source chat", async () => {
    const { h, runs, calls } = topicRuns()
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "Review team/site!12", kind: "send" })
    runs[0].resolve({ content: "ok" })
    await flush()
    // Same caller chat, no ref: the #1749 caller-chat resume, not a topic one.
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "and the rest", kind: "send" })
    runs[1]?.resolve({ content: "ok" })
    await flush()
    expect(calls[1].opts.resumeFrom).toHaveLength(1)
    expect(calls[1].opts.topic).toBeUndefined()
    h.mgr.start({ caller: OTHER_CHAT, callee: "writer", message: "Fix team/site!12", kind: "send" })
    await flush()
    expect(calls[2].opts.resumeFrom).toHaveLength(1)
    expect(calls[2].opts.topic).toBe(true)
  })

  it("a topic run that takes a source chat makes it busy for the caller-chat key too (A/B/C)", async () => {
    const { h, runs, calls } = topicRuns()
    // A from P1 on team/site!12 ends in chat X.
    const a = h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "Review team/site!12", kind: "send" })
    runs[0].resolve({ content: "ok" })
    await flush()
    const x = { channel: "a2a", chatId: `a2a:planner:writer:${a.taskId}` }
    // B from P2 names !12 and continues X; it is still going.
    h.mgr.start({ caller: OTHER_CHAT, callee: "writer", message: "Fix team/site!12", kind: "send" })
    await flush()
    expect(calls[1].opts.resumeFrom).toEqual([x])
    // C from P1 with no ref: P1's caller-chat key still names X, which B
    // is running on. C starts fresh, so no two runs share X's session.
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "one more thing", kind: "send" })
    await flush()
    expect(calls[2].opts.resumeFrom).toBeUndefined()
    // Once B ended, X is free again.
    runs[1].resolve({ content: "ok" })
    runs[2].resolve({ content: "ok" })
    await flush()
    expect(h.logs.some((l) => l.includes("still going"))).toBe(false)
  })

  it("and the other way round: a caller-chat run on a source chat makes it busy for the topic", async () => {
    const { h, runs, calls } = topicRuns()
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "Review team/site!12", kind: "send" })
    runs[0].resolve({ content: "ok" })
    await flush()
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "one more thing", kind: "send" })
    await flush()
    expect(calls[1].opts.resumeFrom).toHaveLength(1)
    h.mgr.start({ caller: OTHER_CHAT, callee: "writer", message: "Fix team/site!12", kind: "send" })
    await flush()
    expect(calls[2].opts.resumeFrom).toBeUndefined()
  })

  it("off: today's behaviour, with one 'would continue' line", async () => {
    const { h, runs, calls } = topicRuns({ topicSessions: false })
    const a = h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "Review team/site!12", kind: "send" })
    runs[0].resolve({ content: "ok" })
    await flush()
    h.mgr.start({ caller: OTHER_CHAT, callee: "writer", message: "Fix team/site!12", kind: "send" })
    await flush()
    expect(calls[1].opts.resumeFrom).toBeUndefined()
    expect(h.logs.some((l) => l.includes(`would continue a2a:a2a:planner:writer:${a.taskId} on team/site!12`))).toBe(true)
  })

  it("is rebuilt after a restart from the stored request, inside the warm window only", async () => {
    let now = 1_000_000
    const n = node()
    const first = topicRuns({ now: () => now, store: n.store() })
    const a = first.h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "Review team/site!12", kind: "send" })
    first.runs[0].resolve({ content: "ok" })
    await flush()
    // The stored row names no home.
    expect((n.db.prepare("SELECT home FROM handoffs WHERE id = ?").get(a.taskId) as any).home).toBeNull()
    now += 60_000
    const second = topicRuns({ now: () => now, store: n.store() })
    expect(second.h.logs.some((l) => l.includes("1 topic session(s) rebuilt"))).toBe(true)
    second.h.mgr.start({ caller: OTHER_CHAT, callee: "writer", message: "Fix team/site!12", kind: "send" })
    await flush()
    expect(second.calls[0].opts.resumeFrom).toEqual([{ channel: "a2a", chatId: `a2a:planner:writer:${a.taskId}` }])
    // Past the window: nothing rebuilt.
    now += 2 * 3_600_000
    const third = topicRuns({ now: () => now, store: n.store() })
    expect(third.h.logs.some((l) => l.includes("topic session(s) rebuilt"))).toBe(false)
  })

  it("rebuilds no key from a clipped request: a ref across the cut, or one the cut may hide", async () => {
    let now = 1_000_000
    const n = node()
    const first = topicRuns({ now: () => now, store: n.store() })
    // team/site!1234 lands across the 500-character cut: stored as "team/site!12…".
    const across = "x".repeat(489) + " team/site!1234 more"
    // One ref before the cut, a second one after it: the live run had no key.
    const hidden = "Review team/site!12 " + "y".repeat(600) + " and team/site!13"
    first.h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: across, kind: "send" })
    first.h.mgr.start({ caller: OTHER_CHAT, callee: "writer", message: hidden, kind: "send" })
    first.runs[0].resolve({ content: "ok" })
    first.runs[1].resolve({ content: "ok" })
    await flush()
    now += 60_000
    const second = topicRuns({ now: () => now, store: n.store() })
    expect(second.h.logs.some((l) => l.includes("topic session(s) rebuilt"))).toBe(false)
    second.h.mgr.start({ caller: { ...AGENT_TURN, context: { ...AGENT_TURN.context, chatId: "c5" } }, callee: "writer", message: "Fix team/site!12", kind: "send" })
    await flush()
    expect(second.calls[0].opts.resumeFrom).toBeUndefined()
  })
})

describe("a run that ends to wait is not done (#1100)", () => {
  it("is reported as waiting, with what for and until when, for an agent's send", async () => {
    const h = harness()
    const { taskId } = h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "Build S07", kind: "send" })
    const due = Date.parse("2030-01-01T12:00:00Z")
    expect(h.mgr.markWaiting("callee-run-1", { on: "the S07 build to finish", dueAt: due })?.id).toBe(taskId)
    h.local.resolve({ content: "Started the build; the monitor will tell me when it ends." })
    await flush()
    expect(h.injected).toHaveLength(1)
    const msg = h.injected[0].message
    expect(msg).toContain("status=waiting")
    expect(msg).toContain("is NOT finished")
    expect(msg).toContain("the S07 build to finish, expected by 2030-01-01 12:00 UTC")
    expect(msg).toContain("Do not count it as done")
    expect(h.injected[0].context).toMatchObject({ delegation: { status: "waiting" } })
  })

  it("tells a person-started caller to say it is under way, and its fallback says not finished", async () => {
    const h = harness({ injectTurn: async (turn) => { h.injected.push(turn); return { content: "" } } })
    h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Publish the page" })
    h.mgr.markWaiting("callee-run-1", { on: "the deploy" })
    h.local.resolve({ content: "Deploy started." })
    await flush()
    expect(h.injected[0].message).toContain("Tell the person it is under way")
    expect(h.delivered[0].text).toContain("is not finished yet; it is waiting for the deploy")
    expect(h.delivered[0].outcome).toBe("done")
  })

  it("only counts for the run of a pending delegation, and an error still wins", async () => {
    const h = harness()
    expect(h.mgr.markWaiting("some-other-run", { on: "x" })).toBeNull()
    h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "x", kind: "send" })
    h.mgr.markWaiting("callee-run-1", { on: "x" })
    h.local.resolve({ content: "", error: "boom" })
    await flush()
    expect(h.injected[0].message).toContain("status=error")
  })

  it("tells listeners the delegation ended waiting, with its due time", async () => {
    const ends: any[] = []
    const h = harness({ onDone: (rec, result) => ends.push({ id: rec.id, ...result }) })
    const { taskId } = h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "x", kind: "send" })
    h.mgr.markWaiting("callee-run-1", { on: "review", dueAt: 123 })
    h.local.resolve({ content: "asked for review" })
    await flush()
    expect(ends).toEqual([{ id: taskId, status: "waiting", text: "asked for review", waiting: { on: "review", dueAt: 123 } }])
  })
})

describe("repeatsWritten", () => {
  it("counts an end mostly made of words already written as a repeat", () => {
    expect(repeatsWritten("Note 138001 posted on #412, all 30 names moved, no rollback.", ["All 30 names moved to the new server; note 138001 posted on #412. No rollback."])).toBe(true)
  })
  it("does not count a real result after a progress note", () => {
    expect(repeatsWritten("Box posting-1 is live at 10.0.0.5, noVNC on :6080, Chrome 131 signed in.", ["On it, building the box now."])).toBe(false)
  })
})

describe("the job's state a callee's run ended with (#1861)", () => {
  const rec = { id: "dlg-1", caller: "front", callee: "worker", request: "Ship it", kind: "ask" } as any

  it("only a run that said done, or was not checked, is done", () => {
    expect(resultOfRun({ content: "ok" }, { callee: "worker" })).toEqual({ status: "done", text: "ok" })
    expect(resultOfRun({ content: "ok", jobState: { state: "done", proof: "PR #9" } }, { callee: "worker" })).toMatchObject({ status: "done", text: "ok" })
    expect(resultOfRun({ content: "", error: "boom", jobState: { state: "done", proof: "x" } }, { callee: "worker" })).toEqual({ status: "error", text: "boom" })
  })

  it("continue and waiting are not finished, with the time when it reads as one", () => {
    const w = resultOfRun({ content: "PR open.\n\n[Job state] waiting on devops until 2030-01-31T17:00:00Z", jobState: { state: "waiting", on: "devops", until: "2030-01-31T17:00:00Z" } }, { callee: "worker" })
    expect(w).toMatchObject({ status: "waiting", waiting: { on: "devops", dueAt: Date.UTC(2030, 0, 31, 17) } })
    expect(w.text).toBe("[Job state] waiting on devops until 2030-01-31T17:00:00Z\n\nPR open.")
    const c = resultOfRun({ content: "Half done.", jobState: { state: "continue", left: "docs", when: "tonight" } }, { callee: "worker" })
    expect(c).toMatchObject({ status: "waiting", waiting: { on: "worker to carry on: docs" }, state: { state: "continue" } })
    expect(c.waiting?.dueAt).toBeUndefined()
    expect(buildCallbackMessage(rec, c)).toMatch(/status=waiting\][\s\S]*is NOT finished: worker ended its run with work left/)
    expect(fallbackReply(rec, c)).toMatch(/^worker is not finished yet; it has work left:/)
  })

  it("blocked and stalled come back as not finished, for the caller to decide", () => {
    const b = resultOfRun({ content: "Tried.", jobState: { state: "blocked", why: "no token" } }, { callee: "worker" })
    expect(b).toMatchObject({ status: "error", text: "[Job state] blocked — no token\n\nTried." })
    expect(buildCallbackMessage(rec, b)).toMatch(/status=error\][\s\S]*is NOT finished: worker says it is blocked[\s\S]*\[Job state\] blocked — no token/)
    expect(fallbackReply(rec, b)).toMatch(/^worker is not finished; it says it is blocked:\n\n\[Job state\] blocked — no token/)
    const s = resultOfRun({ content: "Built it.", jobState: { state: "stalled" } }, { callee: "worker" })
    expect(s.status).toBe("error")
    expect(s.text).toMatch(/^\[Job stalled\] worker ended its run[\s\S]*\n\nBuilt it\.$/)
    expect(fallbackReply(rec, s)).toMatch(/^worker did not say whether the work is done/)
  })

  it("keeps the state in sight when a long answer is clipped", () => {
    const long = "x".repeat(20_000)
    const b = resultOfRun({ content: `${long}\n\n[Job state] blocked — no token`, jobState: { state: "blocked", why: "no token" } }, { callee: "worker" })
    expect(buildCallbackMessage(rec, b)).toContain("[Job state] blocked — no token")
    expect(fallbackReply(rec, b)).toContain("[Job state] blocked — no token")
    expect(b.text.match(/\[Job state\]/g)).toHaveLength(1)
    const d = resultOfRun({ content: `${long}\n\n[Job state] done — PR #9`, jobState: { state: "done", proof: "PR #9" } }, { callee: "worker" })
    expect(fallbackReply(rec, d)).toContain("[Job state] done — PR #9")
  })

  it("what the run said with agentx_waiting stands", () => {
    const r = resultOfRun({ content: "ok", jobState: { state: "waiting", on: "the build" } }, { callee: "worker", said: { on: "the S07 build", dueAt: 5 } })
    expect(r).toMatchObject({ status: "waiting", text: "ok", waiting: { on: "the S07 build", dueAt: 5 } })
  })

  it("reads the state of an answer from another node on its last lines", () => {
    expect(resultOfRun({ content: "Tried.\n\n[Job state] blocked — no token" }, { callee: "worker", peer: true })).toMatchObject({ status: "error", state: { state: "blocked", why: "no token" } })
    expect(resultOfRun({ content: "Tried.\n\n[Job state] blocked — no token" }, { callee: "worker" }).status).toBe("done")
  })

  it("a local callee that says it is blocked is not reported done, and is not a failure signal", async () => {
    const db = new Database(":memory:")
    setSignalDb(db)
    onTestFinished(() => { setSignalDb(null); db.close() })
    const h = harness()
    const { taskId } = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Ship it" })
    h.local.resolve({ content: "Tried.\n\n[Job state] blocked — no token", jobState: { state: "blocked", why: "no token" } })
    await flush()
    expect(h.injected[0].message).toContain("status=error]")
    expect(h.injected[0].message).toContain("worker says it is blocked")
    expect(h.injected[0].context).toMatchObject({ delegation: { taskId, status: "error" } })
    expect(readSignals(db, 0)).toEqual([])
  })
})

// #2007 B3: an empty answer is an error only when the callee stated no job
// state, did not say it was waiting, and wrote nothing back to the caller.
describe("an empty answer is an error only when nothing was said (#2007 B3)", () => {
  it("is an error when the run is truly empty", () => {
    expect(resultOfRun({ content: "" }, { callee: "worker" })).toEqual({ status: "error", text: "empty answer from worker" })
    expect(resultOfRun({ content: "  \n " }, { callee: "worker" })).toEqual({ status: "error", text: "empty answer from worker" })
    expect(resultOfRun({ content: "" }, { callee: "worker", peer: true, wrote: false })).toEqual({ status: "error", text: "empty answer from worker" })
  })

  it("is not an error when the run wrote an answer", () => {
    expect(resultOfRun({ content: "ok" }, { callee: "worker" })).toEqual({ status: "done", text: "ok" })
  })

  it("is not an error when the run stated a job state", () => {
    const r = resultOfRun({ content: "", jobState: { state: "done", proof: "PR #9" } }, { callee: "worker" })
    expect(r).toMatchObject({ status: "done", state: { state: "done" } })
    expect(r.text).not.toContain("empty answer from")
  })

  it("is not an error when the run said it was waiting", () => {
    expect(resultOfRun({ content: "" }, { callee: "worker", said: { on: "the build" } })).toMatchObject({ status: "waiting", waiting: { on: "the build" } })
  })

  it("is not an error when the callee already wrote back to the caller", () => {
    expect(resultOfRun({ content: "" }, { callee: "worker", wrote: true })).toMatchObject({ status: "done" })
  })

  it("a truly empty run comes back as an error and a failure signal", async () => {
    const db = new Database(":memory:")
    setSignalDb(db)
    onTestFinished(() => { setSignalDb(null); db.close() })
    const ends: any[] = []
    const h = harness({ onDone: (rec, result) => ends.push({ id: rec.id, ...result }) })
    const { taskId } = h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "Review this", kind: "send" })
    h.local.resolve({ content: "" })
    await flush()
    expect(ends).toEqual([{ id: taskId, status: "error", text: "empty answer from builder" }])
    expect(h.injected[0].message).toContain("status=error")
    expect(readSignals(db, 0).map((r) => r.kind)).toEqual(["delegation_failed"])
  })

  it("a callee that wrote back, then ended empty, is done and said so", async () => {
    const ends: any[] = []
    const h = harness({ onDone: (rec, result) => ends.push({ id: rec.id, ...result }) })
    const { record } = h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "Review this", kind: "send" })
    h.mgr.relayReply(record, "Verdict: approved.")
    await flush()
    h.local.resolve({ content: "" })
    await flush()
    expect(ends[0].status).toBe("done")
    expect(h.injected).toHaveLength(2)
    expect(h.injected[1].message).toContain("status=done")
    expect(h.injected[1].message).toContain("already wrote to you during the work")
  })

  it("a callee that said it waits, then ended empty, is waiting", async () => {
    const ends: any[] = []
    const h = harness({ onDone: (rec, result) => ends.push({ id: rec.id, ...result }) })
    h.mgr.start({ caller: AGENT_TURN, callee: "builder", message: "Build S07", kind: "send" })
    h.mgr.markWaiting("callee-run-1", { on: "the S07 build" })
    h.local.resolve({ content: "" })
    await flush()
    expect(ends[0]).toMatchObject({ status: "waiting", waiting: { on: "the S07 build" } })
  })
})
