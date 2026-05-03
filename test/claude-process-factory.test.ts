import { describe, it, expect } from "vitest"
import { execSync } from "child_process"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ClaudeProcessFactory } from "../src/agents/claude-process-factory"
import type { ProcessKey, SpawnOptions } from "../src/agents/process-registry"

// These tests spawn a REAL `claude -p` subprocess. Skipped automatically
// when the binary is missing so the suite stays green on CI hosts that
// don't have Claude Code installed. Detection runs at module-load time
// because describe.skipIf is evaluated when the file is collected,
// before any beforeAll hook runs.
//
// They use sonnet for cost — ~6KB of cache_create per turn after the
// initial build, well under a cent per run on standard pricing. Each
// test sends a one-token-output prompt ("Reply with the word ready").

const claudeAvailable = (() => {
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
