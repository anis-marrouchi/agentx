import { join } from "path"
import { skillsAdd } from "./shared"
import type { RuntimeConventions } from "./types"

// opencode reads project skills from .opencode/skills, and also from the
// Claude-compatible .claude/skills and the shared .agents/skills (opencode
// docs, "Agent Skills", 2026-10-19). `skills add -a opencode` installs into
// .agents/skills, so that is where AgentX adds one too.
export const opencode = {
  tier: "opencode",
  skillDirs: (ws: string) => [join(ws, ".agents", "skills"), join(ws, ".opencode", "skills"), join(ws, ".claude", "skills")],
  addSkillCommand: skillsAdd("opencode"),
  instructionsFile: "AGENTS.md",
  cli: { command: "opencode", label: "OpenCode" },
} satisfies RuntimeConventions
