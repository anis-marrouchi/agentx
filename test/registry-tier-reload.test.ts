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

const config = (tier: string, maxConcurrent = 1) => daemonConfigSchema.parse({
  node: { id: "test", name: "test" },
  agents: {
    front: { name: "Front", tier, workspace: dir, maxConcurrent },
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

  it("holds runs queued after the switch until the old runs end, so each starts on the new engine", () => {
    const r = new AgentRegistry(config("claude-code", 2), () => {})
    const state = (r as any).agents.get("front")
    state.activeTasks = 1
    expect((r as any).slotFull(state)).toBe(false)
    r.setConfig(config("codex-cli", 2))
    // A free slot, but no new run may start on the old engine.
    expect((r as any).slotFull(state)).toBe(true)
    expect(r.slotHolders("front")?.full).toBe(true)
    expect(state.def.tier).toBe("claude-code")
    // The last old run ends: the switch lands, the queue may start again.
    state.activeTasks = 0
    ;(r as any).applyPendingTier(state)
    expect((r as any).slotFull(state)).toBe(false)
    expect(state.def.tier).toBe("codex-cli")
    // Another agent is never held by this agent's switch.
    const other = (r as any).agents.get("other")
    expect((r as any).slotFull(other)).toBe(false)
  })

  it("the next run after a switch never resumes the old engine's session", () => {
    const r = new AgentRegistry(config("claude-code"), () => {})
    const sessions = (r as any).sessions
    sessions.setClaudeSessionId("front", "telegram", "42", "claude-sess-1")
    expect(r.resumeIdFor("front", r.tierOf("front")!, "telegram", "42")).toBe("claude-sess-1")
    r.setConfig(config("codex-cli"))
    // Fresh session on the new engine.
    expect(r.resumeIdFor("front", r.tierOf("front")!, "telegram", "42")).toBeUndefined()
    sessions.setCodexSessionId("front", "telegram", "42", "codex-sess-1")
    expect(r.resumeIdFor("front", r.tierOf("front")!, "telegram", "42")).toBe("codex-sess-1")
  })

  it("a reload that changes another field leaves the running definition untouched", () => {
    const r = new AgentRegistry(config("claude-code"), () => {})
    const before = def(r, "front")
    const next = config("claude-code")
    ;(next.agents.front as any).systemPrompt = "changed"
    ;(next.agents.front as any).model = "some-other-model"
    r.setConfig(next)
    expect(def(r, "front")).toBe(before)
  })

  // #2101 B2: an agent running several jobs at once.
  const row = (r: AgentRegistry, id: string) => r.list().find((a) => a.id === id)!
  const endRun = (r: AgentRegistry, state: any) => { state.activeTasks--; (r as any).applyPendingTier(state) }

  it("with two runs going, the switch waits for both and the list shows it waiting", () => {
    const r = new AgentRegistry(config("claude-code", 3), () => {})
    const state = (r as any).agents.get("front")
    state.activeTasks = 2
    r.setConfig(config("codex-cli", 3))
    expect(row(r, "front")).toMatchObject({ tier: "claude-code", pendingTier: "codex-cli", active: 2 })
    expect((r as any).slotFull(state)).toBe(true)
    endRun(r, state)
    // One run still going: still the old engine, still no new run.
    expect(state.def.tier).toBe("claude-code")
    expect(row(r, "front").pendingTier).toBe("codex-cli")
    expect((r as any).slotFull(state)).toBe(true)
    endRun(r, state)
    expect(state.def.tier).toBe("codex-cli")
    expect(row(r, "front").pendingTier).toBeUndefined()
    expect((r as any).slotFull(state)).toBe(false)
    expect(row(r, "other").pendingTier).toBeUndefined()
  })

  it("a run waiting for a slot when the switch is saved starts on the new engine", async () => {
    const r = new AgentRegistry(config("claude-code", 2), () => {})
    const state = (r as any).agents.get("front")
    state.activeTasks = 2
    // A queued run waits on the same gate the queue and the slot wait use.
    const started = (async () => {
      while ((r as any).slotFull(state)) await new Promise((res) => setTimeout(res, 5))
      state.activeTasks++
      return state.def.tier
    })()
    await new Promise((res) => setTimeout(res, 15))
    r.setConfig(config("codex-cli", 2))
    endRun(r, state)
    // A slot is free now, but the run still waits: the old run is going.
    await new Promise((res) => setTimeout(res, 15))
    expect(state.activeTasks).toBe(1)
    endRun(r, state)
    expect(await started).toBe("codex-cli")
  })

  it("switching back to the old engine resumes that engine's earlier session", () => {
    const r = new AgentRegistry(config("claude-code"), () => {})
    const sessions = (r as any).sessions
    sessions.setClaudeSessionId("front", "telegram", "42", "claude-sess-1")
    r.setConfig(config("codex-cli"))
    r.setConfig(config("claude-code"))
    expect(r.resumeIdFor("front", r.tierOf("front")!, "telegram", "42")).toBe("claude-sess-1")
  })
})
