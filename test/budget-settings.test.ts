import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { budgetPatchProblem, updateBudget } from "../src/daemon/budget-settings"

// Budgets set and raised from the Cost page land in agentx.json (#1290).

let dir: string
let file: string
const read = () => JSON.parse(readFileSync(file, "utf-8"))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-budget-settings-"))
  file = join(dir, "agentx.json")
  writeFileSync(file, JSON.stringify({
    node: { id: "t", name: "t" },
    agents: { scout: { name: "Scout", workspace: dir, budget: { monthlyUsd: 40, warnRatio: 0.9 } }, desk: { name: "Desk", workspace: dir } },
    dashboard: { wall: { projects: [{ name: "Shop", repos: ["acme/shop"] }] } },
  }))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const save = (patch: Parameters<typeof updateBudget>[0]) => updateBudget(patch, { configPath: file, reload: false })

describe("updateBudget", () => {
  it("raises an agent's cap and keeps its warn line", async () => {
    expect((await save({ scope: "agent", id: "scout", monthlyUsd: 80 })).success).toBe(true)
    expect(read().agents.scout.budget).toEqual({ monthlyUsd: 80, warnRatio: 0.9 })
  })

  it("sets a cap on an agent, a project and the fleet", async () => {
    await save({ scope: "agent", id: "desk", monthlyUsd: 5 })
    await save({ scope: "project", id: "Shop", monthlyUsd: 25 })
    await save({ scope: "fleet", monthlyUsd: 100 })
    const cfg = read()
    expect(cfg.agents.desk.budget).toEqual({ monthlyUsd: 5 })
    expect(cfg.dashboard.wall.projects[0].budget).toEqual({ monthlyUsd: 25 })
    expect(cfg.budget).toEqual({ monthlyUsd: 100 })
  })

  it("removes a cap with null", async () => {
    await save({ scope: "agent", id: "scout", monthlyUsd: null })
    expect(read().agents.scout.budget).toBeUndefined()
  })

  it("refuses an unknown agent or project and writes nothing", async () => {
    const before = readFileSync(file, "utf-8")
    expect((await save({ scope: "agent", id: "ghost", monthlyUsd: 5 })).error).toContain('no agent "ghost"')
    expect((await save({ scope: "project", id: "Nope", monthlyUsd: 5 })).error).toContain('no project "Nope"')
    expect(readFileSync(file, "utf-8")).toBe(before)
  })
})

describe("budgetPatchProblem", () => {
  it("accepts a good patch and names what is wrong with a bad one", () => {
    expect(budgetPatchProblem({ scope: "fleet", monthlyUsd: 50 })).toBeNull()
    expect(budgetPatchProblem({ scope: "agent", id: "scout", monthlyUsd: null })).toBeNull()
    expect(budgetPatchProblem({ scope: "team", monthlyUsd: 1 })).toContain("scope")
    expect(budgetPatchProblem({ scope: "agent", monthlyUsd: 1 })).toContain("agent id")
    expect(budgetPatchProblem({ scope: "fleet", monthlyUsd: -1 })).toContain("monthlyUsd")
    expect(budgetPatchProblem({ scope: "fleet", monthlyUsd: "10" })).toContain("monthlyUsd")
    expect(budgetPatchProblem({ scope: "fleet", monthlyUsd: 10, warnRatio: 2 })).toContain("warnRatio")
  })
})
