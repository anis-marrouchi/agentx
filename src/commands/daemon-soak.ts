import { Command } from "commander"
import chalk from "chalk"
import { execFileSync } from "child_process"
import Database from "better-sqlite3"
import { existsSync, readFileSync } from "fs"
import { userInfo } from "os"
import { resolve } from "path"
import { readBootLog } from "@/daemon/boot-record"
import {
  appendEvent, canaryReport, deployDecision, evaluateSoak, ledgerReadable, readEvents, readReleases,
  recordSoak, recordedSoak, resultFromRecord,
  type CanarySettings, type CrashLoopSettings, type DeployDecision, type SoakResult, type TaskCounter,
} from "@/daemon/canary-soak"
import { daemonConfigSchema, loadDaemonConfig } from "@/daemon/config"

// --- agentx daemon soak [sha] — canary soak status (#993) ---
//
// Reads the local daemon's boot log and task history (src/daemon/
// canary-soak.ts) and keeps the first pass or fail per release. The same
// check gates `agentx daemon deploy` when quality.canary.enabled is on.

const agentxDir = (cwd = process.cwd()) => resolve(cwd, ".agentx")

function findConfig(configPath: string | undefined, cwd: string): string | undefined {
  return configPath ?? ["agentx.json", ".agentx/config.json"].map((f) => resolve(cwd, f)).find((p) => existsSync(p))
}

/** Whether quality.canary.enabled is literally true in the raw config. Reads
 *  that one key only: no .env, no validation, never throws, so with the gate
 *  off a deploy behaves exactly as it did before the gate existed. A config
 *  that can't be parsed, or a switch that is set but not a boolean, reads as
 *  off with a warning, so the gate never turns off without a word. */
export function canarySwitch(configPath?: string, cwd = process.cwd()): { enabled: boolean; warning?: string } {
  const found = findConfig(configPath, cwd)
  if (!found) return { enabled: false }
  let raw: any
  try { raw = JSON.parse(readFileSync(found, "utf-8")) } catch {
    return { enabled: false, warning: `${found} is not valid JSON, so the canary soak is treated as off.` }
  }
  const value = raw?.quality?.canary?.enabled
  if (value === true) return { enabled: true }
  if (value === undefined || value === false) return { enabled: false }
  return { enabled: false, warning: `quality.canary.enabled is ${JSON.stringify(value)}, not true, so the canary soak is off.` }
}

export function canaryEnabled(configPath?: string, cwd = process.cwd()): boolean {
  return canarySwitch(configPath, cwd).enabled
}

function canarySettings(configPath?: string, cwd = process.cwd()): { canary: CanarySettings; crashLoop: CrashLoopSettings } {
  // No config at all (a plain checkout): the defaults, so the gate is off.
  // A config that exists but does not load still throws.
  const found = findConfig(configPath, cwd)
  if (!found) {
    const { shape } = daemonConfigSchema
    return { canary: shape.quality.parse(undefined).canary, crashLoop: shape.resume.parse(undefined).crashLoop }
  }
  const cfg = loadDaemonConfig(found)
  return { canary: cfg.quality.canary, crashLoop: cfg.resume.crashLoop }
}

/** The release SHA of this checkout, as tsup bakes it into a build. */
export function headCommit(cwd = process.cwd()): string | null {
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  try {
    const sha = git(["rev-parse", "--short=7", "HEAD"])
    const dirty = git(["status", "--porcelain", "--untracked-files=no"])
    return sha ? (dirty ? `${sha}-dirty` : sha) : null
  } catch { return null }
}

/** Why the checkout no longer matches the soaked commit, or null when it
 *  still does. Deploy calls it before the build and again before rsync. */
export function checkoutMoved(soaked: string, cwd = process.cwd()): string | null {
  const now = headCommit(cwd)
  return now === soaked ? null : `this checkout moved from ${soaked} to ${now ?? "an unknown commit"} after the soak check. Run the deploy again.`
}

/** The build environment that bakes the soaked commit into dist/. */
export function pinnedBuildEnv(commit: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, AGENTX_BUILD_COMMIT: commit }
}

/** Task counts from the daemon's own db, opened read-only. A missing file
 *  (wrong folder) reads as unavailable, never as zero tasks. Only errors and
 *  timeouts count as failed; a task someone stopped did not fail. */
