// --- Deploy-safe restart: wait for idle, then restart through whatever runs the daemon ---
//
// Two callers share this module:
//
//   * `agentx daemon restart [--when-idle]` (commands/daemon-restart.ts)
//     polls the daemon's in-flight count from outside, then restarts it
//     through launchd, systemd, or a plain stop + start.
//   * The dashboard's "Restart when idle" button (POST /daemon/restart) asks
//     the daemon to exit by itself once idle. That only works when a service
//     manager starts it again, so the daemon first checks that one would.
//
// Everything here is pure and unit tested. Running commands lives in
// restart-host.ts.

// ── What runs the daemon ────────────────────────────────────────────────

export type ServiceInfo =
  /** A launchd job. domain is "gui/<uid>" or "system". */
  | { kind: "launchd"; label: string; domain: string }
  /** A systemd unit, in the system manager or a user's own manager. */
  | { kind: "systemd"; unit: string; scope: "system" | "user" }
  /** Started from a shell (`agentx daemon start --detach`, nohup, tmux…). */
  | { kind: "none" }

/** The systemd unit a process belongs to, from the text of
 *  /proc/<pid>/cgroup. Null when the process is not in a service (a login
 *  session scope, a container, no systemd). */
export function parseSystemdCgroup(text: string): { unit: string; scope: "system" | "user" } | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    // v2: "0::/path"; v1: "1:name=systemd:/path"
    const parts = line.split(":")
    if (parts.length < 3) continue
    const controllers = parts[1]
    if (!(parts[0] === "0" && controllers === "") && controllers !== "name=systemd") continue
    const path = parts.slice(2).join(":")
    const segments = path.split("/").filter(Boolean)
    // The deepest .service that is not the per-user manager itself.
    let unit: string | null = null
    for (const s of segments) {
      if (s.endsWith(".service") && !/^user@\d+\.service$/.test(s)) unit = s
    }
    if (!unit) continue
    const scope = segments.some((s) => /^user@\d+\.service$/.test(s)) ? "user" : "system"
    return { unit, scope }
  }
  return null
}

/** The label of the launchd job whose process is `pid`, from the output of
 *  `launchctl list` ("PID\tStatus\tLabel" rows). */
export function parseLaunchctlList(output: string, pid: number): string | null {
  for (const raw of output.split("\n")) {
    const cols = raw.trim().split(/\s+/)
    if (cols.length < 3) continue
    if (cols[0] === String(pid)) return cols.slice(2).join(" ")
  }
  return null
}

/** The settings file and running PID from `launchctl print <domain>/<label>`. */
export function parseLaunchctlPrint(output: string): { path?: string; pid?: number } {
  const out: { path?: string; pid?: number } = {}
  for (const raw of output.split("\n")) {
    const m = raw.match(/^\s*(path|pid)\s*=\s*(.+?)\s*$/)
    if (!m) continue
    if (m[1] === "path" && !out.path) out.path = m[2]
    if (m[1] === "pid" && out.pid === undefined) {
      const n = parseInt(m[2], 10)
      if (Number.isFinite(n)) out.pid = n
    }
  }
  return out
}

// ── Would it come back after exiting? ───────────────────────────────────

/** Whether the service manager starts the daemon again after it exits
 *  cleanly (code 0) or with an error code. */
export interface Respawn {
  onCleanExit: boolean
  onErrorExit: boolean
  /** The setting the answer came from, for messages. */
  setting: string
}

/** launchd's KeepAlive key: true, false, or a dictionary of conditions. */
export function launchdRespawn(keepAlive: unknown): Respawn {
  if (keepAlive === true) return { onCleanExit: true, onErrorExit: true, setting: "KeepAlive=true" }
  if (keepAlive && typeof keepAlive === "object") {
    const se = (keepAlive as Record<string, unknown>).SuccessfulExit
    if (se === false) return { onCleanExit: false, onErrorExit: true, setting: "KeepAlive.SuccessfulExit=false" }
    if (se === true) return { onCleanExit: true, onErrorExit: false, setting: "KeepAlive.SuccessfulExit=true" }
    return { onCleanExit: false, onErrorExit: false, setting: "KeepAlive (no SuccessfulExit condition)" }
  }
  return { onCleanExit: false, onErrorExit: false, setting: keepAlive === false ? "KeepAlive=false" : "no KeepAlive" }
}

