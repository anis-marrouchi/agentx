import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The pattern language page (#1137 step 0) names where each pattern lives
// in the code. This keeps those names true: a rename that forgets the page
// fails here instead of leaving a map that points nowhere.

const root = new URL("../", import.meta.url)
const page = readFileSync(new URL("docs/architecture/patterns.md", root), "utf8")
const FIELDS = ["Problem", "Shape", "Lives in", "Do it well"] as const

function patterns(md: string): Array<{ name: string; body: string }> {
  const section = md.split(/^## Patterns$/m)[1]?.split(/^## /m)[0] ?? ""
  return section
    .split(/^### /m)
    .slice(1)
    .map((chunk) => {
      const [name, ...rest] = chunk.split("\n")
      return { name: name.trim(), body: rest.join("\n") }
    })
}

function field(body: string, label: string): string | null {
  const m = body.match(new RegExp(`^- \\*\\*${label}\\*\\*: (.+)$`, "m"))
  return m ? m[1].trim() : null
}

describe("docs/architecture/patterns.md", () => {
  const list = patterns(page)

  it("lists patterns", () => {
    expect(list.length).toBeGreaterThanOrEqual(16)
  })

  it.each(list.map((p) => [p.name, p.body]))("%s has all four lines", (_name, body) => {
    for (const label of FIELDS) expect(field(body, label), label).toBeTruthy()
  })

  it.each(list.map((p) => [p.name, p.body]))("%s says where it lives", (_name, body) => {
    const lives = field(body, "Lives in") ?? ""
    expect(/`src\/[^`]+`/.test(lives) || /#\d+/.test(lives)).toBe(true)
  })

  it("every code path on the page exists", () => {
    const paths = [...page.matchAll(/`(src\/[^`\s]+)`/g)].map((m) => m[1])
    expect(paths.length).toBeGreaterThan(0)
    const missing = [...new Set(paths)].filter((p) => !existsSync(new URL(p, root)))
    expect(missing).toEqual([])
  })
})
