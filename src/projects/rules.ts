// --- Per-project webhook rules + runbook reference ---
//
// Project rules live in `.agentx/projects/<org>/<project>.yaml` (or any
// nested path; the loader walks the tree). Each file declares which
// channel events for that project may reach an agent and where the
// project's runbook (CLAUDE.md / AGENTS.md / DEPLOY.md / RUNBOOK.md)
// lives so the registry can inject it into the agent's system prefix.
//
// The store is loaded at daemon boot and watched for changes — write a
// file, save, and the next webhook event picks up the new rules without
// a daemon restart. Validation errors are logged and the offending file
// is skipped (other rules keep working).
//
// Why per-file: agencies grow projects faster than they touch agentx
// internals; a single project.yaml would force coordination on every
// edit. One file per project lets each project owner edit their own
// rules without merge conflicts.
//
// Schema is intentionally narrow:
//   - issue.actions / pull_request.actions / issues.actions: action allowlist
//   - requireLabels: at least one must be present (OR-of). Empty/absent = no
//     label requirement.
//   - excludeLabels: any present blocks the event.
//   - excludeStates: states that always block (e.g. "closed").
//   - excludeAuthors: handle prefixes that always block (bots).
//   - note.triggers: at least one must match for a comment to fire.
//   - runbook: filesystem path; the registry reads CLAUDE.md / AGENTS.md /
//     DEPLOY.md / RUNBOOK.md from this path (extensible via `runbookFiles`).
//
// Anything not listed by a rule passes through with the legacy default
// (existing adapter behaviour). Rules opt INTO filtering, never opt out
// of an event the adapter already drops.

import { existsSync, readdirSync, readFileSync, statSync, watch } from "fs"
import type { FSWatcher } from "fs"
import { extname, join, resolve } from "path"
import yaml from "js-yaml"

export type Channel = "gitlab" | "github"

/** Default runbook filenames read into the agent system prefix. Order
 *  preserved so CLAUDE.md (claude convention) lands before AGENTS.md
 *  (codex convention) — agents see Claude rules first. Operator can
 *  override per-project via `runbookFiles`. */
export const DEFAULT_RUNBOOK_FILES = ["CLAUDE.md", "AGENTS.md", "DEPLOY.md", "RUNBOOK.md"] as const

export interface IssueRule {
  /** Allowed actions. Empty/absent = no action restriction. */
  actions?: string[]
  /** Issue must carry at least one of these labels. Empty/absent = no req. */
  requireLabels?: string[]
  /** Any of these labels present blocks the event. */
  excludeLabels?: string[]
  /** States that always block (gitlab: opened|closed|reopened, github: open|closed). */
  excludeStates?: string[]
  /** Username substrings/equals that always block — used for bot exclusion. */
  excludeAuthors?: string[]
}

export interface NoteTrigger {
  /** Comment must contain this @mention to fire. Case-insensitive. */
  mention?: string
  /** Comment must contain this keyword (case-insensitive substring). */
  keyword?: string
}

export interface NoteRule {
  /** Restrict to certain noteable types — gitlab: issue|merge_request|commit|snippet. */
  onlyOn?: string[]
  /** At least one trigger must match the comment text for the event to fire. */
  triggers?: NoteTrigger[]
  /** Username substrings/equals that always block. */
  excludeAuthors?: string[]
}

export interface PipelineRule {
  /** Allowed pipeline statuses (success|failed|canceled|...). */
  actions?: string[]
}

export interface ProjectRule {
  /** Project path. GitLab: `org/repo`. GitHub: `owner/repo`. Required. */
  project: string
  channel?: Channel
  /** Default agent for this project. Overrides channel-level resolveAgent
   *  when set. Optional — leaving unset preserves existing behaviour. */
  agent?: string
  /** Filesystem path to the project root (where CLAUDE.md/AGENTS.md live).
   *  When set, the registry injects those files into the agent system
   *  prefix for tasks scoped to this project. */
  runbook?: string
  /** Override the default runbook file set (DEFAULT_RUNBOOK_FILES). */
  runbookFiles?: string[]
  gitlab?: {
    issue?: IssueRule
    note?: NoteRule
    pipeline?: PipelineRule
  }
  github?: {
    /** GitHub uses `issues` for issue events and `pull_request` for PRs. */
    issues?: IssueRule
    pull_request?: IssueRule
    push?: { branches?: string[] }
  }
  /** Free-form notes for the operator. Ignored by the loader. */
  description?: string
  /** Internal: file path the rule was loaded from, for diagnostics. */
  _path?: string
}

