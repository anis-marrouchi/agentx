import { spawnSync } from "child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { basename, resolve } from "path"
import { waitForIdle } from "@/daemon/restart"
import { launchdDomain, launchdPlistPath } from "@/daemon/restart-host"
import { jobPid, loadedJobsNaming, plistValid, readPlistJson, reloadJob, type LaunchdJob } from "@/native/macos/launchd"
import { writeShutdownRequest } from "@/daemon/shutdown"
import { ensureNativeModules } from "@/daemon/upgrade-native"
import { loadDaemonConfig } from "@/daemon/config"
import {
  chatRouteOk, checksSummary, daemonNodeFromArgs, healthIsUpgraded, hubPageOk, peerSkew, releaseDirFromArgs, retargetPlist, runsToCut,
  upgradeJobLabel, type HubProbe, type PeerSkew, type UpgradeOutcome,
} from "@/daemon/upgrade"
import { dashboardBaseUrl } from "./start-plan"
import { daemonBase, drainLimitMs, getJson, readHolding, readInflight, readRunning } from "./daemon-http"

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
  /** Wait only for runs a person is waiting on (see holdsUpgrade). */
  peopleOnly?: boolean
  /** How long the Hub page may take to load after the reload (tests). */
  hubWaitMs?: number
}

/** The version a release folder's CLI reports, or null when it does not run. */
export function releaseVersion(dir: string): string | null {
  const cli = resolve(dir, "dist/cli.js")
  if (!existsSync(cli)) return null
  const r = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf-8", timeout: 60_000 })
  const v = r.status === 0 ? r.stdout.trim().split("\n").pop()?.trim() : ""
  return v || null
}

/** Per-check wait and checks missed in a row before the daemon counts as
 *  gone while waiting for idle. A loaded daemon answers slowly; an upgrade
 *  was refused after six 3 s misses (about a minute) on a busy node. */
export const IDLE_READ_TIMEOUT_MS = 15_000
export const IDLE_MAX_MISSES = 24

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

/** One GET with status, content type and size; status null and the error
 *  message when no answer. */
async function probe(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<{ status: number | null; type: string; bytes: number; body: string; error?: string }> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    const body = await r.text()
    return { status: r.status, type: r.headers.get("content-type") ?? "", bytes: Buffer.byteLength(body), body }
  } catch (e) {
    // fetch says only "fetch failed"; the cause has ECONNREFUSED and the like.
    const cause = (e as { cause?: { message?: string } })?.cause?.message
    return { status: null, type: "", bytes: 0, body: "", error: `${e instanceof Error ? e.message : String(e)}${cause ? `: ${cause}` : ""}` }
  }
}

/** How long the Hub may take to serve its page after its job reloads. */
export const HUB_WAIT_MS = 90_000

/** After the new daemon answers /health (#2227): compare every mesh peer's
 *  /health version and commit with ours, and load the real Hub page and the
 *  chat route of the local dashboard. */
