// --- Names the fleet's agents go by, so their pages are not people (#819) ---
//
// Old pages about an agent often carry `type: person` and a title that is
// just the agent's name ("Helper", or a persona name). The classify rules
// only catch titles with "agent" or "bot" in them. The roster lists every
// name an agent answers to: its id, its configured name, the persona name
// in its workspace, and any extra names the owner lists under
// `agent_names` in ontology.yaml (agents on another node, for example).
// Deterministic: no model call.

import { existsSync, readFileSync, statSync } from "fs"
import { resolve } from "path"
import { normName } from "./graph"

/** Normalised name → agent id. */
export type AgentRoster = Map<string, string>

export interface RosterAgent {
  id: string
  name?: string
  /** Persona name read from the agent's workspace. */
  persona?: string
}

export function buildRoster(agents: RosterAgent[], extraNames: string[] = []): AgentRoster {
  const roster: AgentRoster = new Map()
  const add = (name: string | undefined, id: string): void => {
    const key = name ? normName(name) : ""
    if (key && !roster.has(key)) roster.set(key, id)
  }
  for (const a of agents) {
    // An agent named "<id> Agent" is named after a person: the bare id
    // is that person's name, so only the full name points at the agent.
    if (!a.name || normName(a.name) !== `${normName(a.id)} agent`) add(a.id, a.id)
    add(a.name, a.id)
    add(a.persona, a.id)
  }
  for (const n of extraNames) add(n, n)
  return roster
}

/** The agent a title or alias names, if any. "<name> agent" counts too. */
export function rosterMatch(roster: AgentRoster, names: string[]): string | undefined {
  for (const n of names) {
    const key = normName(n)
    const hit = roster.get(key) ?? roster.get(key.replace(/ (agent|bot)$/, ""))
    if (hit) return hit
    // "Release Helper (release_helper_bot)": an agent name, then its handle.
    if (/ (agent|bot)( |$)/.test(key)) {
      for (const [name, id] of roster) if (key.startsWith(`${name} `)) return id
    }
  }
  return undefined
}

const PERSONA_FILES = ["IDENTITY.md", "persona.md", "PERSONA.md"]

/** `**Name:** Nova (…)` → "Nova". Only a short single name counts. */
export function personaName(text: string): string | undefined {
  const m = text.match(/\*\*Name:\*\*[ \t]*([^\n(.,;—–]+)/)
  const name = m?.[1]?.replace(/[*_`]/g, "").trim()
  return name && name.length <= 40 ? name : undefined
}

function readPersona(workspace: string | undefined): string | undefined {
  if (!workspace) return undefined
  for (const f of PERSONA_FILES) {
    const file = resolve(workspace, f)
    try {
      if (existsSync(file)) {
        const name = personaName(readFileSync(file, "utf-8"))
        if (name) return name
      }
    } catch {
      // An unreadable workspace file just means no persona name.
    }
  }
  return undefined
}

let cached: { file: string; mtimeMs: number; agents: RosterAgent[] } | null = null

/** Agents configured in the `agentx.json` next to the wiki (`<root>/.agentx/wiki`). */
export function configuredAgents(wikiDir: string): RosterAgent[] {
  const file = resolve(wikiDir, "..", "..", "agentx.json")
  let mtimeMs: number
  try { mtimeMs = statSync(file).mtimeMs } catch { return [] }
  if (cached && cached.file === file && cached.mtimeMs === mtimeMs) return cached.agents
  let agents: RosterAgent[] = []
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as { agents?: Record<string, { name?: unknown; workspace?: unknown }> }
    agents = Object.entries(raw.agents ?? {}).map(([id, a]) => ({
      id,
      name: typeof a?.name === "string" ? a.name : undefined,
      persona: readPersona(typeof a?.workspace === "string" ? a.workspace : undefined),
    }))
  } catch {
    agents = [] // a config being rewritten; the next request reads it again
  }
  cached = { file, mtimeMs, agents }
  return agents
}

/** Roster for a wiki: its agent folders, the node's config, and `agent_names`. */
export function loadRoster(wikiDir: string, agentIds: string[], extraNames: string[] = []): AgentRoster {
  const configured = configuredAgents(wikiDir)
  const known = new Set(configured.map(a => a.id))
  return buildRoster([...configured, ...agentIds.filter(id => !known.has(id)).map(id => ({ id }))], extraNames)
}
