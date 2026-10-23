import { checkGitAncestor, type GitRunner } from "../checkers/git-ancestor"
import type { CheckerSettings } from "../checkers"
import type { ForgeReader } from "../checkers/issue"
import { issueLinks, issueRef, type Provider } from "./refs"
import type { DriftForge, MergedChange } from "./forge"

// --- Status follows the work: find the drift (#1138 step F) ---
//
// For one project: read the merge requests merged in the last
// `lookbackDays`, map each to the issues it closes (refs.ts), read where
// each issue says it is (its status label, or its state), and compare with
// what happened:
//
//   merged, not live (or live unknown), issue still To Do or Doing
//                              → merged-not-review (expected Review)
//   merged and live, issue not Done (open, or closed but still Review)
//                              → live-not-done (expected Done)
//   issue Done or closed, a merge it names not live yet
//                              → done-not-live (the other way)
//
// "Live" is: every running commit listed under the project's `live`
// contains the merge commit. Read only; nothing here writes anywhere.

export interface DriftProject {
  provider: Provider
  project: string
  live: string[]
  repo?: string
}

export interface StatusLabels { todo: string[]; doing: string[]; review: string[]; done: string[] }

export interface DriftSettings {
  enabled: boolean
  checkEveryMinutes: number
  lookbackDays: number
  projects: DriftProject[]
  liveField: string
  labels: StatusLabels
  /** Done, not live is told only once a merge has waited this long to go
   *  live: a forge closes the issue at merge time, before any deploy. */
  doneNotLiveAfterHours: number
  write: boolean
  writeProjects: string[]
}

export const DEFAULT_DRIFT_SETTINGS: DriftSettings = {
  enabled: true, checkEveryMinutes: 30, lookbackDays: 7, projects: [], liveField: "commit",
  labels: { todo: ["To Do", "Status::To Do"], doing: ["Doing", "Status::Doing"], review: ["Review", "Status::Review"], done: ["Done", "Status::Done"] },
  doneNotLiveAfterHours: 24,
  write: false, writeProjects: [],
}

export type Status = "todo" | "doing" | "review" | "done" | "closed" | "open"
export type DriftKind = "merged-not-review" | "live-not-done" | "done-not-live"
export type Liveness = "live" | "not-live" | "unknown"

/** A running commit, read from one `live` source. */
export interface LiveCommit { source: string; commit: string | null; error?: string }

export interface Drift {
  kind: DriftKind
  provider: Provider
  /** The issue: "group/project#12". */
  issue: string
  project: string
  number: number
  issueUrl: string
  status: Status
  /** The status label the issue carries, as written there. */
  statusLabel: string | null
  /** Every status label it carries: write mode removes them. */
  statusLabels: string[]
  /** The merges that close it. */
  changes: MergedChange[]
  /** The running commits, for live-not-done and done-not-live. */
  live: LiveCommit[]
  checkedAt: number
  /** One line, for the owner. */
  line: string
}

export interface ProjectCheck {
  project: DriftProject
  merged: number
  issues: number
  live: LiveCommit[]
  drifts: Drift[]
  errors: string[]
}

export interface DriftCheckDeps {
  /** `projects`: the issues a merge may name outside its own project.
   *  `doneNotLiveAfterHours`: unset, the default. */
  settings: Pick<DriftSettings, "lookbackDays" | "labels"> & Partial<Pick<DriftSettings, "projects" | "doneNotLiveAfterHours">>
  forge: DriftForge
  readIssue: ForgeReader
  /** The running commit of one `live` source. */
  liveCommit: (source: string) => Promise<LiveCommit>
  /** For a project with a `repo`: the checker settings that name it. */
  checkers?: Pick<CheckerSettings, "repos">
  git?: GitRunner
  /** Answers of "is this merge in that running commit", kept between
   *  checks: neither changes while the two commits stay the same. */
  liveCache?: Map<string, boolean>
  now?: number
}