async function postUpgradeChecks(configPath: string | undefined, up: any, hubWaitMs: number): Promise<{ self: { version: string | null; commit: string | null }; peerSkew: PeerSkew[]; hub: HubProbe[]; checksSkipped?: string }> {
  const self = { version: typeof up?.version === "string" ? up.version : null, commit: typeof up?.commit === "string" ? up.commit : null }
  let config: ReturnType<typeof loadDaemonConfig>
  try { config = loadDaemonConfig(configPath) } catch (e) {
    // Without agentx.json there are no peers or dashboard to check; say so
    // instead of passing as "dashboard not enabled".
    const checksSkipped = `agentx.json did not load: ${e instanceof Error ? e.message : String(e)}`
    log(`peer and Hub checks skipped: ${checksSkipped}`)
    return { self, peerSkew: [], hub: [], checksSkipped }
  }

  const peers = (config.mesh?.enabled ? config.mesh.peers : []) ?? []
  const answers = await Promise.all(peers.map(async (p) => {
    const url = p.url.replace(/\/+$/, "")
    const r = await probe(`${url}/health`, 10_000, p.token ? { Authorization: `Bearer ${p.token}` } : {})
    let health: any = null
    try { health = r.status === 200 ? JSON.parse(r.body) : null } catch { /* not JSON */ }
    return { peer: p.name ?? url, url, health }
  }))
  const skew = peerSkew(self, answers)
  for (const a of answers) {
    const s = skew.find((x) => x.url === a.url)
    log(s ? `VERSION SKEW: peer ${a.peer} runs ${s.version ?? "no answer"} ${s.commit?.slice(0, 8) ?? ""}, this node ${self.version} ${self.commit?.slice(0, 8) ?? ""}; tell DevOps`
      : `peer ${a.peer}: same version ${self.version} ${self.commit?.slice(0, 8) ?? ""}`)
  }

  const hub: HubProbe[] = []
  if (config.dashboard?.enabled) {
    // Same address `agentx start` opens: 0.0.0.0 and :: become 127.0.0.1.
    const hubUrl = dashboardBaseUrl(config)
    // The dashboard job was reloaded a moment ago; give it time to listen.
    const t0 = Date.now()
    let page = await probe(`${hubUrl}/`, 15_000)
    while (!hubPageOk(page.status, page.type, page.bytes) && Date.now() - t0 < hubWaitMs) {
      await sleep(3000)
      page = await probe(`${hubUrl}/`, 15_000)
    }
    hub.push({ name: "Hub page", url: `${hubUrl}/`, status: page.status, ok: hubPageOk(page.status, page.type, page.bytes),
      ...(hubPageOk(page.status, page.type, page.bytes) ? {} : { detail: page.error ?? `${page.type || "no type"}, ${page.bytes} bytes` }) })
    const chat = await probe(`${hubUrl}/api/app/conversations`, 15_000)
    hub.push({ name: "chat route", url: `${hubUrl}/api/app/conversations`, status: chat.status, ok: chatRouteOk(chat.status, chat.type),
      ...(chatRouteOk(chat.status, chat.type) ? {} : { detail: chat.error ?? (chat.type || "no type") }) })
    for (const h of hub) log(`${h.name} ${h.url}: ${h.status ?? "no answer"} ${h.ok ? "ok" : `FAILED${h.detail ? ` (${h.detail})` : ""}`}`)
  } else log("Hub check skipped: dashboard not enabled in agentx.json")
  return { self, peerSkew: skew, hub }
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
  const programArgs = daemonPlist ? readPlistJson(daemonPlist)?.ProgramArguments : null
  const oldDir = releaseDirFromArgs(programArgs)
  if (!daemonPlist || !oldDir) return finish("refused", "daemon settings file does not run a release folder")
  outcome.from.dir = oldDir
  if (oldDir === o.dir) return finish("refused", `already on ${o.dir}`)
  log(`daemon ${daemon.label} PID ${oldPid ?? "?"} runs ${oldDir} (${outcome.from.version ?? "?"})`)

  // 0. Native modules must load with the Node launchd runs the daemon with,
  // not the Node that staged the folder (#2227: /health stayed ok while
  // every openDb failed).
  const daemonNode = daemonNodeFromArgs(programArgs) ?? process.execPath
  const native = ensureNativeModules(o.dir, daemonNode, log)
  if (!native.ok) return finish("refused", `${native.detail}; nothing changed`)
  log(`better-sqlite3 with ${daemonNode}: ${native.detail}`)

  // 1. Idle. With --people-only, only runs a person is waiting on count.
  const what = o.peopleOnly ? "run(s) with a person waiting" : "task(s) running"
  const idle = await waitForIdle({
    // A busy daemon can take well over 3 s to answer, or miss a few checks in
    // a row; only ~10 minutes of silence means it is really gone.
    read: () => (o.peopleOnly ? readHolding(base, IDLE_READ_TIMEOUT_MS) : readInflight(base, IDLE_READ_TIMEOUT_MS)),
    intervalMs: 10_000, timeoutMs: o.timeoutMin * 60_000, maxUnreachable: IDLE_MAX_MISSES,
    onCheck: (n) => { if (n) log(`waiting: ${n} ${what}`) },
  })
  if (idle.outcome === "unreachable") return finish("refused", `daemon did not answer ${IDLE_MAX_MISSES} checks in a row (about ${Math.round(IDLE_MAX_MISSES * (10_000 + IDLE_READ_TIMEOUT_MS) / 60_000)} min) while waiting for idle; nothing changed`)
  if (idle.outcome === "timeout") {
    if (!o.force) return finish("refused", `still ${idle.inflight ?? "some"} ${what} after ${o.timeoutMin} min; nothing changed (use --force)`)
    log(`still ${idle.inflight ?? "some"} ${what}; restarting anyway (--force), they get the usual drain time`)
  } else log(o.peopleOnly ? "no person is waiting on a run" : "no tasks running")
  if (o.peopleOnly) {
    const cut = runsToCut((await readRunning(base)) ?? [])
    outcome.cut = cut
    for (const r of cut) log(`not waited for: ${r.agentId} on ${r.channel} (task ${r.taskId}); it gets the usual drain time, then is cut`)
  }

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
    // 3b. Checks past /health (#2227): peers on the same version, Hub serves.
    // A failed Hub check leaves the upgrade in place ("degraded"); only a
    // failed /health rolls back.
    const checks = await postUpgradeChecks(o.configPath, up, o.hubWaitMs ?? HUB_WAIT_MS)
    Object.assign(outcome, checks)
    const summary = checksSummary(checks.peerSkew, checks.hub)
    const skipped = checks.checksSkipped ? `peer and Hub checks skipped (${checks.checksSkipped})` : ""
    const reasons = [failed.length ? `could not reload ${failed.join(", ")}` : "", summary, skipped].filter(Boolean)
    const hubBroken = checks.hub.some((h) => !h.ok)
    return finish(hubBroken ? "degraded" : "ok", reasons.length ? `daemon upgraded; ${reasons.join("; ")}` : undefined)
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

