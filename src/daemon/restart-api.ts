import { applyRestartPolicy, type IdleRestartScheduler, type OnTimeout, type RestartPolicy, type SelfRestartPlan, type ServiceInfo } from "./restart"

// --- HTTP surface for "restart when idle" (operator-only; the daemon gates
// it with checkMeshAuth: loopback or a mesh token, never a foreign page) ---
//
//   GET  /daemon/restart         what runs this daemon, in-flight count and
//                                the runs a restart would cut, request state
//   POST /daemon/restart         { timeoutMinutes?, onTimeout?: "restart"|"abort", by? }
//                                schedule a restart for when the daemon is idle;
//                                shutdown.restart may force onTimeout to "abort",
//                                hold the request until a daily window (202,
//                                state "deferred"), or refuse it (403)
//   POST /daemon/restart/cancel  drop a pending or deferred request
//
// Pure request → reply mapping; index.ts supplies the context.

export const RESTART_API_PATHS = new Set(["/daemon/restart", "/daemon/restart/cancel"])

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30
const MAX_IDLE_TIMEOUT_MINUTES = 24 * 60

/** A run a restart would cut off, for the deploy script asking. */
export interface RunningSummary {
  agentId: string
  taskId: string
  channel: string
  chatId?: string
  step?: string
  ageSeconds: number
}

export interface RestartApiContext {
  scheduler: IdleRestartScheduler
  inflight: () => { local: number; meshForwards: number; total: number }
  /** The runs in flight right now, oldest first. */
  running?: () => RunningSummary[]
  /** What runs the daemon, and whether it can restart itself. Detected once. */
  service: () => { service: ServiceInfo; plan: SelfRestartPlan }
  policy?: RestartPolicy
  now?: () => number
  pid: number
  cwd: string
  configPath?: string
}

export interface Reply { status: number; body: unknown }

export function handleRestartApi(
  method: string,
  path: string,
  body: Record<string, unknown>,
  ctx: RestartApiContext,
): Reply {
  const m = method.toUpperCase()
  const running = () => ctx.running?.() ?? []
  if (path === "/daemon/restart" && m === "GET") {
    const { service, plan } = ctx.service()
    return {
      status: 200,
      body: {
        pid: ctx.pid,
        cwd: ctx.cwd,
        configPath: ctx.configPath,
        inflight: ctx.inflight(),
        running: running(),
        service,
        selfRestart: plan,
        policy: ctx.policy ?? null,
        ...ctx.scheduler.state(),
      },
    }
  }
  if (path === "/daemon/restart" && m === "POST") {
    const { plan } = ctx.service()
    if (!plan.ok) return { status: 409, body: { error: plan.reason } }
    const minutes = body.timeoutMinutes === undefined ? DEFAULT_IDLE_TIMEOUT_MINUTES : Number(body.timeoutMinutes)
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_IDLE_TIMEOUT_MINUTES) {
      return { status: 400, body: { error: `timeoutMinutes must be between 0 and ${MAX_IDLE_TIMEOUT_MINUTES}` } }
    }
    const requested: OnTimeout | null = body.onTimeout === undefined ? "restart"
      : body.onTimeout === "restart" || body.onTimeout === "abort" ? body.onTimeout : null
    if (!requested) return { status: 400, body: { error: `onTimeout must be "restart" or "abort"` } }
    const by = typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 80) : "the dashboard"
    const decision = applyRestartPolicy({ by, onTimeout: requested }, ctx.policy, (ctx.now ?? Date.now)())
    if (decision.action === "refuse") {
      return { status: 403, body: { error: decision.reason, inflight: ctx.inflight(), running: running() } }
    }
    const before = ctx.scheduler.state().state
    if (decision.action === "defer") {
      const state = ctx.scheduler.defer({ requestedBy: by, untilMs: decision.untilMs, timeoutMs: decision.timeoutMs, onTimeout: "abort" })
      return {
        status: before === "none" ? 202 : 200,
        body: { ...state, how: plan.how, deferred: decision.reason, inflight: ctx.inflight(), running: running() },
      }
    }
    const state = ctx.scheduler.schedule({ requestedBy: by, timeoutMs: minutes * 60_000, onTimeout: decision.onTimeout })
    return {
      status: before === "none" ? 202 : 200,
      body: {
        ...state,
        how: plan.how,
        ...(decision.forced ? { onTimeoutForced: "abort" as const, note: "shutdown.restart.forbidOnTimeoutRestart: the wait gives up instead of restarting over running work" } : {}),
        inflight: ctx.inflight(),
        running: running(),
      },
    }
  }
  if (path === "/daemon/restart/cancel" && m === "POST") {
    const cancelled = ctx.scheduler.cancel()
    return { status: cancelled ? 200 : 409, body: cancelled ? ctx.scheduler.state() : { error: "no restart is waiting", ...ctx.scheduler.state() } }
  }
  return { status: 405, body: { error: "Method not allowed" } }
}
