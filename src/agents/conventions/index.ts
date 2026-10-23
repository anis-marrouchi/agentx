import { existsSync, readdirSync } from "fs"
import { join } from "path"
import { claudeCode } from "./claude-code"
import { codexCli } from "./codex-cli"
import { opencode } from "./opencode"
import { orchestrator, sdk } from "./sdk"
import type { RuntimeConventions } from "./types"

export type { ConventionTier, RuntimeConventions } from "./types"

const BY_TIER: Record<string, RuntimeConventions> = {
  "claude-code": claudeCode,
  "codex-cli": codexCli,
  opencode,
  sdk,
  orchestrator,
}

/** The runtime's conventions, or null for a tier AgentX does not know.
 *  An unset tier is claude-code, the config default. */
export function getConventions(tier: string | undefined): RuntimeConventions | null {
  return BY_TIER[tier ?? "claude-code"] ?? null
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