function taskCounter(dir: string): TaskCounter {
  return (from, to) => {
    const path = resolve(dir, "db.sqlite")
    if (!existsSync(path)) return null
    let db: Database.Database | undefined
    try {
      db = new Database(path, { readonly: true, fileMustExist: true })
      const row = db.prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('error', 'timeout') THEN 1 ELSE 0 END) AS failed
           FROM task_history WHERE started_at >= ? AND started_at < ?`,
      ).get(new Date(from).toISOString(), new Date(to).toISOString()) as { total: number; failed: number | null }
      return { total: row.total, failed: row.failed ?? 0 }
    } catch { return null } finally { db?.close() }
  }
}

/** The soak result for a commit: the kept decision, else judged now (and
 *  kept when it passes or fails, unless `record` is false). */
export function soakFor(
  commit: string, canary: CanarySettings, crashLoop: CrashLoopSettings,
  opts: { now?: number; record?: boolean; cwd?: string } = {},
): SoakResult {
  const dir = agentxDir(opts.cwd)
  const now = opts.now ?? Date.now()
  // A ledger that can't be read may hold a fail: refuse to judge again.
  if (!ledgerReadable(dir)) {
    return {
      commit, status: "unavailable", startedAt: null, endsAt: null, remainingMinutes: 0, checks: [],
      checkedAt: new Date(now).toISOString(),
      reason: "not judged: the release ledger (.agentx/canary/releases.json) can't be read, so an earlier fail can't be ruled out. Fix or move the file, then check again.",
    }
  }
  const kept = recordedSoak(dir, commit)
  if (kept) return resultFromRecord(kept, now)
  const result = evaluateSoak({ commit, boots: readBootLog(dir), now, settings: canary, crashLoop, tasks: taskCounter(dir) })
  if (opts.record !== false) recordSoak(dir, result)
  return result
}

/** Called by `agentx daemon deploy` before anything is copied. With the gate
 *  off it returns "allow" after reading only the switch. Refusals and
 *  overrides are logged to .agentx/canary/events.jsonl. A dry run writes
 *  nothing: no ledger entry, no event. */
export function soakGate(
  host: string,
  opts: { config?: string; overrideSoak?: string; dryRun?: boolean; cwd?: string },
): DeployDecision & { commit: string | null; enabled: boolean; warning?: string } {
  const cwd = opts.cwd ?? process.cwd()
  const sw = canarySwitch(opts.config, cwd)
  if (!sw.enabled) {
    return { allow: true, message: "canary soak is off", overridden: false, commit: null, enabled: false, ...(sw.warning ? { warning: sw.warning } : {}) }
  }
  const { canary, crashLoop } = canarySettings(opts.config, cwd)
  if (!canary.enabled) return { ...deployDecision(canary, null, null), commit: null, enabled: false }
  const commit = headCommit(cwd)
  const soak = commit && !commit.endsWith("-dirty") ? soakFor(commit, canary, crashLoop, { record: !opts.dryRun, cwd }) : null
  const decision = deployDecision(canary, commit, soak, opts.overrideSoak)
  if (!opts.dryRun && (decision.overridden || !decision.allow)) {
    appendEvent(agentxDir(cwd), {
      at: new Date().toISOString(),
      type: decision.overridden ? "override" : "blocked",
      commit, host, reason: decision.overridden ? opts.overrideSoak!.trim() : decision.message,
      ...(decision.overridden ? { by: userInfo().username } : {}),
    })
  }
  return { ...decision, commit, enabled: true }
}

function printResult(r: SoakResult): void {
  const color = r.status === "passed" ? chalk.green : r.status === "soaking" ? chalk.yellow : chalk.red
  console.log(`  ${chalk.bold(r.commit)}  soak: ${color(r.status)}`)
  console.log(`  ${r.reason}`)
  if (r.startedAt) console.log(chalk.dim(`  started ${r.startedAt}${r.endsAt ? `, ends ${r.endsAt}` : ""}`))
  for (const c of r.checks) {
    const mark = c.ok === true ? chalk.green("✓") : c.ok === false ? chalk.red("✗") : chalk.dim("–")
    console.log(`  ${mark} ${c.name}: ${c.detail}`)
  }
}

export const soakCommand = new Command("soak")
  .description("show whether a release passed its canary soak on this daemon")
  .argument("[sha]", "release commit (default: this checkout's HEAD)")
  .option("-c, --config <path>", "path to agentx.json")
  .option("--history", "list soak results per release and how many were blocked", false)
  .option("--since <days>", "with --history: only the last N days")
  .option("--json", "print JSON", false)
  .action((sha: string | undefined, opts) => {
    const { canary, crashLoop } = canarySettings(opts.config)
    if (opts.history) {
      const days = opts.since ? Number(opts.since) : 0
      const since = days > 0 ? Date.now() - days * 86_400_000 : 0
      const report = canaryReport(Object.values(readReleases(agentxDir())), readEvents(agentxDir()), since)
      if (opts.json) { console.log(JSON.stringify(report, null, 2)); return }
      console.log(`  ${report.passed} passed, ${report.failed} failed, ${report.blockedReleases} release(s) blocked (${report.blockedDeploys} deploy(s) refused), ${report.overrides} override(s)`)
      for (const r of report.releases) console.log(`  ${r.decidedAt}  ${r.commit}  ${r.status}  ${chalk.dim(r.reason)}`)
      return
    }
    const commit = sha ?? headCommit()
    if (!commit) { console.log(chalk.red("  No commit given and this folder is not a git checkout.")); process.exitCode = 1; return }
    const result = soakFor(commit, canary, crashLoop)
    if (opts.json) { console.log(JSON.stringify({ enabled: canary.enabled, ...result }, null, 2)); return }
    if (!canary.enabled) console.log(chalk.dim("  quality.canary.enabled is off: deploys are not gated."))
    printResult(result)
  })
