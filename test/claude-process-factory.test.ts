import { describe, it, expect } from "vitest"
import { execSync } from "child_process"
import { chmodSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ClaudeProcessFactory, TurnDeadlineExceeded, TurnInterrupted } from "../src/agents/claude-process-factory"
import type { ProcessKey, SpawnOptions, UnaskedReply } from "../src/agents/process-registry"

// These tests spawn a REAL `claude -p` subprocess. Skipped automatically
// when the binary is missing so the suite stays green on CI hosts that
// don't have Claude Code installed. Detection runs at module-load time
// because describe.skipIf is evaluated when the file is collected,
// before any beforeAll hook runs.
//
// They use sonnet for cost — ~6KB of cache_create per turn after the
// initial build, well under a cent per run on standard pricing. Each
// test sends a one-token-output prompt ("Reply with the word ready").

// Paid live-provider tests require explicit opt-in, even when Claude is installed.
const claudeAvailable = process.env.AGENTX_TEST_LIVE_CLAUDE === "1" && (() => {
  try {
    execSync("claude --version", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()
const workspace = mkdtempSync(join(tmpdir(), "agentx-claude-spike-"))

const KEY: ProcessKey = { agentId: "spike-agent", channel: "test", chatId: "c1" }
const OPTS = (): SpawnOptions => ({
  agentId: "spike-agent",
  channel: "test",
  chatId: "c1",
  workspace,
  model: "claude-sonnet-4-6",
})

describe.skipIf(!claudeAvailable)("ClaudeProcessFactory — real subprocess", () => {
  it("runs a single turn end-to-end and reports usage on the result event", async () => {
    const factory = new ClaudeProcessFactory()
    const handle = factory.spawn(KEY, OPTS())
    try {
      let sawSystemInit = false
      let sawAssistantText: string | null = null
      let resultEvent: any = null

      for await (const evt of handle.runTurn({ message: "Reply with exactly the word ready. No tools.", taskId: "01TURN1" })) {
        if (evt.type === "system" && (evt.raw as any).subtype === "init") sawSystemInit = true
        if (evt.type === "assistant") {
          const blocks = ((evt.raw as any).message?.content ?? []) as Array<{ type: string; text?: string }>
          for (const b of blocks) if (b.type === "text" && b.text) sawAssistantText = (sawAssistantText ?? "") + b.text
        }
        if (evt.type === "result") resultEvent = evt.raw
      }

      expect(sawSystemInit).toBe(true)
      expect(sawAssistantText?.toLowerCase()).toContain("ready")
      expect(resultEvent).not.toBeNull()
      expect(resultEvent.is_error).toBe(false)
      expect(typeof resultEvent.session_id).toBe("string")

      const snap = handle.snapshot()
      expect(snap.state).toBe("idle")
      expect(snap.turnCount).toBe(1)
      expect(snap.claudeSessionId).toBe(resultEvent.session_id)
      expect(snap.lastInputTokens).toBeGreaterThan(0)
    } finally {
      await handle.kill("test-end")
    }
  }, 60_000)

  it("amortizes cache across multiple turns in one process (the load-bearing claim)", async () => {
    const factory = new ClaudeProcessFactory()
    const handle = factory.spawn(KEY, OPTS())
    try {
      const usages: Array<{ cache_create: number; cache_read: number }> = []
      for (let i = 0; i < 2; i++) {
        for await (const evt of handle.runTurn({ message: `Turn ${i + 1}: reply with the single word ready.`, taskId: `01T${i}` })) {
          if (evt.type === "result") {
            const u = (evt.raw as any).usage ?? {}
            usages.push({
              cache_create: u.cache_creation_input_tokens ?? 0,
              cache_read: u.cache_read_input_tokens ?? 0,
            })
          }
        }
      }

      expect(usages).toHaveLength(2)
      // The load-bearing claim of this design: turn 2 reuses turn 1's
      // cache. Two ways that can show up in the API response —
      //   (a) turn 2 cache_create is materially smaller than turn 1, OR
      //   (b) turn 2 has cache_read > 0.
      // Concurrent claude calls on the same host can evict each other's
      // cache between turns under suite-level test load (verified
      // 2026-05-03: the spike running standalone hit (b) cleanly with
      // turn 2 cache_create=20 + cache_read=24575; under --pool=forks
      // it occasionally regresses to (a) with both turns close because
      // other tests' system-prompt cache evicted ours mid-run). Either
      // signal is enough proof that the persistent process is sharing
      // state across turns; the failure mode worth catching is BOTH
      // missing — meaning no state crossed between turns at all.
      const sameShape = Math.abs(usages[1].cache_create - usages[0].cache_create) < 100 && usages[1].cache_read === 0
      expect(sameShape, `expected cache amortization between turns (turn 1: ${JSON.stringify(usages[0])}, turn 2: ${JSON.stringify(usages[1])})`).toBe(false)

      const snap = handle.snapshot()
      expect(snap.turnCount).toBe(2)
    } finally {
      await handle.kill("test-end")
    }
  }, 90_000)

  it("serializes concurrent runTurn calls — no event interleaving", async () => {
    const factory = new ClaudeProcessFactory()
    const handle = factory.spawn(KEY, OPTS())
    try {
      // Kick off two turns concurrently. The handle's internal queue
      // must serialize them; we verify by counting result events and
      // confirming neither iterator throws.
      const collect = async (taskId: string) => {
        const events: string[] = []
        for await (const evt of handle.runTurn({ message: "Reply with: ok", taskId })) {
          events.push(evt.type)
        }
        return events
      }
      const [a, b] = await Promise.all([collect("01A"), collect("01B")])
      expect(a.filter((t) => t === "result")).toHaveLength(1)
      expect(b.filter((t) => t === "result")).toHaveLength(1)
      expect(handle.snapshot().turnCount).toBe(2)
    } finally {
      await handle.kill("test-end")
    }
  }, 120_000)

  it("kill() ends the process and subsequent runTurn rejects", async () => {
    const factory = new ClaudeProcessFactory()
    const handle = factory.spawn(KEY, OPTS())
    await handle.kill("test")
    expect(handle.state()).toBe("dead")
    let threw = false
    try {
      for await (const _ of handle.runTurn({ message: "noop", taskId: "01X" })) { /* */ }
    } catch (e: any) {
      threw = true
      expect(e.message).toMatch(/dead/)
    }
    expect(threw).toBe(true)
  }, 30_000)
})

describe("ClaudeProcessFactory — does not require the binary at construction time", () => {
  // This test runs even when claude isn't installed — proves that
  // constructing the factory doesn't probe the binary, which matters
  // for daemon startup on hosts where the binary is at an odd path.
  it("can be constructed in any environment", () => {
    const factory = new ClaudeProcessFactory()
    expect(factory).toBeDefined()
  })
})

describe("ClaudeProcessFactory — turn deadline", () => {
  // Stands in for a Claude turn still working when its budget runs out:
  // accepts the user line and never emits a result.
  it("reports a timeout and stops the process instead of calling it an exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-silent-claude-"))
    const binary = join(dir, "claude")
    writeFileSync(binary, "#!/bin/sh\nexec cat >/dev/null\n")
    chmodSync(binary, 0o755)
    const handle = new ClaudeProcessFactory({ binary }).spawn(KEY, OPTS())

    const run = async () => { for await (const _ of handle.runTurn({ message: "hi", taskId: "t", deadlineMs: 200 })) { /* none */ } }
    await expect(run()).rejects.toBeInstanceOf(TurnDeadlineExceeded)
    await new Promise(r => setTimeout(r, 300))
    expect(handle.state()).toBe("dead")
  })

  // A daemon restart kills the process mid-turn, long before its budget.
  // kill() wakes the turn before the child has exited; that used to read
  // as the turn's own deadline and reported "timed out after 90m".
  it("reports a mid-turn kill as an interruption with its reason, not a timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-silent-claude-"))
    const binary = join(dir, "claude")
    writeFileSync(binary, "#!/bin/sh\nexec cat >/dev/null\n")
    chmodSync(binary, 0o755)
    const handle = new ClaudeProcessFactory({ binary }).spawn(KEY, OPTS())

    const run = async () => { for await (const _ of handle.runTurn({ message: "hi", taskId: "t", deadlineMs: 60_000 })) { /* none */ } }
    const turn = run()
    setTimeout(() => { void handle.kill("registry-stop") }, 100)
    const err = await turn.then(() => null, (e) => e)
    expect(err).toBeInstanceOf(TurnInterrupted)
    expect(err).not.toBeInstanceOf(TurnDeadlineExceeded)
    expect((err as TurnInterrupted).reason).toBe("registry-stop")
  })
})

