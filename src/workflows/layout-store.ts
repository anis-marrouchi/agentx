import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import { z } from "zod"

// --- LayoutStore ---
//
// Persists node (state) positions for the visual editor alongside workflow
// definitions, but in a sibling file so the Workflow schema stays pure
// behavior. A missing layout just means "no positions yet" — the editor
// falls back to auto-layout on load.
//
// Layout here is only x/y for state nodes. Edges derive their path from the
// endpoint nodes at render time, so they don't need persisted coordinates.
//
// Shape on disk:
//   .agentx/workflows/_layouts/<id>.json
//     { "version": 1, "nodes": { "<stateName>": { "x": 120, "y": 80 } } }

const layoutSchema = z.object({
  version: z.literal(1),
  nodes: z.record(z.object({
    x: z.number(),
    y: z.number(),
  })),
})
export type WorkflowLayout = z.infer<typeof layoutSchema>

export interface LayoutStoreOptions {
  baseDir?: string
}

export class LayoutStore {
  readonly baseDir: string
  readonly layoutsDir: string

  constructor(opts: LayoutStoreOptions = {}) {
    this.baseDir = opts.baseDir ?? resolve(process.cwd(), ".agentx/workflows")
    this.layoutsDir = resolve(this.baseDir, "_layouts")
    mkdirSync(this.layoutsDir, { recursive: true })
  }

  private pathFor(workflowId: string): string {
    // The workflow id grammar already excludes path-hostile chars, but guard
    // anyway in case a caller passes something unvalidated.
    const safe = workflowId.replace(/[^a-zA-Z0-9._-]/g, "_")
    return resolve(this.layoutsDir, `${safe}.json`)
  }

  get(workflowId: string): WorkflowLayout | null {
    const p = this.pathFor(workflowId)
    if (!existsSync(p)) return null
    try {
      const parsed = layoutSchema.safeParse(JSON.parse(readFileSync(p, "utf-8")))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  /** Save node positions. Callers should pass only coordinates for states
   *  that currently exist in the workflow — stale entries are kept until
   *  the caller explicitly prunes them via `sync()`. */
  save(workflowId: string, layout: WorkflowLayout): WorkflowLayout {
    const parsed = layoutSchema.parse(layout)
    writeFileSync(this.pathFor(workflowId), JSON.stringify(parsed, null, 2) + "\n")
    return parsed
  }

  /** Drop nodes from the layout whose ids aren't in `validIds`. Prevents
   *  stale positions from lingering after a state is removed in the editor. */
  sync(workflowId: string, validIds: string[]): WorkflowLayout | null {
    const existing = this.get(workflowId)
    if (!existing) return null
    const keep: WorkflowLayout["nodes"] = {}
    for (const id of validIds) if (existing.nodes[id]) keep[id] = existing.nodes[id]
    const next: WorkflowLayout = { version: 1, nodes: keep }
    return this.save(workflowId, next)
  }

  delete(workflowId: string): boolean {
    const p = this.pathFor(workflowId)
    if (!existsSync(p)) return false
    unlinkSync(p)
    return true
  }
}
