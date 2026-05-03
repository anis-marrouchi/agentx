import { z } from "zod"

// --- Action registry types ---
//
// Actions are reusable, parameterized invocations operators register
// once and call from workflows, CLI, or the dashboard. Two kinds for v1:
//
//   kind = "shell"   — exec a shell command. Most flexible.
//   kind = "http"    — POST/GET/PUT/DELETE/PATCH to a URL.
//
// Inputs are typed and templated into the command/url/body via {{name}}
// markers. Env-var refs ($VAR) are resolved against process.env at run
// time.
//
// On disk: .agentx/actions/<id>.json (one file per action).

export const actionInputTypeSchema = z.enum(["string", "number", "boolean"])
export type ActionInputType = z.infer<typeof actionInputTypeSchema>

export const actionInputSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "input name must be identifier-safe"),
  type: actionInputTypeSchema.default("string"),
  required: z.boolean().default(false),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().optional(),
})
export type ActionInput = z.infer<typeof actionInputSchema>

const baseActionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/, "id must be lowercase slug (alnum, '-', '_')"),
  title: z.string().min(1),
  description: z.string().optional(),
  inputs: z.array(actionInputSchema).default([]),
  timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

export const shellActionSchema = baseActionSchema.extend({
  kind: z.literal("shell"),
  /** Templated shell command. {{name}} and ${ENV_VAR} are interpolated. */
  command: z.string().min(1),
  /** When set, the working directory the command runs in. Defaults to the
   *  daemon's cwd. Useful when the action's a script in a subproject. */
  cwd: z.string().optional(),
  /** Extra env vars merged with process.env at invocation. Values may
   *  reference {{input}} or other env vars. */
  env: z.record(z.string(), z.string()).optional(),
})
export type ShellAction = z.infer<typeof shellActionSchema>

export const httpActionSchema = baseActionSchema.extend({
  kind: z.literal("http"),
  /** URL with optional {{name}} substitutions. */
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  headers: z.record(z.string(), z.string()).optional(),
  /** Body template (string). For JSON, the operator types JSON; we don't
   *  pretty-print. Skipped on GET / DELETE. */
  body: z.string().optional(),
})
export type HttpAction = z.infer<typeof httpActionSchema>

export const actionSchema = z.discriminatedUnion("kind", [shellActionSchema, httpActionSchema])
export type Action = z.infer<typeof actionSchema>

export interface ActionRunResult {
  ok: boolean
  /** stdout for shell, response body for http. Capped at ~32KB. */
  output: string
  /** stderr for shell, status text + headers summary for http. */
  errors?: string
  /** Exit code (shell) or HTTP status (http). */
  status?: number
  durationMs: number
}
