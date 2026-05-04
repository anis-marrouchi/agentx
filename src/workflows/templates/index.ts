// Workflow templates — bundled as string exports so they survive
// tsup's tree-shaking. Each template is the raw YAML; the CLI loads
// it, substitutes the placeholders (__ID__, __TITLE__, __AGENT__,
// __REVIEWER__), and writes the result into .agentx/workflows/.
//
// Why inline as a TS module instead of copying the .yaml files into
// dist/? Two reasons: (1) tsup doesn't copy non-code assets, and
// adding a custom copy step risks drift between dev and prod; (2) the
// templates are small enough that inlining costs ~5KB in the bundle
// — well below the threshold worth a separate file pipeline.
//
// To edit: change the .yaml file in this directory, then re-run
// `pnpm tsx scripts/sync-templates.ts` (or just paste the new
// content into the matching export below). The .yaml files are the
// source of truth; this index.ts is a hand-mirror.

import { readFileSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

export type TemplateName =
  | "linear"
  | "branching"
  | "extract"
  | "human-in-the-loop"
  | "retry"

export interface TemplateMeta {
  name: TemplateName
  title: string
  description: string
}

export const TEMPLATES: TemplateMeta[] = [
  { name: "linear",            title: "Linear",                description: "Trigger → Agent → End. Smallest workflow that runs." },
  { name: "branching",         title: "Branching",             description: "Classify, then route on the result via a branch node." },
  { name: "extract",           title: "Structured extraction", description: "Pull typed fields from free-form text via extract.structured." },
  { name: "human-in-the-loop", title: "Human-in-the-loop",     description: "Pause for a userTask form before continuing." },
  { name: "retry",             title: "Retry + fallback",      description: "Per-node retry policy with a branch fallback path." },
]

/** Read a template's raw YAML. Tries a small set of candidate paths
 *  so the same code works in (a) dev, where templates sit next to
 *  this .ts file, and (b) the bundled CLI, where tsup's onSuccess
 *  hook copies them to `dist/workflows/templates/`. After bundling
 *  the calling chunk may not live at dist/cli.js, so we fall back
 *  to argv[1]-relative + a couple of common parent layouts before
 *  giving up. */
export function readTemplate(name: TemplateName): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const cliDir = process.argv[1] ? dirname(process.argv[1]) : ""
  const candidates = [
    resolve(here, `${name}.yaml`),
    resolve(here, "workflows/templates", `${name}.yaml`),
    resolve(here, "..", "workflows/templates", `${name}.yaml`),
    resolve(here, "../..", "workflows/templates", `${name}.yaml`),
    cliDir ? resolve(cliDir, "workflows/templates", `${name}.yaml`) : "",
    cliDir ? resolve(cliDir, "..", "workflows/templates", `${name}.yaml`) : "",
  ].filter(Boolean) as string[]
  for (const path of candidates) {
    try { return readFileSync(path, "utf-8") } catch { /* try next */ }
  }
  throw new Error(`workflow template "${name}" not found in any of:\n  ${candidates.join("\n  ")}`)
}
