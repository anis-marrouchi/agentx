import { spawn } from "child_process"
import { mkdirSync, openSync } from "fs"
import { homedir } from "os"
import { join } from "path"

// --- pxpipe integration (github.com/teamchong/pxpipe) ---
//
// pxpipe is a local Anthropic-API proxy that renders bulky context (system
// prompt slab, large tool_result bodies, collapsed older history) into dense
// PNGs before forwarding — image tokens are priced by pixels, not content,
// so dense text lands at ~3.1 chars/image-token vs ~1.9 chars/token as text.
//
// It is LOSSY on byte-exact strings (hashes, IDs — misreads are silent
// confabulations, not errors), so it stays opt-in per agent / per task and
// is only wired into the claude-code tier, where the claude CLI honors
// ANTHROPIC_BASE_URL. Resolution order mirrors contextStrategy:
// task.pxpipe → agent.pxpipe → config.pxpipe.enabled.
//
// Fail-open by design: when the proxy is down and can't be started, the
// dispatch runs direct (no base-URL override) instead of erroring — a
// missing optimizer must never block an agent.

export interface PxpipeConfig {
  enabled: boolean
  /** Proxy origin the claude CLI is pointed at via ANTHROPIC_BASE_URL. */
  url: string
  /** Spawn `npx pxpipe-proxy` on demand when the health check fails. */
  autoStart: boolean
  /** PXPIPE_MODELS allowlist for the spawned proxy (unset = pxpipe default). */
  models?: string
}

/** Single-flight guard so N concurrent dispatches don't spawn N proxies. */
let ensureInFlight: Promise<string | null> | null = null

/**
 * Return the proxy base URL when it's reachable (starting it if allowed),
 * or null when pxpipe can't be used for this dispatch.
 */
export async function ensurePxpipeProxy(
  cfg: PxpipeConfig | undefined,
  log: (msg: string) => void = () => {},
): Promise<string | null> {
  const url = cfg?.url || "http://127.0.0.1:47821"
  if (await isHealthy(url)) return url
  if (cfg && cfg.autoStart === false) return null

  if (!ensureInFlight) {
    ensureInFlight = startProxy(url, cfg?.models, log).finally(() => {
      ensureInFlight = null
    })
  }
  return ensureInFlight
}

/** The pxpipe dashboard answers on GET / — any HTTP response means alive. */
async function isHealthy(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1_500) })
    return r.status < 500
  } catch {
    return false
  }
}

async function startProxy(
  url: string,
  models: string | undefined,
  log: (msg: string) => void,
): Promise<string | null> {
  const port = String(new URL(url).port || "47821")
  const logDir = join(homedir(), ".pxpipe")
  let out: number | undefined
  try {
    mkdirSync(logDir, { recursive: true })
    out = openSync(join(logDir, "proxy.log"), "a")
  } catch { /* log file is best-effort */ }

  log(`[pxpipe] proxy not reachable at ${url} — starting: npx -y pxpipe-proxy`)
  try {
    const child = spawn("npx", ["-y", "pxpipe-proxy"], {
      detached: true,
      stdio: ["ignore", out ?? "ignore", out ?? "ignore"],
      env: {
        ...process.env,
        PORT: port,
        PXPIPE_PORT: port,
        ...(models ? { PXPIPE_MODELS: models } : {}),
      },
    })
    child.unref()
  } catch (e: any) {
    log(`[pxpipe] failed to spawn proxy: ${e.message}`)
    return null
  }

  // First run may npm-install the package; poll generously but cap hard.
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (await isHealthy(url)) {
      log(`[pxpipe] proxy up at ${url}`)
      return url
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  log(`[pxpipe] proxy did not become healthy within 45s — running direct`)
  return null
}
