import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  buildBudgetView,
  budgetConfigFrom,
  clearAgentSpend,
  getBudgetView,
  monthKey,
  monthStart,
  preflightBudgetGate,
  recordAgentSpend,
  seedMonthSpend,
  setAgentBudgets,
} from "../src/agents/agent-budget"
import { openDb, closeDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd, spendByAgentSince } from "../src/storage/traces"

const OCT = Date.UTC(2026, 9, 10, 12)
const NOV = Date.UTC(2026, 10, 1, 0, 0, 1)

beforeEach(() => {
  clearAgentSpend()
  setAgentBudgets({ agents: { scout: { monthlyUsd: 40, warnRatio: 0.8 } } })
})

describe("monthly agent budget", () => {
  it("lets runs through under the cap", () => {
    expect(recordAgentSpend("scout", 10, OCT)).toEqual([])
    expect(preflightBudgetGate("scout", OCT)).toBeNull()
  })

  it("warns once at 80%, not on every run after", () => {
    const first = recordAgentSpend("scout", 32, OCT)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ kind: "warn", scope: "scout", capUsd: 40 })
    expect(first[0].message).toContain("$32.00 of its $40.00")
    expect(recordAgentSpend("scout", 1, OCT)).toEqual([])
    expect(recordAgentSpend("scout", 1, OCT)).toEqual([])
    expect(preflightBudgetGate("scout", OCT)).toBeNull()
  })

  it("refuses new runs at 100% with the reason, and tells the owner once", () => {
    recordAgentSpend("scout", 32, OCT)
    const capped = recordAgentSpend("scout", 8, OCT)
    expect(capped.map((n) => n.kind)).toEqual(["cap"])
    const gate = preflightBudgetGate("scout", OCT)
    expect(gate).toMatchObject({ abort: true, reason: "agent_budget" })
    expect(gate!.message).toContain("agents.scout.budget.monthlyUsd")
    expect(gate!.message).toContain("2026-10")
    expect(recordAgentSpend("scout", 1, OCT)).toEqual([])
  })

  it("a run that jumps straight past the cap sends the cap notice only", () => {
    expect(recordAgentSpend("scout", 50, OCT).map((n) => n.kind)).toEqual(["cap"])
  })

  it("resumes when the month turns", () => {
    recordAgentSpend("scout", 40, OCT)
    expect(preflightBudgetGate("scout", OCT)).not.toBeNull()
    expect(preflightBudgetGate("scout", NOV)).toBeNull()
    expect(getBudgetView(NOV).agents.find((a) => a.agentId === "scout")?.spentUsd).toBe(0)
    // A new month warns again.
    expect(recordAgentSpend("scout", 33, NOV).map((n) => n.kind)).toEqual(["warn"])
  })

  it("resumes when the cap is raised", () => {
    recordAgentSpend("scout", 40, OCT)
    expect(preflightBudgetGate("scout", OCT)).not.toBeNull()
    setAgentBudgets({ agents: { scout: { monthlyUsd: 100 } } })
    expect(preflightBudgetGate("scout", OCT)).toBeNull()
  })

  it("leaves agents without a cap alone", () => {
    expect(recordAgentSpend("helper", 1000, OCT)).toEqual([])
    expect(preflightBudgetGate("helper", OCT)).toBeNull()
  })

  it("ignores runs with no known cost", () => {
    expect(recordAgentSpend("scout", undefined, OCT)).toEqual([])
    expect(recordAgentSpend("scout", Number.NaN, OCT)).toEqual([])
    expect(getBudgetView(OCT).agents[0].spentUsd).toBe(0)
  })

  it("pauses a $0.01 agent after its first paid run", () => {
    setAgentBudgets({ agents: { probe: { monthlyUsd: 0.01 } } })
    expect(preflightBudgetGate("probe", OCT)).toBeNull()
    recordAgentSpend("probe", 0.0123, OCT)
    expect(preflightBudgetGate("probe", OCT)?.message).toContain("$0.0123 of its $0.01")
  })

  it("a fleet cap pauses every agent", () => {
    setAgentBudgets({ fleet: { monthlyUsd: 10 } })
    recordAgentSpend("a", 6, OCT)
    const n = recordAgentSpend("b", 4, OCT)
    expect(n).toEqual([expect.objectContaining({ kind: "cap", scope: "fleet" })])
    expect(preflightBudgetGate("c", OCT)).toMatchObject({ reason: "fleet_budget" })
  })

  it("a restart does not repeat a notice already crossed", () => {
    seedMonthSpend({ scout: 35 }, OCT)
    expect(recordAgentSpend("scout", 1, OCT)).toEqual([])
    expect(recordAgentSpend("scout", 4, OCT).map((n) => n.kind)).toEqual(["cap"])
  })
})

