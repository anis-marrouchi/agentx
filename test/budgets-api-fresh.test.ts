import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { currentBudgetSource } from "../src/daemon/observability-panel"
import { updateBudget } from "../src/daemon/budget-settings"
import { budgetConfigFrom } from "../src/agents/agent-budget"
import type { DaemonConfig } from "../src/daemon/config"

// The budgets API reads agentx.json on each request (#1295), so a budget
// saved after the dashboard started shows on the card.

let dir: string
let file: string
let startup: DaemonConfig

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-budgets-fresh-"))
  file = join(dir, "agentx.json")
  startup = {
    node: { id: "t", name: "t" },
    agents: { scout: { name: "Scout", workspace: dir, budget: { monthlyUsd: 40 } } },
    dashboard: { wall: { projects: [{ name: "Shop", repos: ["acme/shop"] }] } },
  } as unknown as DaemonConfig
  writeFileSync(file, JSON.stringify(startup))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("currentBudgetSource", () => {
  it("sees a budget saved after startup", async () => {
    expect((await updateBudget({ scope: "project", id: "Shop", monthlyUsd: 25 }, { configPath: file, reload: false })).success).toBe(true)
    expect((await updateBudget({ scope: "agent", id: "scout", monthlyUsd: 80 }, { configPath: file, reload: false })).success).toBe(true)
    const cfg = budgetConfigFrom(currentBudgetSource(startup, file)!)
    expect(cfg.projects?.Shop).toEqual({ monthlyUsd: 25 })
    expect(cfg.agents?.scout).toEqual({ monthlyUsd: 80 })
  })

  it("falls back to the config in hand when the file is half-written", () => {
    writeFileSync(file, "{ \"agents\": ")
    expect(currentBudgetSource(startup, file)).toBe(startup)
  })

  it("falls back when the file is missing", () => {
    rmSync(file)
    expect(currentBudgetSource(startup, file)).toBe(startup)
  })
})
