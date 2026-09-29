import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import fg from "fast-glob"
import { clearSkillCache, loadLocalSkills } from "../src/agent/skills/loader"

// Every turn globbed the workspace and parsed each SKILL.md; under load
// the step was seen taking 90s. Skills change when someone edits the
// workspace, so a one-minute cache per workspace is safe.

let tmp: string
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`

beforeEach(() => {
  clearSkillCache()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-skills-cache-"))
  mkdirSync(path.join(tmp, ".claude/skills/one"), { recursive: true })
  writeFileSync(path.join(tmp, ".claude/skills/one/SKILL.md"), skill("one"))
})
afterEach(() => {
  vi.restoreAllMocks()
  clearSkillCache()
  rmSync(tmp, { recursive: true, force: true })
})

describe("loadLocalSkills cache", () => {
  it("globs once per workspace within the window", async () => {
    expect((await loadLocalSkills(tmp)).map((s) => s.frontmatter.name)).toEqual(["one"])
    const glob = vi.spyOn(fg, "glob")
    for (let i = 0; i < 3; i++) expect(await loadLocalSkills(tmp)).toHaveLength(1)
    expect(glob).not.toHaveBeenCalled()
  })

  it("picks up a new skill after the cache is cleared", async () => {
    await loadLocalSkills(tmp)
    mkdirSync(path.join(tmp, ".claude/skills/two"), { recursive: true })
    writeFileSync(path.join(tmp, ".claude/skills/two/SKILL.md"), skill("two"))
    expect(await loadLocalSkills(tmp)).toHaveLength(1)
    clearSkillCache(tmp)
    expect((await loadLocalSkills(tmp)).map((s) => s.frontmatter.name).sort()).toEqual(["one", "two"])
  })
})
