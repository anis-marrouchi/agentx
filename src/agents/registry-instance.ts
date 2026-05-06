import type { AgentRegistry } from "./registry"

// --- Singleton accessor for the live AgentRegistry ---
//
// Mirrors src/agents/process-registry-instance.ts and src/a2a/mesh-instance.ts.
// Daemon registers the registry at boot; cross-tier composition seams (e.g.
// the agent.call built-in action that needs to dispatch a local task without
// going through HTTP) read it via getAgentRegistry().
//
// This is a DOCUMENTED SEAM under the three-tier discipline rule — listed in
// test/tier-discipline.test.ts:DOCUMENTED_SEAMS so a procedure module can
// import this without violating "procedures must not import the agent
// registry runtime". The escape hatch is intentional: local delegation
// reuses the registry's session management + permission resolution + trace
// recording, which would otherwise need to be duplicated in the action.

let _registry: AgentRegistry | null = null

export function getAgentRegistry(): AgentRegistry | null {
  return _registry
}

export function setAgentRegistry(r: AgentRegistry | null): void {
  _registry = r
}

/** Test-only — guarantees a clean slate between cases. */
export function resetAgentRegistryForTesting(): void {
  _registry = null
}
