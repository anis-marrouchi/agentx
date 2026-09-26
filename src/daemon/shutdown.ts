import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"

// --- Graceful shutdown: who asked, and what may still come in ---
//
// On a stop signal the daemon drains in-flight agent tasks before exiting
// (index.ts stop()). Two things make that drain useful:
//
//   1. Nothing new starts while it waits. Requests that would start an agent
//      run are answered 503 "restarting". Requests an in-flight agent still
//      needs to finish its turn — its memory writes, the guard check on its
//      tool calls, sending its reply — keep working.
//   2. The log says why the daemon stopped. A signal carries no sender, so
//      `agentx daemon stop` leaves a short request file first; otherwise the
//      service manager (systemd / launchd) is the best available answer.
//
// Pure functions, unit tested.

export const SHUTDOWN_REQUEST_FILE = "shutdown-request.json"
/** A request file older than this belongs to an earlier stop. */
const REQUEST_MAX_AGE_MS = 10 * 60_000

export interface ShutdownRequest {
  /** What asked, e.g. "agentx daemon stop". */
  by: string
  /** Process that asked. */
  pid: number
  at: string
}

export function writeShutdownRequest(agentxDir: string, req: ShutdownRequest): void {
  writeFileSync(resolve(agentxDir, SHUTDOWN_REQUEST_FILE), JSON.stringify(req) + "\n")
}

/** The pending request, if a recent one exists. Removes the file either
 *  way, so a stale request can't be blamed for a later stop. */
export function takeShutdownRequest(agentxDir: string, now = Date.now()): ShutdownRequest | null {
  const path = resolve(agentxDir, SHUTDOWN_REQUEST_FILE)
  if (!existsSync(path)) return null
  let req: ShutdownRequest | null = null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    const at = Date.parse(parsed?.at)
    if (typeof parsed?.by === "string" && Number.isFinite(at) && now - at <= REQUEST_MAX_AGE_MS) req = parsed
  } catch { /* unreadable → unknown sender */ }
  try { unlinkSync(path) } catch { /* already gone */ }
  return req
}

export function serviceManager(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.INVOCATION_ID) return "systemd"
  if (env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== "0") return `launchd (${env.XPC_SERVICE_NAME})`
  return null
}

/** The one line that explains a shutdown in the daemon log. */
export function describeShutdown(input: {
  signal: string
  request: ShutdownRequest | null
  manager: string | null
  inflight: number
  uptimeSec: number
}): string {
  const who = input.request
    ? `requested by ${input.request.by} (pid ${input.request.pid})`
    : input.manager
      ? `from ${input.manager}`
      : "sender unknown"
  const up = input.uptimeSec >= 3600
    ? `${(input.uptimeSec / 3600).toFixed(1)}h`
    : `${Math.round(input.uptimeSec / 60)}m`
  return `Shutdown: ${input.signal} ${who}; ${input.inflight} task(s) in flight; up ${up}`
}

const NEW_WORK_PATHS = new Set([
  "/task", "/ask", "/mesh/task", "/mesh/inbox/send", "/workflow/event",
  "/talk", "/narration", "/teach/live", "/v1/chat/completions",
])
const NEW_WORK_PREFIXES = ["/webhook/", "/routines/", "/llm/", "/api/workflows/signal/"]

/** Whether a request would start an agent run. GET /ask runs a prompt too. */
export function startsNewWork(method: string | undefined, path: string): boolean {
  const m = (method || "GET").toUpperCase()
  if (m === "GET") return path === "/ask"
  if (m !== "POST") return false
  if (NEW_WORK_PATHS.has(path) || NEW_WORK_PREFIXES.some((p) => path.startsWith(p))) return true
  // A manual workflow run, and a follow-up turn on a task.
  return /^\/workflows\/[^/]+\/run$/.test(path) || /^\/api\/tasks\/[^/]+\/followup$/.test(path)
    || path === "/api/workflows/editor/chat"
}
