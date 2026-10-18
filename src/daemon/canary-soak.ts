import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { resolve } from "path"
import type { BootEntry } from "./boot-record"

// --- Canary soak (#993): a release runs here before it goes to another host ---
//
// A release is a commit. Its soak starts at the first boot of the latest run
// of boots on that commit (boot-log.json) and lasts soakMinutes. During it:
//
//   * restarts       clean restarts on that commit, after the first boot
//   * crashes        restarts with no last-stop.json before them (crash, kill)
//   * crash-loop     resume.crashLoop's restarts within its window, any time
//   * failed-tasks   task_history rows that ended "error" or "timeout"
//   * error-rate     share of failed tasks vs the previous release's run
//
// Any failed check fails the soak at once. A run replaced by another commit
// before its soak ends is "interrupted". When task history can't be read the
// soak is "unavailable": not judged, never kept. The first pass or fail is kept in
// canary/releases.json, so later trouble on a passed release does not undo
// it. Refusals and overrides are appended to canary/events.jsonl.
//
// Pure functions over plain data, plus the small file helpers at the end.

export const CANARY_DIR = "canary"
export const RELEASES_FILE = "releases.json"
export const EVENTS_FILE = "events.jsonl"
const MINUTE = 60_000
/** How far back the previous release's run counts as a baseline. */
const BASELINE_MAX_MS = 7 * 24 * 60 * MINUTE

export interface CanaryThresholds {
  maxRestarts: number
  maxCrashes: number
  maxFailedTasks: number
  maxErrorRateIncrease: number
  minTasksForRate: number
}

export interface CanarySettings {
  enabled: boolean
  soakMinutes: number
  thresholds: CanaryThresholds
}

export interface CrashLoopSettings {
  restarts: number
  windowMinutes: number
}

export interface TaskCounts {
  total: number
  failed: number
}

/** Counts tasks started in [from, to). Null when task history can't be read. */
export type TaskCounter = (from: number, to: number) => TaskCounts | null

export type SoakStatus = "passed" | "failed" | "soaking" | "interrupted" | "not-started" | "unavailable"

export type SoakCheckName = "restarts" | "crashes" | "crash-loop" | "failed-tasks" | "error-rate"

export interface SoakCheck {
  name: SoakCheckName
  /** null: not judged (too little data); never blocks. */
  ok: boolean | null
  detail: string
}

export interface SoakResult {
  commit: string
  status: SoakStatus
  startedAt: string | null
  endsAt: string | null
  /** Minutes left while soaking; 0 once decided. */
  remainingMinutes: number | null
  checks: SoakCheck[]
  /** One line for people: why it passed, failed or is still waiting. */
  reason: string
  /** When it was judged, ISO. */
  checkedAt: string
}

export interface ReleaseRun {
  commit: string | null
  start: number
  /** First boot of the next run, on another commit; null while running. */
  end: number | null
  boots: BootEntry[]
}

/** Commits as the build records them: short SHA, "-dirty" when built from
 *  an unclean tree. A longer SHA given by hand matches its short form. */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  if (a.endsWith("-dirty") || b.endsWith("-dirty")) return a === b
  const [x, y] = a.length <= b.length ? [a, b] : [b, a]
  return x.length >= 7 && y.startsWith(x)
}

/** Split the boot log into runs: consecutive boots on the same commit. */
export function releaseRuns(boots: BootEntry[]): ReleaseRun[] {
  const runs: ReleaseRun[] = []
  for (const b of [...boots].sort((x, y) => x.at - y.at)) {
    const commit = b.commit ?? null
    const last = runs[runs.length - 1]
    if (last && (last.commit === commit || sameCommit(last.commit, commit))) last.boots.push(b)
    else {
      if (last) last.end = b.at
      runs.push({ commit, start: b.at, end: null, boots: [b] })
    }
  }
  return runs
}

/** Whether any boot in the run had crashLoop.restarts boots (itself
 *  included) within the window before it. */
