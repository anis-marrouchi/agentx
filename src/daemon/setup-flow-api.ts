import { resolve } from "path"
import type { IncomingMessage, ServerResponse } from "http"
import { HUB_PATH } from "./ui/hub-name"
import {
  checkModel, createFirstAgent, firstAgent, plainError, saveModelKey, switchEngine,
  SetupError, type SetupEngine, type SetupEnv,
} from "./setup-flow"

// --- The guided first run, over HTTP (#2143) ---
//
//   GET  /api/setup/state                 → { model, agent, daemon, hubChat }
//   POST /api/setup/model-key {key}       → saves the key to .env    → { model }
//   POST /api/setup/engine {engine}       → first agent on that account → { model }
//   POST /api/setup/agent {name, workspace} → the first agent, once, and a
//                                           daemon that has loaded it
//   POST /api/setup/first-task {message}  → { threadId }  (the daemon's POST /api/assistant)
//   GET  /api/setup/first-task?thread=<id> → { status, taskId?, answer?, error? }
//
// Every error is { error: <plain sentence with the next step> }. The page
// streams the answer itself through the dashboard's /api/task/stream while
// the run's taskId is known, and reads the result here. The production
// wiring (this folder's daemon, the real CLIs) is setup-flow-daemon.ts.

export const SETUP_API_PREFIX = "/api/setup/"

export type DaemonState = "down" | "ours" | "other-agentx" | "other"

export interface SetupApiDeps extends SetupEnv {
  readBody: (req: IncomingMessage) => Promise<any>
  daemon: {
    /** The address it answers on, for messages and the stream. */
    url: string
    probe: () => Promise<DaemonState>
    /** Whether the running daemon has this agent loaded. */
    hasAgent: (id: string) => Promise<boolean>
    /** Start it and wait; true once it answers. */
    start: () => Promise<boolean>
    /** Re-read agentx.json and .env; lists what only a restart applies. */
    reload: () => Promise<{ restartRequired: string[] }>
    /** Restart it and wait; true once it answers again. */
    restart: () => Promise<boolean>
  }
  /** The daemon's /api/assistant routes, with its token. */
  assistant: (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; body: any }>
}

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
  return true
}

function port(url: string): string {
  try { return new URL(url).port || "80" } catch { return "18800" }
}

const NOT_LOADED = "Your agent is saved, but AgentX's background service did not load it. In Terminal, run: agentx daemon restart — then press Try again."

/** Throws, in plain words, when the daemon's port answers for someone else. */
function portFree(deps: SetupApiDeps, state: DaemonState): void {
  if (state === "other-agentx") {
    throw new SetupError(409, `Port ${port(deps.daemon.url)} is used by another AgentX install. Stop it with agentx daemon stop in its folder, or run this one on other ports: agentx start --port 18810 --dashboard-port 4212`)
  }
  if (state === "other") {
    throw new SetupError(409, `Port ${port(deps.daemon.url)} is already used by another program. Close that program, or run AgentX on other ports: agentx start --port 18810 --dashboard-port 4212`)
  }
}

/** A daemon that runs this folder's agents: started when down, told to
 *  re-read the config when asked, and restarted when that is not enough.
 *  A reload does not add a new agent or change an agent's engine (the
 *  daemon's reload() lists those as restartRequired), so with `agentId`
 *  the daemon is restarted until it has that agent. A port held by
 *  something else is said as such. */
export async function ensureDaemon(deps: SetupApiDeps, opts: { reload: boolean; agentId?: string }): Promise<"running" | "reloaded" | "restarted" | "started"> {
  const state = await deps.daemon.probe()
  portFree(deps, state)
  if (state === "down") {
    if (!(await deps.daemon.start())) {
      throw new SetupError(504, `AgentX's background service did not start. See the log in ${resolve(deps.dir, ".agentx", "daemon.log")}, or run agentx start in Terminal, then press Try again.`)
    }
    return "started"
  }
  let restart = false
  if (opts.reload) {
    try {
      const r = await deps.daemon.reload()
      restart = r.restartRequired.some((x) => x.startsWith("agents"))
    } catch { throw new SetupError(502, NOT_LOADED) }
  }
  if (!restart && opts.agentId) restart = !(await deps.daemon.hasAgent(opts.agentId))
  if (!restart) return opts.reload ? "reloaded" : "running"
  if (!(await deps.daemon.restart())) throw new SetupError(504, NOT_LOADED)
  return "restarted"
}

