import { Command } from "commander"
import chalk from "chalk"
import { execFileSync } from "child_process"
import { existsSync } from "fs"
import { userInfo } from "os"
import { resolve } from "path"
import { readBootLog } from "@/daemon/boot-record"
import {
  appendEvent, canaryReport, deployDecision, evaluateSoak, readEvents, readReleases,
  recordSoak, recordedSoak, resultFromRecord,
  type CanarySettings, type CrashLoopSettings, type DeployDecision, type SoakResult, type TaskCounter,
} from "@/daemon/canary-soak"
import { daemonConfigSchema, loadDaemonConfig } from "@/daemon/config"
import { openDb } from "@/storage/sqlite"

// --- agentx daemon soak [sha] — canary soak status (#993) ---
//
// Reads the local daemon's boot log and task history (src/daemon/
// canary-soak.ts) and keeps the first pass or fail per release. The same
// check gates `agentx daemon deploy` when quality.canary.enabled is on.

const agentxDir = () => resolve(process.cwd(), ".agentx")

function canarySettings(configPath?: string): { canary: CanarySettings; crashLoop: CrashLoopSettings } {
  // No config at all (a plain checkout): the defaults, so the gate is off.
  // A config that exists but does not load still throws.
  const found = configPath ?? ["agentx.json", ".agentx/config.json"].map((f) => resolve(process.cwd(), f)).find((p) => existsSync(p))
  if (!found) {
    const { shape } = daemonConfigSchema
    return { canary: shape.quality.parse(undefined).canary, crashLoop: shape.resume.parse(undefined).crashLoop }
  }
  const cfg = loadDaemonConfig(found)
  return { canary: cfg.quality.canary, crashLoop: cfg.resume.crashLoop }
}

/** The release SHA of this checkout, as tsup bakes it into a build. */
export function headCommit(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    return sha ? (dirty ? `${sha}-dirty` : sha) : null
  } catch { return null }
}

const taskCounter: TaskCounter = (from, to) => {
  const db = openDb()
  if (!db) return null
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'ok' THEN 0 ELSE 1 END) AS failed
         FROM task_history WHERE started_at >= ? AND started_at < ?`,
    ).get(new Date(from).toISOString(), new Date(to).toISOString()) as { total: number; failed: number | null }
    return { total: row.total, failed: row.failed ?? 0 }
  } catch { return null }
}

/** The soak result for a commit: the kept decision, else judged now (and
 *  kept when it passes or fails). */
export function soakFor(commit: string, canary: CanarySettings, crashLoop: CrashLoopSettings, now = Date.now()): SoakResult {
  const dir = agentxDir()
  const kept = recordedSoak(dir, commit)
  if (kept) return resultFromRecord(kept, now)
  const result = evaluateSoak({ commit, boots: readBootLog(dir), now, settings: canary, crashLoop, tasks: taskCounter })
  recordSoak(dir, result)
  return result
}

/** Called by `agentx daemon deploy` before anything is copied. With the gate
 *  off it returns "allow" without reading anything. Refusals and overrides
 *  are logged to .agentx/canary/events.jsonl. */
export function soakGate(host: string, opts: { config?: string; overrideSoak?: string; dryRun?: boolean }): DeployDecision & { commit: string | null; enabled: boolean } {
  const { canary, crashLoop } = canarySettings(opts.config)
  if (!canary.enabled) return { ...deployDecision(canary, null, null), commit: null, enabled: false }
  const commit = headCommit()
  const soak = commit && !commit.endsWith("-dirty") ? soakFor(commit, canary, crashLoop) : null
  const decision = deployDecision(canary, commit, soak, opts.overrideSoak)
  if (!opts.dryRun && (decision.overridden || !decision.allow)) {
    appendEvent(agentxDir(), {
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
