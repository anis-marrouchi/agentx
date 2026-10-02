import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
// @ts-expect-error plain ESM script without type declarations
import { C, createDiagram } from "../docs/.scripts/diagrams/kit.mjs"

const specs = new URL("../docs/.scripts/diagrams/", import.meta.url)
const built = new URL("../docs/public/diagrams/", import.meta.url)
const names = readdirSync(specs)
  .filter((file) => file.endsWith(".mjs") && file !== "kit.mjs")
  .map((file) => file.slice(0, -4))

describe("docs diagram kit", () => {
  it("numbers the steps in the order they are added, across rows", () => {
    const d = createDiagram({ height: 400, title: "T", desc: "D" })
    d.row([{ title: ["One"] }, { title: ["Two"] }], 100, { who: "accent" })
    d.row([{ title: ["Three"], who: "ink" }], 260)
    const numbers = [...d.svg().matchAll(/class="num"[^>]*>(\d+)</g)].map((m) => m[1])
    expect(numbers).toEqual(["1", "2", "3"])
  })

  it("delays each step after the one before it", () => {
    const d = createDiagram({ height: 300, title: "T", desc: "D" })
    const anchors = d.row([{ title: ["One"] }, { title: ["Two"] }, { title: ["Three"] }], 100, { who: "accent" })
    expect(anchors[0].at).toBeLessThan(anchors[1].at)
    expect(anchors[1].at).toBeLessThan(anchors[2].at)
    expect(d.now).toBe(anchors[2].at)
  })

  it("escapes text and carries a title, a description and a reduced-motion rule", () => {
    const d = createDiagram({ height: 300, title: "A & B", desc: "x < y" })
    d.header("Tom & <Jerry>")
    const svg = d.svg()
    expect(svg).toContain("<title id=\"t\">A &amp; B</title>")
    expect(svg).toContain("x &lt; y")
    expect(svg).toContain("Tom &amp; &lt;Jerry&gt;")
    expect(svg).toContain("prefers-reduced-motion: reduce")
    expect(svg).toContain(C.accent)
  })

  it("keeps every element visible when animation is ignored", () => {
    const d = createDiagram({ height: 300, title: "T", desc: "D" })
    d.row([{ title: ["One"] }], 100, { who: "accent" })
    // Hidden-until-animated would be `opacity: 0` on a class that carries content.
    expect(d.svg()).not.toMatch(/\.(rise|fade|wrap)\s*\{[^}]*opacity:\s*0/)
  })
})

describe("built diagrams", () => {
  it("has at least one spec", () => {
    expect(names.length).toBeGreaterThan(0)
  })

  it.each(names)("%s.svg matches its spec", async (name) => {
    const { default: svg } = await import(new URL(`${name}.mjs`, specs).href)
    expect(readFileSync(new URL(`${name}.svg`, built), "utf8")).toBe(svg)
  })
})