/** systemd's Restart= setting. */
export function systemdRespawn(restart: string): Respawn {
  const r = restart.trim()
  const setting = `Restart=${r || "no"}`
  if (r === "always") return { onCleanExit: true, onErrorExit: true, setting }
  if (r === "on-success") return { onCleanExit: true, onErrorExit: false, setting }
  if (r === "on-failure") return { onCleanExit: false, onErrorExit: true, setting }
  // on-abnormal / on-abort / on-watchdog only react to signals and timeouts.
  return { onCleanExit: false, onErrorExit: false, setting }
}

/** Exit code used when only a failed exit brings the daemon back
 *  (EX_TEMPFAIL: "try again"). */
export const RESTART_EXIT_CODE = 75

export type SelfRestartPlan =
  | { ok: true; exitCode: number; how: string }
  | { ok: false; reason: string }

/** How the daemon can restart itself: exit with a code its service manager
 *  answers by starting it again. Refuses when nothing would. */
export function planSelfRestart(service: ServiceInfo, respawn: Respawn | null): SelfRestartPlan {
  const fromTerminal = "Restart it from a terminal instead: agentx daemon restart --when-idle"
  if (service.kind === "none") {
    return { ok: false, reason: `AgentX was not started by a service manager (launchd or systemd), so nothing would start it again. ${fromTerminal}` }
  }
  const name = service.kind === "launchd" ? `launchd job ${service.label}` : `systemd unit ${service.unit}`
  if (!respawn) {
    return { ok: false, reason: `Could not read the restart setting of ${name}. ${fromTerminal}` }
  }
  if (respawn.onCleanExit) return { ok: true, exitCode: 0, how: `${name} restarts it (${respawn.setting})` }
  if (respawn.onErrorExit) return { ok: true, exitCode: RESTART_EXIT_CODE, how: `${name} restarts it after an error exit (${respawn.setting})` }
  const fix = service.kind === "launchd"
    ? "Set KeepAlive to true in its settings file"
    : "Set Restart=always on the unit"
  return { ok: false, reason: `${name} would not start AgentX again (${respawn.setting}). ${fix}, or ${fromTerminal.charAt(0).toLowerCase()}${fromTerminal.slice(1)}` }
}

// ── Commands for each service manager ───────────────────────────────────

/** The systemctl call for a unit. A system unit run by a non-root user
 *  needs sudo; the caller decides whether it may prompt. */
export function systemctlArgs(service: { unit: string; scope: "system" | "user" }, verb: string): string[] {
  return service.scope === "user" ? ["--user", verb, service.unit] : [verb, service.unit]
}

/** The exact command an operator can paste to restart the service. */
export function manualRestartCommand(service: ServiceInfo, opts: { isRoot: boolean } = { isRoot: false }): string {
  switch (service.kind) {
    case "launchd":
      return `launchctl kickstart -k ${service.domain}/${service.label}`
    case "systemd":
      return `${service.scope === "system" && !opts.isRoot ? "sudo " : ""}systemctl ${systemctlArgs(service, "restart").join(" ")}`
    default:
      return "agentx daemon stop && agentx daemon start --detach"
  }
}

// ── Waiting for idle ────────────────────────────────────────────────────

/** Consecutive zero readings before the daemon counts as idle. One reading
 *  can land in the gap between a task ending and the next one starting. */
export const IDLE_CHECKS = 2

export interface IdleWaitOptions {
  /** Current in-flight count, or null when the daemon did not answer. */
  read: () => Promise<number | null>
  intervalMs: number
  timeoutMs: number
  consecutive?: number
  /** Unanswered reads in a row before giving up. */
  maxUnreachable?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onCheck?: (inflight: number | null, elapsedMs: number) => void
}

