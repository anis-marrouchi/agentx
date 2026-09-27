import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// The `digest` delivery briefs a FRESH session on subscribed events. A
// resumed session must get nothing injected: --resume already replays the
// transcript, and per-turn blocks bloat context and force rotation.

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

let dir: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-event-digest-"))
  process.chdir(dir)
  calls.length = 0
  getEventBus().removeAllListeners()
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function registry(): AgentRegistry {
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: {
      ops: {
        name: "Ops", tier: "claude-code", workspace: dir,
        subscriptions: [{ kinds: ["run"], match: "nightly", delivery: "digest" }],
      },
    },
  })
  return new AgentRegistry(config, () => {})
}

const run = (r: AgentRegistry) => r.execute({ message: "hello", agentId: "ops", context: { channel: "cron", chatId: "cron:x" } })

describe("digest injection", () => {
  it("briefs a fresh session on subscribed events", async () => {
    getEventBus().publish({ kind: "run", type: "failed", summary: "nightly-backup failed at step upload" })
    await run(registry())
    expect(calls).toHaveLength(1)
    expect(calls[0].resume).toBeUndefined()
    expect(calls[0].context).toContain("[Events since your last turn")
    expect(calls[0].context).toContain("nightly-backup failed at step upload")
  })

  it("injects nothing into a resumed session", async () => {
    const r = registry()
    ;(r as any).sessions.setClaudeSessionId("ops", "cron", "cron:x", "sess-1")
    getEventBus().publish({ kind: "run", type: "failed", summary: "nightly-backup failed at step upload" })
    await run(r)
    expect(calls).toHaveLength(1)
    expect(calls[0].resume).toBe("sess-1")
    expect(calls[0].context).not.toContain("Events since your last turn")
    expect(calls[0].context).not.toContain("nightly-backup")
  })
})
