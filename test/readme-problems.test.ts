import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The README's "Problems we solve" table and "right for you" list (#1161)
// are what a business owner reads first. Keep them above the install
// steps, and keep every row pointing at a guide that exists.

const root = new URL("../", import.meta.url)
const md = readFileSync(new URL("README.md", root), "utf8")
const section = (title: string) => md.split(`\n## ${title}\n`)[1]?.split(/\n## /)[0] ?? ""

describe("README problems and fit", () => {
  it("sits above the install section", () => {
    const install = md.indexOf("\n## Install\n")
    expect(md.indexOf("\n## Problems we solve\n")).toBeGreaterThan(-1)
    expect(md.indexOf("\n## Is AgentX right for you?\n")).toBeGreaterThan(-1)
    expect(md.indexOf("\n## Problems we solve\n")).toBeLessThan(install)
    expect(md.indexOf("\n## Is AgentX right for you?\n")).toBeLessThan(install)
  })

  it("links every problem row to a guide in the repo", () => {
    const rows = section("Problems we solve").split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Your problem"))
    expect(rows.length).toBeGreaterThanOrEqual(5)
    for (const row of rows) {
      const links = [...row.matchAll(/\]\((docs\/[^)#]+)\)/g)].map((m) => m[1])
      expect(links.length, row).toBeGreaterThan(0)
      for (const link of links) expect(existsSync(new URL(link, root)), link).toBe(true)
    }
  })

  it("says who it is not for", () => {
    const fit = section("Is AgentX right for you?")
    expect(fit).toContain("**Right for you if:**")
    expect(fit).toContain("**Not for you yet if:**")
    for (const link of [...fit.matchAll(/\]\((docs\/[^)#]+)\)/g)].map((m) => m[1])) {
      expect(existsSync(new URL(link, root)), link).toBe(true)
    }
  })
})
