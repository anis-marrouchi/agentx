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
import { recordTraceStart, recordTraceEnd, spendByAgentSince, spendByChatSince, unpricedRunsByAgentSince } from "../src/storage/traces"

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

  it("reads budgets from agentx.json's shape", () => {
    expect(budgetConfigFrom({ agents: { scout: { budget: { monthlyUsd: 40 } }, other: {} }, budget: { monthlyUsd: 90 } }))
      .toEqual({ agents: { scout: { monthlyUsd: 40 } }, projects: {}, fleet: { monthlyUsd: 90 } })
  })

  it("lists every Wall project, with its budget when it has one", () => {
    const cfg = budgetConfigFrom({ dashboard: { wall: { projects: [{ name: "Shop", budget: { monthlyUsd: 20 } }, { name: "Docs" }, { name: "Shop" }] } } })
    expect(cfg.projects).toEqual({ Shop: { monthlyUsd: 20 }, Docs: undefined })
  })

  it("shows projects and runs with no price", () => {
    const v = buildBudgetView(
      { agents: { scout: { monthlyUsd: 40 } }, projects: { Shop: { monthlyUsd: 20 }, Docs: undefined } },
      { scout: 10 },
      "2026-10",
      { Shop: 19 },
      { local: 3 },
    )
    expect(v.projects.map((p) => [p.name, p.state, p.spentUsd])).toEqual([["Shop", "warn", 19], ["Docs", "uncapped", 0]])
    expect(v.agents.find((a) => a.agentId === "local")).toMatchObject({ spentUsd: 0, unpricedRuns: 3, state: "uncapped" })
    expect(v.fleet.unpricedRuns).toBe(3)
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

  it("sums per chat for projects and counts runs with no price", () => {
    const db = openDb({ path: path.join(tmp, "db.sqlite") })!
    const run = (agentId: string, chatId: string, costUsd?: number, inputTokens = 100) => {
      const id = recordTraceStart(db, { agentId, channel: "github", chatId })
      recordTraceEnd(db, id, { status: "ok", costUsd, inputTokens, outputTokens: inputTokens ? 10 : 0 })
    }
    run("dev", "acme/shop:issue:1", 0.5)
    run("dev", "acme/shop:issue:1", 0.25)
    run("local", "c", undefined)
    run("local", "c", undefined)
    run("local", "c", undefined, 0) // no tokens: a failed start, not an unpriced run
    expect(spendByChatSince(db, monthStart())).toEqual([{ agentId: "dev", chatId: "acme/shop:issue:1", usd: 0.75 }])
    expect(unpricedRunsByAgentSince(db, monthStart())).toEqual({ local: 2 })
  })
})

