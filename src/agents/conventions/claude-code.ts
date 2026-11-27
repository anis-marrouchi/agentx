import { join } from "path"
import { skillsAdd } from "./shared"
import type { RuntimeConventions } from "./types"

/** loggedIn from `claude auth status` output, or null when it is not that JSON. */
export function parseAuthStatus(out: string): boolean | null {
  try {
    const v = JSON.parse(out)
    return typeof v?.loggedIn === "boolean" ? v.loggedIn : null
  } catch { return null }
}

// Claude Code reads project skills from .claude/skills/<name>/SKILL.md.
export const claudeCode = {
  tier: "claude-code",
  skillDirs: (ws: string) => [join(ws, ".claude", "skills")],
  addSkillCommand: skillsAdd("claude-code"),
  instructionsFile: "CLAUDE.md",
  cli: {
    command: "claude",
    label: "Claude Code",
    account: {
      provider: "claude" as const,
      envVar: "CLAUDE_CONFIG_DIR",
      defaultDir: (h: string) => join(h, ".claude"),
      signIn: "CLAUDE_CONFIG_DIR=<dir> claude, then /login",
    },
    signInStatus: { args: ["auth", "status"], parse: parseAuthStatus },
  },
} satisfies RuntimeConventions