function crashLoopIn(boots: BootEntry[], s: CrashLoopSettings): boolean {
  const window = s.windowMinutes * MINUTE
  return boots.some((b) => boots.filter((o) => o.at <= b.at && o.at > b.at - window).length >= s.restarts)
}

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`

/** Judge a commit's soak. Pure: boots, task counts and the time are given. */
export function evaluateSoak(input: {
  commit: string
  boots: BootEntry[]
  now: number
  settings: CanarySettings
  crashLoop: CrashLoopSettings
  tasks: TaskCounter
}): SoakResult {
  const { commit, now, settings, crashLoop, tasks } = input
  const t = settings.thresholds
  const checkedAt = new Date(now).toISOString()
  const runs = releaseRuns(input.boots)
  let index = -1
  for (let i = runs.length - 1; i >= 0; i--) if (sameCommit(runs[i].commit, commit)) { index = i; break }
  if (index < 0) {
    return {
      commit, status: "not-started", startedAt: null, endsAt: null, remainingMinutes: null, checks: [], checkedAt,
      reason: `${commit} has not run on this daemon yet. Restart the local daemon on it to start the soak.`,
    }
  }
  const run = runs[index]
  const soakEnd = run.start + settings.soakMinutes * MINUTE
  const until = Math.min(soakEnd, run.end ?? now, now)
  const inWindow = run.boots.filter((b) => b.at <= until)
  const restarts = inWindow.slice(1)
  const crashes = restarts.filter((b) => b.by === null && b.reason === null)
  const clean = restarts.length - crashes.length

  const checks: SoakCheck[] = [
    { name: "restarts", ok: clean <= t.maxRestarts, detail: `${clean} restart(s), ${t.maxRestarts} allowed` },
    { name: "crashes", ok: crashes.length <= t.maxCrashes, detail: `${crashes.length} unclean stop(s), ${t.maxCrashes} allowed` },
    {
      name: "crash-loop",
      ok: !crashLoopIn(inWindow, crashLoop),
      detail: `${crashLoop.restarts} restarts within ${crashLoop.windowMinutes} min counts as a crash loop`,
    },
  ]

  const current = tasks(run.start, until)
  if (!current) {
    checks.push({ name: "failed-tasks", ok: null, detail: "task history unavailable (.agentx/db.sqlite)" })
  } else {
    checks.push({
      name: "failed-tasks",
      ok: current.failed <= t.maxFailedTasks,
      detail: `${current.failed} of ${current.total} task(s) failed, ${t.maxFailedTasks} allowed`,
    })
    const prev = index > 0 ? runs[index - 1] : null
    const baseline = prev ? tasks(Math.max(prev.start, run.start - BASELINE_MAX_MS), run.start) : null
    if (current.total < t.minTasksForRate) {
      checks.push({ name: "error-rate", ok: null, detail: `only ${current.total} task(s), rate needs ${t.minTasksForRate}` })
    } else if (!baseline || baseline.total === 0) {
      checks.push({ name: "error-rate", ok: null, detail: "no tasks on the previous release to compare with" })
    } else {
      const rate = current.failed / current.total
      const base = baseline.failed / baseline.total
      checks.push({
        name: "error-rate",
        ok: rate - base <= t.maxErrorRateIncrease,
        detail: `${pct(rate)} failed vs ${pct(base)} on ${prev!.commit ?? "the previous release"}, +${pct(t.maxErrorRateIncrease)} allowed`,
      })
    }
  }

  const base = { commit, startedAt: new Date(run.start).toISOString(), endsAt: new Date(soakEnd).toISOString(), checks, checkedAt }
  const failed = checks.filter((c) => c.ok === false)
  if (failed.length) {
    return { ...base, status: "failed", remainingMinutes: 0, reason: `failed: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}` }
  }
  if (until >= soakEnd && !current) {
    return {
      ...base, status: "unavailable", remainingMinutes: 0,
      reason: "not judged: task history unavailable (.agentx/db.sqlite). Nothing is recorded; check again once it can be read.",
    }
  }
  if (until >= soakEnd) {
    return { ...base, status: "passed", remainingMinutes: 0, reason: `passed after ${settings.soakMinutes} min on the local daemon` }
  }
  if (run.end !== null) {
    return {
      ...base, status: "interrupted", remainingMinutes: null,
      reason: `interrupted: replaced after ${Math.round((run.end - run.start) / MINUTE)} of ${settings.soakMinutes} min. Run it on the local daemon again to restart the soak.`,
    }
  }
  const remaining = Math.ceil((soakEnd - now) / MINUTE)
  return { ...base, status: "soaking", remainingMinutes: remaining, reason: `soaking: ${remaining} min left` }
}

export interface DeployDecision {
  allow: boolean
  /** Why, for the operator. */
  message: string
  overridden: boolean
}

/** Whether a deploy of `commit` may go ahead. With the gate off, always. */
export function deployDecision(
  settings: CanarySettings,
  commit: string | null,
  soak: SoakResult | null,
  override?: string,
): DeployDecision {
  if (!settings.enabled) return { allow: true, message: "canary soak is off", overridden: false }
  let blocked: string | null = null
  if (!commit) blocked = "no release SHA: build from a git checkout"
  else if (commit.endsWith("-dirty")) blocked = `${commit} has uncommitted changes, so it is not a release. Commit first.`
  else if (!soak) blocked = `no soak result for ${commit}`
  else if (soak.status !== "passed") blocked = soak.reason
  if (!blocked) return { allow: true, message: `${commit}: soak passed`, overridden: false }
  if (override?.trim()) return { allow: true, message: `soak override (${override.trim()}): ${blocked}`, overridden: true }
  return { allow: false, message: blocked, overridden: false }
}

// --- Ledger ---

export interface ReleaseRecord {
  commit: string
  status: "passed" | "failed"
  decidedAt: string
  startedAt: string | null
  reason: string
  checks: SoakCheck[]
}

export interface CanaryEvent {
  at: string
  type: "blocked" | "override"
  commit: string | null
  host: string
  reason: string
  by?: string
}

export interface CanaryReport {
  releases: ReleaseRecord[]
  passed: number
  failed: number
  /** Distinct commits a deploy was refused for. */
  blockedReleases: number
  blockedDeploys: number
  overrides: number
}

/** Per-release soak results and refusals, oldest first. `since` (ms) keeps
 *  only what happened from then on. */
export function canaryReport(releases: ReleaseRecord[], events: CanaryEvent[], since = 0): CanaryReport {
  const recent = releases.filter((r) => Date.parse(r.decidedAt) >= since).sort((a, b) => a.decidedAt.localeCompare(b.decidedAt))
  const ev = events.filter((e) => Date.parse(e.at) >= since)
  const blocked = ev.filter((e) => e.type === "blocked")
  return {
    releases: recent,
    passed: recent.filter((r) => r.status === "passed").length,
    failed: recent.filter((r) => r.status === "failed").length,
    blockedReleases: new Set(blocked.map((e) => e.commit ?? "")).size,
    blockedDeploys: blocked.length,
    overrides: ev.filter((e) => e.type === "override").length,
  }
}

/** The ledger; null when the file exists but can't be read, so a write
 *  never replaces kept decisions with an empty ledger. */
function loadReleases(agentxDir: string): Record<string, ReleaseRecord> | null {
  const path = resolve(agentxDir, CANARY_DIR, RELEASES_FILE)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

/** False when releases.json exists but can't be read. */
export function ledgerReadable(agentxDir: string): boolean {
  return loadReleases(agentxDir) !== null
}

export function readReleases(agentxDir: string): Record<string, ReleaseRecord> {
  return loadReleases(agentxDir) ?? {}
}

export function readEvents(agentxDir: string): CanaryEvent[] {
  const path = resolve(agentxDir, CANARY_DIR, EVENTS_FILE)
  if (!existsSync(path)) return []
  const out: CanaryEvent[] = []
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* torn line */ }
  }
  return out
}

export function appendEvent(agentxDir: string, event: CanaryEvent): void {
  mkdirSync(resolve(agentxDir, CANARY_DIR), { recursive: true })
  appendFileSync(resolve(agentxDir, CANARY_DIR, EVENTS_FILE), JSON.stringify(event) + "\n")
}

/** The kept decision for a commit, if any. */
export function recordedSoak(agentxDir: string, commit: string): ReleaseRecord | null {
  const releases = readReleases(agentxDir)
  return Object.values(releases).find((r) => sameCommit(r.commit, commit)) ?? null
}

/** Keep the first pass or fail of a commit. Returns what is on record. */
export function recordSoak(agentxDir: string, result: SoakResult): ReleaseRecord | null {
  const kept = recordedSoak(agentxDir, result.commit)
  if (kept || (result.status !== "passed" && result.status !== "failed")) return kept
  const releases = loadReleases(agentxDir)
  if (!releases) return null
  const record: ReleaseRecord = {
    commit: result.commit, status: result.status, decidedAt: result.checkedAt,
    startedAt: result.startedAt, reason: result.reason, checks: result.checks,
  }
  releases[result.commit] = record
  mkdirSync(resolve(agentxDir, CANARY_DIR), { recursive: true })
  // Temp file + rename: a torn write never leaves a half ledger behind.
  const path = resolve(agentxDir, CANARY_DIR, RELEASES_FILE)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(releases, null, 2) + "\n")
  renameSync(tmp, path)
  return record
}

/** A kept decision as a result, so callers handle one shape. */
export function resultFromRecord(r: ReleaseRecord, now: number): SoakResult {
  return {
    commit: r.commit, status: r.status, startedAt: r.startedAt, endsAt: null, remainingMinutes: 0,
    checks: r.checks, reason: `${r.reason} (decided ${r.decidedAt})`, checkedAt: new Date(now).toISOString(),
  }
}