/** Answers kept in a live cache before it is emptied. */
export const LIVE_CACHE_MAX = 5000

const DAY = 86_400_000
const ORDER: Array<keyof StatusLabels> = ["done", "review", "doing", "todo"]

/** Where an issue says it is: its status label, the furthest along when
 *  it has two, else its state. */
export function statusOf(issue: { state: string; labels?: string[] }, labels: StatusLabels): { status: Status; label: string | null; all: string[] } {
  const have = issue.labels ?? []
  const all = have.filter((l) => ORDER.some((s) => labels[s].some((x) => x.toLowerCase() === l.toLowerCase())))
  for (const s of ORDER) {
    const label = have.find((l) => labels[s].some((x) => x.toLowerCase() === l.toLowerCase()))
    if (label) return { status: s, label, all }
  }
  return { status: issue.state === "open" ? "open" : "closed", label: null, all }
}

const short = (c: string | null) => (c ? c.slice(0, 8) : "?")
const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC"
const said = (d: { statusLabel: string | null; status: Status }) => d.statusLabel ?? d.status

function lineOf(d: Omit<Drift, "line">): string {
  const mrs = d.changes.map((c) => `${c.ref} (${short(c.commit)}, merged ${day(c.mergedAt)})`).join(", ")
  const running = d.live.filter((l) => l.commit).map((l) => `${short(l.commit)} on ${l.source}`).join(", ")
  switch (d.kind) {
    case "live-not-done": return `${d.issue} is live (${mrs} in ${running}), still ${said(d)}: expected Done`
    case "merged-not-review": return `${d.issue} merged in ${mrs}, still ${said(d)}: expected Review`
    case "done-not-live": return `${d.issue} says ${said(d)} but ${mrs} is not live yet (${running})`
  }
}

/** The drifts of one project. Never throws: what could not be read is
 *  in `errors`, and an issue that could not be read is not judged. */
