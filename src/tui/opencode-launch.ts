import type { ChildProcess } from "node:child_process"
import { OpenCodeServerUnavailable } from "@/agents/opencode-process"

// How `agentx tui` opens OpenCode.
//
// `opencode --standalone` starts a private server and a screen in one go,
// and the screen gives that server about two seconds to answer before it
// reports "Timed out connecting to server" and retries. On a machine that
// is already running agent processes, the server took six seconds to load
// its plugins and watchers, the screen gave up, and the whole thing closed
// on the user before anything was drawn.
//
// So the launcher starts the server first, through the same pool the
// OpenCode agent tier uses, waits for the server's own ready line, and only
// then opens the screen with `--server <url>`. The pool's credentials travel
// in the environment. If a server cannot be started, the old standalone
// launch is the fallback rather than a failure.

export interface OpenCodeServerHandle {
  url: string
  env: NodeJS.ProcessEnv
  release: (failed?: boolean) => void
}

export interface OpenCodeServerPool {
  acquire(o: { key: string; cwd: string; env: NodeJS.ProcessEnv; model?: string; fresh?: boolean }): Promise<OpenCodeServerHandle>
}

export interface LaunchOptions {
  agentId: string
  /** Environment for OpenCode, with OPENCODE_CONFIG_CONTENT already set. */
  env: NodeJS.ProcessEnv
  cwd: string
  pool: OpenCodeServerPool
  spawnImpl: (command: string, args: string[], opts: { stdio: "inherit"; env: NodeJS.ProcessEnv; cwd: string }) => ChildProcess
  log: (line: string) => void
}

export interface LaunchResult {
  /** "server" when the screen connected to a pre-started server, else "standalone". */
  mode: "server" | "standalone"
}

export async function launchOpenCode(opts: LaunchOptions): Promise<LaunchResult> {
  let server: OpenCodeServerHandle | undefined
  try {
    server = await opts.pool.acquire({
      key: `tui:${opts.agentId}`,
      cwd: opts.cwd,
      env: opts.env,
      model: `agentx/${opts.agentId}`,
      // A console session starts clean; a warm server from an earlier
      // session would carry that session's configuration fingerprint.
      fresh: true,
    })
  } catch (error: any) {
    if (!(error instanceof OpenCodeServerUnavailable)) throw error
    opts.log(`OpenCode server not started (${error.message}); opening OpenCode standalone.`)
  }

  const args = server ? ["--server", server.url] : ["--standalone"]
  const child = opts.spawnImpl("opencode", args, { stdio: "inherit", env: server ? server.env : opts.env, cwd: opts.cwd })
  try {
    await new Promise<void>((done, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => code === 0 ? done() : reject(new Error(`OpenCode exited with code ${code ?? "unknown"}`)))
    })
  } finally {
    // The server belongs to this screen: close it when the screen goes.
    server?.release(true)
  }
  return { mode: server ? "server" : "standalone" }
}
