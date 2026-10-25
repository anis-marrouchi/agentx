import { describe, it, expect } from "vitest"
import { renderCostPage } from "../src/daemon/ui/pages/cost"

// The Cost page's browser script is a template literal tsc cannot check: a
// syntax error there blanks the whole page, budget card included (#1290).
describe("Cost page script", () => {
  it("every inline script parses", () => {
    const html = renderCostPage()
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(scripts.length).toBeGreaterThan(0)
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
  })

  it("has the budget form", () => {
    const html = renderCostPage()
    expect(html).toContain('id="cost-budget-form"')
    expect(html).toContain("/api/admin/budgets")
    expect(html).toContain("Budgets do not count them")
  })
})
