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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, renameSync, copyFileSync } from "fs"
import { dirname, extname, join, resolve } from "path"
import yaml from "js-yaml"
import type { ProjectRule, ProjectKind } from "@/projects/rules"

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

// ────────────────────────────────────────────────────────────────────────
// Project rule file mutations
// ────────────────────────────────────────────────────────────────────────
//
// Walks .agentx/projects/ to find the YAML for a given project key,
// runs the operator's mutator on the parsed rule, validates that the
// result still parses as YAML, then atomic-writes with a backup.
//
// Round-tripping: js-yaml's load/dump pair drops comments and may
// re-order keys. For the operator-edit workflow we prefer that —
// edits become canonical, predictable. The original is preserved in
// the .bak.<unix-ms> sidecar, so anyone who hand-authored comments
// has a recovery path.

const RULES_DIR_REL = ".agentx/projects"

function findRulePath(projectKey: string, cwd: string): string | null {
  const root = resolve(cwd, RULES_DIR_REL)
  if (!existsSync(root)) return null
  // Walk the tree — rule files live at any depth (org/repo/...).
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try { entries = readdirSync(dir) } catch { continue }
    for (const name of entries) {
      const full = join(dir, name)
      let s
      try { s = statSync(full) } catch { continue }
      if (s.isDirectory()) { stack.push(full); continue }
      const ext = extname(name).toLowerCase()
      if (ext !== ".yaml" && ext !== ".yml") continue
      try {
        const raw = yaml.load(readFileSync(full, "utf-8")) as { project?: string } | null
        if (raw?.project === projectKey) return full
      } catch { /* skip malformed */ }
    }
  }
  return null
}

function pathForNewRule(projectKey: string, cwd: string): string {
  // Layout matches the existing seeds: <root>/<org>/<repo>.yaml.
  // For non-VCS projects (jira / linear) the operator might pick a slug
  // without a slash; we still write under <root>/<slug>.yaml in that case.
  const root = resolve(cwd, RULES_DIR_REL)
  const safe = projectKey.replace(/[^a-zA-Z0-9._/-]/g, "_")
  return resolve(root, safe + ".yaml")
}

export interface MutateProjectRuleOpts {
  projectKey: string
  cwd: string
  mutator: (rule: ProjectRule) => ProjectRule
}

export interface MutateProjectRuleResult {
  projectKey: string
  path: string
  backup: string
  changed: boolean
}

export function mutateProjectRule(opts: MutateProjectRuleOpts): MutateProjectRuleResult {
  const path = findRulePath(opts.projectKey, opts.cwd)
  if (!path) {
    throw new Error(`project rule for "${opts.projectKey}" not found under ${RULES_DIR_REL}`)
  }
  const before = readFileSync(path, "utf-8")
  const rule = (yaml.load(before) ?? {}) as ProjectRule
  if (rule.project !== opts.projectKey) {
    // Defensive — finder matched on .project so this should be impossible.
    throw new Error(`rule file at ${path} project=${rule.project} does not match requested ${opts.projectKey}`)
  }
  const mutated = opts.mutator(structuredClone(rule))

  // Strip empty/undefined fields so the output stays clean. Operators
  // expect "set field to empty string" to mean "remove the field" —
  // matches the pattern across agentx config (cron prompts, channel
  // tokens, etc.).
  const cleaned = pruneEmpty(mutated)

  const after = yaml.dump(cleaned, { lineWidth: 100, noRefs: true, sortKeys: false })
  if (after === before) {
    return { projectKey: opts.projectKey, path, backup: "", changed: false }
  }
  // Validate the post-mutation YAML round-trips cleanly.
  try { yaml.load(after) } catch (e: any) {
    throw new Error(`refusing to write — YAML parse failed after mutation: ${e?.message ?? e}`)
  }
  const backup = `${path}.bak.${Date.now()}`
  copyFileSync(path, backup)
  atomicWrite(path, after)
  return { projectKey: opts.projectKey, path, backup, changed: true }
}

/** Strip undefined / null / empty-string / empty-array values recursively
 *  so the YAML output stays compact. Empty objects become undefined and
 *  the parent strips them on the next pass. */
function pruneEmpty(input: unknown): unknown {
  if (input === null || input === undefined) return undefined
  if (typeof input === "string") return input === "" ? undefined : input
  if (Array.isArray(input)) {
    const out = input.map(pruneEmpty).filter((v) => v !== undefined)
    return out.length > 0 ? out : undefined
  }
  if (typeof input === "object") {
    const out: Record<string, unknown> = {}
    let kept = 0
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const cleaned = pruneEmpty(v)
      if (cleaned !== undefined) { out[k] = cleaned; kept++ }
    }
    return kept > 0 ? out : undefined
  }
  return input
}

// ── Header-only mutations: shallow merge into the rule's top-level
// scalar fields. The Project page's edit modal uses this — sending
// only the fields the operator actually changed. Empty string =
// remove field.
const HEADER_FIELDS = ["displayName", "homeUrl", "kind", "runbook", "agent"] as const
type HeaderField = typeof HEADER_FIELDS[number]