export type IdleWaitResult =
  | { outcome: "idle"; waitedMs: number }
  | { outcome: "timeout"; waitedMs: number; inflight: number | null }
  | { outcome: "unreachable"; waitedMs: number }

export async function waitForIdle(o: IdleWaitOptions): Promise<IdleWaitResult> {
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const need = Math.max(1, o.consecutive ?? IDLE_CHECKS)
  const maxUnreachable = Math.max(1, o.maxUnreachable ?? 3)
  const start = now()
  let zeros = 0
  let misses = 0
  let last: number | null = null
  for (;;) {
    const n = await o.read()
    const elapsed = now() - start
    o.onCheck?.(n, elapsed)
    if (n === null) {
      zeros = 0
      if (++misses >= maxUnreachable) return { outcome: "unreachable", waitedMs: elapsed }
    } else {
      misses = 0
      last = n
      zeros = n === 0 ? zeros + 1 : 0
      if (zeros >= need) return { outcome: "idle", waitedMs: elapsed }
    }
    if (elapsed + o.intervalMs > o.timeoutMs) return { outcome: "timeout", waitedMs: elapsed, inflight: last }
    await sleep(o.intervalMs)
  }
}

// ── The daemon's own "restart when idle" ────────────────────────────────

export type OnTimeout = "restart" | "abort"

export interface RestartRequestState {
  /** "deferred": held until `until`, then it becomes a pending idle wait. */
  state: "none" | "deferred" | "pending" | "restarting"
  requestedBy?: string
  requestedAt?: string
  /** When the wait ends (ISO). */
  deadline?: string
  /** When a deferred request starts its idle wait (ISO). */
  until?: string
  onTimeout?: OnTimeout
  /** How the last request ended, when it did not restart. */
  last?: { outcome: "cancelled" | "timeout-aborted"; at: string }
}

// ── Restart policy (shutdown.restart) ──────────────────────────────────
//
// A deploy script that asks for "restart when idle" with onTimeout
// "restart" restarts over running work once the wait runs out. The policy
// lets the operator forbid that, hold requests from anyone but named
// requesters, and give the held requests a daily time at which they run,
// idle-only. It replaces the external guard scripts operators wrote for it.

export interface RestartPolicy {
  /** Regular expression on the request's `by`. Unset: everyone. */
  allowBy?: string
  /** Local time "HH:MM" at which held requests start their idle wait. */
  window?: string
  /** How long that idle wait lasts before it gives up. */
  windowWaitMinutes: number
  /** Every request becomes idle-only: onTimeout "restart" is turned into "abort". */
  forbidOnTimeoutRestart: boolean
}

export type PolicyDecision =
  | { action: "allow"; onTimeout: OnTimeout; forced: boolean }
  | { action: "defer"; onTimeout: "abort"; untilMs: number; timeoutMs: number; reason: string }
  | { action: "refuse"; reason: string }

/** The next occurrence of local time "HH:MM" strictly after `now` (ms). */
export function nextWindowMs(window: string, now: number): number {
  const m = window.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) throw new Error(`window must be HH:MM, got ${JSON.stringify(window)}`)
  const at = new Date(now)
  at.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

export function applyRestartPolicy(
  req: { by: string; onTimeout: OnTimeout },
  policy: RestartPolicy | undefined,
  now: number,
): PolicyDecision {
  if (!policy) return { action: "allow", onTimeout: req.onTimeout, forced: false }
  const forced = policy.forbidOnTimeoutRestart && req.onTimeout === "restart"
  const onTimeout: OnTimeout = forced ? "abort" : req.onTimeout
  if (policy.allowBy) {
    let allowed: boolean
    try { allowed = new RegExp(policy.allowBy).test(req.by) } catch { allowed = false }
    if (!allowed) {
      if (policy.window) {
        return {
          action: "defer",
          onTimeout: "abort",
          untilMs: nextWindowMs(policy.window, now),
          timeoutMs: policy.windowWaitMinutes * 60_000,
          reason: `restart requests by "${req.by}" are held until ${policy.window}; allowed now: /${policy.allowBy}/`,
        }
      }
      return { action: "refuse", reason: `restart requests by "${req.by}" are not allowed; allowed: /${policy.allowBy}/` }
    }
  }
  return { action: "allow", onTimeout, forced }
}

