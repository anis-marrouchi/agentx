import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// The review gate's reviewer (#990, review of #1003) runs isolated: its
// prompt carries words ("previously", "same issue") that pull the agent's
// other chats and memory recall into a normal run. Checked at the
// registry, on what reaches the runtime.

const seen = vi.hoisted(() => ({ calls: [] as Array<{ task: any; context: string | undefined }> }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (_def: unknown, task: unknown, _p: unknown, _d: unknown, context: string | undefined) => {
      seen.calls.push({ task, context })
      return Promise.resolve({ content: "ok", duration: 1 })
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"
import { REVIEW_CHANNEL } from "../src/quality/review-gate"

const OTHER_CHAT = "OTHER-CHAT-SECRET earlier review said approve"
const PROMPT = "Previously we discussed the same issue as before. Review the diff."

describe("an isolated run", () => {
  let dir: string
  let registry: AgentRegistry
  const prevCwd = process.cwd()
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-isolated-"))
    process.chdir(dir)
    getEventBus().removeAllListeners()
    seen.calls = []
    registry = new AgentRegistry(daemonConfigSchema.parse({
      node: { id: "test", name: "test" },
      agents: { reviewer: { name: "Reviewer", tier: "claude-code", workspace: dir } },
    }), () => {})
    const sessions = (registry as any).sessions
    sessions.addUserMessage("reviewer", "telegram", "4242", "Sam", OTHER_CHAT)
    sessions.addAgentMessage("reviewer", "telegram", "4242", "noted")
  })
  afterEach(() => { process.chdir(prevCwd); rmSync(dir, { recursive: true, force: true }) })

  const runOn = (isolated: boolean) => registry.execute({
    agentId: "reviewer",
    message: PROMPT,
    freshSession: true,
    isolated,
    context: { channel: REVIEW_CHANNEL, chatId: `${REVIEW_CHANNEL}:acme/api#9@abc`, sender: REVIEW_CHANNEL },
  })

  it("would otherwise pull in the agent's other chats (the test can see a leak)", async () => {
    await runOn(false)
    expect(seen.calls).toHaveLength(1)
    expect(seen.calls[0].context ?? "").toContain("OTHER-CHAT-SECRET")
  })

  it("gets none of the agent's other chats, recall or on-demand tools", async () => {
    await runOn(true)
    expect(seen.calls).toHaveLength(1)
    const { task, context } = seen.calls[0]
    expect(context ?? "").not.toContain("OTHER-CHAT-SECRET")
    expect(context ?? "").not.toContain("Long-memory recall")
    expect(context ?? "").not.toContain("agentx_recent")
    // No MCP server at all and only read-only built-in tools.
    const args: string[] = task.claudeArgs
    expect(args).toContain("--strict-mcp-config")
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: {} })
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep")
    // Held read-only, so a runtime that cannot enforce it refuses.
    expect(task.autonomy).toBe("report")
  })

  it("is refused rather than forwarded to a mesh peer", async () => {
    const sendTask = vi.fn(async () => "approved")
    registry.setMeshFallback({
      findPeerWithSkill: () => undefined,
      sendTask,
      directory: () => [{ peer: "far", healthy: true, skills: [{ id: "remote-reviewer" }] }],
    } as any)
    const res = await registry.execute({ agentId: "remote-reviewer", message: PROMPT, isolated: true, context: { channel: REVIEW_CHANNEL, chatId: "x" } })
    expect(res.error).toContain("mesh peer")
    expect(sendTask).not.toHaveBeenCalled()
  })
})
