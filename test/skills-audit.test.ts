import { describe, it, expect } from "vitest"
import { auditAll } from "../src/agent/skills/audit"
import type { Skill } from "../src/agent/skills/types"
import type { ReferenceIndex } from "../src/agents/references/types"
import type { RecipeIndex } from "../src/agents/references/recipes"

function refIndex(): ReferenceIndex {
  const card = {
    id: "ksi.ssh.clawd-mac",
    kind: "ssh" as const,
    summary: "clawd-server",
    fields: { user: "clawd", host: "64.226.102.124" },
    tags: [] as string[],
  }
  return {
    byId: new Map([[card.id, card]]),
    byTag: new Map(),
    sourceById: new Map([[card.id, "fixture.yaml"]]),
  }
}

function recipeIndex(skills: string[] = []): RecipeIndex {
  return {
    recipes: skills.length
      ? [{ id: "r", priority: 0, when: {}, references: [], skills, maxChars: undefined }]
      : [],
    sourceById: new Map(),
  }
}

function skill(fm: Partial<Skill["frontmatter"]> & { name: string; description: string }, body = ""): Skill {
  return {
    frontmatter: { ...fm },
    instructions: body,
    source: "local",
  }
}

describe("auditSkill", () => {
  it("PASS for a clean skill citing a real reference", () => {
    const s = skill({
      name: "ksi-v2-deploy",
      description: "Deploy KSI V2",
      category: "deploy",
      references: ["ksi.ssh.clawd-mac"],
    })
    const out = auditAll({ skills: [s], references: refIndex(), recipes: recipeIndex() })
    expect(out[0].verdict).toBe("PASS")
  })

  it("FAILING when a referenced id does not resolve", () => {
    const s = skill({
      name: "ksi-broken",
      description: "broken",
      references: ["ksi.gitlab.does-not-exist"],
    })
    const out = auditAll({ skills: [s], references: refIndex(), recipes: recipeIndex() })
    expect(out[0].verdict).toBe("FAILING")
    expect(out[0].reasons.join(" ")).toContain("does not resolve")
  })

  it("REVIEW when a fenced code block contains raw python3 ~/scripts/", () => {
    const body = "```bash\npython3 ~/scripts/hotmail.py search --from ksi.tn\n```"
    const s = skill(
      { name: "ksi-cx-email", description: "email skill", category: "email", references: ["ksi.ssh.clawd-mac"] },
      body,
    )
    const out = auditAll({ skills: [s], references: refIndex(), recipes: recipeIndex() })
    expect(out[0].verdict).toBe("REVIEW")
    expect(out[0].reasons.join(" ")).toContain("python3")
  })

  it("PASS when python3 ~/scripts/ appears only in prose (negation context)", () => {
    const body = "Do NOT invoke `python3 ~/scripts/hotmail.py` directly — delegate to the hotmail skill."
    const s = skill(
      { name: "ksi-cx-email-v2", description: "email skill", category: "email", references: ["ksi.ssh.clawd-mac"] },
      body,
    )
    const out = auditAll({ skills: [s], references: refIndex(), recipes: recipeIndex() })
    expect(out[0].verdict).toBe("PASS")
  })

  it("REVIEW for an infra skill missing references frontmatter", () => {
    const s = skill({ name: "infra-x", description: "deploy and ssh notes", category: "deploy" })
    const out = auditAll({ skills: [s], references: refIndex(), recipes: recipeIndex() })
    expect(out[0].verdict).toBe("REVIEW")
    expect(out[0].reasons.join(" ")).toContain("references")
  })

  it("REVIEW when raw IPs are embedded outside the registry", () => {
    const s = skill(
      { name: "ksi-stale", description: "infra", category: "deploy", references: ["ksi.ssh.clawd-mac"] },
      "ssh root@10.0.0.55 to deploy",
    )
    const out = auditAll({ skills: [s], references: refIndex(), recipes: recipeIndex() })
    expect(out[0].verdict).toBe("REVIEW")
    expect(out[0].reasons.join(" ")).toContain("10.0.0.55")
  })

  it("FAILING when a recipe requires a phantom skill", () => {
    const out = auditAll({
      skills: [],
      references: refIndex(),
      recipes: recipeIndex(["ksi-v2-deploy"]),
    })
    expect(out).toHaveLength(1)
    expect(out[0].verdict).toBe("FAILING")
    expect(out[0].name).toBe("ksi-v2-deploy")
  })

  it("FAILING when delegatesTo points at a missing skill", () => {
    const s = skill({
      name: "ksi-cx-email",
      description: "email",
      category: "email",
      references: ["ksi.ssh.clawd-mac"],
      delegatesTo: ["nonexistent-skill"],
    })
    const out = auditAll({ skills: [s], references: refIndex(), recipes: recipeIndex() })
    expect(out[0].verdict).toBe("FAILING")
  })
})
