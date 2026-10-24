import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The 3-step story under the headline (#1160): the README and the docs home
// tell the same three steps, the Arabic README has its own three, and the
// word "harness" stays off the README's first screen (the part above the
// first section heading).

const root = new URL("../", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), "utf8")
const steps = (md: string) => md.match(/^[1-3]\. \*\*.+$/gm)?.slice(0, 3) ?? []
const firstScreen = (md: string) => md.slice(0, md.indexOf("\n## "))

const readme = read("README.md")
const docsHome = read("docs/index.md")
const arabic = read("docs/ar/README.md")

describe("result-first story", () => {
  it("has three steps on the README first screen", () => {
    const story = steps(firstScreen(readme))
    expect(story).toHaveLength(3)
    expect(story[0]).toContain("Give each agent a job")
  })

  it("is the same on the docs home", () => {
    expect(steps(firstScreen(docsHome))).toEqual(steps(firstScreen(readme)))
  })

  it("has three steps on the Arabic README first screen", () => {
    expect(steps(firstScreen(arabic))).toHaveLength(3)
  })

  it("keeps the word harness off the first screen", () => {
    for (const md of [readme, docsHome, arabic]) expect(firstScreen(md)).not.toContain("harness")
  })

  it("puts the stability notes below the demo and What it does", () => {
    const state = readme.indexOf("\n## Current state:")
    expect(state).toBeGreaterThan(readme.indexOf("\n## See it without an account\n"))
    expect(state).toBeGreaterThan(readme.indexOf("\n## What it does\n"))
    const arState = arabic.indexOf("\n## الوضع الحالي")
    expect(arState).toBeGreaterThan(arabic.indexOf("\n## جرّبه دون حساب\n"))
    expect(arState).toBeGreaterThan(arabic.indexOf("\n## ماذا يفعل\n"))
  })
})
