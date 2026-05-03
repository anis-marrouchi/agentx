import type { BuiltinAction, BuiltinActionMetadata } from "./types"

// --- Built-in action registry ---
//
// Process-global. Built-ins register at module-load time via the
// barrel in ./index.ts; the daemon never has to wire them up
// explicitly. Lookup is O(1).

const _registry = new Map<string, BuiltinAction>()

const NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/

/**
 * Register a built-in. Idempotent — re-registering the same name
 * overwrites (useful for tests). Throws on malformed names so the
 * dotted-namespace contract stays consistent across the codebase.
 */
export function registerBuiltin<I, O>(action: BuiltinAction<I, O>): void {
  if (!NAME_PATTERN.test(action.name)) {
    throw new Error(`built-in action name must be dotted lowercase identifier (got "${action.name}")`)
  }
  _registry.set(action.name, action as BuiltinAction)
}

export function getBuiltin(name: string): BuiltinAction | undefined {
  return _registry.get(name)
}

/** List metadata for every registered built-in, sorted by name. The
 *  full schemas aren't included here — operators fetch the JSON-schema
 *  rendering separately to keep the list response small. */
export function listBuiltins(): BuiltinActionMetadata[] {
  const out: BuiltinActionMetadata[] = []
  for (const [name, a] of _registry.entries()) {
    out.push({ name, description: a.description, timeoutMs: a.timeoutMs })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** Test-only — wipe the registry between cases. Production never clears. */
export function _resetBuiltinsForTesting(): void {
  _registry.clear()
}

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Run a built-in. Wraps the handler in:
 *   - input validation (Zod parse — throws on bad shape)
 *   - per-action timeout (with daemon-default fallback)
 *   - output validation (Zod parse — log on mismatch but pass through;
 *     output drift shouldn't break callers, just signal)
 *
 * Returns the validated output, or rejects on timeout / handler error.
 * Callers (HTTP route, CLI) catch and translate to error responses.
 */
export async function runBuiltin<I, O>(name: string, rawInput: unknown): Promise<O> {
  const action = _registry.get(name) as BuiltinAction<I, O> | undefined
  if (!action) {
    throw new Error(`unknown built-in action: ${name}`)
  }
  const input = action.inputSchema.parse(rawInput) as I
  const timeoutMs = action.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const handlerPromise = action.handler(input)
  const timeoutPromise = new Promise<O>((_, reject) => {
    setTimeout(() => reject(new Error(`built-in action ${name} timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  const output = await Promise.race([handlerPromise, timeoutPromise])

  // Soft validation on output — log mismatches but pass the value
  // through. A handler that drifts from its schema shouldn't break
  // production; surfacing the drift in the daemon log is enough signal.
  const parsed = action.outputSchema.safeParse(output)
  if (!parsed.success) {
    process.stderr.write(`[builtin-action] ${name} output failed schema validation: ${parsed.error.message}\n`)
  }
  return output
}
