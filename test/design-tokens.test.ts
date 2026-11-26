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

  it("follows the Orca look: 1px lines, 10px radius, no hard offset shadow, Geist (#2101)", () => {
    expect(AX_TOKENS_CSS).toContain("--ax-border-w: 1px")
    expect(AX_TOKENS_CSS).toContain("--ax-radius: 10px")
    expect(AX_TOKENS_CSS).toContain('--ax-font: "Geist"')
    // Orca's values are credited with its MIT notice.
    expect(readFileSync(join(UI, "tokens.ts"), "utf-8")).toMatch(/Lovecast Inc\.[\s\S]*MIT/)
    // One primary button value per theme.
    expect([...AX_TOKENS_CSS.matchAll(/--ax-primary\s*:/g)]).toHaveLength(2)
    // No page brings back the hard offset shadow ("0 4px 0 <colour>").
    const offenders = walk(UI).filter(f => /box-shadow:\s*0 [2-5]px 0 [#v]/.test(readFileSync(f, "utf-8")))
    expect(offenders).toEqual([])
  })

  it("no page defines --ax-* values outside tokens.ts: one style set (#2101)", () => {
    const offenders: string[] = []
    for (const file of walk("src/daemon")) {
      if (file.endsWith("ui/tokens.ts")) continue
      if (/--ax-[a-z0-9-]+\s*:/.test(readFileSync(file, "utf-8"))) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it("serves Geist from the daemon, never a font CDN (#2101 condition 1)", () => {
    expect(AX_TOKENS_CSS).toContain('url("/assets/Geist-Variable.woff2")')
    for (const file of walk("src/daemon")) expect(readFileSync(file, "utf-8")).not.toContain("fonts.googleapis.com")
    for (const f of ["Geist-Variable.woff2", "GeistMono-Variable.woff2", "OFL-Geist.txt"]) {
      expect(readFileSync(join("src/web/public/fonts", f)).length).toBeGreaterThan(1000)
    }
  })

  it("keeps the blue primary button label readable in both themes (#2101 PR 1b)", () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    }
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
      return (x + 0.05) / (y + 0.05)
    }
    const all = (name: string) => [...AX_TOKENS_CSS.matchAll(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`, "g"))].map(m => m[1])
    const bg = all("--ax-primary")
    const fg = all("--ax-primary-fg")
    expect(bg).toHaveLength(2)
    for (let i = 0; i < 2; i++) expect(ratio(bg[i], fg[i])).toBeGreaterThanOrEqual(4.5)
    // Links and focus blue on the dark ground (Hakim's v2 nit).
    expect(ratio(all("--ax-blue")[1], "#0a0a0a")).toBeGreaterThanOrEqual(4.5)
    // Ink on the accent (Hub nav count badge), light and dark (DevOps nit on #2127).
    const blue = all("--ax-blue")
    const ink = all("--ax-on-accent")
    expect(ink).toHaveLength(2)
    for (let i = 0; i < 2; i++) expect(ratio(blue[i], ink[i])).toBeGreaterThanOrEqual(4.5)
  })

  it("carries a text-safe step for the two colours that fail as small text", () => {
    // Amber and red are the only palette entries that cannot carry words.
    for (const t of ["--ax-amber-ink", "--ax-red-ink"]) {
      expect(AX_TOKENS_CSS).toContain(t)
      // ...and both themes must define them, or dark mode loses the text.
      expect([...AX_TOKENS_CSS.matchAll(new RegExp(t + "\\s*:", "g"))]).toHaveLength(2)
    }
  })

  it("keeps a focus ring on controls whose selected state sets its own box-shadow (Hakim B1 on #2378)", () => {
    // :root :focus-visible draws the ring with box-shadow; a later state rule
    // of equal specificity replaces it, so each needs a focused pair.
    const pairs: [string, string][] = [
      ["pages/wall-space.ts", ".ax-wall__item.is-on:focus-visible"],
      ["pages/hub-layout.ts", '.whl__seg button[aria-checked="true"]:focus-visible'],
      ["pages/wall-settings.client.ts", ".wsl__f.is-on:focus-visible"],
      ["pages/wall-pages.client.ts", ".wcr__a.is-on:focus-visible"],
      ["pages/wall-agent-templates.ts", ".wat__t.is-on:focus-visible"],
      ["pages/mesh.css.ts", '.mx-run[aria-pressed="true"]:focus-visible'],
    ]
    for (const [file, sel] of pairs) {
      const src = readFileSync(join(UI, file), "utf8")
      const at = src.indexOf(sel)
      expect(at, sel).toBeGreaterThan(-1)
      const rule = src.slice(at, src.indexOf("}", at))
      expect(rule, sel).toMatch(/box-shadow:[^;}]*(var\(--ax-focus-ring\)|var\(--ax-ring\))/)
    }
  })

  it("keeps the phone app title sizes; no mock asked to shrink them (Hakim B1 v2 on #2378)", () => {
    const app = readFileSync(join(UI, "pages/app-redesign.css.ts"), "utf8")
    expect(app).toMatch(/\.bar h1 \{ font-size: 22px;/)
    expect(app).toMatch(/main h2 \{ font-size: 28px;/)
    const member = readFileSync(join(UI, "pages/member-styles.ts"), "utf8")
    expect(member).toMatch(/\.bar h1 \{ font-size: 20px;/)
  })
})
