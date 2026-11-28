import { join } from "path"
import type { RuntimeConventions } from "./types"

// Antigravity CLI (`agy`) reads project skills from .agents/skills/<name>/
// SKILL.md and follows AGENTS.md at the workspace root (both checked with a
// headless run of agy 1.5.19, 28 Nov 2026, #2348). No account entry yet: its
// sign-in does not move with a config folder, so AgentX cannot switch it.
export const antigravityCli = {
  tier: "antigravity-cli",
  skillDirs: (ws: string) => [join(ws, ".agents", "skills")],
  // skills.sh has no agent name checked for agy; nothing is offered until one is.
  addSkillCommand: () => null,
  instructionsFile: "AGENTS.md",
  cli: { command: "agy", label: "Antigravity" },
} satisfies RuntimeConventions
