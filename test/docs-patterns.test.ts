import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// docs/architecture/patterns.md names where each pattern lives in the code
// (#1137). A path that no longer resolves makes the page lie, so every
// backticked `src/...` path on it must exist.

const root = new URL("../", import.meta.url)
const page = readFileSync(new URL("docs/architecture/patterns.md", root), "utf8")

const pathsIn = (text: string) => [...text.matchAll(/`(src\/[^`\s]*)`/g)].map((m) => m[1].replace(/:\d+$/, ""))

function patterns(): Array<{ name: string; body: string }> {
  const section = page.split(/^## The patterns$/m)[1]?.split(/^## /m)[0] ?? ""
  return section
    .split(/^### /m)
    .slice(1)
    .map((chunk) => {
      const [name, ...rest] = chunk.split("\n")
      return { name: name.trim(), body: rest.join("\n") }
    })
}

describe("docs/architecture/patterns.md", () => {
  it("names only paths that exist", () => {
    const paths = [...new Set(pathsIn(page))]
    expect(paths.length).toBeGreaterThan(10)
    expect(paths.filter((p) => !existsSync(new URL(p, root)))).toEqual([])
  })

  it("gives every pattern a problem, a shape, a lives-in path and a best practice, in that order", () => {
    const list = patterns()
    expect(list.length).toBeGreaterThan(0)
    for (const { name, body } of list) {
      const at = ["Problem", "Shape", "Lives in", "Best practice"].map((label) => body.indexOf(`- **${label}:**`))
      expect(at, name).not.toContain(-1)
      expect([...at].sort((a, b) => a - b), name).toEqual(at)
      const livesIn = body.split("\n").find((line) => line.startsWith("- **Lives in:**")) ?? ""
      expect(pathsIn(livesIn).length, name).toBeGreaterThan(0)
    }
  })

  it("keeps the first set of patterns from #1137", () => {
    const names = patterns().map((p) => p.name)
    for (const name of [
      "Promise", "Fact", "Home", "Listener", "Party", "Reach", "Told once", "Hold", "Digest",
      "Approval with expiry", "Verdict", "Chaser", "Evidence watcher", "Handoff", "Delegation result", "Plan gate",
    ]) expect(names).toContain(name)
  })
})
