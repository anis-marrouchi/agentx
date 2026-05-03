import type { z } from "zod"

// --- Built-in action types ---
//
// Improvement plan #6 — typed action library shipped with the daemon.
// Distinct from the operator-defined actions in src/actions/{types,
// store,runner}.ts:
//
//   Operator actions:  user-defined shell/http with {{name}} templating,
//                      stored as .agentx/actions/<id>.json. Loose typing.
//   Built-in actions:  daemon-shipped, Zod-validated I/O, called from
//                      agents (via HTTP fetch from Bash) or workflows.
//                      Strict typing.
//
// They coexist without interfering — different routes, different consumers.
// An agent invoking `http.fetch` doesn't need the operator to have
// pre-defined a curl-shaped action; it's there out of the box.

/**
 * One named, typed action shipped with the daemon. Handlers take a
 * Zod-validated input and return a Zod-validated output. Both schemas
 * also serve as the documentation surface — `GET /api/actions/builtin`
 * exports them as JSON-schema for operators / workflow editors.
 */
export interface BuiltinAction<I = unknown, O = unknown> {
  /** Dotted namespace.action — e.g. "http.fetch", "mesh.delegate". */
  name: string
  /** One-line description. Surfaced in the registry list. */
  description: string
  /** Zod schema for the input payload. The handler receives the
   *  parsed/validated value. */
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>
  /** Zod schema for the output. Validated AFTER the handler returns;
   *  divergence is logged so we catch handler / schema drift early. */
  outputSchema: z.ZodType<O, z.ZodTypeDef, unknown>
  /** Optional per-action timeout. Daemon-level cap is 60s. */
  timeoutMs?: number
  /** The actual implementation. Must not throw — return an error
   *  result via the output schema or wrap in a try/catch upstream. */
  handler: (input: I) => Promise<O>
}

export interface BuiltinActionMetadata {
  name: string
  description: string
  timeoutMs?: number
  /** JSON-Schema rendering of inputSchema, suitable for workflow
   *  editors / dashboard form builders. Generated from the Zod schema
   *  at registration time. */
  inputJsonSchema?: Record<string, unknown>
  outputJsonSchema?: Record<string, unknown>
}
