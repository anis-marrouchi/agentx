import type { IdleRestartScheduler, OnTimeout, SelfRestartPlan, ServiceInfo } from "./restart"

// --- HTTP surface for "restart when idle" (operator-only; the daemon gates
// it with checkMeshAuth: loopback or a mesh token, never a foreign page) ---
//
//   GET  /daemon/restart         what runs this daemon, in-flight count, request state
//   POST /daemon/restart         { timeoutMinutes?, onTimeout?: "restart"|"abort", by? }
//                                schedule a restart for when the daemon is idle
//   POST /daemon/restart/cancel  drop a pending request
//
// Pure request → reply mapping; index.ts supplies the context.

export const RESTART_API_PATHS = new Set(["/daemon/restart", "/daemon/restart/cancel"])

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30
const MAX_IDLE_TIMEOUT_MINUTES = 24 * 60

export interface RestartApiContext {
  scheduler: IdleRestartScheduler
  inflight: () => { local: number; meshForwards: number; total: number }
  /** What runs the daemon, and whether it can restart itself. Detected once. */
  service: () => { service: ServiceInfo; plan: SelfRestartPlan }
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
  if (path === "/daemon/restart" && m === "GET") {
    const { service, plan } = ctx.service()
    return {
      status: 200,
      body: {
        pid: ctx.pid,
        cwd: ctx.cwd,
        configPath: ctx.configPath,
        inflight: ctx.inflight(),
        service,
        selfRestart: plan,
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
    const onTimeout: OnTimeout | null = body.onTimeout === undefined ? "restart"
      : body.onTimeout === "restart" || body.onTimeout === "abort" ? body.onTimeout : null
    if (!onTimeout) return { status: 400, body: { error: `onTimeout must be "restart" or "abort"` } }
    const by = typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 80) : "the dashboard"
    const before = ctx.scheduler.state().state
    const state = ctx.scheduler.schedule({ requestedBy: by, timeoutMs: minutes * 60_000, onTimeout })
    return { status: before === "none" ? 202 : 200, body: { ...state, how: plan.how, inflight: ctx.inflight() } }
  }
  if (path === "/daemon/restart/cancel" && m === "POST") {
    const cancelled = ctx.scheduler.cancel()
    return { status: cancelled ? 200 : 409, body: cancelled ? ctx.scheduler.state() : { error: "no restart is waiting", ...ctx.scheduler.state() } }
  }
  return { status: 405, body: { error: "Method not allowed" } }
}
