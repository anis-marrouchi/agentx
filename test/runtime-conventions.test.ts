import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { getConventions, installedSkills, skillHome } from "../src/agents/conventions"

// #1062 step 10: skills go where each runtime reads them, and the install
// command is the runtime's own.

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "agentx-conv-")) })
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

const skill = (dir: string, name: string) => {
  mkdirSync(join(ws, dir, name), { recursive: true })
  writeFileSync(join(ws, dir, name, "SKILL.md"), `---\nname: ${name}\n---\n`)
}

describe("runtime conventions", () => {
  it("adds claude-code skills to .claude/skills, with the claude-code install command", () => {
    expect(skillHome("claude-code", ws)).toBe(join(ws, ".claude", "skills"))
    expect(skillHome(undefined, ws)).toBe(join(ws, ".claude", "skills"))
    expect(getConventions("claude-code")!.addSkillCommand("acme/skills", ws)).toBe(`cd ${ws} && npx -y skills add acme/skills -a claude-code -y`)
    expect(getConventions("claude-code")!.instructionsFile).toBe("CLAUDE.md")
  })

  it("adds codex skills to .agents/skills, where Codex reads them", () => {
    expect(skillHome("codex-cli", ws)).toBe(join(ws, ".agents", "skills"))
    expect(getConventions("codex-cli")!.addSkillCommand("acme/skills", ws)).toContain("-a codex -y")
    expect(getConventions("codex-cli")!.instructionsFile).toBe("AGENTS.md")
  })

  it("lists opencode skills from all three folders it reads, first folder winning", () => {
    skill(".opencode/skills", "deploy")
    skill(".claude/skills", "deploy")
    skill(".agents/skills", "review")
    mkdirSync(join(ws, ".claude/skills", "not-a-skill"), { recursive: true })
    expect(installedSkills("opencode", ws)).toEqual([
      { name: "deploy", dir: join(ws, ".opencode/skills", "deploy") },
      { name: "review", dir: join(ws, ".agents/skills", "review") },
    ])
  })

  it("gives sdk and orchestrator agents no skills at all", () => {
    for (const tier of ["sdk", "orchestrator"]) {
      expect(getConventions(tier)).toBeNull()
      expect(skillHome(tier, ws)).toBeNull()
      expect(installedSkills(tier, ws)).toEqual([])
    }
  })

  it("quotes a workspace or package that is not a plain shell word", () => {
    expect(getConventions("claude-code")!.addSkillCommand("acme/skills", "/tmp/my ws/it's")).toBe(`cd '/tmp/my ws/it'\\''s' && npx -y skills add acme/skills -a claude-code -y`)
  })
})

describe("agentx skill add (#1062)", () => {
  it("puts a skill where each agent's runtime reads it, and skips an sdk agent", async () => {
    const { skillCmd } = await import("../src/commands/manage")
    const cwd = process.cwd()
    const cc = join(ws, "cc"), cx = join(ws, "cx"), sdk = join(ws, "sdk")
    for (const d of [cc, cx, sdk]) mkdirSync(d)
    writeFileSync(join(ws, "agentx.json"), JSON.stringify({ agents: {
      cc: { name: "CC", workspace: cc, tier: "claude-code" },
      cx: { name: "CX", workspace: cx, tier: "codex-cli" },
      sd: { name: "SD", workspace: sdk, tier: "sdk" },
    } }))
    skill("src-skills", "greet")
    const log = console.log
    console.log = () => {}
    try {
      process.chdir(ws)
      await skillCmd.parseAsync(["add", join(ws, "src-skills", "greet"), "--all"], { from: "user" })
    } finally {
      process.chdir(cwd)
      console.log = log
    }
    expect(installedSkills("claude-code", cc).map((s) => s.dir)).toEqual([join(cc, ".claude", "skills", "greet")])
    expect(installedSkills("codex-cli", cx).map((s) => s.dir)).toEqual([join(cx, ".agents", "skills", "greet")])
    expect(installedSkills("claude-code", sdk)).toEqual([])
  })
})
