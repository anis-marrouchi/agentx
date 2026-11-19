import { writeFileSync } from "fs"
import { resolve } from "path"
import { readTemplate } from "@/workflows/templates"
import { parseYamlWorkflow } from "@/workflows/yaml"
import { workflowSchema } from "@/workflows/types"
import type { WorkflowStore } from "@/workflows/store"
import { CLOSE_WORKFLOW, EXPIRY_WORKFLOW } from "./runs"

// --- The two workflows of a talk's closing steps (#1892, phase 4) ---
//
// `situation-close` and `situation-expiry` are ordinary workflows in the
// node's workflow folder, so they show on the Workflows page with their
// runs. They are written from the bundled templates (YAML, with their
// comments) the first time a run of them is needed (closing steps
// switched on and a talk that has them), and never overwritten: an owner
// may edit them, for example to change the note's prompt.

export function ensureSituationWorkflows(store: Pick<WorkflowStore, "get" | "baseDir">): string[] {
  const added: string[] = []
  for (const id of [CLOSE_WORKFLOW, EXPIRY_WORKFLOW] as const) {
    if (store.get(id)) continue
    const text = readTemplate(id)
    // Checked before it is written: a broken template never lands.
    workflowSchema.parse(parseYamlWorkflow(text, { filePath: `${id}.yaml` }))
    writeFileSync(resolve(store.baseDir, `${id}.yaml`), text)
    added.push(id)
  }
  return added
}
