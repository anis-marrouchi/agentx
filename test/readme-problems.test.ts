import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The README's job sections (#1318, were the "Problems we solve" table of
// #1161) and "right for you" list are what a business owner reads first.
// Keep them above the install steps, and keep every job pointing at a
// guide that exists.

const root = new URL("../", import.meta.url)
const md = readFileSync(new URL("README.md", root), "utf8")
const section = (title: string) => md.split(`\n## ${title}\n`)[1]?.split(/\n## /)[0] ?? ""

describe("README jobs and fit", () => {
  it("sits above the install section", () => {
    const install = md.indexOf("\n## Install\n")
    expect(md.indexOf("\n## The jobs AgentX does\n")).toBeGreaterThan(-1)
    expect(md.indexOf("\n## Is AgentX right for you?\n")).toBeGreaterThan(-1)
    expect(md.indexOf("\n## The jobs AgentX does\n")).toBeLessThan(install)
    expect(md.indexOf("\n## Is AgentX right for you?\n")).toBeLessThan(install)
  })

  it("links every job to a guide in the repo", () => {
    const jobs = section("The jobs AgentX does").split(/\n### /).slice(1)
    expect(jobs.length).toBeGreaterThanOrEqual(5)
    for (const job of jobs) {
      // A link may point at a section of its guide (#1290: the budget section).
      const links = [...job.matchAll(/\]\((docs\/[^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1])
      expect(links.length, job.split("\n")[0]).toBeGreaterThan(0)
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
