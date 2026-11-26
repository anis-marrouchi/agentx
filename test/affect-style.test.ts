// #2152 stage 2: the affectUI treatments have one style source, every
// surface loads it, and the MIT notice ships with the package.
import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"
import { AX_AFFECT_CSS, afLoaderHtml } from "../src/daemon/ui/affect.css"
import { renderWallDocument } from "../src/daemon/ui/pages/wall-space"
import { renderShell } from "../src/daemon/ui/shell"
import { renderAppPage } from "../src/daemon/ui/pages/app"

const ROOT = join(__dirname, "..")
const SOURCE = "src/daemon/ui/affect.css.ts"

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p))
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(p)
  }
  return out
}

const count = (s: string, part: string) => s.split(part).length - 1

describe("affectUI style source (#2152)", () => {
  it("only affect.css.ts writes .ax-af-* rules", () => {
    // A rule = the class followed by `{`, `,` or a pseudo/child selector
    // inside a stylesheet string; class="ax-af-…" in markup is a use.
    const rule = /(^|[\s,}>])\.ax-af-[\w-]+[^{};"'`<\n]*\{/m
    const owners = files(join(ROOT, "src"))
      .filter((p) => rule.test(readFileSync(p, "utf8")))
      .map((p) => relative(ROOT, p))
    expect(owners).toEqual([SOURCE])
  })

  it("the Hub, the dashboard pages and the phone app load it once", () => {
    const pages = {
      hub: renderWallDocument({ title: "Hub", css: "", body: "", scripts: "" }),
      shell: renderShell({ title: "x", activeTab: "custom", subtitle: "x", body: "" }),
      app: renderAppPage(),
    }
    for (const [name, html] of Object.entries(pages)) {
      expect(count(html, "/* --- affect: card (Decision Inbox) --- */"), name).toBe(1)
    }
  })

  it("keeps state colour on state only and honours reduced motion", () => {
    expect(AX_AFFECT_CSS).toContain("prefers-reduced-motion: reduce")
    expect(AX_AFFECT_CSS).not.toMatch(/#[0-9a-f]{3,6}\b/i)
  })

  it("escapes the loader label", () => {
    const html = afLoaderHtml("<b>Loading</b>")
    expect(html).toContain("&lt;b&gt;Loading&lt;/b&gt;")
    expect(count(html, "<span style=")).toBe(8)
  })

  it("ships the MIT notice with the package", () => {
    const license = readFileSync(join(ROOT, "src/daemon/ui/LICENSE.affectui"), "utf8")
    expect(license).toContain("MIT License")
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] }
    expect(pkg.files).toContain("src/daemon/ui/LICENSE.affectui")
  })
})
