import { describe, it, expect } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { CodexProcessPool, CodexUnavailable } from "../src/agents/codex-process"

function fixture(mode = "ok") {
  let spawned = 0
  const requests: any[] = []
  const launch = () => {
    spawned++
    const child: any = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.kill = () => { child.exitCode = 0; child.emit("exit", 0) }
    const send = (v: any) => child.stdout.write(JSON.stringify(v) + "\n")
    child.stdin = new Writable({ write(data, _, done) {
      const m = JSON.parse(data.toString())
      requests.push(m)
      queueMicrotask(() => {
        if (!m.id) return
        if (mode === "init-error" && m.method === "initialize") { child.emit("exit", 1); return }
        if (m.method === "turn/start" && mode === "turn-error") { child.emit("exit", 1); return }
        send({ id: m.id, result: m.method.startsWith("thread/") ? { thread: { id: m.params.threadId || "thread-new" } } : {} })
        if (m.method === "turn/start" && mode !== "hang") {
          send({ method: "item/agentMessage/delta", params: { threadId: "thread-new", delta: "hello" } })
          if (mode === "usage") {
            // Two model calls inside one turn. `last` is per call, `total` is
            // the thread's running sum, and OpenAI's inputTokens INCLUDES the
            // cached part.
            send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-new", tokenUsage: {
              last: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 50 },
              total: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 50 } } } })
            send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-new", tokenUsage: {
              last: { inputTokens: 1200, cachedInputTokens: 900, outputTokens: 30 },
              total: { inputTokens: 2200, cachedInputTokens: 900, outputTokens: 80 } } } })
          }
          send({ method: "turn/completed", params: { threadId: "thread-new", turn: { status: "completed" } } })
        }
      })
      done()
    } })
    return child
  }
  const pool = new CodexProcessPool(launch, 2, 10)
  const options = { key: "agent/chat", cwd: "/tmp", env: {}, args: [], bypass: false, prompt: "test", timeoutMs: 2000 }
  return { pool, options, requests, spawned: () => spawned }
}

describe("Codex persistent processes", () => {
  it("reuses the process and resumes only the explicitly supplied thread", async () => {
    const f = fixture()
    try {
      expect((await f.pool.run(f.options)).content).toBe("hello")
      await f.pool.run({ ...f.options, resume: "thread-new" })
      expect(f.spawned()).toBe(1)
      expect(f.requests.filter(r => r.method === "initialize")).toHaveLength(1)
      expect(f.requests.find(r => r.method === "thread/resume").params.threadId).toBe("thread-new")
      await f.pool.run(f.options)
      expect(f.requests.filter(r => r.method === "thread/start")).toHaveLength(2)
    } finally { f.pool.stop() }
  })
  it("isolates chats and rotates on permission, model, environment and fresh-session changes", async () => {
    const f = fixture()
    try {
      await f.pool.run(f.options)
      await f.pool.run({ ...f.options, key: "another" })
      await f.pool.run({ ...f.options, bypass: true })
      await f.pool.run({ ...f.options, model: "other-model" })
      await f.pool.run({ ...f.options, env: { AGENTX_CHAT_ID: "changed" } })
      await f.pool.run({ ...f.options, fresh: true })
      expect(f.spawned()).toBe(6)
    } finally { f.pool.stop() }
  })
  it("allows fallback only before turn submission", async () => {
    const before = fixture("init-error")
    await expect(before.pool.run(before.options)).rejects.toBeInstanceOf(CodexUnavailable)
    const after = fixture("turn-error")
    expect((await after.pool.run(after.options)).error).toMatch(/exited/)
    expect(after.requests.filter(r => r.method === "turn/start")).toHaveLength(1)
  })
  it("cancels an in-flight turn without replay", async () => {
    const f = fixture("hang")
    const controller = new AbortController()
    const promise = f.pool.run({ ...f.options, signal: controller.signal })
    setTimeout(() => controller.abort(), 5)
    expect((await promise).error).toMatch(/cancelled/)
    f.pool.stop()
  })
  it("reports the whole turn's usage, with cached input split out", async () => {
    const f = fixture("usage")
    try {
      const { usage } = await f.pool.run(f.options)
      expect(usage).toEqual({ inputTokens: 1300, outputTokens: 80, cacheReadTokens: 900, cacheCreateTokens: 0 })
    } finally { f.pool.stop() }
  })
  it("times out and removes idle processes", async () => {
    const f = fixture("hang")
    expect((await f.pool.run({ ...f.options, timeoutMs: 5 })).error).toMatch(/timed out/)
    const g = fixture()
    await g.pool.run(g.options)
    await new Promise(r => setTimeout(r, 25))
    await g.pool.run(g.options)
    expect(g.spawned()).toBe(2)
    g.pool.stop()
  })
})
