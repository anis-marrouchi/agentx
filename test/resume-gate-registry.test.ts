import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #779 review of #778: the resume gate's inputs, read through the registry.
// Recording the inbound message bumps the session's updatedAt, so idle time
// must be read before it; and a turn with no context reading must resume
// rather than fall back to the turn's summed input.

// Hang the turn at the request planner, which is awaited after the gate.
const hang = vi.hoisted(() => ({ on: false }))
vi.mock("../src/agents/request-planner", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    evaluateRequest: (...args: any[]) => hang.on ? new Promise(() => {}) : real.evaluateRequest(...args),
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"

const MIN = 60_000

describe("resume gate inputs in the registry", () => {
  let dir: string
  const prevCwd = process.cwd()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-resume-gate-"))
    process.chdir(dir)
    hang.on = true
  })
  afterEach(() => {
    hang.on = false
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  })

  const ctx = { channel: "telegram", chatId: "chat-1", sender: "Sam" }

  /** Run one turn on a resumable session idle for `idleMs`, stop it once
   *  the gate has spoken, and return the log lines. */
  async function gateRun(opts: { idleMs: number; contextTokens?: number; turnInputTokens: number; mode?: "shadow" | "active" }) {
    const config = daemonConfigSchema.parse({
      node: { id: "test", name: "test" },
      agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir, maxConcurrent: 1 } },
      people: [{ id: "sam", name: "Sam", role: "member", identities: ["telegram:77"] }],
      session: { resumeGate: { mode: opts.mode ?? "shadow", cacheTtlMinutes: 5 } },
    })
    const lines: string[] = []
    const r = new AgentRegistry(config, (l: string) => { lines.push(l) })
    const sessions = (r as any).sessions
    sessions.setClaudeSessionId("ops", "telegram", "chat-1", "native-1")
    sessions.recordTurnUsage("ops", "telegram", "chat-1",
      { inputTokens: opts.turnInputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      opts.contextTokens)
    sessions.getSession("ops", "telegram", "chat-1").updatedAt = new Date(Date.now() - opts.idleMs).toISOString()

    let onStart!: (id: string) => void
    const started = new Promise<string>((res) => { onStart = res })
    const run = r.execute({ message: "hello", agentId: "ops", context: ctx, onStart })
    const id = await started
    for (let i = 0; i < 100 && !lines.some((l) => /resume gate|cost rotation/.test(l)); i++) {
      await new Promise((res) => setTimeout(res, 20))
    }
    r.cancelRunningTask(id, "done")
    await run
    return { lines }
  }

  it("sees the idle time from before this turn's message, not ~0", async () => {
    const { lines } = await gateRun({ idleMs: 30 * MIN, contextTokens: 60_000, turnInputTokens: 600_000 })
    const gate = lines.find((l) => l.includes("resume gate (shadow)"))
    expect(gate).toContain("cold cache")
    expect(gate).toContain("start fresh")
  })

  it("keeps a recent session warm", async () => {
    const { lines } = await gateRun({ idleMs: MIN, contextTokens: 60_000, turnInputTokens: 600_000 })
    expect(lines.find((l) => l.includes("resume gate (shadow)"))).toContain("warm cache")
  })

  it("resumes when the last turn left no context reading", async () => {
    // Before the fix the gate fell back to the summed input: C = 150k, N = 1,
    // and a cold cache (≈300k against 90k) would have rotated on twice the
    // whole turn. Kept under the tier-2 line so that rule stays out of it.
    const { lines } = await gateRun({ idleMs: 30 * MIN, turnInputTokens: 150_000 })
    expect(lines.find((l) => l.includes("resume gate (shadow)"))).toMatch(/would resume: no context reading \(cold cache\)/)
  })

  it("reports the rotated session's input tokens on a cost rotation", async () => {
    const { getEventBus } = await import("../src/events/bus")
    const seen: any[] = []
    const listen = (p: any) => { if (p.reason === "cost") seen.push(p) }
    getEventBus().on("session:rotated", listen)
    try {
      const { lines } = await gateRun({ idleMs: 30 * MIN, contextTokens: 60_000, turnInputTokens: 600_000, mode: "active" })
      expect(lines.some((l) => l.includes("cost rotation"))).toBe(true)
    } finally {
      getEventBus().off("session:rotated", listen)
    }
    expect(seen).toHaveLength(1)
    expect(seen[0].lastTurnInputTokens).toBe(600_000)
  })
})
