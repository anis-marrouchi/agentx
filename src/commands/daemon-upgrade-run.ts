import { spawnSync } from "child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { basename, resolve } from "path"
import { waitForIdle } from "@/daemon/restart"
import { launchdDomain, launchdPlistPath } from "@/daemon/restart-host"
import { jobPid, loadedJobsNaming, plistValid, readPlistJson, reloadJob, type LaunchdJob } from "@/native/macos/launchd"
import { writeShutdownRequest } from "@/daemon/shutdown"
import { healthIsUpgraded, releaseDirFromArgs, retargetPlist, upgradeJobLabel, type UpgradeOutcome } from "@/daemon/upgrade"
import { daemonBase, drainLimitMs, getJson, readInflight } from "./daemon-http"

// The upgrade itself, run inside the one-shot launchd job that
// `agentx daemon upgrade` starts. Everything goes to stdout, which launchd
// writes to the upgrade log. The outcome goes to .agentx/upgrade/last.json.

export interface UpgradeRunOptions {
  dir: string
  configPath?: string
  expectVersion?: string
  timeoutMin: number
  force: boolean
  bootTimeoutMin: number
}

/** The version a release folder's CLI reports, or null when it does not run. */
export function releaseVersion(dir: string): string | null {
  const cli = resolve(dir, "dist/cli.js")
  if (!existsSync(cli)) return null
  const r = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf-8", timeout: 60_000 })
  const v = r.status === 0 ? r.stdout.trim().split("\n").pop()?.trim() : ""
  return v || null
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`)

/** Wait until /health matches; null when it never does within `ms`. */
async function waitHealth(base: string, ms: number, ok: (h: any) => boolean): Promise<any | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const h = await getJson(`${base}/health`, 5000)
    if (ok(h)) return h
    await sleep(2000)
  }
  return null
}

export async function runUpgrade(o: UpgradeRunOptions): Promise<number> {
  const startedAt = new Date().toISOString()
  const base = daemonBase(o.configPath)
  const info = await getJson(`${base}/daemon/restart`, 10_000)
  const cwd: string = info?.cwd ?? process.cwd()
  const upDir = resolve(cwd, ".agentx/upgrade")
  mkdirSync(upDir, { recursive: true })
  const outcome: UpgradeOutcome = {
    result: "refused", from: { dir: "", version: null }, to: { dir: o.dir, version: "" }, jobs: [], startedAt, endedAt: "",
  }
  const finish = (result: UpgradeOutcome["result"], reason?: string): number => {
    outcome.result = result
    if (reason) outcome.reason = reason
    outcome.endedAt = new Date().toISOString()
    writeFileSync(resolve(upDir, "last.json"), JSON.stringify(outcome, null, 2) + "\n")
    log(`RESULT ${result}${reason ? `: ${reason}` : ""}`)
    return result === "ok" ? 0 : 1
  }

  log(`upgrade to ${o.dir} (runner PID ${process.pid})`)
  const version = releaseVersion(o.dir)
  if (!version) return finish("refused", `${o.dir}/dist/cli.js is missing or does not run`)
  outcome.to.version = version
  if (o.expectVersion && version !== o.expectVersion) return finish("refused", `release is ${version}, not ${o.expectVersion}`)
  if (info?.service?.kind !== "launchd") return finish("refused", "daemon not answering or not run by launchd")

  const domain: string = info.service.domain ?? launchdDomain()
  const daemon: LaunchdJob = { label: info.service.label, domain }
  const health = await getJson(`${base}/health`, 10_000)
  const oldPid: number | null = info.pid ?? jobPid(daemon)
  outcome.from.version = health?.version ?? null
  const daemonPlist = launchdPlistPath(daemon)
  const oldDir = daemonPlist ? releaseDirFromArgs(readPlistJson(daemonPlist)?.ProgramArguments) : null
  if (!daemonPlist || !oldDir) return finish("refused", "daemon settings file does not run a release folder")
  outcome.from.dir = oldDir
  if (oldDir === o.dir) return finish("refused", `already on ${o.dir}`)
  log(`daemon ${daemon.label} PID ${oldPid ?? "?"} runs ${oldDir} (${outcome.from.version ?? "?"})`)

  // 1. Idle.
  const idle = await waitForIdle({
    read: () => readInflight(base), intervalMs: 10_000, timeoutMs: o.timeoutMin * 60_000, maxUnreachable: 6,
    onCheck: (n) => { if (n) log(`waiting: ${n} task(s) running`) },
  })
  if (idle.outcome === "unreachable") return finish("refused", "daemon stopped answering while waiting for idle; nothing changed")
  if (idle.outcome === "timeout") {
    if (!o.force) return finish("refused", `still ${idle.inflight ?? "some"} task(s) running after ${o.timeoutMin} min; nothing changed (use --force)`)
    log(`still ${idle.inflight ?? "some"} task(s) running; restarting anyway (--force), they get the usual drain time`)
  } else log("no tasks running")

  // 2. Switch settings files, with backups.
  const self = upgradeJobLabel(daemon.label)
  const others = loadedJobsNaming(oldDir, domain).filter((j) => j.label !== daemon.label && j.label !== self)
  const jobs = [{ ...daemon, plist: daemonPlist }, ...others]
  outcome.jobs = jobs.map((j) => j.label)
  const bak = resolve(upDir, `backup-${startedAt.replace(/[:.]/g, "-")}`)
  mkdirSync(bak, { recursive: true })
  for (const j of jobs) copyFileSync(j.plist, resolve(bak, basename(j.plist)))
  const restore = () => { for (const j of jobs) copyFileSync(resolve(bak, basename(j.plist)), j.plist) }
  for (const j of jobs) {
    const r = retargetPlist(readFileSync(j.plist, "utf-8"), oldDir, o.dir)
    writeFileSync(j.plist, r.text)
    if (!plistValid(j.plist)) { restore(); return finish("refused", `${j.plist} invalid after the switch; restored, nothing restarted`) }
    log(`${j.label}: ${r.count} path(s) → ${o.dir}`)
  }
  log(`backups in ${bak}`)

  // 3. Daemon first, then the jobs that follow it.
  try { writeShutdownRequest(resolve(cwd, ".agentx"), { by: "agentx daemon upgrade", pid: process.pid, at: new Date().toISOString() }) } catch { /* best effort */ }
  const drain = drainLimitMs()
  const bootMs = o.bootTimeoutMin * 60_000
  const t0 = Date.now()
  const loaded = await reloadJob(daemon, daemonPlist, { drainLimitMs: drain, log })
  const up = loaded ? await waitHealth(base, bootMs, (h) => healthIsUpgraded(h, { version, oldPid })) : null
  if (up) {
    log(`daemon answers: ${version} PID ${up.pid ?? "?"} after ${Math.round((Date.now() - t0) / 1000)}s`)
    const failed: string[] = []
    for (const j of others) if (!(await reloadJob(j, j.plist, { drainLimitMs: 60_000, log }))) failed.push(j.label)
    return failed.length ? finish("ok", `daemon upgraded; could not reload ${failed.join(", ")}`) : finish("ok")
  }

  // 4. Roll back.
  log(loaded ? `${version} did not answer within ${o.bootTimeoutMin} min; rolling back` : "daemon could not be loaded; rolling back")
  restore()
  await reloadJob(daemon, daemonPlist, { drainLimitMs: drain, log })
  const back = await waitHealth(base, bootMs, (h) => !!h && (!outcome.from.version || h.version === outcome.from.version))
  // The other jobs were never reloaded; their restored files are enough.
  return back
    ? finish("rolled-back", `${version} did not come up; back on ${outcome.from.version ?? oldDir}`)
    : finish("down", `${version} did not come up and the old release does not answer either; load it with: launchctl bootstrap ${domain} ${daemonPlist}`)
}

