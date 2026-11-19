import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import { readTemplate, type TemplateName } from "@/workflows/templates"
import { parseYamlWorkflow } from "@/workflows/yaml"
import { workflowSchema } from "@/workflows/types"
import type { WorkflowStore } from "@/workflows/store"
import { CLOSE_WORKFLOW, EXPIRY_WORKFLOW } from "./runs"

// --- The two workflows of a talk's closing steps (#1892, phase 4) ---
//
// `situation-close` and `situation-expiry` are ordinary workflows in the
// node's workflow folder, so they show on the Workflows page with their
// runs. They are written from the bundled templates (YAML, with their
// comments) the first time a run of them is needed, and only then:
//
//   - a file for the id already there (.yaml, .yml or .json) is never
//     touched, even when it does not load: it is the owner's edit. It is
//     reported as broken, and no run of it starts;
//   - a template written once and later deleted stays deleted: the owner
//     removed it. Reported as deleted, and no run of it starts.
//
// What was written is kept in `_situation-workflows.json` in the same
// folder (files starting with "_" are not workflows to the store).

const MARKER = "_situation-workflows.json"
const IDS = [CLOSE_WORKFLOW, EXPIRY_WORKFLOW] as const
/** Phase 8: the weekly learning run, installed only while
 *  `situations.learned.enabled` is on (at daemon start, before the cron
 *  triggers are registered). */
const LEARN_ID = "situation-learn"

export interface SituationWorkflowsState {
  added: string[]
  /** A file exists but does not load as a workflow. */
  broken: Array<{ id: string; why: string }>
  /** Written once, since deleted by the owner. */
  deleted: string[]
}

function installed(dir: string): string[] {
  try {
    const v = JSON.parse(readFileSync(resolve(dir, MARKER), "utf-8")) as { installed?: unknown }
    return Array.isArray(v.installed) ? v.installed.filter((x): x is string => typeof x === "string") : []
  } catch { return [] }
}

/** Workflow files other than `<id>.yaml|yml|json` whose own id is `id`. */
function otherFilesDeclaring(dir: string, id: string): string[] {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return [] }
  const yamlId = new RegExp(`^id:\\s*["']?${id.replace(/[.-]/g, "\\$&")}["']?\\s*(#.*)?$`, "m")
  const jsonId = new RegExp(`"id"\\s*:\\s*"${id.replace(/[.-]/g, "\\$&")}"`)
  return names.filter((f) => /\.(ya?ml|json)$/.test(f) && !f.startsWith("_") && ![`${id}.yaml`, `${id}.yml`, `${id}.json`].includes(f))
    .filter((f) => {
      try { const t = readFileSync(resolve(dir, f), "utf-8"); return f.endsWith(".json") ? jsonId.test(t) : yamlId.test(t) } catch { return false }
    })
}

export function ensureSituationWorkflows(store: Pick<WorkflowStore, "get" | "baseDir">, opts: { learn?: boolean } = {}): SituationWorkflowsState {
  const dir = store.baseDir
  const out: SituationWorkflowsState = { added: [], broken: [], deleted: [] }
  const done = installed(dir)
  const ids: readonly TemplateName[] = opts.learn ? [LEARN_ID] : IDS
  for (const id of ids) {
    const files = [`${id}.yaml`, `${id}.yml`, `${id}.json`].filter((f) => existsSync(resolve(dir, f)))
    // The learning run is not the owner's to edit (its steps, the owner's
    // notice): a file that differs from the shipped one is put back, and
    // a deleted one too. To stop it, switch situations.learned.enabled off.
    if (id === LEARN_ID) {
      // Another file declaring the same id could take its place.
      for (const f of otherFilesDeclaring(dir, id)) out.broken.push({ id, why: `${f} also declares id ${id}; delete it (only ${id}.yaml is used)` })
      const text = readTemplate(id)
      let same = false
      try { same = files.length === 1 && files[0] === `${id}.yaml` && readFileSync(resolve(dir, files[0]), "utf-8") === text } catch { same = false }
      if (same) continue
      for (const f of files) { try { unlinkSync(resolve(dir, f)) } catch { /* rewritten below */ } }
      workflowSchema.parse(parseYamlWorkflow(text, { filePath: `${id}.yaml` }))
      writeFileSync(resolve(dir, `${id}.yaml`), text)
      out.added.push(id)
      continue
    }
    if (files.length > 0) {
      if (files.length > 1) { out.broken.push({ id, why: `both ${files.join(" and ")} exist; delete one` }); continue }
      if (!store.get(id)) out.broken.push({ id, why: `${files[0]} does not load as a workflow (agentx workflow validate shows why)` })
      continue
    }
    if (done.includes(id)) { out.deleted.push(id); continue }
    const text = readTemplate(id)
    // Checked before it is written: a broken template never lands.
    workflowSchema.parse(parseYamlWorkflow(text, { filePath: `${id}.yaml` }))
    writeFileSync(resolve(dir, `${id}.yaml`), text)
    out.added.push(id)
  }
  if (out.added.length) {
    try { writeFileSync(resolve(dir, MARKER), JSON.stringify({ installed: [...new Set([...done, ...out.added])] })) } catch { /* best effort */ }
  }
  return out
}
