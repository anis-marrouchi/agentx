import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"
import { createCard, decideCard, listCards, readCard } from "../src/approvals/cards"
import { listInbox } from "../src/approvals/inbox"
import { budgetMonth, budgetRows, checkBudget, monthSpendUsd, monthlyLimit, readBudgetState, type BudgetCheckDeps } from "../src/agents/budget"
import { daemonConfigSchema } from "../src/daemon/config"

// Monthly dollar budget per agent (#1167). What must hold:
//   - under 80% nothing happens
//   - at 80% the owner gets one Desk card, once per month and limit
//   - at 100% the next task is held with a reason, and one hold card asks
//     whether to allow one more run; each yes lets exactly one run through
//   - a new month, or a new limit, starts over
//   - spend unreadable never holds a task
//   - spend is the Cost page's number for the agent, this month only

const OCT = Date.parse("2026-10-20T12:00:00.000Z")
const NOV = Date.parse("2026-11-01T00:00:05.000Z")
let root: string
let spend: number | null
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentx-budget-")); spend = 0 })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function deps(now = OCT): BudgetCheckDeps {
  return {
    root,
    now,
    spend: () => spend,
    readCard: (id) => readCard(root, id),
    raiseCard: (input, origin) => {
      const r = createCard(root, input, { origin, now })
      if (!r.ok) throw new Error(r.error)
      return r.card.id
    },
  }
}

const budgetCards = () => listCards(root).filter((c) => c.origin?.kind === "budget")

describe("monthly budget check", () => {
  it("does nothing without a limit or under 80%", () => {
    spend = 50
    expect(checkBudget("writer", undefined, deps())).toEqual({ hold: false })
    spend = 0.79
    expect(checkBudget("writer", 1, deps()).hold).toBe(false)
    expect(budgetCards()).toHaveLength(0)
  })

  it("sends one notice at $0.85 of $1 and holds the next task at $1.00", () => {
    spend = 0.85
    expect(checkBudget("writer", 1, deps()).hold).toBe(false)
    expect(checkBudget("writer", 1, deps()).hold).toBe(false)
    const notices = budgetCards()
    expect(notices).toHaveLength(1)
    expect(notices[0].title).toBe("writer has used 85% of its monthly budget")
    expect(notices[0].origin).toEqual({ kind: "budget", agentId: "writer", month: "2026-10", level: "notice" })

    spend = 1
    const held = checkBudget("writer", 1, deps())
    expect(held.hold).toBe(true)
    if (held.hold) {
      expect(held.message).toContain("reached its monthly limit")
      expect(held.message).toContain("$1.00 of its $1.00 budget for October")
    }
    const holds = budgetCards().filter((c) => c.origin?.kind === "budget" && c.origin.level === "hold")
    expect(holds).toHaveLength(1)
    expect(holds[0].ask).toMatch(/Allow one more run\?$/)
    // Still waiting for the owner: held again, no second card.
    expect(checkBudget("writer", 1, deps()).hold).toBe(true)
    expect(budgetCards()).toHaveLength(2)
  })

  it("skips the notice when spend jumps straight past the limit", () => {
    spend = 3
    expect(checkBudget("writer", 1, deps()).hold).toBe(true)
    const cards = budgetCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].origin).toMatchObject({ level: "hold" })
  })

  it("lets exactly one run through for each yes, then asks again", () => {
    spend = 1.2
    checkBudget("writer", 1, deps())
    const first = readBudgetState(root).writer.hold!
    expect(decideCard(root, first, "yes", { now: OCT }).ok).toBe(true)
    expect(checkBudget("writer", 1, deps()).hold).toBe(false)
    // The yes is used: the next task is held and a fresh card asks.
    expect(checkBudget("writer", 1, deps()).hold).toBe(true)
    const second = readBudgetState(root).writer.hold!
    expect(second).not.toBe(first)
    expect(readCard(root, second)?.status).toBe("pending")
  })

  it("keeps holding after a no without asking again", () => {
    spend = 1.2
    checkBudget("writer", 1, deps())
    const id = readBudgetState(root).writer.hold!
    decideCard(root, id, "no", { now: OCT })
    expect(checkBudget("writer", 1, deps()).hold).toBe(true)
    expect(checkBudget("writer", 1, deps()).hold).toBe(true)
    expect(budgetCards()).toHaveLength(1)
  })

  it("holds from 80% when the owner answers no on the notice", () => {
    spend = 0.9
    checkBudget("writer", 1, deps())
    decideCard(root, readBudgetState(root).writer.notice!, "no", { now: OCT })
    const held = checkBudget("writer", 1, deps())
    expect(held.hold).toBe(true)
    if (held.hold) expect(held.message).toContain("80% notice")
  })

  it("starts over when the limit is raised", () => {
    spend = 1
    expect(checkBudget("writer", 1, deps()).hold).toBe(true)
    expect(checkBudget("writer", 2, deps()).hold).toBe(false)
    // 80% of the new limit gets its own notice.
    spend = 1.7
    expect(checkBudget("writer", 2, deps()).hold).toBe(false)
    expect(budgetCards().filter((c) => c.origin?.kind === "budget" && c.origin.level === "notice")).toHaveLength(1)
  })

  it("starts over at the month rollover", () => {
    spend = 1.5
    expect(checkBudget("writer", 1, deps(OCT)).hold).toBe(true)
    // November: the spend lookup is per month, so it starts from zero.
    spend = 0
    expect(checkBudget("writer", 1, deps(NOV)).hold).toBe(false)
    spend = 0.8
    expect(checkBudget("writer", 1, deps(NOV)).hold).toBe(false)
    expect(readBudgetState(root).writer).toMatchObject({ month: "2026-11", limitUsd: 1 })
    expect(budgetCards().filter((c) => c.origin?.kind === "budget" && c.origin.month === "2026-11")).toHaveLength(1)
  })

  it("never holds when spend can't be read", () => {
    spend = null
    expect(checkBudget("writer", 1, deps()).hold).toBe(false)
  })

  it("shows the budget's own yes and no on the Desk", () => {
    spend = 1
    checkBudget("writer", 1, deps())
    const item = listInbox({ root, now: OCT }, { kinds: ["card"] }).items.find((i) => i.kind === "card")
    expect(item).toMatchObject({ yes: "allow one more run", no: "keep holding its new tasks" })
  })
})

