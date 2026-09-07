import { describe, expect, it } from "vitest"
import { injectFns } from "../src/daemon/ui/inject"

describe("shipping server functions to the browser", () => {
  it("keeps a minified cross-reference resolvable", () => {
    // Exactly what the bundler produces: the callee is renamed, and the
    // caller emits the renamed identifier. Binding only the readable name
    // leaves `Fe` unbound and the page throws at runtime.
    function Fe(n: number) { return n * 2 }
    function zt(n: number) { return (globalThis as any).Fe(n) + 1 }
    Object.defineProperty(zt, "toString", { value: () => "function zt(n){return Fe(n)+1}" })
    const src = injectFns({ decayOf: Fe, rankByDecay: zt })
    expect(new Function(src + "return rankByDecay(4)")()).toBe(9)
  })

  it("binds the readable name too, so page code can call it", () => {
    function inner() { return "ok" }
    expect(new Function(injectFns({ helper: inner }) + "return helper()")()).toBe("ok")
  })

  it("survives an anonymous function, which has no name to bind", () => {
    const anon = function (x: number) { return x + 1 }
    Object.defineProperty(anon, "name", { value: "" })
    expect(new Function(injectFns({ bump: anon }) + "return bump(1)")()).toBe(2)
  })

  it("survives a page injecting more than one set", () => {
    // The shell injects its own helpers on top of whatever the page injects.
    // Two `const __bind` declarations in one document was a SyntaxError that
    // took both scripts down with it.
    function one() { return 1 }
    function two() { return 2 }
    const src = injectFns({ one }) + injectFns({ two })
    expect(() => new Function(src)).not.toThrow()
    expect(new Function(src + "return one() + two()")()).toBe(3)
  })
})

describe("markdown travels to the browser", () => {
  it("renders with no helper left behind in module scope", async () => {
    const { markdownToHtml } = await import("../src/utils/markdown-html")
    const { injectFns } = await import("../src/daemon/ui/inject")
    // new Function() cannot see the module, so a helper the minifier renamed
    // — escapeHtml became "$" in the bundle — fails here exactly as it did
    // in the drawer.
    const out = new Function(injectFns({ markdownToHtml }) +
      "return markdownToHtml('**b** `c`\\n\\n| a |\\n|---|\\n| 1 |')")()
    expect(out).toContain("<strong>b</strong>")
    expect(out).toContain("<code>c</code>")
    expect(out).toContain("<table>")
  })

  it("escapes before it marks up, because the text is not ours", async () => {
    const { markdownToHtml } = await import("../src/utils/markdown-html")
    const out = markdownToHtml('<img src=x onerror=alert(1)> [x](javascript:alert(1))')
    expect(out).not.toContain("<img")
    expect(out).toContain("&lt;img")
  })
})
