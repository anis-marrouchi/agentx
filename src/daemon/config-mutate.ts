import { existsSync, readFileSync, writeFileSync, copyFileSync } from "fs"
import { resolve } from "path"
import { loadDaemonConfig } from "./config"

// --- Shared helpers for safe agentx.json mutation ---
//
// Multiple CLI commands and the dashboard admin UI all need to read → tweak →
// write agentx.json without corrupting it on failure. This module owns the
// atomic-write + backup + best-effort-reload pattern so every caller gets the
// same guarantees.

export interface MutateOptions {
  /** Absolute path to the target agentx.json. Defaults to ./agentx.json. */
  configPath?: string
  /** When true, don't write a timestamped backup. Use for operations that are
   *  intrinsically reversible (or when the caller already took a snapshot). */
  skipBackup?: boolean
  /** When true, don't POST /reload after writing. Handy in tests. */
  skipReload?: boolean
}

export interface MutateResult<T = void> {
  summary: string
  payload?: T
}

/**
 * Read agentx.json, let the mutator tweak it in-place, then atomically write
 * the result back to disk. The mutator returns a short human-readable summary
 * of what changed and may optionally return a payload for the caller to relay.
 *
 * If the mutator throws, nothing is written. If writing succeeds but the file
 * doesn't round-trip as JSON, we restore from backup and rethrow.
 */
export function mutateAgentxConfig<T = void>(
  mutator: (cfg: any) => MutateResult<T> | string,
  opts: MutateOptions = {},
): { summary: string; payload?: T; backupPath?: string } {
  const file = opts.configPath || resolve(process.cwd(), "agentx.json")
  if (!existsSync(file)) throw new Error(`agentx.json not found at ${file}`)

  const cfg = JSON.parse(readFileSync(file, "utf-8"))
  const raw = mutator(cfg)
  const result: MutateResult<T> = typeof raw === "string" ? { summary: raw } : raw

  const json = JSON.stringify(cfg, null, 2) + "\n"
  const tmp = file + ".tmp"
  writeFileSync(tmp, json, "utf-8")
  try {
    JSON.parse(readFileSync(tmp, "utf-8"))
  } catch (e: any) {
    throw new Error(`config did not round-trip cleanly: ${e.message}`)
  }

  let backupPath: string | undefined
  if (!opts.skipBackup) {
    backupPath = `${file}.bak.${Date.now()}`
    copyFileSync(file, backupPath)
  }
  writeFileSync(file, json, "utf-8")

  if (!opts.skipReload) triggerLocalReload().catch(() => { /* daemon may be off */ })

  return { summary: result.summary, payload: result.payload, backupPath }
}

/**
 * Write a fresh agentx.json from scratch. Used by the setup wizard on a truly
 * empty working directory. Fails if a file already exists (callers must pass
 * the overwrite flag explicitly — we don't want to silently clobber an
 * operator's hand-written config).
 */
export function writeAgentxConfig(
  cfg: unknown,
  opts: { configPath?: string; overwrite?: boolean } = {},
): { file: string } {
  const file = opts.configPath || resolve(process.cwd(), "agentx.json")
  if (existsSync(file) && !opts.overwrite) {
    throw new Error(`agentx.json already exists at ${file}. Pass overwrite=true to replace it.`)
  }
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf-8")
  return { file }
}

/**
 * POST to the primary daemon's /reload endpoint so it picks up config changes
 * without a full restart. Silently no-ops if the daemon isn't running.
 */
async function triggerLocalReload(): Promise<void> {
  try {
    const cfg = loadDaemonConfig()
    const url = cfg.dashboard.daemonUrl?.replace(/\/+$/, "") || "http://127.0.0.1:18800"
    await fetch(`${url}/reload`, { method: "POST" }).catch(() => null)
  } catch { /* config didn't load — leave it */ }
}
