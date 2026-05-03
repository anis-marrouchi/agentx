import type { ProcessRegistry } from "./process-registry"

// --- Singleton accessor for the live ProcessRegistry ---
//
// Lifetime: the daemon constructs a registry in AgentRegistry's
// constructor (when at least one agent has `persistentProcess: true`)
// and registers it here. `executeTask` reads the singleton when it
// needs to dispatch via the persistent path. Tests use the
// set/reset hooks to inject fakes without touching the daemon.
//
// Why a singleton (vs threading the registry through executeTask's
// signature): executeTask is called from many sites — registry,
// cron, mesh — and adding a parameter to all of them is invasive.
// The registry is a process-global resource (one per daemon), same
// lifetime story as the event bus.

let _registry: ProcessRegistry | null = null

export function getProcessRegistry(): ProcessRegistry | null {
  return _registry
}

export function setProcessRegistry(r: ProcessRegistry | null): void {
  _registry = r
}

/** Test-only — guarantees a clean slate between cases. */
export function resetProcessRegistryForTesting(): void {
  _registry = null
}