describe("monthly spend", () => {
  function db(): Database.Database {
    const d = new Database(":memory:")
    d.exec(`CREATE TABLE usage_daily (
      agent_id TEXT, model TEXT, day TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_create_tokens INTEGER DEFAULT 0,
      tier2_input_tokens INTEGER DEFAULT 0, tier2_output_tokens INTEGER DEFAULT 0,
      tier2_cache_read_tokens INTEGER DEFAULT 0, tier2_cache_create_tokens INTEGER DEFAULT 0,
      tasks INTEGER DEFAULT 0)`)
    const add = d.prepare(`INSERT INTO usage_daily (agent_id, model, day, output_tokens) VALUES (?, ?, ?, ?)`)
    // Sonnet output is $15 per million tokens.
    add.run("writer", "claude-sonnet-5-5", "2026-09-30", 1_000_000)
    add.run("writer", "claude-sonnet-5-5", "2026-10-01", 40_000)
    add.run("writer", "claude-sonnet-5-5", "2026-10-31", 20_000)
    add.run("writer", "gpt-5", "2026-10-10", 1_000_000)
    add.run("other", "claude-sonnet-5-5", "2026-10-10", 1_000_000)
    add.run("writer", "claude-sonnet-5-5", "2026-11-01", 1_000_000)
    return d
  }

  it("counts this month only, priced as the Cost page prices it", () => {
    const d = db()
    expect(monthSpendUsd(d, "writer", "2026-10")).toBeCloseTo(0.9, 6)
    expect(monthSpendUsd(d, "writer", budgetMonth(Date.parse("2026-12-15T00:00:00Z")))).toBe(0)
  })

  it("lists spend against budget for the Cost page", () => {
    const rows = budgetRows(db(), { writer: 1, other: 100 }, OCT)
    expect(rows.map((r) => [r.agent_id, r.status])).toEqual([["writer", "notice"], ["other", "ok"]])
    expect(rows[0].spentUsd).toBeCloseTo(0.9, 6)
  })
})

describe("budget setting", () => {
  it("is optional and read only when above zero", () => {
    const agent = (extra: object) => ({ name: "A", tier: "claude-code", workspace: "/tmp/a", ...extra })
    const parse = (agents: object) => daemonConfigSchema.parse({ node: { id: "n", name: "n" }, agents })
    const cfg = parse({ a: agent({ budget: { monthlyUsd: 25 } }), b: agent({}) })
    expect(monthlyLimit(cfg.agents.a)).toBe(25)
    expect(monthlyLimit(cfg.agents.b)).toBeUndefined()
    expect(monthlyLimit({ budget: { monthlyUsd: 0 } })).toBeUndefined()
    expect(() => parse({ a: agent({ budget: { monthlyUsd: -1 } }) })).toThrow()
  })
})
