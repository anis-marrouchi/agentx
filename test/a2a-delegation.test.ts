import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DelegationManager, MAX_DONE_IDS, MAX_SEND_DEPTH, DELEGATION_RESULT_MARKER, callbackDepthOf, delegationIdOfChat, isDelegationRelay, stoppedByRestart, type DelegationDeps, type CallerTurn, type InjectedTurn } from "../src/a2a/delegation"

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
    expect(h.delivered).toEqual([{ channel: "telegram", chatId: "chat-1", text: "summary for front", agentId: "front", accountId: undefined, record: false, taskId, outcome: "done" }])
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
  it("keeps each outcome and stays bounded while the daemon runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-dlg-"))
    try {
      const logPath = join(dir, "delegations.jsonl")
      const h = harness({ logPath })
      const a = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "a" })
      await h.mgr.complete(a.taskId, { status: "timeout", text: "slow" })
      // Enough start/done pairs to trigger compaction more than once.
      for (let i = 0; i < 600; i++) {
        const t = h.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: `m${i}` })
        await h.mgr.complete(t.taskId, { status: i % 2 ? "error" : "done", text: "x" })
      }
      const lines = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l))
      expect(lines.length).toBeLessThan(2 * 500 + 10)
      // A compacted done line keeps how the delegation ended.
      expect(lines.find((l) => l.id === a.taskId)).toMatchObject({ type: "done", status: "timeout" })
      expect(new Set(lines.filter((l) => l.type === "done").map((l) => l.status))).toEqual(new Set(["timeout", "done", "error"]))

      // A new process still suppresses the old ids.
      const again = harness({ logPath })
      expect(await again.mgr.complete(a.taskId, { status: "done", text: "late" })).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("remembers the same number of finished ids in memory and on disk", () => {
    expect(MAX_DONE_IDS).toBe(2000)
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

describe("a callback turn stopped by a restart (#846)", () => {
  const STOPPED = { content: "", error: "Claude Code was stopped mid-turn (registry-stop), before its time limit" }

  function withLog<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "agentx-dlg-"))
    return fn(join(dir, "delegations.jsonl")).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  /** Before the restart: the callee answers, the callback turn is stopped. */
  async function stoppedRelay(logPath: string, over: Partial<DelegationDeps> = {}) {
    const before = harness({ logPath, injectTurn: async (turn) => { before.injected.push(turn); return STOPPED }, ...over })
    const { taskId } = before.mgr.start({ caller: HUMAN_TURN, callee: "worker", message: "Find the report" })
    before.local.resolve({ content: "Here is the report" })
    await flush()
    before.mgr.stop()
    return { before, taskId }
  }

  it("holds the relay and runs it once more after the restart", async () => {
    await withLog(async (logPath) => {
      const { before, taskId } = await stoppedRelay(logPath)
      expect(before.injected).toHaveLength(1)
      expect(before.injected[0].message.startsWith(DELEGATION_RESULT_MARKER)).toBe(true)
      expect(before.delivered).toHaveLength(0) // nothing sent while the channels are down

      const after = harness({ logPath })
      await after.mgr.recover()
      expect(after.injected).toHaveLength(1)
      expect(after.injected[0].message).toContain(`task=${taskId}`)
      expect(after.injected[0].message).toContain("Here is the report")
      expect(after.delivered).toEqual([expect.objectContaining({ channel: "telegram", chatId: "chat-1", text: "summary for front", record: false })])

      // Relayed: a later start runs nothing more.
      const again = harness({ logPath })
      await again.mgr.recover()
      expect(again.injected).toHaveLength(0)
      expect(again.delivered).toHaveLength(0)
    })
  })

  it("sends the notice and notes the request when the re-run fails too", async () => {
    await withLog(async (logPath) => {
      const { taskId } = await stoppedRelay(logPath)
      const failed: Array<{ id: string; reason: string }> = []
      const after = harness({
        logPath,
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
      const again = harness({ logPath })
      await again.mgr.recover()
      expect(again.injected).toHaveLength(0)
      expect(again.delivered).toHaveLength(0)
    })
  })

  it("re-runs at most once: a re-run stopped by another restart gets the notice next time", async () => {
    await withLog(async (logPath) => {
      const { taskId } = await stoppedRelay(logPath)
      const second = harness({ logPath, injectTurn: async (turn) => { second.injected.push(turn); return STOPPED } })
      await second.mgr.recover()
      expect(second.injected).toHaveLength(1)
      expect(second.delivered).toHaveLength(0)

      const failed: string[] = []
      const third = harness({ logPath, onRelayFailed: (rec) => { failed.push(rec.id) } })
      await third.mgr.recover()
      expect(third.injected).toHaveLength(0)
      expect(failed).toEqual([taskId])
      expect(third.delivered).toEqual([expect.objectContaining({ taskId, outcome: "error", record: true })])
    })
  })

  it("does not hold a turn stopped for another reason, or with a reply", async () => {
    await withLog(async (logPath) => {
      const { before } = await stoppedRelay(logPath, {
        injectTurn: async (turn) => { before.injected.push(turn); return { content: "", error: "stopped mid-turn (turn deadline (30m))" } },
      })
      expect(before.delivered).toHaveLength(1) // the plain result, as before
      const after = harness({ logPath })
      await after.mgr.recover()
      expect(after.injected).toHaveLength(0)
    })
    expect(stoppedByRestart({ content: "partial answer", error: "stopped mid-turn (registry-stop)" })).toBe(false)
    expect(stoppedByRestart(STOPPED)).toBe(true)
  })

  it("can be turned off", async () => {
    await withLog(async (logPath) => {
      await stoppedRelay(logPath, { requeueRelayOnRestart: false })
      const after = harness({ logPath })
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
    expect(h.mgr.originFor(taskId)).toEqual({ caller: "planner", origin: { channel: "mcp", chatId: "mcp:lead:planner:work-1" } })
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

  it("leaves work without a home as it was", async () => {
    const { h, calls } = twoRuns()
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "one", kind: "send" })
    h.mgr.start({ caller: AGENT_TURN, callee: "writer", message: "two", kind: "send" })
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1].opts.resumeFrom).toBeUndefined()
  })
})
