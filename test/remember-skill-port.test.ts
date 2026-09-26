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

import { readFileSync } from "fs"
import { resolve } from "path"
import { SHIPPED_SKILL_FINGERPRINTS, skillFingerprint, upgradeRememberSkill } from "../src/agents/skills/remember-skill"

describe("remember skill — upgrades", () => {
  it("registers the current body as shipped, so the next release can upgrade it", () => {
    expect(SHIPPED_SKILL_FINGERPRINTS.has(skillFingerprint(REMEMBER_SKILL_BODY))).toBe(true)
  })

  it("fingerprints ignore the port", () => {
    expect(skillFingerprint(rememberSkillBody(19900))).toBe(skillFingerprint(REMEMBER_SKILL_BODY))
  })

  it("leaves an up-to-date install alone", () => {
    expect(upgradeRememberSkill(rememberSkillBody(19900), 19900)).toBeNull()
  })

  it("replaces an unedited older release with the current body", () => {
    // An earlier shipped body, as installed on a node listening on 19900.
    const v1 = readFileSync(resolve(__dirname, "fixtures/remember-skill-v2.md"), "utf-8")
      .split("localhost:18800/api/memory").join("localhost:19900/api/memory")
    expect(upgradeRememberSkill(v1, 19900)).toBe(rememberSkillBody(19900))
  })

  it("only retargets the port of an edited copy", () => {
    const edited = REMEMBER_SKILL_BODY + "\n## My note\nKeep this.\n"
    const out = upgradeRememberSkill(edited, 19900)!
    expect(out).toContain("## My note\nKeep this.")
    expect(out).not.toContain("localhost:18800")
  })

  it("the current body sends the task header on every write example", () => {
    const writes = REMEMBER_SKILL_BODY.split("curl -sS -X ").slice(1)
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) expect(w.split("```")[0]).toContain("X-AgentX-Task: $AGENTX_TASK_ID")
  })
})
