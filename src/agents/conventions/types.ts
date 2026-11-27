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
  /** How the runtime's CLI is run, when it is one (#2349). Its models are in
   *  seed-models.ts, which the Hub bundle can read. */
  cli?: CliFacts
}

export interface CliFacts {
  /** The binary's name on the PATH. */
  command: string
  /** The CLI's name as people see it. */
  label: string
  /** Its sign-in folder, when AgentX can switch accounts (cli-accounts.ts). */
  account?: CliAccount
  /** A command that prints whether the CLI is signed in, run on demand only. */
  signInStatus?: { args: string[]; parse(out: string): boolean | null }
}

export interface CliAccount {
  /** The key in cli-accounts.json. */
  provider: string
  /** The variable that points the CLI at a config folder. */
  envVar: string
  defaultDir(home: string): string
  /** How to sign in to a folder, shown in the Hub. */
  signIn: string
}
