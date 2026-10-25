// --- agentx start: the decisions, without the side effects (#1163) ---
//
// Which config to use, which agent to open, where its chat lives and
// whether the daemon answering on the port is this install's. start.ts
// does the writing and spawning; everything here is plain data in, data out.

import { existsSync } from "fs"
import { resolve } from "path"
import type { WizardPayload } from "@/daemon/setup-wizard"
import { shippedTeam } from "@/teams/catalog"
import { teamConflicts, teamMembers } from "@/teams/package"

export const FIRST_AGENT_ID = "assistant"

/** The config file this folder already has, if any, in the order the
 *  daemon looks for it (loadDaemonConfig). */
export function existingConfigPath(dir: string): string | null {
  for (const p of [resolve(dir, "agentx.json"), resolve(dir, ".agentx/config.json")]) {
    if (existsSync(p)) return p
  }
  return null
}

/** The one agent a fresh install gets. Claude Code when it is installed
 *  (its own login, no key to paste); otherwise the built-in engine on the
 *  Anthropic API (providers.claude, key from ${ANTHROPIC_API_KEY}), whose
 *  key the chat page asks for. Not the "sdk" engine: it needs
 *  @anthropic-ai/claude-agent-sdk, which the package does not ship. */
export function firstAgentPayload(nodeName: string, hasClaudeCli: boolean): WizardPayload {
  return {
    nodeName: nodeName.trim() || "My team",
    agent: {
      id: FIRST_AGENT_ID,
      name: "Assistant",
      triggerWords: `@${FIRST_AGENT_ID}, ${FIRST_AGENT_ID}`,
      ...(hasClaudeCli ? { tier: "claude-code" as const } : { tier: "orchestrator" as const, provider: "claude" }),
    },
  }
}

/** The agent to open: node.defaultAgent when it exists, else the first one. */
export function pickAgent(cfg: { node?: { defaultAgent?: string }; agents?: Record<string, unknown> }): string | null {
  const ids = Object.keys(cfg.agents || {})
  const preferred = cfg.node?.defaultAgent
  if (preferred && ids.includes(preferred)) return preferred
  return ids[0] ?? null
}

/** A bind address as a URL this machine can open. */
export function localUrl(bind: string): string {
  const hostPort = bind.replace(/^0\.0\.0\.0(?=:)/, "127.0.0.1").replace(/^\[::\](?=:)/, "127.0.0.1")
  return `http://${hostPort}`
}

export function daemonBaseUrl(cfg: { node?: { bind?: string } }): string {
  return localUrl(cfg.node?.bind || "127.0.0.1:18800")
}

export function dashboardBaseUrl(cfg: { dashboard?: { bind?: string; port?: number } }): string {
  return localUrl(`${cfg.dashboard?.bind || "127.0.0.1"}:${cfg.dashboard?.port || 4202}`)
}

/** The agent page with its chat open (agent.ts opens it on #chat). */
export function chatUrl(cfg: { dashboard?: { bind?: string; port?: number } }, agentId: string): string {
  return `${dashboardBaseUrl(cfg)}/admin/agents/${encodeURIComponent(agentId)}#chat`
}

/** Whether the daemon that answered /health is this folder's install.
 *  Another AgentX on the same port must not be taken for ours. */
export function isSameInstall(health: any, cfg: { node?: { id?: string } }): boolean {
  const theirs = health?.node?.id
  return !theirs || !cfg.node?.id || theirs === cfg.node.id
}

/** What `agentx start --team <name>` does (#1293): add a shipped team on the
 *  engine the first agent already uses, so it needs no other login or key;
 *  or nothing when it is already added, so a second run is safe. With
 *  `workspaceRoot`, an agent, schedule or folder the team would collide with
 *  is an error here, so start stops before it writes anything (#1319 review). */
export function startTeamPlan(
  rawConfig: { node?: { defaultAgent?: string }; agents?: Record<string, any>; crons?: Record<string, any> },
  name: string,
  opts?: { workspaceRoot?: string },
): { add: { team: string; tier?: string; provider?: string } } | { skip: string } | { error: string } {
  const pkg = shippedTeam(name)
  if (!pkg) return { error: `No team named "${name}".` }
  if (teamMembers(rawConfig, pkg.name).length) return { skip: `Team ${pkg.name} is already added (left as it is)` }
  const taken = opts?.workspaceRoot ? teamConflicts(rawConfig, pkg, { workspaceRoot: opts.workspaceRoot }) : teamConflicts(rawConfig, pkg)
  if (taken.length) return { error: `Team ${pkg.name} can't be added: already in this folder: ${taken.join(", ")}. Remove or rename them, or run start without --team.` }
  const first = rawConfig.agents?.[pickAgent(rawConfig) ?? ""]
  return { add: { team: pkg.name, tier: first?.tier, provider: first?.provider } }
}
