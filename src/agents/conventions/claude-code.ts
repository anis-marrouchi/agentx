import { join } from "path"
import { skillsAdd } from "./shared"
import type { RuntimeConventions } from "./types"

// Claude Code reads project skills from .claude/skills/<name>/SKILL.md.
export const claudeCode: RuntimeConventions = {
  tier: "claude-code",
  skillDirs: (ws) => [join(ws, ".claude", "skills")],
  addSkillCommand: skillsAdd("claude-code"),
  instructionsFile: "CLAUDE.md",
}
