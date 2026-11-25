import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"

// #2101 B1: the Hub's CLI switch writes the agent's tier; the reload hands it
// to the registry, so the next run uses the new engine with no restart.

let dir: string
const prevCwd = process.cwd()
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-tier-reload-"))
  process.chdir(dir)
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

const config = (tier: string) => daemonConfigSchema.parse({
  node: { id: "test", name: "test" },
  agents: {
    front: { name: "Front", tier, workspace: dir },
    other: { name: "Other", tier: "claude-code", workspace: dir },
  },
})
const def = (r: AgentRegistry, id: string) => (r as any).agents.get(id).def

describe("an engine switch without a restart", () => {
  it("an idle agent's next run reads the new tier at once", () => {
    const r = new AgentRegistry(config("claude-code"), () => {})
    r.setConfig(config("codex-cli"))
    expect(def(r, "front").tier).toBe("codex-cli")
    expect(r.tierOf("front")).toBe("codex-cli")
    expect(def(r, "other").tier).toBe("claude-code")
  })

  it("a busy agent keeps its engine until its last run ends", () => {
    const r = new AgentRegistry(config("claude-code"), () => {})
    const state = (r as any).agents.get("front")
    state.activeTasks = 1
    r.setConfig(config("codex-cli"))
    expect(state.def.tier).toBe("claude-code")
    expect(r.tierOf("front")).toBe("codex-cli")
    state.activeTasks = 0
    ;(r as any).applyPendingTier(state)
    expect(state.def.tier).toBe("codex-cli")
  })

  it("switching back before the run ends drops the waiting tier", () => {
    const r = new AgentRegistry(config("claude-code"), () => {})
    const state = (r as any).agents.get("front")
    state.activeTasks = 1
    r.setConfig(config("codex-cli"))
    r.setConfig(config("claude-code"))
    state.activeTasks = 0
    ;(r as any).applyPendingTier(state)
    expect(state.def.tier).toBe("claude-code")
    expect(r.tierOf("front")).toBe("claude-code")
  })

  it("keeps the rest of the running definition as it was", () => {
    const r = new AgentRegistry(config("claude-code"), () => {})
    const before = def(r, "front")
    r.setConfig(config("opencode"))
    expect({ ...def(r, "front"), tier: before.tier }).toEqual(before)
  })
})
