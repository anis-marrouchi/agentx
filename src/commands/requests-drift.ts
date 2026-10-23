import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig, type DaemonConfig } from "@/daemon/config"
import { forgeReader } from "@/requests/checkers/issue"
import { DEFAULT_CHECKER_SETTINGS } from "@/requests/checkers"
import { checkProject, DEFAULT_DRIFT_SETTINGS, type DriftProject, type DriftSettings } from "@/requests/drift/check"
import { driftForge } from "@/requests/drift/forge"
import { forgeConnectorsOf, liveReader } from "@/requests/drift/live"

// --- agentx requests drift — replay status drift by hand (#1138 step F) ---
//
// Reads the merge requests merged in the last days on a project and prints
// the issues whose status label is not where the work is. Read only: it
// tells nobody and writes nothing, whatever `write` says. Use it to check
// the daemon's findings against the tracker.

const KINDS: Record<string, string> = {
  "live-not-done": "live, not Done",
  "merged-not-review": "merged, not in Review",
  "done-not-live": "Done, not live",
}

/** "self" from the command line is the daemon on this machine. */
async function daemonCommit(config: DaemonConfig): Promise<string | null> {
  const port = parseInt(config.node.bind.split(":")[1] || "18800", 10)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) })
    const body: any = await res.json()
    return typeof body?.commit === "string" ? body.commit : null
  } catch {
    return null
  }
}

export const drift = new Command("drift")
  .description("replay status drift: merged merge requests whose issues' status labels are not where the work is (read only)")
  .option("--project <path>", "one project, group/project or owner/repo (default: every project in requests.statusDrift.projects)")
  .option("--provider <name>", "gitlab or github (default: the project's entry, else gitlab)")
  .option("--days <n>", "how far back merged merge requests are read", "7")
  .option("--live <source...>", "where the running commit is read: self, or a health URL (default: the project's entry)")
  .option("--repo <name>", "a clone named in requests.checkers.repos, for the live check")
  .option("--json", "machine-readable output")
  .action(async (opts: { project?: string; provider?: string; days: string; live?: string[]; repo?: string; json?: boolean }) => {
    let config: DaemonConfig
    try {
      config = loadDaemonConfig()
    } catch (e: any) {
      console.error(chalk.red(`  could not read agentx.json: ${e?.message ?? e}`))
      process.exitCode = 1
      return
    }
    const settings: DriftSettings = { ...DEFAULT_DRIFT_SETTINGS, ...config.requests.statusDrift }
    const days = Number(opts.days)
    if (!Number.isInteger(days) || days < 1 || days > 60) {
      console.error(chalk.red("  --days must be a whole number from 1 to 60"))
      process.exitCode = 1
      return
    }
    let projects: DriftProject[] = settings.projects
    if (opts.project) {
      const listed = settings.projects.find((p) => p.project === opts.project)
      const provider = (opts.provider ?? listed?.provider ?? "gitlab").toLowerCase()
      if (provider !== "gitlab" && provider !== "github") {
        console.error(chalk.red("  --provider must be gitlab or github"))
        process.exitCode = 1
        return
      }
      projects = [{ provider, project: opts.project, live: opts.live ?? listed?.live ?? [], repo: opts.repo ?? listed?.repo }]
    }
    if (!projects.length) {
      console.error(chalk.red("  no project: give --project, or list projects under requests.statusDrift.projects"))
      process.exitCode = 1
      return
    }
    const connectors = forgeConnectorsOf(config)
    const self = await daemonCommit(config)
    const deps = {
      settings: { ...settings, lookbackDays: days },
      forge: driftForge(connectors),
      readIssue: forgeReader(connectors),
      liveCommit: liveReader({ field: settings.liveField, self: () => self }),
      checkers: config.requests.checkers ?? DEFAULT_CHECKER_SETTINGS,
    }
    const results = []
    for (const p of projects) results.push(await checkProject(p, deps))
    if (opts.json) { console.log(JSON.stringify(results, null, 2)); return }
    for (const r of results) {
      console.log(chalk.bold(`\n  ${r.project.provider} ${r.project.project}`) + chalk.dim(` · last ${days} days · ${r.merged} merged · ${r.issues} issue(s) they close`))
      const live = r.live.map((l) => (l.commit ? `${l.commit.slice(0, 8)} on ${l.source}` : chalk.yellow(`${l.source}: ${l.error}`)))
      console.log(chalk.dim(`  running: ${live.length ? live.join(", ") : "no live source: only merged-not-in-Review is checked"}`))
      for (const e of r.errors) console.log(chalk.yellow(`  could not read ${e}`))
      if (!r.drifts.length) { console.log(chalk.green("  no drift")); continue }
      for (const d of r.drifts) {
        console.log(`  ${chalk.red(`[${KINDS[d.kind]}]`)} ${d.line}`)
        console.log(chalk.dim(`    ${d.issueUrl}`))
      }
    }
    console.log(chalk.dim("\n  Read only: nothing was told or written."))
  })