describe("monthly project budget", () => {
  beforeEach(() => {
    setAgentBudgets({ projects: { "acme/site": { monthlyUsd: 10, warnRatio: 0.8, agents: ["coder", "qa"] } } })
  })

  it("adds the project's agents together and warns once at 80%", () => {
    expect(recordAgentSpend("coder", 5, OCT)).toEqual([])
    const n = recordAgentSpend("qa", 3, OCT)
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ kind: "warn", scope: "project:acme/site", capUsd: 10 })
    expect(n[0].title).toBe("Project acme/site is near its monthly budget")
    expect(n[0].message).toContain("budget.projects.acme/site.monthlyUsd")
    expect(recordAgentSpend("qa", 0.5, OCT)).toEqual([])
  })

  it("pauses every agent of the project at the cap, and only them", () => {
    recordAgentSpend("coder", 6, OCT)
    const n = recordAgentSpend("qa", 4, OCT)
    expect(n.map((x) => [x.kind, x.scope])).toEqual([["cap", "project:acme/site"]])
    expect(n[0].message).toContain("Every agent of the project is paused")
    for (const id of ["coder", "qa"]) {
      const gate = preflightBudgetGate(id, OCT)
      expect(gate).toMatchObject({ abort: true, reason: "project_budget" })
      expect(gate!.message).toContain("raise budget.projects.acme/site.monthlyUsd")
    }
    expect(preflightBudgetGate("writer", OCT)).toBeNull()
  })

  it("an outside agent's spend does not count", () => {
    recordAgentSpend("writer", 50, OCT)
    expect(preflightBudgetGate("coder", OCT)).toBeNull()
  })

  it("resumes on a new month or a raised cap", () => {
    recordAgentSpend("coder", 10, OCT)
    expect(preflightBudgetGate("qa", OCT)).not.toBeNull()
    expect(preflightBudgetGate("qa", NOV)).toBeNull()
    recordAgentSpend("coder", 10, NOV)
    setAgentBudgets({ projects: { "acme/site": { monthlyUsd: 20, agents: ["coder", "qa"] } } })
    expect(preflightBudgetGate("qa", NOV)).toBeNull()
  })

  it("an agent's own cap still applies inside a project", () => {
    setAgentBudgets({
      agents: { coder: { monthlyUsd: 2 } },
      projects: { "acme/site": { monthlyUsd: 10, agents: ["coder", "qa"] } },
    })
    recordAgentSpend("coder", 2, OCT)
    expect(preflightBudgetGate("coder", OCT)).toMatchObject({ reason: "agent_budget" })
    expect(preflightBudgetGate("qa", OCT)).toBeNull()
  })

  it("a restart does not repeat a project notice already crossed", () => {
    seedMonthSpend({ coder: 5, qa: 3.5 }, OCT)
    expect(recordAgentSpend("qa", 0.5, OCT)).toEqual([])
    expect(recordAgentSpend("qa", 1, OCT).map((x) => x.kind)).toEqual(["cap"])
  })
})