describe("ClaudeProcessFactory — a reply no question asked for (#585)", () => {
  // Stands in for Claude Code with --replay-user-messages: echoes each
  // question's uuid, then answers it. 50 ms after the first answer it runs
  // a turn of its own, as Claude does when a background task ends; that
  // turn takes 200 ms and a question written meanwhile waits behind it.
  const standIn = `#!/usr/bin/env node
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n")
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let chain = Promise.resolve()
let n = 0
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const q = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    chain = chain.then(() => {
      n++
      out({ type: "system", subtype: "init", turn: n })
      out({ type: "user", uuid: q.uuid, isReplay: true, message: q.message })
      out({ type: "result", result: "answer " + n, session_id: "sid-1", total_cost_usd: 0.01 })
      if (n === 1) setTimeout(() => { chain = chain.then(async () => {
        out({ type: "system", subtype: "init", turn: "notification" })
        await wait(200)
        out({ type: "result", result: "notification reply", session_id: "sid-1", total_cost_usd: 0.02 })
      }) }, 50)
    })
  }
})
`
  const spawnStandIn = (onUnaskedReply?: (r: UnaskedReply) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-notifying-claude-"))
    const binary = join(dir, "claude")
    writeFileSync(binary, standIn)
    chmodSync(binary, 0o755)
    const logs: string[] = []
    const handle = new ClaudeProcessFactory({ binary, log: (m) => logs.push(m) })
      .spawn(KEY, OPTS(), onUnaskedReply ? { onUnaskedReply } : undefined)
    const ask = async (message: string) => {
      const events: any[] = []
      for await (const evt of handle.runTurn({ message, taskId: "t", deadlineMs: 5_000 })) events.push(evt.raw)
      return events
    }
    return { handle, logs, ask }
  }
  const answer = (events: any[]) => events.find((e) => e.type === "result")?.result

  it("answers the question asked, not the reply that was waiting", async () => {
    const { handle, logs, ask } = spawnStandIn()
    try {
      expect(answer(await ask("q1"))).toBe("answer 1")
      await new Promise(r => setTimeout(r, 400))   // the notification turn ends while nobody asks
      const second = await ask("q2")
      expect(answer(second)).toBe("answer 2")
      // The turn keeps its own init, not the notification's.
      expect(second.filter((e) => e.subtype === "init").map((e) => e.turn)).toEqual([2])
      expect(answer(await ask("q3"))).toBe("answer 3")
      expect(logs.filter((m) => m.includes("notification reply"))).toHaveLength(1)
      expect(logs.filter((m) => m.includes("dropped a reply"))).toHaveLength(1)
      expect(handle.snapshot().turnCount).toBe(3)
    } finally {
      await handle.kill("test-end")
    }
  })

  // #1861: the reply goes to the job that left the work running.
  it("passes the reply to the handler as it arrives, once, and not the asked ones", async () => {
    const got: UnaskedReply[] = []
    const { handle, logs, ask } = spawnStandIn((r) => got.push(r))
    try {
      const before = Date.now()
      expect(answer(await ask("q1"))).toBe("answer 1")
      expect(got).toHaveLength(0)                   // an asked turn is not passed
      await new Promise(r => setTimeout(r, 400))   // no next question yet
      expect(got).toHaveLength(1)
      expect(got[0]).toMatchObject({ key: KEY, text: "notification reply", sessionId: "sid-1", costUsd: 0.02 })
      expect(got[0].at).toBeGreaterThanOrEqual(before)
      // The next asked turn reads past it: its answer is its own, no second call.
      expect(answer(await ask("q2"))).toBe("answer 2")
      expect(answer(await ask("q3"))).toBe("answer 3")
      expect(got).toHaveLength(1)
      expect(logs.filter((m) => m.includes("passed to its job a reply"))).toHaveLength(1)
      expect(logs.filter((m) => m.includes("dropped a reply"))).toHaveLength(0)
      expect(handle.snapshot().turnCount).toBe(3)
    } finally {
      await handle.kill("test-end")
    }
  })

  it("passes a reply that ends while the next question waits, once", async () => {
    const got: UnaskedReply[] = []
    const { handle, ask } = spawnStandIn((r) => got.push(r))
    try {
      expect(answer(await ask("q1"))).toBe("answer 1")
      await new Promise(r => setTimeout(r, 120))   // the notification turn has started
      expect(answer(await ask("q2"))).toBe("answer 2")
      expect(got.map((r) => r.text)).toEqual(["notification reply"])
    } finally {
      await handle.kill("test-end")
    }
  })

  it("a handler that throws breaks neither the stream nor the next turn", async () => {
    let calls = 0
    const { handle, logs, ask } = spawnStandIn(() => { calls++; throw new Error("job store down") })
    try {
      expect(answer(await ask("q1"))).toBe("answer 1")
      await new Promise(r => setTimeout(r, 400))
      expect(calls).toBe(1)
      expect(logs.some((m) => m.includes("unasked reply handler failed: job store down"))).toBe(true)
      expect(answer(await ask("q2"))).toBe("answer 2")
      expect(calls).toBe(1)
    } finally {
      await handle.kill("test-end")
    }
  })

  it("answers a question written while that turn is still running", async () => {
    const { handle, ask } = spawnStandIn()
    try {
      expect(answer(await ask("q1"))).toBe("answer 1")
      await new Promise(r => setTimeout(r, 120))   // the notification turn has started
      expect(answer(await ask("q2"))).toBe("answer 2")
    } finally {
      await handle.kill("test-end")
    }
  })
})

