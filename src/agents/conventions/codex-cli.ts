import { join } from "path"
import { skillsAdd } from "./shared"
import type { RuntimeConventions } from "./types"

// Codex CLI reads project skills from .agents/skills/<name>/SKILL.md in
// every folder from the project root down to its working folder (checked
// against openai/codex ext/skills host_roots.rs and codex-cli 0.155.1,
// 2026-10-19). Its older $CODEX_HOME/skills is user-wide, not per agent.
export const codexCli = {
  tier: "codex-cli",
  skillDirs: (ws: string) => [join(ws, ".agents", "skills")],
  addSkillCommand: skillsAdd("codex"),
  instructionsFile: "AGENTS.md",
  cli: {
    command: "codex",
    label: "Codex",
    account: {
      provider: "codex" as const,
      envVar: "CODEX_HOME",
      defaultDir: (h: string) => join(h, ".codex"),
      signIn: "CODEX_HOME=<dir> codex login",
    },
  },
} satisfies RuntimeConventions