describe("budget view", () => {
  it("shows spend vs cap per agent, fullest first", () => {
    const v = buildBudgetView(
      { agents: { scout: { monthlyUsd: 40 }, idle: { monthlyUsd: 5 } }, fleet: { monthlyUsd: 100 } },
      { scout: 34, helper: 3 },
      "2026-10",
    )
    expect(v.month).toBe("2026-10")
    expect(v.agents.map((a) => [a.agentId, a.state])).toEqual([["scout", "warn"], ["idle", "ok"], ["helper", "uncapped"]])
    expect(v.fleet).toMatchObject({ spentUsd: 37, capUsd: 100, state: "ok" })
  })

  it("shows each capped project with its members", () => {
    const v = buildBudgetView(
      { projects: { site: { monthlyUsd: 10, agents: ["coder", "qa"] }, docs: { monthlyUsd: 100, agents: ["writer"] }, free: { agents: ["x"] } } },
      { coder: 6, qa: 3, writer: 1 },
      "2026-10",
    )
    expect(v.projects.map((p) => [p.project, p.spentUsd, p.state])).toEqual([["site", 9, "warn"], ["docs", 1, "ok"]])
    expect(v.projects[0].agents).toEqual(["coder", "qa"])
  })

  it("resolves a project's members from its list and its team", () => {
    const cfg = budgetConfigFrom({
      agents: { coder: { team: "dev" }, qa: { team: "dev" }, writer: {} },
      budget: { monthlyUsd: 90, projects: { site: { monthlyUsd: 10, agents: ["writer"], team: "dev" } } },
    })
    expect(cfg.fleet).toEqual({ monthlyUsd: 90 })
    expect(cfg.projects).toEqual({ site: { monthlyUsd: 10, warnRatio: undefined, agents: ["coder", "qa", "writer"] } })
  })

  it("reads budgets from agentx.json's shape", () => {
    expect(budgetConfigFrom({ agents: { scout: { budget: { monthlyUsd: 40 } }, other: {} }, budget: { monthlyUsd: 90 } }))
      .toEqual({ agents: { scout: { monthlyUsd: 40 } }, fleet: { monthlyUsd: 90 } })
  })

  it("names the UTC month", () => {
    expect(monthKey(Date.UTC(2026, 11, 31, 23, 59))).toBe("2026-12")
    expect(monthStart(OCT)).toBe(Date.UTC(2026, 9, 1))
  })
})

describe("trace sum", () => {
  let tmp: string
  beforeEach(() => { closeDb(); tmp = mkdtempSync(path.join(tmpdir(), "agentx-budget-")) })
  afterEach(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }) })

  it("sums each agent's recorded run cost since the month start", () => {
    const db = openDb({ path: path.join(tmp, "db.sqlite") })!
    const run = (agentId: string, costUsd?: number) => {
      const id = recordTraceStart(db, { agentId, channel: "cron", chatId: "c" })
      recordTraceEnd(db, id, { status: "ok", costUsd })
    }
    run("scout", 0.5)
    run("scout", 0.25)
    run("helper", 1)
    run("helper")
    expect(spendByAgentSince(db, monthStart())).toEqual({ scout: 0.75, helper: 1 })
    expect(spendByAgentSince(db, Date.now() + 60_000)).toEqual({})
  })
})

describe("which runs are priced from tokens", () => {
  it("prices Claude models only", async () => {
    const { isPricedModel } = await import("../src/daemon/token-tracker")
    expect(isPricedModel("claude-sonnet-4-6")).toBe(true)
    expect(isPricedModel("opus")).toBe(true)
    expect(isPricedModel(undefined, "claude-code")).toBe(true)
    expect(isPricedModel("gpt-5.5", "codex-cli")).toBe(false)
    expect(isPricedModel("gemini-2.5-pro", "sdk")).toBe(false)
    expect(isPricedModel("qwen3:32b", "sdk")).toBe(false)
    expect(isPricedModel(undefined, "codex-cli")).toBe(false)
  })
})
