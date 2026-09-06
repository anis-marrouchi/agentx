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
})