describe("ClaudeProcessFactory — background work that ends without a word (#1861)", () => {
  // Answers the question, then 50 ms later runs a turn of its own whose
  // result carries no text.
  const standIn = `#!/usr/bin/env node
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n")
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const q = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    out({ type: "system", subtype: "init" })
    out({ type: "user", uuid: q.uuid, isReplay: true, message: q.message })
    out({ type: "result", result: "started" })
    setTimeout(() => {
      out({ type: "system", subtype: "init" })
      out({ type: "result" })
    }, 50)
  }
})
`
  it("still calls the handler, with empty text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-silent-claude-"))
    const binary = join(dir, "claude")
    writeFileSync(binary, standIn)
    chmodSync(binary, 0o755)
    const got: UnaskedReply[] = []
    const handle = new ClaudeProcessFactory({ binary }).spawn(KEY, OPTS(), { onUnaskedReply: (r) => got.push(r) })
    try {
      for await (const _ of handle.runTurn({ message: "go", taskId: "t", deadlineMs: 5_000 })) { /* drain */ }
      await new Promise(r => setTimeout(r, 250))
      expect(got).toHaveLength(1)
      expect(got[0].text).toBe("")
      expect(got[0].key).toEqual(KEY)
      expect(got[0].costUsd).toBeUndefined()
    } finally {
      await handle.kill("test-end")
    }
  })
})

