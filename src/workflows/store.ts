import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { resolve, relative } from "path"
import { lintWorkflow, workflowSchema, type Workflow } from "./types"

// --- WorkflowStore (V2) ---
//
// Filesystem persistence for workflow definitions. JSON on disk, one file
// per workflow, same convention as .agentx/procedures/ and .agentx/wiki/.
// V2 workflows are DAGs (nodes + edges); see types.ts. The matching
// dispatcher lives in dispatcher.ts and walks wf.nodes for the trigger.
//
// No YAML dep — authors can hand-write JSON or use the visual editor.

export interface WorkflowStoreOptions {
  baseDir?: string
}

export interface WorkflowValidation {
  workflow: Workflow
  issues: string[]
  isValid: boolean
}

export class WorkflowStore {
  readonly baseDir: string

  constructor(opts: WorkflowStoreOptions = {}) {
    this.baseDir = opts.baseDir ?? resolve(process.cwd(), ".agentx/workflows")
    mkdirSync(this.baseDir, { recursive: true })
  }

  private pathFor(id: string): string {
    return resolve(this.baseDir, `${id}.json`)
  }

  /** Returns every well-formed workflow. Malformed files are skipped; the
   *  CLI `validate` subcommand is where authors get details. */
  list(): Workflow[] {
    if (!existsSync(this.baseDir)) return []
    const out: Workflow[] = []
    for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith("_")) continue
      const full = resolve(this.baseDir, entry.name)
      try {
        const raw = JSON.parse(readFileSync(full, "utf-8"))
        const parsed = workflowSchema.safeParse(raw)
        if (parsed.success) out.push(parsed.data)
      } catch {
        // intentional: skip malformed
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  validateAll(): Array<WorkflowValidation | { id: string; path: string; issues: string[]; isValid: false }> {
    const results: Array<WorkflowValidation | { id: string; path: string; issues: string[]; isValid: false }> = []
    if (!existsSync(this.baseDir)) return results
    for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith("_")) continue
      const full = resolve(this.baseDir, entry.name)
      const rel = relative(this.baseDir, full)
      let rawJson: unknown
      try {
        rawJson = JSON.parse(readFileSync(full, "utf-8"))
      } catch (e: any) {
        results.push({ id: entry.name.replace(/\.json$/, ""), path: rel, issues: [`parse error: ${e.message}`], isValid: false })
        continue
      }
      const parsed = workflowSchema.safeParse(rawJson)
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        results.push({ id: String((rawJson as any)?.id ?? entry.name.replace(/\.json$/, "")), path: rel, issues, isValid: false })
        continue
      }
      const lintIssues = lintWorkflow(parsed.data)
      results.push({ workflow: parsed.data, issues: lintIssues, isValid: lintIssues.length === 0 })
    }
    return results
  }

  get(id: string): Workflow | null {
    const p = this.pathFor(id)
    if (!existsSync(p)) return null
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8"))
      const parsed = workflowSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  save(workflow: Workflow): Workflow {
    const now = new Date().toISOString().slice(0, 10)
    const normalized = workflowSchema.parse({
      ...workflow,
      created: workflow.created || now,
      updated: now,
    })
    writeFileSync(this.pathFor(normalized.id), JSON.stringify(normalized, null, 2) + "\n")
    return normalized
  }

  delete(id: string): boolean {
    const p = this.pathFor(id)
    if (!existsSync(p)) return false
    unlinkSync(p)
    return true
  }
}