export interface FilterDecision {
  allow: boolean
  /** Reason for the decision — surfaced in logs so operators can see why
   *  an event was dropped. Always present when allow=false. */
  reason?: string
}

export class ProjectRulesStore {
  private byProject = new Map<string, ProjectRule>()
  private dir: string
  private log: (...args: unknown[]) => void
  private watcher?: FSWatcher
  private debounce?: ReturnType<typeof setTimeout>
  private loadErrors: Array<{ file: string; error: string }> = []

  constructor(dir: string, log: (...args: unknown[]) => void = console.error.bind(console, "[projects]")) {
    this.dir = dir
    this.log = log
  }

  load(): { count: number; errors: number } {
    this.byProject.clear()
    this.loadErrors = []
    if (!existsSync(this.dir)) {
      return { count: 0, errors: 0 }
    }
    for (const file of this.walk(this.dir)) {
      try {
        const raw = readFileSync(file, "utf-8")
        const parsed = yaml.load(raw) as unknown
        const rule = this.validate(parsed, file)
        if (!rule) continue
        rule._path = file
        if (this.byProject.has(rule.project)) {
          this.log(`duplicate project "${rule.project}" — keeping ${this.byProject.get(rule.project)!._path}, skipping ${file}`)
          continue
        }
        this.byProject.set(rule.project, rule)
      } catch (e: any) {
        this.loadErrors.push({ file, error: e?.message ?? String(e) })
        this.log(`failed to load ${file}: ${e?.message ?? e}`)
      }
    }
    return { count: this.byProject.size, errors: this.loadErrors.length }
  }

  startWatching(onReload?: () => void): void {
    if (!existsSync(this.dir)) return
    try {
      this.watcher = watch(this.dir, { recursive: true }, () => {
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => {
          const result = this.load()
          this.log(`rules reloaded: ${result.count} project(s), ${result.errors} error(s)`)
          onReload?.()
        }, 200)
      })
    } catch (e: any) {
      this.log(`watcher unavailable (${e.message}) — rules will not hot-reload`)
    }
  }

  stop(): void {
    this.watcher?.close()
    if (this.debounce) clearTimeout(this.debounce)
  }

  /** Look up a rule by project path. Returns undefined if no rule
   *  exists — callers must treat that as "no filter, legacy behaviour". */
  find(project: string): ProjectRule | undefined {
    return this.byProject.get(project)
  }

  list(): ProjectRule[] {
    return Array.from(this.byProject.values())
  }

  health(): { count: number; errors: Array<{ file: string; error: string }> } {
    return { count: this.byProject.size, errors: [...this.loadErrors] }
  }

  // --- Filter decisions ---

  /** Should a GitLab issue event reach an agent? */
  shouldFireGitlabIssue(project: string, payload: {
    action?: string
    state?: string
    labels?: string[]
    authorUsername?: string
  }): FilterDecision {
    const rule = this.find(project)?.gitlab?.issue
    if (!rule) return { allow: true }
    return matchIssueRule(rule, payload, "gitlab")
  }

  /** Should a GitLab MR-or-issue note event reach an agent? */
  shouldFireGitlabNote(project: string, payload: {
    noteableType?: string
    text?: string
    authorUsername?: string
  }): FilterDecision {
    const rule = this.find(project)?.gitlab?.note
    if (!rule) return { allow: true }
    return matchNoteRule(rule, payload)
  }

  /** Should a GitLab pipeline event reach an agent? */
  shouldFireGitlabPipeline(project: string, payload: { status?: string }): FilterDecision {
    const rule = this.find(project)?.gitlab?.pipeline
    if (!rule) return { allow: true }
    if (rule.actions && rule.actions.length > 0 && payload.status && !rule.actions.includes(payload.status)) {
      return { allow: false, reason: `pipeline status="${payload.status}" not in actions=${JSON.stringify(rule.actions)}` }
    }
    return { allow: true }
  }

  /** Should a GitHub issues event reach an agent? */
  shouldFireGithubIssue(project: string, payload: {
    action?: string
    state?: string
    labels?: string[]
    authorUsername?: string
  }): FilterDecision {
    const rule = this.find(project)?.github?.issues
    if (!rule) return { allow: true }
    return matchIssueRule(rule, payload, "github")
  }

  /** Should a GitHub pull_request event reach an agent? */
  shouldFireGithubPR(project: string, payload: {
    action?: string
    state?: string
    labels?: string[]
    authorUsername?: string
  }): FilterDecision {
    const rule = this.find(project)?.github?.pull_request
    if (!rule) return { allow: true }
    return matchIssueRule(rule, payload, "github")
  }

  // --- Internals ---

  private *walk(dir: string): Generator<string> {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      let stat
      try { stat = statSync(full) } catch { continue }
      if (stat.isDirectory()) {
        yield* this.walk(full)
        continue
      }
      const ext = extname(name).toLowerCase()
      if (ext === ".yaml" || ext === ".yml") yield full
    }
  }

  private validate(raw: unknown, file: string): ProjectRule | null {
    if (!raw || typeof raw !== "object") {
      throw new Error(`${file}: top-level must be an object`)
    }
    const r = raw as Record<string, unknown>
    if (typeof r.project !== "string" || !r.project.includes("/")) {
      throw new Error(`${file}: \`project\` must be a string of the form "org/repo"`)
    }
    if (r.runbook !== undefined && typeof r.runbook !== "string") {
      throw new Error(`${file}: \`runbook\` must be a string path`)
    }
    if (r.runbook && !resolve(r.runbook as string)) {
      // resolve never returns falsy — kept for symmetry / future expansion.
    }
    return raw as ProjectRule
  }
}

