import { join } from "path"
import { skillsAdd } from "./shared"
import type { RuntimeConventions } from "./types"

// opencode reads project skills from .opencode/skills, and also from the
// Claude-compatible .claude/skills and the shared .agents/skills (opencode
// docs, "Agent Skills", 2026-10-19).
export const opencode: RuntimeConventions = {
  tier: "opencode",
  skillDirs: (ws) => [join(ws, ".opencode", "skills"), join(ws, ".claude", "skills"), join(ws, ".agents", "skills")],
  addSkillCommand: skillsAdd("opencode"),
  instructionsFile: "AGENTS.md",
}
