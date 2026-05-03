import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { resolve, relative } from "path"
import { lintWorkflow, workflowSchema, type Workflow } from "./types"
import { parseYamlWorkflow, WorkflowYamlError } from "./yaml"

// --- WorkflowStore (V2) ---
//
// Filesystem persistence for workflow definitions. JSON on disk, one file
// per workflow, same convention as .agentx/procedures/ and .agentx/wiki/.
// V2 workflows are DAGs (nodes + edges); see types.ts. The matching
// dispatcher lives in dispatcher.ts and walks wf.nodes for the trigger.
//
// Move C — YAML files (`.yaml`/`.yml`) are loaded alongside JSON. The
// editor still saves JSON; YAML is read-only authoring. When a workflow
// has BOTH `<id>.yaml` and `<id>.json`, list()/validateAll() report the
// collision rather than silently picking one — operators delete one.

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
    return this.pathForJson(id)
  }

  private pathForJson(id: string): string {
    return resolve(this.baseDir, `${id}.json`)
  }

  private pathForYaml(id: string): string {
    return resolve(this.baseDir, `${id}.yaml`)
  }

  /** True for any *.json / *.yaml / *.yml file that doesn't start with `_`
   *  (which is how run logs / index files are filtered out). */
  private isWorkflowFile(name: string): boolean {
    if (name.startsWith("_")) return false
    return name.endsWith(".json") || name.endsWith(".yaml") || name.endsWith(".yml")
  }

  /** Strip the format extension to recover the workflow id. */
  private idFromFilename(name: string): string {
    return name.replace(/\.(json|ya?ml)$/, "")
  }

  /** Parse a workflow file from disk based on its extension. JSON is the
   *  canonical shape; YAML runs through the desugar pass first. */
  private readAndParse(name: string): unknown {
    const full = resolve(this.baseDir, name)
    const text = readFileSync(full, "utf-8")
    if (name.endsWith(".json")) return JSON.parse(text)
    return parseYamlWorkflow(text, { filePath: name })
  }

  /** Returns every well-formed workflow. Malformed files are skipped; the
   *  CLI `validate` subcommand is where authors get details.
   *
   *  Coexisting `<id>.json` + `<id>.yaml` is treated as a hard ambiguity
   *  — neither variant is loaded, and the id is omitted from list().
   *  validateAll() surfaces the collision with a clear message. */
  list(): Workflow[] {
    if (!existsSync(this.baseDir)) return []
    const byId = new Map<string, string[]>()
    for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isFile() || !this.isWorkflowFile(entry.name)) continue
      const id = this.idFromFilename(entry.name)
      const list = byId.get(id) ?? []
      list.push(entry.name)
      byId.set(id, list)
    }
    const out: Workflow[] = []
    for (const [, files] of byId) {
      // Skip ambiguous ids — list() must never pick a winner silently.
      if (files.length > 1) continue
      try {
        const raw = this.readAndParse(files[0])
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

    const byId = new Map<string, string[]>()
    for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isFile() || !this.isWorkflowFile(entry.name)) continue
      const id = this.idFromFilename(entry.name)
      const list = byId.get(id) ?? []
      list.push(entry.name)
      byId.set(id, list)
    }

    for (const [id, files] of byId) {
      // Coexisting <id>.json + <id>.yaml — surface BOTH paths with a
      // duplicate-id error attached to each so the operator sees what
      // to delete. Sort for deterministic output.
      if (files.length > 1) {
        const sorted = [...files].sort()
        for (const name of sorted) {
          results.push({
            id,
            path: relative(this.baseDir, resolve(this.baseDir, name)),
            issues: [`duplicate workflow id "${id}" — found ${sorted.join(" and ")}; delete one to disambiguate`],
            isValid: false,
          })
        }
        continue
      }

      const name = files[0]
      const full = resolve(this.baseDir, name)
      const rel = relative(this.baseDir, full)
      let raw: unknown
      try {
        raw = this.readAndParse(name)
      } catch (e: any) {
        const reason =
          e instanceof WorkflowYamlError
            ? e.message
            : `parse error: ${e?.message ?? e}`
        results.push({ id, path: rel, issues: [reason], isValid: false })
        continue
      }
      const parsed = workflowSchema.safeParse(raw)
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        results.push({ id: String((raw as any)?.id ?? id), path: rel, issues, isValid: false })
        continue
      }
      const lintIssues = lintWorkflow(parsed.data)
      results.push({ workflow: parsed.data, issues: lintIssues, isValid: lintIssues.length === 0 })
    }
    return results
  }

  get(id: string): Workflow | null {
    const jsonPath = this.pathForJson(id)
    const yamlPath = this.pathForYaml(id)
    const ymlPath = resolve(this.baseDir, `${id}.yml`)
    const haveJson = existsSync(jsonPath)
    const haveYaml = existsSync(yamlPath) || existsSync(ymlPath)
    // Coexistence is ambiguous at validateAll time; here we refuse to
    // pick a winner so callers don't silently get whichever the file
    // system orders first. Returning null mirrors "no such workflow".
    if (haveJson && haveYaml) return null
    if (haveJson) {
      try {
        const raw = JSON.parse(readFileSync(jsonPath, "utf-8"))
        const parsed = workflowSchema.safeParse(raw)
        return parsed.success ? parsed.data : null
      } catch {
        return null
      }
    }
    const yPath = existsSync(yamlPath) ? yamlPath : (existsSync(ymlPath) ? ymlPath : null)
    if (!yPath) return null
    try {
      const text = readFileSync(yPath, "utf-8")
      const raw = parseYamlWorkflow(text, { filePath: relative(this.baseDir, yPath) })
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
    // Editor saves are always JSON (canonical). If a YAML sibling exists
    // for this id, refuse — the operator authored it on disk and the
    // editor must not overwrite it with a JSON twin.
    const yamlPath = this.pathForYaml(normalized.id)
    const ymlPath = resolve(this.baseDir, `${normalized.id}.yml`)
    if (existsSync(yamlPath) || existsSync(ymlPath)) {
      throw new Error(
        `yaml-authored workflow "${normalized.id}" exists at ${
          existsSync(yamlPath) ? yamlPath : ymlPath
        }; edit on disk or delete the YAML before saving from the editor`,
      )
    }
    writeFileSync(this.pathForJson(normalized.id), JSON.stringify(normalized, null, 2) + "\n")
    return normalized
  }

  delete(id: string): boolean {
    const jsonPath = this.pathForJson(id)
    const yamlPath = this.pathForYaml(id)
    const ymlPath = resolve(this.baseDir, `${id}.yml`)
    let removed = false
    if (existsSync(jsonPath)) { unlinkSync(jsonPath); removed = true }
    if (existsSync(yamlPath)) { unlinkSync(yamlPath); removed = true }
    if (existsSync(ymlPath))  { unlinkSync(ymlPath);  removed = true }
    return removed
  }
}