function matchIssueRule(rule: IssueRule, payload: {
  action?: string
  state?: string
  labels?: string[]
  authorUsername?: string
}, kind: Channel): FilterDecision {
  const labels = payload.labels ?? []
  const author = payload.authorUsername ?? ""
  if (rule.actions && rule.actions.length > 0) {
    if (!payload.action || !rule.actions.includes(payload.action)) {
      return { allow: false, reason: `${kind} issue action="${payload.action}" not in actions=${JSON.stringify(rule.actions)}` }
    }
  }
  if (rule.excludeStates && payload.state && rule.excludeStates.includes(payload.state)) {
    return { allow: false, reason: `${kind} issue state="${payload.state}" in excludeStates` }
  }
  if (rule.requireLabels && rule.requireLabels.length > 0) {
    const has = rule.requireLabels.some((req) => labels.includes(req))
    if (!has) {
      return { allow: false, reason: `${kind} issue missing requireLabels=${JSON.stringify(rule.requireLabels)} (have ${JSON.stringify(labels)})` }
    }
  }
  if (rule.excludeLabels && rule.excludeLabels.length > 0) {
    const hit = rule.excludeLabels.find((bad) => labels.includes(bad))
    if (hit) {
      return { allow: false, reason: `${kind} issue carries excluded label "${hit}"` }
    }
  }
  if (rule.excludeAuthors && rule.excludeAuthors.length > 0) {
    const hit = rule.excludeAuthors.find((bad) => author.toLowerCase().includes(bad.toLowerCase()))
    if (hit) {
      return { allow: false, reason: `${kind} issue authored by "${author}" matched excludeAuthors entry "${hit}"` }
    }
  }
  return { allow: true }
}

function matchNoteRule(rule: NoteRule, payload: {
  noteableType?: string
  text?: string
  authorUsername?: string
}): FilterDecision {
  const text = (payload.text ?? "").toLowerCase()
  const author = payload.authorUsername ?? ""
  if (rule.onlyOn && rule.onlyOn.length > 0) {
    if (!payload.noteableType || !rule.onlyOn.includes(payload.noteableType)) {
      return { allow: false, reason: `note noteableType="${payload.noteableType}" not in onlyOn=${JSON.stringify(rule.onlyOn)}` }
    }
  }
  if (rule.excludeAuthors && rule.excludeAuthors.length > 0) {
    const hit = rule.excludeAuthors.find((bad) => author.toLowerCase().includes(bad.toLowerCase()))
    if (hit) {
      return { allow: false, reason: `note authored by "${author}" matched excludeAuthors entry "${hit}"` }
    }
  }
  if (rule.triggers && rule.triggers.length > 0) {
    const matched = rule.triggers.some((t) => {
      if (t.mention) {
        const m = t.mention.toLowerCase()
        if (text.includes(m)) return true
      }
      if (t.keyword) {
        if (text.includes(t.keyword.toLowerCase())) return true
      }
      return false
    })
    if (!matched) {
      return { allow: false, reason: `note text matched no trigger` }
    }
  }
  return { allow: true }
}
