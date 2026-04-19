import { z } from "zod"

// --- Procedures (foundation) ---
//
// Karpathy-style SOPs as first-class artifacts. Each procedure is a small
// typed doc with a trigger, inputs, ordered steps, expected output, and KPIs.
// v1 ships definition + list/add/show — the "delta extraction" flow
// (agents emit one-line deltas when they run a procedure, cheap O(runs)
// instead of O(entries × articles)) is deferred.
//
// Shape on disk (.agentx/procedures/):
//   <slug>.md            — frontmatter (id/title/trigger/inputs/expected/kpis)
//                          + markdown body (steps + notes)
//   _runs/<run-id>.json  — future: one per procedure run, holds deltas

export const procedureMetaSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "procedure id must be lower-kebab"),
  title: z.string().min(1),
  trigger: z.string().min(1, "procedures must describe when they apply"),
  inputs: z.array(z.string()).default([]),
  expected: z.string().optional(),
  kpis: z.array(z.string()).default([]),
  owner: z.string().optional(),
  tags: z.array(z.string()).default([]),
  created: z.string().optional(),
  updated: z.string().optional(),
  /** Related procedures (ids) or wiki articles (titles). Drives the graph. */
  related: z.array(z.string()).default([]),
})

export type ProcedureMeta = z.infer<typeof procedureMetaSchema>

export interface Procedure {
  meta: ProcedureMeta
  /** Markdown body — typically a "## Steps" section and optional notes. */
  body: string
  /** Relative path within the procedures root, e.g. "deploy-clawd.md". */
  path: string
}
