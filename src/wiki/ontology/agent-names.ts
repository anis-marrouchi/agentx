// --- The names agents go by on this node (#819) ---
//
// An agent page written as a person page shows up as somebody's
// relation. The graph types a page as an agent when its title is one of
// these names: each agent's id, its configured name, and the name in its
// workspace IDENTITY.md. Read from agentx.json in the working directory;
// a node without one has no names here, and `agent_names` in
// ontology.yaml still applies.

import { existsSync, readFileSync, statSync } from "fs"
import { resolve } from "path"

let cache: { key: string; names: string[] } | null = null

/** The persona name in an IDENTITY.md: a `Name:` line, bold or not. */
export function identityName(text: string): string | undefined {
  const m = text.match(/^\s*[-*]?\s*\**name\**\s*:\**\s*(.+?)\s*$/im)
  const name = m?.[1]?.replace(/\*+/g, "").trim()
  return name && name.length <= 60 ? name : undefined
}

/** Ids, names and persona names of the agents in `agents`. */
export function agentNamesOf(agents: Record<string, { name?: unknown; workspace?: unknown }> | undefined, baseDir = process.cwd()): string[] {
  const out = new Set<string>()
  for (const [id, a] of Object.entries(agents ?? {})) {
    out.add(id)
    if (typeof a?.name === "string" && a.name.trim()) out.add(a.name.trim())
    if (typeof a?.workspace !== "string") continue
    try {
      const file = resolve(baseDir, a.workspace.replace(/^~(?=\/)/, process.env.HOME ?? "~"), "IDENTITY.md")
      if (!existsSync(file)) continue
      const name = identityName(readFileSync(file, "utf-8"))
      if (name) out.add(name)
    } catch { /* an unreadable workspace adds no name */ }
  }
  return [...out].sort()
}

/** The names from this node's agentx.json, re-read when the file changes. */
export function registeredAgentNames(configPath = resolve(process.cwd(), "agentx.json")): string[] {
  try {
    if (!existsSync(configPath)) return []
    const key = `${configPath}:${statSync(configPath).mtimeMs}`
    if (cache?.key === key) return cache.names
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"))
    const names = agentNamesOf(cfg?.agents, resolve(configPath, ".."))
    cache = { key, names }
    return names
  } catch {
    return []
  }
}
