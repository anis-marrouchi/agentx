import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { Readable } from "stream"
import type { IncomingMessage, ServerResponse } from "http"
import { tmpdir } from "os"
import { join } from "path"

// #2101 B1 (DevOps review on 3a32df5): the Hub's CLI switch changed the engine
// but kept a Claude model, so the next Codex run got `--model claude-opus-5-5`
// and failed. The model now goes over with the tier: one the new engine
// cannot run is dropped and the engine's default is used.

const run = vi.hoisted(() => ({ calls: [] as Array<{ tier: string; model?: string }> }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (agent: any, task: any) => {
      run.calls.push({ tier: agent.tier, model: task.model || agent.model })
      return Promise.resolve({ content: "ok", duration: 1 })
    },
  }
})

import { AgentRegistry } from "../src/agents/registry"
import { modelFitsEngine, modelAfterSwitch } from "../src/agents/engine-model"
import { daemonConfigSchema } from "../src/daemon/config"
import { handleAdminApi } from "../src/daemon/admin-panel"

let dir: string
const prevCwd = process.cwd()
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-engine-model-"))
  process.chdir(dir)
  run.calls = []
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

const config = (tier: string, model?: string) => daemonConfigSchema.parse({
  node: { id: "test", name: "test" },
  jobState: { enabled: false },
  agents: { front: { name: "Front", tier, workspace: dir, ...(model ? { model } : {}) } },
})
const state = (r: AgentRegistry) => (r as any).agents.get("front")

describe("which engine can run which model", () => {
  it("Claude ids and aliases on Claude Code and the SDK only", () => {
    for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "opus", "sonnet", "haiku", "fable"]) {
      expect(modelFitsEngine(m, "claude-code")).toBe(true)
      expect(modelFitsEngine(m, "sdk")).toBe(true)
      expect(modelFitsEngine(m, "codex-cli")).toBe(false)
      expect(modelFitsEngine(m, "opencode")).toBe(false)
    }
  })
  it("Codex models on Codex CLI, provider/model on OpenCode", () => {
    expect(modelFitsEngine("gpt-5-codex", "codex-cli")).toBe(true)
    expect(modelFitsEngine("gpt-5-codex", "claude-code")).toBe(false)
    expect(modelFitsEngine("anthropic/claude-opus-5-5", "opencode")).toBe(true)
    expect(modelFitsEngine("anthropic/claude-opus-5-5", "codex-cli")).toBe(false)
  })
  it("no model always fits; the orchestrator keeps any model", () => {
    expect(modelFitsEngine(undefined, "codex-cli")).toBe(true)
    expect(modelFitsEngine("claude-opus-5-5", "orchestrator")).toBe(true)
    expect(modelAfterSwitch("claude-opus-5-5", "codex-cli")).toBeUndefined()
    expect(modelAfterSwitch("claude-opus-5-5", "claude-code")).toBe("claude-opus-5-5")
  })
})

describe("an engine switch takes the model with it", () => {
  it("a run after a switch to Codex CLI with a Claude model saved gets no Claude model", async () => {
    const r = new AgentRegistry(config("claude-code", "claude-opus-5-5"), () => {})
    await r.execute({ agentId: "front", message: "before", context: { channel: "api", chatId: "c1" } as any })
    expect(run.calls.at(-1)).toEqual({ tier: "claude-code", model: "claude-opus-5-5" })

    // The config still holds the Claude model (a hand edit, or a save from
    // before this fix): the registry drops it anyway.
    r.setConfig(config("codex-cli", "claude-opus-5-5"))
    await r.execute({ agentId: "front", message: "after", context: { channel: "api", chatId: "c2" } as any })
    const after = run.calls.at(-1)!
    expect(after.tier).toBe("codex-cli")
    expect(after.model ?? "").not.toMatch(/^claude/)
  })

  it("a busy agent takes the model with the tier when its last run ends", () => {
    const r = new AgentRegistry(config("claude-code", "claude-opus-5-5"), () => {})
    const s = state(r)
    s.activeTasks = 1
    r.setConfig(config("codex-cli", "claude-opus-5-5"))
    expect(s.def).toMatchObject({ tier: "claude-code", model: "claude-opus-5-5" })
    s.activeTasks = 0
    ;(r as any).applyPendingTier(s)
    expect(s.def.tier).toBe("codex-cli")
    expect(s.def.model).toBeUndefined()
  })

  it("a model the new engine can run is kept, and switching back restores the saved one", () => {
    const r = new AgentRegistry(config("claude-code", "claude-opus-5-5"), () => {})
    r.setConfig(config("codex-cli", "gpt-5-codex"))
    expect(state(r).def).toMatchObject({ tier: "codex-cli", model: "gpt-5-codex" })
    r.setConfig(config("claude-code", "claude-sonnet-5-5"))
    expect(state(r).def).toMatchObject({ tier: "claude-code", model: "claude-sonnet-5-5" })
  })
})

describe("the saved config drops the model with the switch", () => {
  const write = (agent: Record<string, unknown>) =>
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({ node: { id: "t", name: "t" }, agents: { front: { name: "Front", workspace: dir, ...agent } } }))
  const saved = () => JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8")).agents.front
  async function patch(p: Record<string, unknown>): Promise<number> {
    const req = Object.assign(Readable.from([JSON.stringify({ id: "front", patch: p })]), { method: "PATCH" }) as unknown as IncomingMessage
    let status = 200
    const res = { writeHead: (s: number) => { status = s; return res }, end: () => {} } as unknown as ServerResponse
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
    try { await handleAdminApi(req, res, "/api/admin/agents", { owner: true }) } finally { fetchMock.mockRestore() }
    return status
  }

  it("the Hub's { tier } save to Codex CLI clears a Claude model", async () => {
    write({ tier: "claude-code", model: "claude-opus-5-5" })
    expect(await patch({ tier: "codex-cli" })).toBe(200)
    expect(saved().tier).toBe("codex-cli")
    expect(saved().model).toBeUndefined()
  })

  it("keeps a model the new engine runs, and a model picked in the same save", async () => {
    write({ tier: "codex-cli", model: "gpt-5-codex" })
    await patch({ tier: "orchestrator" })
    expect(saved().model).toBe("gpt-5-codex")
    write({ tier: "claude-code", model: "claude-opus-5-5" })
    await patch({ tier: "codex-cli", model: "gpt-5-codex" })
    expect(saved()).toMatchObject({ tier: "codex-cli", model: "gpt-5-codex" })
  })
})
