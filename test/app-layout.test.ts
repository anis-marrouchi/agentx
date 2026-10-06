import { describe, expect, it } from "vitest"
import { renderAppPage } from "../src/daemon/ui/pages/app"

// The phone app's shell: the tab bar must stay on screen (#709).
describe("phone app layout", () => {
  const html = renderAppPage()
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
  // The value the cascade ends on for a bare selector (`body`, `main`): the
  // last declaration of prop across that selector's plain rules, whatever the
  // spacing or the order of the other declarations.
  const last = (selector: string, prop: string) => {
    const rules = [...css.matchAll(new RegExp(`(?:^|[\\n}])\\s*${selector}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1])
    const hits = rules.map((r) => r.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1]?.trim()).filter(Boolean)
    return hits[hits.length - 1]
  }

  it("pins the body to the screen instead of letting it grow past it", () => {
    expect(last("body", "position")).toBe("fixed")
    expect(last("body", "inset")).toBe("0")
    expect(last("body", "min-height")).toBe("0")
    expect(last("body", "overflow")).toBe("hidden")
    // A fixed box with top, bottom and a height ignores bottom, so a
    // leftover height: 100dvh would still size the body past the screen.
    expect(last("body", "height")).toBe("auto")
  })

  it("keeps the tabs as the last thing in the body's flex column, after main", () => {
    expect(last("body", "display")).toBe("flex")
    expect(html.indexOf("<main>")).toBeLessThan(html.indexOf('<nav class="tabs"'))
    // main takes what the header and tabs leave, so it must grow and shrink.
    expect(last("main", "flex")).toMatch(/^1 1 0(px|%)?$/)
    expect(last("main", "min-height")).toBe("0")
  })
})
