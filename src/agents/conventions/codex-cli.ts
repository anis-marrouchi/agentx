import { join } from "path"
import { skillsAdd } from "./shared"
import type { RuntimeConventions } from "./types"

// Codex CLI reads project skills from .agents/skills/<name>/SKILL.md in
// every folder from the project root down to its working folder (checked
// against openai/codex ext/skills host_roots.rs and codex-cli 0.155.1,
// 2026-10-19). Its older $CODEX_HOME/skills is user-wide, not per agent.
export const codexCli: RuntimeConventions = {
  tier: "codex-cli",
  skillDirs: (ws) => [join(ws, ".agents", "skills")],
  addSkillCommand: skillsAdd("codex"),
  instructionsFile: "AGENTS.md",
}
