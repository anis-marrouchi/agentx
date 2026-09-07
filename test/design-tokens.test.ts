import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { join } from "path"
import { AX_TOKENS_CSS } from "../src/daemon/ui/tokens"

const UI = "src/daemon/ui"
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [])
}

describe("design tokens", () => {
  it("defines every token a page uses without a fallback", () => {
    // An undefined custom property is silently dropped by CSS: no build error,
    // no console warning, just an element that renders with no colour. This is
    // how var(--ax-fg) survived across five pages.
    const defined = new Set([...AX_TOKENS_CSS.matchAll(/(--ax-[a-z0-9-]+)\s*:/g)].map(m => m[1]))
    const missing: string[] = []
    for (const file of walk(UI)) {
      if (file.endsWith("tokens.ts")) continue
      for (const m of readFileSync(file, "utf-8").matchAll(/var\(\s*(--ax-[a-z0-9-]+)\s*(,)?/g)) {
        if (!defined.has(m[1]) && !m[2]) missing.push(`${file.split("/").pop()} -> ${m[1]}`)
      }
    }
    expect([...new Set(missing)]).toEqual([])
  })

  it("carries a text-safe step for the two colours that fail as small text", () => {
    // Amber and red are the only palette entries that cannot carry words.
    for (const t of ["--ax-amber-ink", "--ax-red-ink"]) {
      expect(AX_TOKENS_CSS).toContain(t)
      // ...and both themes must define them, or dark mode loses the text.
      expect([...AX_TOKENS_CSS.matchAll(new RegExp(t + "\\s*:", "g"))]).toHaveLength(2)
    }
  })
})
