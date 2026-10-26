import { describe, expect, it } from "vitest"
import { profileSpendHtml } from "../src/daemon/ui/pages/wall-spend"
import { buildBudgetView } from "../src/agents/agent-budget"
import { renderWallPage, WALL_CLASSIC_LINKS } from "../src/daemon/ui/pages/wall"
import { injectFns } from "../src/daemon/ui/inject"

// Month spend against the cap on the Wall agent profile (#1393), from the
// same rows /cost's "Monthly budgets" card reads.

const view = (spent: number, cap?: number, extra: { unpriced?: number; fleetCap?: number } = {}) =>
  buildBudgetView(
    { agents: cap ? { coder: { monthlyUsd: cap } } : {}, ...(extra.fleetCap ? { fleet: { monthlyUsd: extra.fleetCap } } : {}) },
    spent ? { coder: spent } : {},
    "2026-10",
    {},
    extra.unpriced ? { coder: extra.unpriced } : {},
  )

describe("profileSpendHtml", () => {
  it("shows spend against the cap while under it, with no state chip", () => {
    const html = profileSpendHtml(view(12.5, 100), "coder")
    expect(html).toContain("Spent <b>$12.50</b> of $100.00 this month")
    expect(html).not.toContain("chip")
    expect(html).toContain('href="/admin/cost"')
  })

  it("warns at the warn ratio", () => {
    const html = profileSpendHtml(view(85, 100), "coder")
    expect(html).toContain("Spent <b>$85.00</b> of $100.00 this month")
    expect(html).toContain('<span class="chip chip--warn">near cap</span>')
  })

  it("says paused when the cap is reached", () => {
    const html = profileSpendHtml(view(100, 100), "coder")
    expect(html).toContain('<span class="chip chip--err">paused: cap reached</span>')
    expect(html).not.toContain("near cap")
  })

  it("says no cap, with the spend, when the agent has none", () => {
    expect(profileSpendHtml(view(3.2), "coder")).toContain("Spent <b>$3.20</b> this month · no cap")
    // An agent with no spend and no cap has no row: still a line, at $0.
    expect(profileSpendHtml(view(0), "coder")).toContain("Spent <b>$0</b> this month · no cap")
  })

  it("says paused when the fleet cap is reached, even under the agent's own", () => {
    const html = profileSpendHtml(view(10, 100, { fleetCap: 10 }), "coder")
    expect(html).toContain("paused: fleet cap reached")
  })

  it("labels runs with no price as /cost does", () => {
    expect(profileSpendHtml(view(1, 100, { unpriced: 2 }), "coder")).toContain("· 2 not priced")
  })

  it("shows nothing until the budgets are read", () => {
    expect(profileSpendHtml(null, "coder")).toBe("")
  })

  it("runs on its own once shipped to the browser", () => {
    const run = new Function(injectFns({ profileSpendHtml }) + "return profileSpendHtml(arguments[0], 'coder')")
    expect(run(view(85, 100))).toBe(profileSpendHtml(view(85, 100), "coder"))
  })
})

describe("Wall links to the Cost page", () => {
  it("lists Cost among the classic pages", () => {
    expect(WALL_CLASSIC_LINKS).toContainEqual(["Cost", "/admin/cost"])
    expect(renderWallPage()).toContain('<a href="/admin/cost">Cost</a>')
  })
})
