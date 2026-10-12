// Which agents a bulk `agentx wiki absorb` compiles (#850).
//
// An installation trying agent notes as the source of the wiki pauses the
// bulk absorb for a few agents with `agents.<id>.wiki.absorb.enabled:
// false`. Their raw entries are still captured, so turning it back on
// lets absorb catch up with nothing lost.

/** The part of an agent's config this module reads. */
export interface AbsorbAgentConfig {
  wiki?: { absorb?: { enabled?: boolean } }
}

/** Agents whose config turns the bulk absorb off. */
export function absorbOffAgents(agents: Record<string, AbsorbAgentConfig | undefined>): Set<string> {
  return new Set(Object.entries(agents).filter(([, a]) => a?.wiki?.absorb?.enabled === false).map(([id]) => id))
}

/**
 * Split the candidate agents into those to absorb and those skipped
 * because absorb is off for them. An agent named with `--agent` is always
 * absorbed: an operator asked for it by name.
 */
export function selectAbsorbAgents(
  candidates: string[],
  opts: { only?: string; off: Set<string> },
): { agents: string[]; skipped: string[] } {
  if (opts.only) return { agents: [opts.only], skipped: [] }
  return {
    agents: candidates.filter((id) => !opts.off.has(id)),
    skipped: candidates.filter((id) => opts.off.has(id)),
  }
}

/**
 * The line a bulk absorb prints for a skipped agent. When that agent is
 * `wikiNotes.absorbAgent`, it also says the notes inbox was not read
 * (#885).
 */
export function absorbSkipMessage(id: string, notesAbsorbAgent?: string): string {
  const inbox = id === notesAbsorbAgent ? " It reads the wiki notes inbox, so the inbox was not read." : ""
  return `absorb is off for this agent (agents.${id}.wiki.absorb.enabled); skipped.${inbox} Use --agent ${id} to run it anyway.`
}

/**
 * Write the switch into one agent's raw config, as the dashboard saves
 * it. Only `false` is written: on is the default, so turning it back on
 * removes the key instead of leaving `enabled: true` behind.
 */
export function setWikiAbsorb(agent: { wiki?: any }, on: boolean): void {
  if (on) {
    if (!agent.wiki?.absorb) return
    delete agent.wiki.absorb.enabled
    if (Object.keys(agent.wiki.absorb).length === 0) delete agent.wiki.absorb
    if (Object.keys(agent.wiki).length === 0) delete agent.wiki
    return
  }
  agent.wiki ??= {}
  agent.wiki.absorb ??= {}
  agent.wiki.absorb.enabled = false
}
