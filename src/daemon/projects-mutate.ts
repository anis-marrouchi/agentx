// --- Project ↔ workflow tag mutation ---
//
// Adds, replaces, or removes the top-level `project:` field on a
// workflow YAML / JSON file in `.agentx/workflows/`. Surface used by
// the Projects page's link/unlink controls so an operator can re-
// associate a workflow without hand-editing its source.
//
// Stability concerns honored:
//   - YAML files: surgical text edit. Preserves comments + ordering +
//     existing fields; only the `project:` line is touched.
//   - JSON files: parse → mutate → write with stable key ordering.
//   - Atomic write via a sibling tempfile + rename so a partial-write
//     can never corrupt the source file.
//   - Backup written to `<file>.bak.<unix-ms>` BEFORE any write so the
//     operator can recover even if the new content is later regretted.
//
// What this DOES NOT do:
//   - Validate that projectKey is a known project. The Projects page
//     resolves the autocomplete from existing projects; the daemon
//     trusts the caller. Setting an unknown project just makes the
//     workflow show up as "(no project)" elsewhere — recoverable.
//   - Notify the workflow store of the change. workflowStore.list() is
//     stateless and re-reads on each call, so the next /api/workflows
//     request picks up the new value automatically.

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "fs"
import { resolve } from "path"
import yaml from "js-yaml"

export interface SetWorkflowProjectOpts {
  workflowId: string
  /** Target project key, or null to strip the field entirely. */
  projectKey: string | null
  cwd: string
}

export interface SetWorkflowProjectResult {
  workflowId: string
  /** Resolved file path that was rewritten — caller can surface it. */
  path: string
  /** Format detected on disk: "yaml" or "json". */
  format: "yaml" | "json"
  /** Backup file written before the mutation. */
  backup: string
  /** New value of `project:` after the mutation (null when unlinked). */
  project: string | null
  /** True when the file actually changed; false when the request was
   *  idempotent (e.g. linking to the same project the workflow already
   *  carries). */
  changed: boolean
}

/**
 * Pick the workflow file. Mirrors the WorkflowStore's
 * `<id>.yaml` > `<id>.yml` > `<id>.json` precedence — file format
 * uniqueness is enforced at WorkflowStore level (collisions cause the
 * id to drop out of list()), so we don't need to re-check that here.
 */
function findWorkflowPath(workflowId: string, baseDir: string): { path: string; format: "yaml" | "json" } | null {
  const candidates: Array<{ path: string; format: "yaml" | "json" }> = [
    { path: resolve(baseDir, `${workflowId}.yaml`), format: "yaml" },
    { path: resolve(baseDir, `${workflowId}.yml`),  format: "yaml" },
    { path: resolve(baseDir, `${workflowId}.json`), format: "json" },
  ]
  return candidates.find((c) => existsSync(c.path)) ?? null
}

function backupPath(p: string): string {
  return `${p}.bak.${Date.now()}`
}

/**
 * Atomically replace the top-level `project:` field in a YAML file.
 *
 * Strategy: scan top-level lines (zero indent). If a `project:` line
 * exists, replace the value (or remove the line when newValue=null).
 * If absent, insert it RIGHT AFTER the existing top-level `id:` line
 * — that's the conventional placement in our seeded workflows. Falls
 * back to inserting at the top of the file when no `id:` is found.
 *
 * Why not js-yaml round-trip: js-yaml drops comments and re-orders
 * keys. Workflow YAMLs are documentation-rich; preserving comments
 * matters for hand-readability. A line-level edit is sufficient
 * because `project:` is always top-level and a single line.
 */
function rewriteYamlProject(text: string, newValue: string | null): { text: string; changed: boolean } {
  const lines = text.split("\n")
  // Top-level lines have no leading whitespace before the colon.
  const projectLineIdx = lines.findIndex((l) => /^project\s*:/.test(l))
  if (projectLineIdx >= 0) {
    if (newValue === null) {
      // Remove. If the line is followed by a YAML block-scalar
      // continuation, that would be unusual for `project:` (always a
      // scalar string in our schema). We assume single-line.
      const before = lines[projectLineIdx]
      lines.splice(projectLineIdx, 1)
      const next = lines.join("\n")
      return { text: next, changed: before !== "" }
    }
    const replaced = `project: ${newValue}`
    if (lines[projectLineIdx] === replaced) {
      return { text, changed: false }
    }
    lines[projectLineIdx] = replaced
    return { text: lines.join("\n"), changed: true }
  }
  // Absent — insert. Prefer placing right after the `id:` line; fall
  // back to top.
  if (newValue === null) {
    return { text, changed: false }   // nothing to remove
  }
  const idLineIdx = lines.findIndex((l) => /^id\s*:/.test(l))
  const insertion = `project: ${newValue}`
  if (idLineIdx >= 0) {
    lines.splice(idLineIdx + 1, 0, insertion)
  } else {
    lines.unshift(insertion)
  }
  return { text: lines.join("\n"), changed: true }
}

function rewriteJsonProject(text: string, newValue: string | null): { text: string; changed: boolean } {
  const obj = JSON.parse(text) as Record<string, unknown>
  const current = (obj.project as string | undefined) ?? null
  if (newValue === null) {
    if (current === null) return { text, changed: false }
    delete obj.project
  } else {
    if (current === newValue) return { text, changed: false }
    obj.project = newValue
  }
  return { text: JSON.stringify(obj, null, 2) + "\n", changed: true }
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, content, "utf-8")
  renameSync(tmp, path)
}

export function setWorkflowProject(opts: SetWorkflowProjectOpts): SetWorkflowProjectResult {
  const baseDir = resolve(opts.cwd, ".agentx/workflows")
  const found = findWorkflowPath(opts.workflowId, baseDir)
  if (!found) {
    throw new Error(`workflow "${opts.workflowId}" not found in ${baseDir}`)
  }
  const text = readFileSync(found.path, "utf-8")
  const { text: nextText, changed } =
    found.format === "yaml"
      ? rewriteYamlProject(text, opts.projectKey)
      : rewriteJsonProject(text, opts.projectKey)

  // Sanity check: the new YAML must still parse. js-yaml.load throws
  // on malformed; we want to fail BEFORE writing, never after.
  if (found.format === "yaml") {
    try { yaml.load(nextText) } catch (e: any) {
      throw new Error(`refusing to write — YAML parse failed after mutation: ${e?.message ?? e}`)
    }
  } else {
    try { JSON.parse(nextText) } catch (e: any) {
      throw new Error(`refusing to write — JSON parse failed after mutation: ${e?.message ?? e}`)
    }
  }

  let backup = ""
  if (changed) {
    backup = backupPath(found.path)
    copyFileSync(found.path, backup)
    atomicWrite(found.path, nextText)
  }

  return {
    workflowId: opts.workflowId,
    path: found.path,
    format: found.format,
    backup,
    project: opts.projectKey,
    changed,
  }
}
