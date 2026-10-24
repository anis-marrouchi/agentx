import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// One result-first line (#1160): the README, the docs home, the docs site
// description and the npm description say the same sentence. Editing one
// place alone fails here instead of leaving two headlines again.

const root = new URL("../", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), "utf8")
const clean = (s: string | undefined) => (s ?? "").trim().replace(/\.$/, "")

const readme = clean(read("README.md").match(/^# AgentX\s+^\*\*(.+)\*\*$/m)?.[1])
const docsHome = clean(read("docs/index.md").match(/^# (.+)$/m)?.[1])
const siteDescription = clean(read("docs/.vitepress/config.ts").match(/^ {2}description: "(.+)",$/m)?.[1])
const npmDescription = String(JSON.parse(read("package.json")).description)

describe("result-first tagline", () => {
  it("is set in the README", () => {
    expect(readme.length).toBeGreaterThan(20)
  })

  it("is the docs home heading", () => {
    expect(docsHome).toBe(readme)
  })

  it("is the docs site description", () => {
    expect(siteDescription).toBe(readme)
  })

  it("opens the npm description", () => {
    expect(npmDescription.startsWith(`${readme}.`)).toBe(true)
  })

  it("comes before the word harness in the README", () => {
    const md = read("README.md")
    const harness = md.indexOf("harness")
    if (harness !== -1) expect(md.indexOf(readme)).toBeLessThan(harness)
  })
})