export function patchProjectHeader(opts: { projectKey: string; cwd: string; patch: Partial<Record<HeaderField, string | null>> }): MutateProjectRuleResult {
  return mutateProjectRule({
    projectKey: opts.projectKey,
    cwd: opts.cwd,
    mutator: (rule) => {
      for (const k of HEADER_FIELDS) {
        if (!(k in opts.patch)) continue
        const v = opts.patch[k]
        if (v === "" || v === null) {
          delete (rule as unknown as Record<string, unknown>)[k]
        } else if (typeof v === "string") {
          if (k === "kind") {
            const allowed: ProjectKind[] = ["gitlab", "github", "jira", "linear", "other"]
            if (!allowed.includes(v as ProjectKind)) {
              throw new Error(`invalid kind="${v}" — allowed: ${allowed.join(", ")}`)
            }
            rule.kind = v as ProjectKind
          } else {
            (rule as unknown as Record<string, unknown>)[k] = v
          }
        }
      }
      return rule
    },
  })
}

// ── Contact link/unlink: array surgery on rule.contacts. ──────────

export function linkContact(opts: { projectKey: string; cwd: string; contactId: string }): MutateProjectRuleResult {
  return mutateProjectRule({
    projectKey: opts.projectKey,
    cwd: opts.cwd,
    mutator: (rule) => {
      const list = Array.isArray(rule.contacts) ? rule.contacts.slice() : []
      if (!list.includes(opts.contactId)) list.push(opts.contactId)
      rule.contacts = list
      return rule
    },
  })
}

export function unlinkContact(opts: { projectKey: string; cwd: string; contactId: string }): MutateProjectRuleResult {
  return mutateProjectRule({
    projectKey: opts.projectKey,
    cwd: opts.cwd,
    mutator: (rule) => {
      const list = Array.isArray(rule.contacts) ? rule.contacts.filter((c) => c !== opts.contactId) : []
      if (list.length > 0) rule.contacts = list
      else delete (rule as { contacts?: unknown }).contacts
      return rule
    },
  })
}

// ── Channel-clause replacement ────────────────────────────────────
//
// The Channels section of a rule (gitlab.issue/merge_request/note/
// pipeline + github.issues/pull_request) is the most form-heavy edit
// surface. Rather than per-clause partial merges (which hide the
// final shape from the operator), we accept the FULL channel object
// from the UI and replace the rule's gitlab / github top-level keys
// in one shot. The form UI is responsible for sending what the
// operator wants the rule to look like; we trust + validate.
//
// Empty objects / arrays are pruned by the generic pruneEmpty so a
// "remove this clause" intent can be expressed by sending {} for it.

export interface SetProjectClausesOpts {
  projectKey: string
  cwd: string
  /** When provided, REPLACES the rule's top-level `gitlab` block in
   *  full. Pass `null` to remove the entire gitlab section. Omit
   *  (undefined) to leave it untouched. Same semantics for github. */
  gitlab?: ProjectRule["gitlab"] | null
  github?: ProjectRule["github"] | null
}

export function setProjectClauses(opts: SetProjectClausesOpts): MutateProjectRuleResult {
  return mutateProjectRule({
    projectKey: opts.projectKey,
    cwd: opts.cwd,
    mutator: (rule) => {
      if (opts.gitlab !== undefined) {
        if (opts.gitlab === null) delete rule.gitlab
        else rule.gitlab = opts.gitlab
      }
      if (opts.github !== undefined) {
        if (opts.github === null) delete rule.github
        else rule.github = opts.github
      }
      return rule
    },
  })
}

// ── Create / delete project rule files ────────────────────────────

export interface CreateProjectOpts {
  projectKey: string
  cwd: string
  kind: ProjectKind
  displayName?: string
  homeUrl?: string
  runbook?: string
  agent?: string
}

export function createProjectRule(opts: CreateProjectOpts): { path: string } {
  if (!/^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/.test(opts.projectKey)) {
    throw new Error("project key must be alphanumeric with optional / separators")
  }
  if (findRulePath(opts.projectKey, opts.cwd)) {
    throw new Error(`project "${opts.projectKey}" already exists`)
  }
  const path = pathForNewRule(opts.projectKey, opts.cwd)
  mkdirSync(dirname(path), { recursive: true })
  const rule: Partial<ProjectRule> = {
    project: opts.projectKey,
    kind: opts.kind,
  }
  if (opts.displayName) rule.displayName = opts.displayName
  if (opts.homeUrl) rule.homeUrl = opts.homeUrl
  if (opts.runbook) rule.runbook = opts.runbook
  if (opts.agent) rule.agent = opts.agent
  const yamlText = yaml.dump(rule, { lineWidth: 100, noRefs: true, sortKeys: false })
  atomicWrite(path, yamlText)
  return { path }
}

export function deleteProjectRule(opts: { projectKey: string; cwd: string }): { path: string; backup: string } {
  const path = findRulePath(opts.projectKey, opts.cwd)
  if (!path) {
    throw new Error(`project "${opts.projectKey}" not found`)
  }
  const backup = `${path}.bak.${Date.now()}`
  copyFileSync(path, backup)
  unlinkSync(path)
  return { path, backup }
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
