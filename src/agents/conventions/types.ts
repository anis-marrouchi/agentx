// --- Where each agent runtime keeps its own things (#1062) ---
//
// AgentX adds skills where the runtime itself reads them, and points people
// at the runtime's own install command, instead of keeping a store of its
// own. One file per runtime; sdk and orchestrator agents run inside AgentX
// and read skills the way AgentX does.

export type ConventionTier = "claude-code" | "codex-cli" | "opencode" | "sdk" | "orchestrator"

export interface RuntimeConventions {
  tier: ConventionTier
  /** Folders the runtime reads skills from, in a workspace. The first is
   *  where AgentX adds one. Empty: the runtime has no project skills. */
  skillDirs(workspace: string): string[]
  /** The shell command that adds a skills package the runtime's way. Shown
   *  to people and given to agents; AgentX itself never runs it. */
  addSkillCommand(pkg: string, workspace: string): string | null
  /** The instructions file the runtime reads at the workspace root. */
  instructionsFile: "CLAUDE.md" | "AGENTS.md"
}
