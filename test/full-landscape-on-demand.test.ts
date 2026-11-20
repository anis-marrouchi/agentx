import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { onDemandContextNote } from "../src/agents/session-profile"

// #2009 part 1, step 5: a full Claude Code fresh start gets the landscape
// on demand too, behind the existing session.lean.contextOnDemand switch.
// Its chat history stays pushed, so its note does not offer it.

const calls = vi.hoisted(() => [] as Array<{ context: string; resume?: string }>)
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (_def: any, _task: any, _providers: any, _onDelta: any, historyContext: string, resumeSessionId?: string) => {
      calls.push({ context: historyContext ?? "", resume: resumeSessionId })
      return Promise.resolve({ content: "ok", duration: 1 })
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"

const LANDSCAPE = "LANDSCAPE_MARK_2009"
let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-full-landscape-"))
  process.chdir(dir)
  calls.length = 0
  getEventBus().removeAllListeners()
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry(contextOnDemand?: boolean): AgentRegistry {
  const config = daemonConfigSchema.parse({
    jobState: { enabled: false },
    node: { id: "test", name: "test" },
    ...(contextOnDemand === undefined ? {} : { session: { lean: { contextOnDemand } } }),
    agents: { ops: { name: "Ops", tier: "claude-code", workspace: dir } },
  })
  const r = new AgentRegistry(config, () => {})
  ;(r as any).landscape = { getForAgent: () => LANDSCAPE }
  return r
}

// telegram is a full-profile channel.
const run = (r: AgentRegistry) => r.execute({ message: "hello", agentId: "ops", context: { channel: "telegram", chatId: "chat-1" } })

describe("landscape on demand for full fresh starts (#2009)", () => {
  it("a full fresh start has the on-demand note and no landscape", async () => {
    await run(registry())
    expect(calls[0].context).toContain("[Context on demand]")
    expect(calls[0].context).toContain("agentx_agents with landscape=true")
    expect(calls[0].context).not.toContain(LANDSCAPE)
  })

  it("a resumed full session has neither", async () => {
    const r = registry()
    ;(r as any).sessions.setClaudeSessionId("ops", "telegram", "chat-1", "sess-1")
    await run(r)
    expect(calls[0].resume).toBe("sess-1")
    expect(calls[0].context).not.toContain("[Context on demand]")
    expect(calls[0].context).not.toContain(LANDSCAPE)
  })

  it("with the switch off, the landscape is pushed as before", async () => {
    await run(registry(false))
    expect(calls[0].context).toContain(LANDSCAPE)
    expect(calls[0].context).not.toContain("[Context on demand]")
  })
})

describe("the note of a full start", () => {
  it("does not offer the chat history, which a full start pushes", () => {
    const note = onDemandContextNote("telegram", "chat-1", { historyPushed: true })
    expect(note).toContain("agentx_agents with landscape=true")
    expect(note).not.toContain("earlier messages on this chat")
    expect(note).toContain("If you need a tool or fact that is not loaded, say which and look it up.")
    expect(onDemandContextNote("telegram", "chat-1")).toContain("earlier messages on this chat")
  })
})
