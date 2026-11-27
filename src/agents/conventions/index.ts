import { existsSync, readdirSync } from "fs"
import { join } from "path"
import { claudeCode } from "./claude-code"
import { codexCli } from "./codex-cli"
import { opencode } from "./opencode"
import { orchestrator, sdk } from "./sdk"
import type { CliAccount, CliFacts, ConventionTier, RuntimeConventions } from "./types"

export type { CliAccount, CliFacts, ConventionTier, RuntimeConventions } from "./types"
export { parseAuthStatus } from "./claude-code"

const BY_TIER = {
  "claude-code": claudeCode,
  "codex-cli": codexCli,
  opencode,
  sdk,
  orchestrator,
} satisfies Record<ConventionTier, RuntimeConventions>

const ALL: Record<string, RuntimeConventions> = BY_TIER

/** The runtime's conventions, or null for a tier AgentX does not know.
 *  An unset tier is claude-code, the config default. */
export function getConventions(tier: string | undefined): RuntimeConventions | null {
  return ALL[tier ?? "claude-code"] ?? null
}

type AccountOf<T> = T extends { cli: { account: { provider: infer P } } } ? P : never
/** The CLIs whose sign-in folder AgentX can switch: "claude" | "codex".
 *  Read from the entries, so a CLI with accounts is added in one place. */
export type CliProvider = AccountOf<(typeof BY_TIER)[keyof typeof BY_TIER]>

/** The CLI entries that have accounts, in catalog order. */
export function accountClis(): (CliFacts & { account: CliAccount & { provider: CliProvider } })[] {
  return Object.values(ALL).flatMap((e) => (e.cli?.account ? [e.cli as CliFacts & { account: CliAccount & { provider: CliProvider } }] : []))
}

/** The CLI entry run by the binary `command`, or null. */
export function cliByCommand(command: string): CliFacts | null {
  return Object.values(ALL).find((e) => e.cli?.command === command)?.cli ?? null
}

/** Where a new skill goes for this agent, or null when it has none. */
export function skillHome(tier: string | undefined, workspace: string): string | null {
  return getConventions(tier)?.skillDirs(workspace)[0] ?? null
}

/** The skills an agent's runtime will find: name and folder, the first
 *  folder winning when two hold the same name. */
export function installedSkills(tier: string | undefined, workspace: string): { name: string; dir: string }[] {
  const seen = new Map<string, string>()
  for (const root of getConventions(tier)?.skillDirs(workspace) ?? []) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      if (name.startsWith(".") || seen.has(name)) continue
      if (existsSync(join(root, name, "SKILL.md"))) seen.set(name, join(root, name))
    }
  }
  return [...seen].map(([name, dir]) => ({ name, dir })).sort((a, b) => a.name.localeCompare(b.name))
}
