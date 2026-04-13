import { readFileSync, writeFileSync, existsSync } from "fs"
import { resolve } from "path"
import { daemonConfigSchema, expandEnvVars } from "./config"

// --- Config mutator ---
//
// Single helper for every "edit agentx.json" code path. Handles:
//   1. Read raw JSON (preserves ${VAR} tokens)
//   2. Call user-supplied mutator on a deep clone
//   3. Validate the env-expanded clone through the Zod schema
//   4. Pretty-print and write back (raw, unexpanded form)
//   5. Signal the running daemon via POST /reload if reachable
//
// Commands that previously called saveConfig() now go through this,
// so every add-wizard gets pre-save validation and auto-reload for free.

export interface MutationOptions {
  /** Run the Zod schema against the env-expanded mutated config. Default: true. */
  validate?: boolean
  /** Compute + print the diff but do NOT write. Default: false. */
  dryRun?: boolean
  /** POST /reload to the running daemon if reachable. Default: true. */
  reload?: boolean
  /** Override the config file path. Default: ./agentx.json then .agentx/config.json. */
  configPath?: string
  /** Override daemon URL for the reload signal. Default: inferred from config. */
  daemonUrl?: string
}

export interface MutationResult {
  success: boolean
  /** Path that was (or would have been) written. */
  path?: string
  /** The mutated raw config (before write, after mutator fn). */
  after?: unknown
  /** Validation error if the Zod parse failed. */
  error?: string
  /** True if the daemon acknowledged the reload. */
  reloaded?: boolean
  /** Reload failure reason — daemon unreachable, 5xx, etc. Not a hard error. */
  reloadSkipped?: string
  /** True when opts.dryRun was set. */
  dryRun?: boolean
}

function findConfigPath(override?: string): string {
  if (override) return resolve(override)
  const candidates = [
    resolve(process.cwd(), "agentx.json"),
    resolve(process.cwd(), ".agentx/config.json"),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return candidates[0]
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

async function signalReload(daemonUrl: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${daemonUrl.replace(/\/$/, "")}/reload`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    return { ok: true }
  } catch (e: any) {
    // Daemon not running is fine — user is editing config before start.
    return { ok: false, reason: e?.cause?.code || e?.message || "unreachable" }
  }
}

/**
 * Read current config, apply `mutator(cfg)` in place, validate, write, reload.
 *
 * The mutator receives the raw parsed JSON (with `${VAR}` tokens intact). Mutate
 * the object directly — no need to return anything. Validation runs against an
 * env-expanded clone so schema errors are caught before we overwrite the file.
 */
export async function applyConfigMutation(
  mutator: (cfg: any) => void | Promise<void>,
  opts: MutationOptions = {},
): Promise<MutationResult> {
  const {
    validate = true,
    dryRun = false,
    reload = true,
    configPath,
    daemonUrl,
  } = opts

  const path = findConfigPath(configPath)

  if (!existsSync(path)) {
    return { success: false, path, error: `Config not found at ${path}. Run \`agentx init\` first.` }
  }

  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch (e: any) {
    return { success: false, path, error: `Cannot read ${path}: ${e.message}` }
  }

  let current: any
  try {
    current = JSON.parse(raw)
  } catch (e: any) {
    return { success: false, path, error: `Invalid JSON in ${path}: ${e.message}` }
  }

  const mutated = deepClone(current)
  try {
    await mutator(mutated)
  } catch (e: any) {
    return { success: false, path, error: `Mutator threw: ${e.message}` }
  }

  if (validate) {
    const expanded = expandEnvVars(mutated)
    const parsed = daemonConfigSchema.safeParse(expanded)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n")
      return { success: false, path, error: `Validation failed:\n${issues}`, after: mutated }
    }
  }

  if (dryRun) {
    return { success: true, path, after: mutated, dryRun: true }
  }

  try {
    writeFileSync(path, JSON.stringify(mutated, null, 2) + "\n")
  } catch (e: any) {
    return { success: false, path, error: `Write failed: ${e.message}`, after: mutated }
  }

  let reloaded = false
  let reloadSkipped: string | undefined

  if (reload) {
    const url = daemonUrl || inferDaemonUrl(mutated)
    const res = await signalReload(url)
    if (res.ok) reloaded = true
    else reloadSkipped = res.reason
  }

  return { success: true, path, after: mutated, reloaded, reloadSkipped }
}

function inferDaemonUrl(cfg: any): string {
  const bind: string | undefined = cfg?.node?.bind
  if (!bind) return "http://127.0.0.1:18800"
  // bind is "host:port" (host may be 0.0.0.0)
  const [host, port] = bind.split(":")
  const reachable = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host
  return `http://${reachable}:${port}`
}

/**
 * Convenience wrapper for dot-path set: `agents.devops.model` = value.
 * Creates intermediate objects as needed. Array indices (`crons.foo.onError.0`)
 * supported.
 */
export function setAtPath(obj: any, path: string, value: unknown): void {
  const parts = path.split(".")
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (cur[k] === undefined || cur[k] === null) cur[k] = {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = value
}

export function getAtPath(obj: any, path: string): unknown {
  const parts = path.split(".")
  let cur = obj
  for (const k of parts) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

export function unsetAtPath(obj: any, path: string): void {
  const parts = path.split(".")
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) return
    cur = cur[parts[i]]
  }
  if (cur != null) delete cur[parts[parts.length - 1]]
}