export async function checkProject(project: DriftProject, deps: DriftCheckDeps): Promise<ProjectCheck> {
  const now = deps.now ?? Date.now()
  const out: ProjectCheck = { project, merged: 0, issues: 0, live: [], drifts: [], errors: [] }
  const merged = await deps.forge.merged(project.provider, project.project, now - deps.settings.lookbackDays * DAY)
  if ("error" in merged) {
    out.errors.push(`${project.project}: merged changes: ${merged.error}`)
    return out
  }
  out.merged = merged.length
  out.live = await Promise.all(project.live.map((s) => deps.liveCommit(s)))
  for (const l of out.live) if (!l.commit) out.errors.push(`${project.project}: live ${l.source}: ${l.error ?? "no commit"}`)
  // A running commit that could not be read would turn "live" into
  // "unknown" and tell a wrong drift: judge nothing this check.
  if (out.live.some((l) => !l.commit)) return out

  // Is one merge in every running commit?
  const liveness = async (c: MergedChange): Promise<Liveness> => {
    if (!c.commit || !out.live.length) return "unknown"
    let all = true
    for (const l of out.live) {
      if (!l.commit) { all = false; continue }
      const has = await containsCommit(project, c.commit, l.commit, deps)
      if (has === false) return "not-live"
      if (has !== true) all = false
    }
    return all ? "live" : "unknown"
  }

  // The merges that close each issue. An issue of another project counts
  // only when that project is listed too: a merge never reaches a
  // project nobody asked to watch (a client's, say).
  const listed = new Set([project.project, ...(deps.settings.projects ?? []).filter((p) => p.provider === project.provider).map((p) => p.project)].map((p) => p.toLowerCase()))
  const byIssue = new Map<string, { project: string; number: number; changes: MergedChange[] }>()
  for (const c of merged) {
    for (const l of issueLinks(project.provider, project.project, c)) {
      if (!l.closes || !listed.has(l.project.toLowerCase())) continue
      const key = issueRef(l).toLowerCase()
      const entry = byIssue.get(key) ?? { project: l.project, number: l.number, changes: [] }
      entry.changes.push(c)
      byIssue.set(key, entry)
    }
  }
  // Only the merges that close an issue are looked up.
  const live = new Map<MergedChange, Liveness>()
  for (const { changes } of byIssue.values()) {
    for (const c of changes) if (!live.has(c)) live.set(c, await liveness(c))
  }
  const graceMs = (deps.settings.doneNotLiveAfterHours ?? DEFAULT_DRIFT_SETTINGS.doneNotLiveAfterHours) * 3_600_000

  for (const { project: p, number, changes } of byIssue.values()) {
    const item = await deps.readIssue(project.provider, { project: p, number, mr: false }, { notes: false })
    if ("error" in item) {
      out.errors.push(`${p}#${number}: ${item.error}`)
      continue
    }
    out.issues++
    const { status, label, all } = statusOf(item, deps.settings.labels)
    const states = changes.map((c) => live.get(c) ?? "unknown")
    const issueLive: Liveness = states.includes("not-live") ? "not-live" : states.every((s) => s === "live") ? "live" : "unknown"
    const kind: DriftKind | null =
      issueLive === "live" && status !== "done" && status !== "closed" ? "live-not-done"
      : issueLive === "not-live" && (status === "done" || status === "closed") ? "done-not-live"
      : issueLive !== "live" && (status === "todo" || status === "doing") ? "merged-not-review"
      : null
    if (!kind) continue
    const shown = kind === "done-not-live" ? changes.filter((c) => live.get(c) === "not-live") : changes
    if (kind === "done-not-live" && !shown.some((c) => now - c.mergedAt >= graceMs)) continue
    const d: Omit<Drift, "line"> = {
      kind, provider: project.provider, issue: `${p}#${number}`, project: p, number, issueUrl: item.url,
      status, statusLabel: label, statusLabels: all, changes: shown,
      live: kind === "merged-not-review" ? [] : out.live, checkedAt: now,
    }
    out.drifts.push({ ...d, line: lineOf(d) })
  }
  return out
}

async function containsCommit(project: DriftProject, commit: string, running: string, deps: DriftCheckDeps): Promise<boolean | null> {
  const key = `${project.provider}:${project.project.toLowerCase()}:${commit.toLowerCase()}:${running.toLowerCase()}`
  const cached = deps.liveCache?.get(key)
  if (cached !== undefined) return cached
  let has: boolean | null
  if (project.repo && deps.checkers) {
    // A local clone: the git-ancestor checker, with the running commit as the ref.
    const r = await checkGitAncestor({ kind: "git-ancestor", repo: project.repo, commit, ref: running }, { settings: { ...deps.checkers } as CheckerSettings, git: deps.git })
    has = r.verdict === "met" ? true : r.verdict === "not_met" ? false : null
  } else {
    has = await deps.forge.contains(project.provider, project.project, commit, running)
  }
  if (has !== null && deps.liveCache) {
    if (deps.liveCache.size >= LIVE_CACHE_MAX) deps.liveCache.clear()
    deps.liveCache.set(key, has)
  }
  return has
}

/** The note write mode leaves on the issue: the proof it moved on. */
export function proofNote(d: Drift, done: string): string {
  const mrs = d.changes.map((c) => `${c.url || c.ref} (merge commit \`${c.commit}\`, merged ${day(c.mergedAt)})`)
  const running = d.live.filter((l) => l.commit).map((l) => `\`${l.commit}\` on ${l.source}`)
  return [
    `Status set to **${done}** by AgentX: the work is live.`,
    "",
    `- Merged: ${mrs.join("; ")}`,
    `- Running: ${running.join("; ")}`,
    `- Checked: ${day(d.checkedAt)}`,
    "",
    `Was: ${said(d)}. The issue is not closed by this.`,
  ].join("\n")
}
