// --- Can this agent answer yet? (#1163) ---
//
// `agentx start` opens the browser on the first agent's chat. When that
// agent has no model yet, the chat asks for one inline instead of failing
// on the first message: a key for an API-key engine, or the CLI login for
// a CLI engine. This module only decides which, from the raw agentx.json
// (where `${VAR}` still names the variable to fill), the environment and
// .env. It reads nothing itself, so it is easy to test.

export type ModelNeed = "key" | "cli"

export interface ModelReadiness {
  ready: boolean
  /** What the page should ask for when not ready. */
  need?: ModelNeed
  /** The .env variable the key goes into (need = "key"). */
  envVar?: string
  /** The CLI the engine runs (need = "cli"). */
  cli?: string
  /** One sentence for the person. */
  hint?: string
}

export interface ModelReadyInput {
  /** The parsed agentx.json, before ${VAR} expansion. */
  rawConfig: any
  agentId: string
  env: Record<string, string | undefined>
  dotenv: Record<string, string>
  /** Whether an executable is installed (findBinary in production). */
  hasBinary: (name: string) => boolean
  /** Whether the CLI is logged in: true/false, or null when it cannot
   *  tell (older CLI, no status command). Unset or null = assume yes. */
  cliLoggedIn?: (name: string) => boolean | null
}

const CLI_FOR_TIER: Record<string, { bin: string; login: string }> = {
  "claude-code": { bin: "claude", login: "Install Claude Code (https://claude.com/claude-code) and run `claude` once to log in" },
  "codex-cli": { bin: "codex", login: "Install Codex CLI and run `codex login`" },
  opencode: { bin: "opencode", login: "Install OpenCode and run `opencode auth login`" },
}

/** The variable a `${VAR}` value names, or null for a literal value. */
export function envRef(value: unknown): string | null {
  if (typeof value !== "string") return null
  const m = value.match(/^\$\{(\w+)\}$/)
  return m ? m[1] : null
}

export function modelReadiness(input: ModelReadyInput): ModelReadiness {
  const agent = input.rawConfig?.agents?.[input.agentId]
  if (!agent) return { ready: false, hint: `No agent "${input.agentId}" in agentx.json.` }
  const tier = String(agent.tier || "")

  const cli = CLI_FOR_TIER[tier]
  if (cli) {
    if (!input.hasBinary(cli.bin)) return { ready: false, need: "cli", cli: cli.bin, hint: `${cli.login}, then press Check again.` }
    if (input.cliLoggedIn?.(cli.bin) === false) {
      return { ready: false, need: "cli", cli: cli.bin, hint: `${cli.bin} is installed but not logged in. In a terminal, run \`${cli.bin}\` once and log in, then press Check again.` }
    }
    return { ready: true }
  }

  // The API-key engine. The orchestrator defaults to the claude-code
  // provider (no key), so only a provider that is configured with an
  // apiKey field is checked.
  if (tier === "sdk" || tier === "orchestrator") {
    const providerName = agent.provider || (tier === "sdk" ? "claude" : "claude-code")
    const provider = input.rawConfig?.providers?.[providerName]
    if (tier === "orchestrator" && !(provider && "apiKey" in provider)) return { ready: true }
    const raw = provider?.apiKey
    const ref = envRef(raw)
    if (ref) {
      if (input.env[ref] || input.dotenv[ref]) return { ready: true }
      return { ready: false, need: "key", envVar: ref, hint: `Paste an API key for "${providerName}". It is saved to .env as ${ref} on this computer only.` }
    }
    if (typeof raw === "string" && raw.trim()) return { ready: true }
    return { ready: false, hint: `Set providers.${providerName}.apiKey in agentx.json.` }
  }

  // Other engines (demo, custom): nothing to ask for here.
  return { ready: true }
}