describe("which runs are priced from tokens", () => {
  it("prices Claude and listed API models, not local ones", async () => {
    const { isPricedModel } = await import("../src/daemon/token-tracker")
    expect(isPricedModel("claude-sonnet-4-6")).toBe(true)
    expect(isPricedModel("opus")).toBe(true)
    expect(isPricedModel(undefined, "claude-code")).toBe(true)
    expect(isPricedModel("gpt-5-codex", "codex-cli")).toBe(true)
    expect(isPricedModel("gemini-2.5-pro", "sdk")).toBe(true)
    // Not in the table: no guess from a near name.
    expect(isPricedModel("gpt-5.5", "codex-cli")).toBe(false)
    expect(isPricedModel("qwen3:32b", "sdk")).toBe(false)
    expect(isPricedModel(undefined, "codex-cli")).toBe(false)
  })

  it("maps an API model id to its list price, longest name first", async () => {
    const { apiModelFamily } = await import("../src/daemon/token-tracker")
    expect(apiModelFamily("gpt-5-mini-2025-08-07")).toBe("gpt-5-mini")
    expect(apiModelFamily("openai/gpt-4.1")).toBe("gpt-4.1")
    expect(apiModelFamily("gemini-2.5-flash-lite")).toBe("gemini-2.5-flash-lite")
    expect(apiModelFamily("gemini-2.5-flash")).toBe("gemini-2.5-flash")
    expect(apiModelFamily("gpt-5.5")).toBeNull()
    expect(apiModelFamily("claude-sonnet-4-6")).toBeNull()
  })

  it("costs an API run at its flat list price and a local run at nothing", async () => {
    const { TokenTracker } = await import("../src/daemon/token-tracker")
    const t = new TokenTracker(path.join(mkdtempSync(path.join(tmpdir(), "agentx-price-")), "usage"))
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheCreateTokens: 0 }
    // gpt-5: $1.25 in + $1.00 out + $0.125 cached
    expect(t.runCost(usage, "gpt-5", "codex-cli")).toBeCloseTo(2.375, 6)
    // No long-prompt surcharge for an API model, even past 200K input.
    expect(t.runCost({ ...usage, outputTokens: 0, cacheReadTokens: 0 }, "gemini-2.5-flash", "sdk")).toBeCloseTo(0.3, 6)
    expect(t.runCost(usage, "llama3.1:8b", "sdk")).toBeUndefined()
    expect(t.runCost({ inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }, "claude-sonnet-4-6", "claude-code")).toBeCloseTo(0.003, 6)
  })
})

describe("project budgets", () => {
  it("warn at 80%, pause the project's runs at 100%, and leave other work alone", () => {
    setAgentBudgets({ projects: { Shop: { monthlyUsd: 10 } } })
    expect(recordAgentSpend("dev", 8, OCT, "Shop").map((n) => [n.kind, n.scope])).toEqual([["warn", "project:Shop"]])
    expect(preflightBudgetGate("dev", OCT, "Shop")).toBeNull()
    const capped = recordAgentSpend("dev", 2, OCT, "Shop")
    expect(capped.map((n) => n.kind)).toEqual(["cap"])
    expect(capped[0].message).toContain("Project Shop")
    const gate = preflightBudgetGate("dev", OCT, "Shop")
    expect(gate).toMatchObject({ reason: "project_budget" })
    expect(gate!.message).toContain("the Wall's Cost page")
    // The same agent on another project, or none, still runs.
    expect(preflightBudgetGate("dev", OCT, "Docs")).toBeNull()
    expect(preflightBudgetGate("dev", OCT)).toBeNull()
  })

  it("seeds project spend at boot without repeating the notice", () => {
    setAgentBudgets({ projects: { Shop: { monthlyUsd: 10 } } })
    seedMonthSpend({ dev: 9 }, OCT, { Shop: 9 })
    expect(recordAgentSpend("dev", 0.5, OCT, "Shop")).toEqual([])
    expect(recordAgentSpend("dev", 0.5, OCT, "Shop").map((n) => n.kind)).toEqual(["cap"])
  })

  it("maps a run to its project the way the Wall does: repo, then agent", async () => {
    const { budgetProjectResolver, spendByProject } = await import("../src/agents/budget-projects")
    const resolve = budgetProjectResolver({
      agents: { dev: { workspace: "/tmp/x" }, desk: { workspace: "/tmp/y" } },
      dashboard: { wall: { projects: [{ name: "Shop", repos: ["acme/shop"] }, { name: "Support", agents: ["desk"] }] } },
    })
    expect(resolve("dev", "acme/shop:issue:12")).toBe("Shop")
    expect(resolve("desk", "acme/shop:pull:3")).toBe("Shop")
    expect(resolve("desk", "telegram-123")).toBe("Support")
    expect(resolve("dev", "telegram-123")).toBeNull()
    expect(spendByProject([
      { agentId: "dev", chatId: "acme/shop:issue:12", usd: 2 },
      { agentId: "desk", chatId: "c", usd: 1 },
      { agentId: "dev", chatId: null, usd: 5 },
    ], resolve)).toEqual({ Shop: 2, Support: 1 })
  })
})