export interface IdleRestartDeps {
  inflight: () => number
  /** Starts the graceful exit. Called at most once. */
  fire: (reason: "idle" | "timeout", req: { requestedBy: string }) => void
  now?: () => number
  intervalMs?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (h: unknown) => void
}

/** Holds one pending "restart when idle" request inside the daemon and fires
 *  it after IDLE_CHECKS zero readings in a row, or at the deadline. */
export class IdleRestartScheduler {
  private s: RestartRequestState = { state: "none" }
  private zeros = 0
  private timer: unknown = null
  private deadlineMs = 0
  constructor(private deps: IdleRestartDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)() }

  state(): RestartRequestState { return { ...this.s } }

  schedule(req: { requestedBy: string; timeoutMs: number; onTimeout: OnTimeout }): RestartRequestState {
    if (this.s.state !== "none") return this.state()
    this.startPending(req)
    this.startTimer()
    return this.state()
  }

  /** Hold a request until `untilMs`, then run it as an idle wait of
   *  `timeoutMs` that gives up rather than restarting over work. */
  defer(req: { requestedBy: string; untilMs: number; timeoutMs: number; onTimeout: OnTimeout }): RestartRequestState {
    if (this.s.state !== "none") return this.state()
    const at = this.now()
    this.deferred = req
    this.s = {
      state: "deferred",
      requestedBy: req.requestedBy,
      requestedAt: new Date(at).toISOString(),
      until: new Date(req.untilMs).toISOString(),
      onTimeout: req.onTimeout,
    }
    this.startTimer()
    return this.state()
  }

  private deferred?: { requestedBy: string; untilMs: number; timeoutMs: number; onTimeout: OnTimeout }

  private startPending(req: { requestedBy: string; timeoutMs: number; onTimeout: OnTimeout }): void {
    const at = this.now()
    this.deadlineMs = at + Math.max(0, req.timeoutMs)
    this.zeros = 0
    this.s = {
      state: "pending",
      requestedBy: req.requestedBy,
      requestedAt: this.s.requestedAt ?? new Date(at).toISOString(),
      deadline: new Date(this.deadlineMs).toISOString(),
      onTimeout: req.onTimeout,
    }
  }

  private startTimer(): void {
    if (this.timer !== null) return
    const every = this.deps.intervalMs ?? 2000
    const set = this.deps.setInterval ?? ((fn: () => void, ms: number) => {
      const h = setInterval(fn, ms)
      h.unref?.()
      return h
    })
    this.timer = set(() => this.tick(), every)
  }

  cancel(): boolean {
    if (this.s.state !== "pending" && this.s.state !== "deferred") return false
    this.stopTimer()
    this.deferred = undefined
    this.s = { state: "none", last: { outcome: "cancelled", at: new Date(this.now()).toISOString() } }
    return true
  }

  /** One check. Exposed for tests; the timer calls it. */
  tick(): void {
    if (this.s.state === "deferred") {
      const d = this.deferred
      if (!d || this.now() < d.untilMs) return
      this.deferred = undefined
      this.startPending(d)
      return
    }
    if (this.s.state !== "pending") return
    const n = this.deps.inflight()
    this.zeros = n === 0 ? this.zeros + 1 : 0
    if (this.zeros >= IDLE_CHECKS) return this.fire("idle")
    if (this.now() >= this.deadlineMs) {
      if (this.s.onTimeout === "restart") return this.fire("timeout")
      this.stopTimer()
      this.s = { state: "none", last: { outcome: "timeout-aborted", at: new Date(this.now()).toISOString() } }
    }
  }

  private fire(reason: "idle" | "timeout"): void {
    this.stopTimer()
    this.s = { ...this.s, state: "restarting" }
    this.deps.fire(reason, { requestedBy: this.s.requestedBy || "unknown" })
  }

  private stopTimer(): void {
    if (this.timer !== null) (this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as any)))(this.timer)
    this.timer = null
  }
}

