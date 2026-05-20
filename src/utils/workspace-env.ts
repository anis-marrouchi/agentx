import { readFileSync, existsSync } from "fs"
import { resolve } from "path"

// Loads per-agent secrets from the agent's workspace and tells the runtime
// which keys the daemon's own .env injected, so we can strip those before
// spawning the agent's claude process. Without this, every agent inherits
// the daemon's GITLAB_TOKEN regardless of whether their workspace has its
// own .env.gitlab — defeating per-agent identity boundaries (each agent
// should commit/push as itself, not as the daemon's account).

/**
 * Parse a dotenv-style file. Tolerates the `export KEY=VALUE` form used by
 * shell-sourced files like .env.gitlab on clawd-server.
 */
function parseDotEnv(content: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const stripped = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed
    const eq = stripped.indexOf("=")
    if (eq === -1) continue
    const key = stripped.slice(0, eq).trim()
    let value = stripped.slice(eq + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (key) out.push([key, value])
  }
  return out
}

/**
 * Read .env then .env.gitlab from a workspace and return their merged keys.
 * .env.gitlab wins on collision — it's the more specific per-channel file.
 */
export function loadWorkspaceEnv(workspace: string): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const fname of [".env", ".env.gitlab"]) {
    const path = resolve(workspace, fname)
    if (!existsSync(path)) continue
    try {
      for (const [k, v] of parseDotEnv(readFileSync(path, "utf-8"))) {
        merged[k] = v
      }
    } catch { /* best-effort */ }
  }
  return merged
}

/**
 * Keys defined in the daemon's own .env file, cached per daemonCwd. The
 * runtime uses this to strip those keys from the child env before adding
 * the workspace overrides — so a daemon-level GITLAB_TOKEN never leaks to
 * an agent that hasn't put one in its own workspace.
 */
const daemonEnvKeysCache = new Map<string, Set<string>>()

export function getDaemonEnvKeys(daemonCwd: string = process.cwd()): Set<string> {
  const cached = daemonEnvKeysCache.get(daemonCwd)
  if (cached) return cached
  const path = resolve(daemonCwd, ".env")
  let keys: Set<string>
  if (!existsSync(path)) {
    keys = new Set()
  } else {
    try {
      keys = new Set(parseDotEnv(readFileSync(path, "utf-8")).map(([k]) => k))
    } catch {
      keys = new Set()
    }
  }
  daemonEnvKeysCache.set(daemonCwd, keys)
  return keys
}

/** Test-only: clear the cache so a different daemonCwd is re-read. */
export function _resetDaemonEnvKeysCache(): void {
  daemonEnvKeysCache.clear()
}

/**
 * Build the env object passed to a spawned agent process. Starts from
 * parentEnv (default process.env), removes any keys that came from the
 * daemon's own .env (so daemon-level secrets don't leak), then layers in
 * workspace .env / .env.gitlab.
 *
 * - System env (PATH, HOME, USER, …) survives untouched.
 * - Daemon-level secrets (e.g. GITLAB_TOKEN in /home/clawd/agentx/.env) are
 *   stripped UNLESS the workspace provides its own value for that key.
 * - Workspace env (per-agent .env / .env.gitlab) wins on the final merge.
 */
export function buildAgentEnv(
  workspace: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
  daemonCwd: string = process.cwd(),
): NodeJS.ProcessEnv {
  const workspaceEnv = loadWorkspaceEnv(workspace)
  const daemonOwnedKeys = getDaemonEnvKeys(daemonCwd)
  const child: NodeJS.ProcessEnv = { ...parentEnv }
  for (const k of daemonOwnedKeys) {
    if (!(k in workspaceEnv)) delete child[k]
  }
  for (const [k, v] of Object.entries(workspaceEnv)) {
    child[k] = v
  }
  return child
}

// Force the `claude` CLI to use OAuth/subscription billing. When
// ANTHROPIC_API_KEY is present (env, systemd EnvironmentFile, daemon .env not
// stripped because the workspace also defines it), the CLI silently switches
// to the API-key path and any usage caps on that key surface as
// "You have reached your specified API usage limits...". This caused
// claude-code-tier agents to bypass the user's subscription. The same
// stripping pattern lives in src/agent/providers/claude-code.ts for the
// in-process provider — keep them in sync.
export function stripAnthropicApiKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_API_KEY_OLD
  return env
}
