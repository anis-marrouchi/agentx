import { existsSync, readFileSync } from "fs"
import { applyConfigMutation, findConfigPath, type MutationResult } from "@/daemon/config-mutator"
import { expandEnvVars, requestsConfigSchema } from "@/daemon/config"
import type { RequestSettings } from "./tracker"

// --- Requests settings: read and change `requests` in agentx.json ---
//
// Shared by `agentx requests settings` and the dashboard, so both validate
// through the config schema and both hot-reload the daemon.

export function readRequestSettings(configPath?: string): RequestSettings {
  const path = findConfigPath(configPath)
  let raw: any = {}
  if (existsSync(path)) {
    try { raw = expandEnvVars(JSON.parse(readFileSync(path, "utf-8"))) } catch { raw = {} }
  }
  const parsed = requestsConfigSchema.safeParse(raw?.requests)
  return parsed.success ? parsed.data : requestsConfigSchema.parse(undefined)
}

export type RequestSettingsPatch = Partial<RequestSettings>

export async function updateRequestSettings(
  patch: RequestSettingsPatch,
  opts: { configPath?: string; reload?: boolean } = {},
): Promise<MutationResult> {
  return applyConfigMutation((cfg) => {
    const r = (cfg.requests ??= {})
    for (const key of ["enabled", "channels", "from", "staleAfterHours", "retentionDays"] as const) {
      if (patch[key] !== undefined) r[key] = patch[key]
    }
  }, { configPath: opts.configPath, reload: opts.reload })
}
