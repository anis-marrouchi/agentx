import type { A2AMesh } from "./mesh"

// --- Singleton accessor for the live A2AMesh ---
//
// Mirrors src/agents/process-registry-instance.ts. The daemon
// instantiates A2AMesh in its boot sequence and registers it here so
// process-global consumers (built-in actions, mesh.delegate) can reach
// it without changing every call site's signature. Setter is null-able
// because mesh-disabled deployments still need a valid module.

let _mesh: A2AMesh | null = null

export function getMesh(): A2AMesh | null {
  return _mesh
}

export function setMesh(m: A2AMesh | null): void {
  _mesh = m
}

/** Test-only — clears the reference between cases. */
export function _resetMeshForTesting(): void {
  _mesh = null
}
