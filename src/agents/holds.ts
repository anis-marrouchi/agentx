import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"

// --- Agents on hold (#1169) ---
//
// An agent is held for one of two reasons:
//   paused    the owner paused it (Org view, or `agentx agent pause`)
//   approval  another agent created it, and the owner has not said yes yet
// A held agent starts no run: the registry checks before each one. The list
// lives in .agentx/agent-holds.json, not agentx.json, so pausing, resuming
// and approving apply at once, with no reload or restart. The CLI, the
// dashboard and the daemon are separate processes; each reads the file.

export type HoldKind = "paused" | "approval"

export interface AgentHold {
  kind: HoldKind
  at: string
  /** Who paused it, or which agent created it. */
  by: string
}

/** The folder whose .agentx/ holds the list: the daemon's working folder.
 *  Every reader and writer uses this one root. It is not the config file's
 *  folder: with .agentx/config.json that folder is .agentx/ itself, and a
 *  hold written there would never reach the daemon. */
export function holdsRoot(): string {
  return process.cwd()
}

export function holdsPath(root: string): string {
  return resolve(root, ".agentx", "agent-holds.json")
}

let cache: { path: string; mtimeMs: number; holds: Record<string, AgentHold> } | null = null

export function readHolds(root: string): Record<string, AgentHold> {
  const path = holdsPath(root)
  let mtimeMs: number
  try { mtimeMs = statSync(path).mtimeMs } catch { return {} }
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.holds
  let holds: Record<string, AgentHold> = {}
  try { holds = JSON.parse(readFileSync(path, "utf-8")) ?? {} } catch { holds = {} }
  cache = { path, mtimeMs, holds }
  return holds
}

function write(root: string, holds: Record<string, AgentHold>): void {
  const path = holdsPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(holds, null, 2) + "\n")
  renameSync(tmp, path)
  cache = null
}

export function holdAgent(root: string, agentId: string, kind: HoldKind, by: string, now = new Date()): AgentHold {
  const holds = { ...readHolds(root) }
  const hold: AgentHold = { kind, at: now.toISOString(), by }
  holds[agentId] = hold
  write(root, holds)
  return hold
}

/** Lift a hold. With `kind`, only a hold of that kind: resuming does not
 *  approve an agent that still waits for the owner's yes. */
export function releaseAgent(root: string, agentId: string, kind?: HoldKind): boolean {
  const holds = { ...readHolds(root) }
  const h = holds[agentId]
  if (!h || (kind && h.kind !== kind)) return false
  delete holds[agentId]
  write(root, holds)
  return true
}

/** Why `agentId` may not run now, in words for the person who asked; or null. */
export function holdMessage(root: string, agentId: string): string | null {
  const h = readHolds(root)[agentId]
  if (!h) return null
  if (h.kind === "approval") {
    return `Agent "${agentId}" was created by ${h.by} and waits for the owner's approval. It starts once the owner says yes in Approvals (agentx approvals approve agent:${agentId}).`
  }
  return `Agent "${agentId}" is paused by ${h.by}. Resume it in the Org view, or with: agentx agent resume ${agentId}`
}

/** The agent this process runs for: set when an agent runs the CLI from its
 *  own shell (the runtime exports AGENTX_AGENT_ID to every run). */
export function callingAgent(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.AGENTX_AGENT_ID?.trim() || undefined
}

/**
 * Agents created by another agent wait for the owner's yes: hold each of
 * `ids`. Returns the creating agent, or undefined when the owner ran the
 * command and nothing was held. A guard against an agent growing the team on
 * its own, not a security boundary: an agent that edits agentx.json by hand,
 * or clears the variable, is not caught here.
 */
export function holdIfAgentCreated(root: string, ids: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const by = callingAgent(env)
  if (!by) return undefined
  for (const id of ids) holdAgent(root, id, "approval", by)
  return by
}
