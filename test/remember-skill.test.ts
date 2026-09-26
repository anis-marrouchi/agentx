import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"
import { installRememberSkill, REMEMBER_SKILL_BODY } from "../src/agents/skills/remember-skill"

const DIR = resolve(__dirname, "../.test-remember-skill")
const SKILL = resolve(DIR, "remember.md")

describe("installRememberSkill", () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })
  })
  afterEach(() => rmSync(DIR, { recursive: true, force: true }))

  it("renders a new install with the daemon's port", () => {
    expect(installRememberSkill(DIR, 19900)).toBe("installed")
    const body = readFileSync(SKILL, "utf-8")
    expect(body).toContain("http://localhost:19900/api/memory")
    expect(body).not.toContain("18800")
  })

  it("repoints a stale install and keeps operator edits", () => {
    writeFileSync(SKILL, REMEMBER_SKILL_BODY + "\n## Operator note\nKeep it short.\n")
    expect(installRememberSkill(DIR, 19900)).toBe("repointed")
    const body = readFileSync(SKILL, "utf-8")
    expect(body).not.toContain("localhost:18800")
    expect(body).toContain("## Operator note\nKeep it short.")
    expect(body).toBe(
      (REMEMBER_SKILL_BODY + "\n## Operator note\nKeep it short.\n").replaceAll("localhost:18800", "localhost:19900"),
    )
  })

  it("leaves a correct install untouched", () => {
    installRememberSkill(DIR, 18800)
    expect(installRememberSkill(DIR, 18800)).toBeNull()
    writeFileSync(SKILL, "custom: http://127.0.0.1:18800/api/memory\n")
    expect(installRememberSkill(DIR, 19900)).toBeNull()
    expect(readFileSync(SKILL, "utf-8")).toBe("custom: http://127.0.0.1:18800/api/memory\n")
  })
})
