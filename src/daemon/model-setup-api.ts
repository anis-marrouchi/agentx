import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import type { IncomingMessage, ServerResponse } from "http"
import { modelReadiness, type ModelReadiness } from "./model-ready"
import { addDotenvKey, readDotenv } from "@/utils/dotenv"
import { findBinary } from "@/voice/transcribe"
import { cliLoggedIn } from "@/utils/cli-login"

// --- The chat's "no model yet" box (#1163) ---
//
//   GET  /api/admin/model-ready?agent=<id>   → ModelReadiness
//   POST /api/admin/model-key {agent, key}   → saves the key to .env, then
//                                              asks the daemon to reload
//
// Mounted on the dashboard below the /api/admin token gate and the
// browser-origin check, so only the owner's own pages reach it. The key is
// written to .env in the folder AgentX runs in, never to agentx.json, and
// is not echoed back.

export const MODEL_READY_PATH = "/api/admin/model-ready"
export const MODEL_KEY_PATH = "/api/admin/model-key"

export interface ModelSetupDeps {
  /** The folder with agentx.json and .env. */
  dir: string
  /** Re-read config on the daemon so the new key is used without a restart. */
  reloadDaemon: () => Promise<void>
  env?: Record<string, string | undefined>
  hasBinary?: (name: string) => boolean
  cliLoggedIn?: (name: string) => boolean | null
  readBody: (req: IncomingMessage) => Promise<any>
}

function rawConfig(dir: string): any {
  for (const p of [resolve(dir, "agentx.json"), resolve(dir, ".agentx/config.json")]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"))
  }
  return {}
}

export function readinessFor(agentId: string, deps: ModelSetupDeps): ModelReadiness {
  return modelReadiness({
    rawConfig: rawConfig(deps.dir),
    agentId,
    env: deps.env ?? process.env,
    dotenv: readDotenv(resolve(deps.dir, ".env")),
    hasBinary: deps.hasBinary ?? ((bin) => Boolean(findBinary(bin))),
    cliLoggedIn: deps.cliLoggedIn ?? cliLoggedIn,
  })
}

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
  return true
}

/** Handles the two routes; false for any other path. */
export async function handleModelSetupApi(
  req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, deps: ModelSetupDeps,
): Promise<boolean> {
  const method = req.method || "GET"
  if (method === "GET" && path === MODEL_READY_PATH) {
    const agent = query.get("agent") || ""
    if (!agent) return send(res, 400, { error: "agent is required" })
    try { return send(res, 200, readinessFor(agent, deps)) } catch (e: any) { return send(res, 500, { error: e.message }) }
  }
  if (method === "POST" && path === MODEL_KEY_PATH) {
    const body = (await deps.readBody(req).catch(() => null)) || {}
    const agent = typeof body.agent === "string" ? body.agent : ""
    const key = typeof body.key === "string" ? body.key.trim() : ""
    if (!agent || !key) return send(res, 400, { error: "agent and key are required" })
    if (/\s/.test(key) || key.length > 500) return send(res, 400, { error: "That does not look like an API key (one line, no spaces)." })
    const before = readinessFor(agent, deps)
    if (before.ready) return send(res, 200, before)
    if (before.need !== "key" || !before.envVar) return send(res, 409, { error: before.hint || "This agent does not take a key." })
    const added = addDotenvKey(resolve(deps.dir, ".env"), before.envVar, key)
    if (!added) return send(res, 409, { error: `${before.envVar} is already in .env. Edit it there.` })
    try { await deps.reloadDaemon() } catch (e: any) {
      return send(res, 502, { error: `Saved to .env, but the daemon did not reload: ${e.message}. Restart it with: agentx daemon restart` })
    }
    return send(res, 200, readinessFor(agent, deps))
  }
  return false
}