/** After a key or engine change: a running daemon picks it up. */
async function applyIfRunning(deps: SetupApiDeps): Promise<void> {
  if ((await deps.daemon.probe()) !== "ours") return
  await ensureDaemon(deps, { reload: true, agentId: firstAgent(deps.dir)?.id })
}

/** Handles /api/setup/<step>; false for any other path. */
export async function handleSetupFlowApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: SetupApiDeps): Promise<boolean> {
  const method = (req.method || "GET").toUpperCase()
  const route = `${method} ${url.pathname}`
  const routes: Record<string, () => Promise<unknown>> = {
    "GET /api/setup/state": async () => ({
      model: checkModel(deps), agent: firstAgent(deps.dir), daemon: (await deps.daemon.probe()) === "ours", hubChat: `${HUB_PATH}#chat=open`,
    }),
    "POST /api/setup/model-key": async () => {
      const body = await deps.readBody(req).catch(() => ({})) || {}
      saveModelKey(deps, checkModel(deps).keyVar || "ANTHROPIC_API_KEY", body.key)
      await applyIfRunning(deps)
      return { model: checkModel(deps) }
    },
    "POST /api/setup/engine": async () => {
      const body = await deps.readBody(req).catch(() => ({})) || {}
      const engine = String(body.engine || "") as SetupEngine
      if (!engine || checkModel(deps).switchTo !== engine) throw new SetupError(409, "That model account is not ready on this computer. Press Check again.")
      switchEngine(deps.dir, engine)
      await applyIfRunning(deps)
      return { model: checkModel(deps) }
    },
    "POST /api/setup/agent": async () => {
      const body = await deps.readBody(req).catch(() => ({})) || {}
      // A port taken by someone else is said before anything is written.
      if (!firstAgent(deps.dir)) portFree(deps, await deps.daemon.probe())
      const out = createFirstAgent(deps, { name: body.name, workspace: body.workspace })
      const daemon = await ensureDaemon(deps, { reload: out.created, agentId: out.agent.id })
      return { ...out, daemon }
    },
    "POST /api/setup/first-task": async () => {
      const body = await deps.readBody(req).catch(() => ({})) || {}
      const agent = firstAgent(deps.dir)
      if (!agent) throw new SetupError(409, "Create your agent first (step 2).")
      const message = String(body.message || "").trim()
      if (!message) throw new SetupError(400, "Type a task for your agent first.")
      if (message.length > 4000) throw new SetupError(400, "Keep the first task under 4,000 characters.")
      await ensureDaemon(deps, { reload: false, agentId: agent.id })
      const r = await deps.assistant("POST", "/api/assistant", { agentId: agent.id, message })
      if (r.status >= 400 || r.body?.error) throw new SetupError(502, plainError(r.body?.error || `HTTP ${r.status}`))
      return { threadId: r.body.threadId, node: deps.daemon.url, agent: agent.id }
    },
    "GET /api/setup/first-task": async () => {
      const thread = url.searchParams.get("thread") || ""
      if (!thread) throw new SetupError(400, "Send the first task again.")
      const r = await deps.assistant("GET", `/api/assistant/thread?id=${encodeURIComponent(thread)}`)
      if (r.status === 404) throw new SetupError(404, "That task was not found. Send it again.")
      if (r.status >= 400) throw new SetupError(502, plainError(r.body?.error || `HTTP ${r.status}`))
      const last = (r.body?.messages || []).filter((m: any) => m.role === "assistant").pop()
      if (!last || last.status === "pending") return { status: "pending", taskId: last?.taskId || null }
      if (last.status === "error") return { status: "error", error: plainError(last.content) }
      return { status: "done", answer: String(last.content || "") }
    },
  }
  const run = routes[route]
  if (!run) return url.pathname.startsWith(SETUP_API_PREFIX) && ["state", "model-key", "engine", "agent", "first-task"].includes(url.pathname.slice(SETUP_API_PREFIX.length))
    ? send(res, 405, { error: "Method not allowed" })
    : false
  // These routes sit above the dashboard's general X-Requested-With check,
  // so they make it themselves: a page on another site cannot send that
  // header, and must not save a key or start a task in the owner's name.
  if (method === "POST" && req.headers["x-requested-with"] !== "agentx-board") {
    return send(res, 400, { error: "missing X-Requested-With: agentx-board" })
  }
  try {
    return send(res, 200, await run())
  } catch (e: any) {
    if (e instanceof SetupError) return send(res, e.status, { error: e.message })
    return send(res, 500, { error: plainError(e) })
  }
}
