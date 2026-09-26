import { describe, it, expect } from "vitest"
import { REMEMBER_SKILL_BODY, rememberSkillBody, retargetRememberSkill } from "../src/agents/skills/remember-skill"

describe("remember skill — daemon port", () => {
  it("renders every API call against the daemon's port", () => {
    const body = rememberSkillBody(19900)
    expect(body).not.toContain("localhost:18800")
    expect(body.match(/localhost:19900\/api\/memory/g)?.length).toBe(
      REMEMBER_SKILL_BODY.match(/localhost:18800\/api\/memory/g)?.length,
    )
  })

  it("leaves the body unchanged on the default port", () => {
    expect(rememberSkillBody(18800)).toBe(REMEMBER_SKILL_BODY)
  })

  it("retargets an old install and keeps operator edits", () => {
    const edited = `${REMEMBER_SKILL_BODY}\n\n## Local note\nAlways tag memories with the project.\n`
    const fixed = retargetRememberSkill(edited, 19900)
    expect(fixed).not.toBeNull()
    expect(fixed).not.toContain("localhost:18800")
    expect(fixed).toContain("## Local note\nAlways tag memories with the project.")
  })

  it("changes nothing when the port is right or the file has no default URL", () => {
    expect(retargetRememberSkill(REMEMBER_SKILL_BODY, 18800)).toBeNull()
    expect(retargetRememberSkill(rememberSkillBody(19900), 19900)).toBeNull()
    expect(retargetRememberSkill("custom skill with no API calls", 19900)).toBeNull()
  })
})