// ── The CLI's restart, step by step ─────────────────────────────────────

export type RestartStep =
  /** Run a command (argv[0] is the program). */
  | { kind: "exec"; argv: string[]; mayFail?: boolean }
  /** Send SIGTERM to the daemon's process: its graceful drain runs. */
  | { kind: "sigterm" }
  /** Wait until the old daemon process has exited. */
  | { kind: "wait-exit" }
  /** Wait until launchd no longer lists the job. */
  | { kind: "wait-unloaded" }
  /** `agentx daemon start --detach` in the daemon's own directory. */
  | { kind: "start-detached" }

export interface CliRestartOptions {
  isRoot: boolean
  /** Also re-read the service's own settings (plist / unit file). */
  reloadService: boolean
  /** launchd only: the job's settings file, needed to load it again. */
  plistPath?: string | null
  /** Whether sudo may prompt for a password (a terminal is attached). */
  interactive: boolean
}

export type CliRestartPlan =
  | { ok: true; steps: RestartStep[]; manual: string }
  | { ok: false; reason: string; manual: string }

/** The steps `agentx daemon restart` takes for each way the daemon runs.
 *  Every plan ends with the daemon started again. */
export function cliRestartPlan(service: ServiceInfo, o: CliRestartOptions): CliRestartPlan {
  const manual = manualRestartCommand(service, { isRoot: o.isRoot })
  if (service.kind === "launchd") {
    const target = `${service.domain}/${service.label}`
    if (o.reloadService) {
      if (!o.plistPath) return { ok: false, reason: `Could not find the settings file of launchd job ${service.label}.`, manual }
      // bootout returns before the job is gone, and bootstrap fails while it
      // is still loaded, which would leave AgentX down. Wait in between.
      return {
        ok: true,
        manual: `launchctl bootout ${target} && launchctl bootstrap ${service.domain} ${o.plistPath}`,
        steps: [
          { kind: "exec", argv: ["launchctl", "bootout", target] },
          { kind: "wait-exit" },
          { kind: "wait-unloaded" },
          { kind: "exec", argv: ["launchctl", "bootstrap", service.domain, o.plistPath] },
        ],
      }
    }
    // Not `kickstart -k`: SIGTERM first so the daemon drains, then start it
    // (a no-op when KeepAlive already did).
    return {
      ok: true,
      manual,
      steps: [
        { kind: "exec", argv: ["launchctl", "kill", "SIGTERM", target] },
        { kind: "wait-exit" },
        { kind: "exec", argv: ["launchctl", "kickstart", target], mayFail: true },
      ],
    }
  }
  if (service.kind === "systemd") {
    const direct = service.scope === "user" || o.isRoot
    const prefix = direct ? ["systemctl"] : o.interactive ? ["sudo", "systemctl"] : ["sudo", "-n", "systemctl"]
    const steps: RestartStep[] = []
    if (o.reloadService) steps.push({ kind: "exec", argv: [...prefix, ...(service.scope === "user" ? ["--user"] : []), "daemon-reload"] })
    steps.push({ kind: "exec", argv: [...prefix, ...systemctlArgs(service, "restart")] })
    return { ok: true, manual, steps }
  }
  return { ok: true, manual, steps: [{ kind: "sigterm" }, { kind: "wait-exit" }, { kind: "start-detached" }] }
}

/** Human description of a service, for the CLI and the dashboard. */
export function describeService(service: ServiceInfo): string {
  if (service.kind === "launchd") return `launchd job ${service.label}`
  if (service.kind === "systemd") return `systemd ${service.scope === "user" ? "user " : ""}unit ${service.unit}`
  return "no service manager (started from a shell)"
}
