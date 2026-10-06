import { describe, expect, it } from "vitest"
import { renderAppPage } from "../src/daemon/ui/pages/app"

// The phone app's shell: the tab bar must stay on screen (#709).
describe("phone app layout", () => {
  const html = renderAppPage()
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
  const bodyRules = [...css.matchAll(/(?:^|\n)body\s*\{([^}]*)\}/g)].map((m) => m[1])
  const last = (prop: string) => {
    const hits = bodyRules.map((r) => r.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`))?.[1]?.trim()).filter(Boolean)
    return hits[hits.length - 1]
  }

  it("pins the body to the screen instead of letting it grow past it", () => {
    expect(last("position")).toBe("fixed")
    expect(last("inset")).toBe("0")
    expect(last("min-height")).toBe("0")
    expect(last("overflow")).toBe("hidden")
  })

  it("keeps the tabs as the last thing in the body's flex column, after main", () => {
    expect(last("display")).toBe("flex")
    expect(html.indexOf("<main>")).toBeLessThan(html.indexOf('<nav class="tabs"'))
    expect(css).toMatch(/main \{ flex: 1 1 0;/)
  })
})
