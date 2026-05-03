// --- Built-in actions barrel ---
//
// Importing this module registers every shipped built-in into the
// process-global registry. The daemon imports it once at startup so
// callers (HTTP routes, CLI, workflows) can look actions up by name.
//
// To add a new built-in: define it in a sibling file, import here,
// pass it to registerBuiltin(). Keep the imports alphabetical for
// human review.

import { registerBuiltin, _resetBuiltinsForTesting as _registryReset } from "./registry"
import { httpFetch, httpPost } from "./http"

/**
 * Register every shipped built-in. Idempotent — re-registering the
 * same name overwrites with the latest handler (registerBuiltin's
 * own contract), so calling this multiple times is safe and matches
 * the in-memory registry's current state.
 */
export function registerAllBuiltins(): void {
  registerBuiltin(httpFetch)
  registerBuiltin(httpPost)
}

/** Test-only — clears the registry. Re-call registerAllBuiltins to repopulate. */
export function _resetBuiltinsForTesting(): void {
  _registryReset()
}

export { getBuiltin, listBuiltins, runBuiltin } from "./registry"
export type { BuiltinAction, BuiltinActionMetadata } from "./types"
