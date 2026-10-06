import { describe, expect, it } from "vitest"
import { renderAppPage } from "../src/daemon/ui/pages/app"

// The phone app's shell: the tab bar must stay on screen (#709).
describe("phone app layout", () => {
  const html = renderAppPage()
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
  // Every style rule in source order, split by brace depth so a rule nested
  // in an at-rule (`@media … { main { … } }`) is kept apart from the plain
  // rules instead of being half-matched by a regex.
  type Rule = { selectors: string[]; decls: string; atRule?: string }
  const parse = (src: string, atRule?: string): Rule[] => {
    const rules: Rule[] = []
    let i = 0
    while (i < src.length) {
      const open = src.indexOf("{", i)
      if (open < 0) break
      const prelude = src.slice(i, open).trim()
      let depth = 1
      let j = open + 1
      for (; j < src.length && depth > 0; j++) {
        if (src[j] === "{") depth++
        else if (src[j] === "}") depth--
      }
      const inner = src.slice(open + 1, j - 1)
      if (prelude.startsWith("@")) rules.push(...parse(inner, prelude))
      else rules.push({ selectors: prelude.split(",").map((s) => s.trim()), decls: inner, atRule })
      i = j
    }
    return rules
  }
  const rules = parse(css.replace(/\/\*[\s\S]*?\*\//g, ""))
  const decl = (r: Rule, prop: string) => r.decls.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1]?.trim()
  // The value the cascade ends on for a bare selector (`body`, `main`): the
  // last declaration of prop across the top-level rules naming that selector,
  // whatever the spacing or the order of the other declarations.
  const last = (selector: string, prop: string) => {
    const hits = rules.filter((r) => !r.atRule && r.selectors.includes(selector)).map((r) => decl(r, prop)).filter(Boolean)
    return hits[hits.length - 1]
  }
  // Rules inside @media and friends that would override prop on some screens.
  const conditional = (selector: string, prop: string) =>
    rules.filter((r) => r.atRule && r.selectors.includes(selector) && decl(r, prop)).map((r) => `${r.atRule} ${selector}`)

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

  it("does not undo the pinning inside a media query", () => {
    for (const prop of ["position", "inset", "height", "min-height", "overflow", "display"]) {
      expect(conditional("body", prop)).toEqual([])
    }
    for (const prop of ["flex", "min-height"]) expect(conditional("main", prop)).toEqual([])
  })
})
