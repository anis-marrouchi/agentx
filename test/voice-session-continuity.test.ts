import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// Two voice turns in a row must share context. Under the tier-2 limit the
// second turn resumes the first turn's Claude session. Over it, the fresh
// session is rebuilt from today's history, and that rebuild must carry the
// turn just before, not only the oldest turns of the day.

const calls = vi.hoisted(() => [] as Array<{ context: string; resume?: string }>)
const reply = vi.hoisted(() => ({ sessionId: "sess-v1", contextTokens: 40_000 }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (_def: any, _task: any, _providers: any, _onDelta: any, historyContext: string, resumeSessionId?: string) => {
      calls.push({ context: historyContext ?? "", resume: resumeSessionId })
      return Promise.resolve({
        content: `answer ${calls.length}`,
        duration: 1,
        claudeSessionId: resumeSessionId ?? reply.sessionId,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: reply.contextTokens, cacheCreateTokens: 0 },
        contextTokens: reply.contextTokens,
      })
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"

let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-voice-continuity-"))
  process.chdir(dir)
  calls.length = 0
  reply.sessionId = "sess-v1"
  reply.contextTokens = 40_000
  getEventBus().removeAllListeners()
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry(): AgentRegistry {
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { secretary: { name: "Secretary", tier: "claude-code", workspace: dir } },
  })
  return new AgentRegistry(config, () => {})
}

const say = (r: AgentRegistry, message: string) =>
  r.execute({ message, agentId: "secretary", context: { channel: "voice", chatId: "voice:secretary" } })

describe("voice session continuity", () => {
  it("two voice turns in a row keep the same session", async () => {
    const r = registry()
    await say(r, "open the MTGL admin, we test the two fixes")
    await say(r, "okay, I am logged in")
    expect(calls).toHaveLength(2)
    expect(calls[0].resume).toBeUndefined()
    expect(calls[1].resume).toBe("sess-v1")
  })

  it("after a tier-2 rotation the fresh session still sees the turn just before", async () => {
    const r = registry()
    const sessions = (r as any).sessions
    // A long voice day: older subjects first, the live MTGL test last.
    for (let i = 0; i < 40; i++) {
      sessions.addUserMessage("secretary", "voice", "voice:secretary", "Voice", `older subject ${i}: the Matt Pocock post ${"filler ".repeat(60)}`)
      sessions.addAgentMessage("secretary", "voice", "voice:secretary", `reply about older subject ${i}`)
    }
    sessions.addUserMessage("secretary", "voice", "voice:secretary", "Voice", "open Ring R2 on the job order and check the work sheet")
    sessions.addAgentMessage("secretary", "voice", "voice:secretary", "Ring R2 work sheet is the last check before the sealing label")

    reply.contextTokens = 250_000 // over every tier-2 limit: next turn rotates
    await say(r, "let us test the MTGL fixes")
    reply.sessionId = "sess-v2"
    reply.contextTokens = 40_000
    await say(r, "okay, I don't know, maybe it's the previous step")

    expect(calls[1].resume).toBeUndefined()
    const fresh = calls[1].context
    expect(fresh).toContain("let us test the MTGL fixes")
    expect(fresh).toContain("Ring R2 work sheet is the last check")
    expect(fresh).toContain("[End of history — respond to the latest message above]")
    expect(fresh).not.toContain("older subject 30:")
  })
})
