import { Command } from "commander"
import chalk from "chalk"
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs"
import { resolve } from "path"
import { launchdDomain, launchdPlistPath } from "@/daemon/restart-host"
import { bootstrapJob, hasLaunchd, jobLoaded, jobPid, readPlistJson } from "@/native/macos/launchd"
import { oneShotPlist, releaseDirFromArgs, upgradeJobLabel } from "@/daemon/upgrade"
import { DEFAULT_KEEP_RELEASES } from "@/daemon/upgrade-prune"
import { daemonBase, getJson } from "./daemon-http"
import { releaseVersion, runUpgrade, type UpgradeRunOptions } from "./daemon-upgrade-run"

// --- agentx daemon upgrade <release-dir> ---
//
// Moves a launchd node to a built release folder (<dir>/dist/cli.js) without
// leaving AgentX down. The work runs in a one-shot launchd job, so it keeps
// going when the daemon (and any agent that typed the command) stops. This
// process only starts that job and shows its log. See docs/jobs/upgrade.md.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function fail(msg: string, hint?: string): never {
  console.log(chalk.red(`  ${msg}`))
  if (hint) console.log(chalk.dim(`  ${hint}`))
  process.exit(1)
}

export const upgradeCommand = new Command("upgrade")
  .description("move this node (launchd) to a built release folder: holds new runs and waits for idle, switches the daemon and dashboard, rolls back on failure")
  .argument("<release-dir>", "built release folder (holds dist/cli.js)")
  .option("-c, --config <path>", "path to agentx.json")
  .option("--expect-version <version>", "refuse unless the release reports this version")
  .option("--timeout <minutes>", "how long to wait for running tasks to finish", "60")
  .option("--force", "restart even if tasks are still running when --timeout runs out")
  .option("--people-only", "wait only for runs a person is waiting on; the fleet's own runs (agent to agent, schedules, workflows) get the drain time and are cut")
  .option("--boot-timeout <minutes>", "how long the new daemon may take to answer", "5")
  .option("--keep-releases <n>", "release folders kept beside the new one after an ok upgrade, live and rollback included (0 keeps all)", String(DEFAULT_KEEP_RELEASES))
  .option("--no-follow", "start the upgrade and return without showing its log")
  .option("--dry-run", "show what would change, without changing anything")
  .option("--run", "(internal) do the upgrade in this process")
  .action(async (dirArg: string, opts) => {
    const dir = resolve(dirArg).replace(/\/+$/, "")
    const runOpts: UpgradeRunOptions = {
      dir,
      configPath: opts.config,
      expectVersion: opts.expectVersion,
      timeoutMin: Number(opts.timeout),
      force: !!opts.force,
      bootTimeoutMin: Number(opts.bootTimeout),
      peopleOnly: !!opts.peopleOnly,
      keepReleases: Number(opts.keepReleases),
    }
    if (!Number.isFinite(runOpts.timeoutMin) || runOpts.timeoutMin < 0) fail("--timeout must be a number of minutes")
    if (!Number.isFinite(runOpts.bootTimeoutMin) || runOpts.bootTimeoutMin <= 0) fail("--boot-timeout must be a number of minutes")
    const keep = runOpts.keepReleases ?? 0
    if (!Number.isInteger(keep) || (keep !== 0 && keep < 2)) fail("--keep-releases must be 0 (keep all) or 2 or more (the live release and its rollback)")
    if (opts.run) process.exit(await runUpgrade(runOpts))

    if (!hasLaunchd()) fail("agentx daemon upgrade works with launchd (macOS) only for now.", "On Linux, point the systemd unit at the new release and run: agentx daemon restart --reload-service")

    const version = releaseVersion(dir)
    if (!version) fail(`${dir}/dist/cli.js is missing or does not run.`, "Build the release first (pnpm build) and pass its folder.")
    if (opts.expectVersion && version !== opts.expectVersion) fail(`${dir} is version ${version}, not ${opts.expectVersion}.`)

    const base = daemonBase(opts.config)
    const info = await getJson(`${base}/daemon/restart`, 10_000)
    if (!info) fail(`The daemon is not answering on ${base}.`, "Start it first (it must be running to be upgraded).")
    const service = info.service
    if (service?.kind !== "launchd") fail("The daemon is not run by launchd, so this command can't upgrade it.", "Point its service at the new release and run: agentx daemon restart --reload-service")

    const domain: string = service.domain ?? launchdDomain()
    const daemonPlist = launchdPlistPath({ label: service.label, domain })
    const oldDir = daemonPlist ? releaseDirFromArgs(readPlistJson(daemonPlist)?.ProgramArguments) : null
    if (!daemonPlist || !oldDir) fail("The daemon's launchd settings file does not run a release folder's dist/cli.js.", "Set it up once by hand, then use this command for later upgrades.")
    if (oldDir === dir) fail(`The daemon already runs ${dir}.`)

    const job = { label: upgradeJobLabel(service.label), domain }
    if (jobPid(job)) fail(`Another upgrade is running (launchd job ${job.label}).`, `Watch it with: tail -f ${resolve(info.cwd ?? process.cwd(), ".agentx/logs")}/upgrade-*.log`)

    console.log()
    console.log(`  Upgrade ${chalk.bold(service.label)}: ${oldDir} → ${chalk.bold(dir)} (${version})`)
    if (opts.dryRun) {
      console.log(chalk.dim(`  Would hold new run starts (queued runs stay queued) and wait up to ${runOpts.timeoutMin} min for ${runOpts.peopleOnly ? "runs a person is waiting on (other runs are not waited for)" : "idle"}${runOpts.force ? ", then restart anyway" : ", then give up"}, switch every loaded job naming ${oldDir},`))
      console.log(chalk.dim(`  reload them, and wait up to ${runOpts.bootTimeoutMin} min for ${version}; on failure put the old settings back.`))
      console.log(chalk.dim(keep ? `  When ok, delete release folders beside it past the newest ${keep} (live and ${oldDir} kept; none in use).` : "  Keep every old release folder (--keep-releases 0)."))
      console.log()
      return
    }

    const cwd: string = info.cwd ?? process.cwd()
    const upDir = resolve(cwd, ".agentx/upgrade")
    const logDir = resolve(cwd, ".agentx/logs")
    mkdirSync(upDir, { recursive: true })
    mkdirSync(logDir, { recursive: true })
    const logPath = resolve(logDir, `upgrade-${new Date().toISOString().replace(/[:.]/g, "-")}.log`)
    const plistPath = resolve(upDir, `${job.label}.plist`)
    const cli = realpathSync(process.argv[1])
    const args = [process.execPath, cli, "daemon", "upgrade", dir, "--run",
      "--timeout", String(runOpts.timeoutMin), "--boot-timeout", String(runOpts.bootTimeoutMin),
      "--keep-releases", String(keep),
      ...(runOpts.force ? ["--force"] : []),
      ...(runOpts.peopleOnly ? ["--people-only"] : []),
      ...(opts.expectVersion ? ["--expect-version", opts.expectVersion] : []),
      ...(opts.config ? ["-c", resolve(opts.config)] : [])]
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" }
    if (process.env.AGENTX_DRAIN_TIMEOUT_MS) env.AGENTX_DRAIN_TIMEOUT_MS = process.env.AGENTX_DRAIN_TIMEOUT_MS
    writeFileSync(plistPath, oneShotPlist({ label: job.label, programArguments: args, workingDirectory: cwd, logPath, environment: env }))
    writeFileSync(logPath, "")

    // A finished run stays loaded (not running) until logout; clear it.
    if (jobLoaded(job)) spawnSync("launchctl", ["bootout", `${domain}/${job.label}`])
    if (!(await bootstrapJob(job, plistPath))) fail(`Could not start launchd job ${job.label}. Nothing was changed.`)
    console.log(chalk.dim(`  Running as launchd job ${job.label}. Log: ${logPath}`))
    if (!opts.follow) return console.log()

    const last = resolve(upDir, "last.json")
    const started = Date.now()
    let shown = 0
    for (;;) {
      await sleep(1000)
      const text = existsSync(logPath) ? readFileSync(logPath, "utf-8") : ""
      const end = text.lastIndexOf("\n") + 1
      if (end > shown) { process.stdout.write(text.slice(shown, end).replace(/^(?=.)/gm, "  ")); shown = end }
      if (existsSync(last) && statSync(last).mtimeMs > started && /RESULT /.test(text)) break
      if (!jobPid(job) && Date.now() - started > 10_000 && !/RESULT /.test(text)) {
        fail("The upgrade job ended without a result.", `See ${logPath}`)
      }
    }
    const outcome = JSON.parse(readFileSync(last, "utf-8"))
    console.log()
    process.exit(outcome.result === "ok" ? 0 : 1)
  })