describe("ClaudeProcessFactory — work between asked turns (#1560)", () => {
  // Stands in for Claude Code whose turn starts a background builder and
  // ends while it runs. 100 ms later the builder finishes; its notification
  // starts a turn nobody asked for, which takes 200 ms.
  const standIn = `#!/usr/bin/env node
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n")
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const q = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    out({ type: "system", subtype: "init" })
    out({ type: "user", uuid: q.uuid, isReplay: true, message: q.message })
    out({ type: "system", subtype: "task_started", task_id: "builder" })
    out({ type: "result", result: "started a builder" })
    setTimeout(() => {
      out({ type: "system", subtype: "task_notification", task_id: "builder", status: "completed" })
      out({ type: "system", subtype: "init" })
      setTimeout(() => out({ type: "result", result: "builder done" }), 200)
    }, 100)
  }
})
`
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

  it("reports open background tasks and the unasked turn on its snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-builder-claude-"))
    const binary = join(dir, "claude")
    writeFileSync(binary, standIn)
    chmodSync(binary, 0o755)
    const handle = new ClaudeProcessFactory({ binary }).spawn(KEY, OPTS())
    try {
      for await (const _ of handle.runTurn({ message: "build it", taskId: "t", deadlineMs: 5_000 })) { /* drain */ }
      const afterTurn = handle.snapshot()
      expect(afterTurn.state).toBe("idle")
      expect(afterTurn.backgroundTasks).toBe(1)
      expect(afterTurn.unaskedTurn).toBe(false)

      await wait(180)   // builder done, the unasked turn is running
      const during = handle.snapshot()
      expect(during.backgroundTasks).toBe(0)
      expect(during.unaskedTurn).toBe(true)
      expect(during.lastActivityAt).toBeGreaterThan(afterTurn.lastTurnAt)
      // Only asked turns move lastTurnAt, so the stale limit still counts from there.
      expect(during.lastTurnAt).toBe(afterTurn.lastTurnAt)

      await wait(250)   // the unasked turn has ended
      const after = handle.snapshot()
      expect(after.unaskedTurn).toBe(false)
      expect(after.state).toBe("idle")
    } finally {
      await handle.kill("test-end")
    }
  })
})

describe("ClaudeProcessFactory — partial messages (#2101 R16, #2163 B1)", () => {
  // Stands in for Claude Code: answers with its own arguments, so the test
  // reads what the persistent process was started with.
  const standIn = `#!/usr/bin/env node
const args = process.argv.slice(2)
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  const nl = buf.indexOf("\\n")
  if (nl === -1) return
  const q = JSON.parse(buf.slice(0, nl))
  buf = buf.slice(nl + 1)
  const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n")
  out({ type: "user", uuid: q.uuid, isReplay: true, message: q.message })
  out({ type: "result", result: JSON.stringify(args), session_id: "sid-1" })
})
`
  it("starts claude with --include-partial-messages, so the answer streams", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-args-claude-"))
    const binary = join(dir, "claude")
    writeFileSync(binary, standIn)
    chmodSync(binary, 0o755)
    const handle = new ClaudeProcessFactory({ binary, log: () => {} }).spawn(KEY, OPTS())
    try {
      let result = ""
      for await (const evt of handle.runTurn({ message: "q", taskId: "t", deadlineMs: 5_000 })) {
        if (evt.type === "result") result = String((evt.raw as any).result)
      }
      const args = JSON.parse(result) as string[]
      expect(args).toContain("--include-partial-messages")
      expect(args).toContain("stream-json")
    } finally {
      await handle.kill("test-done")
    }
  })
})
