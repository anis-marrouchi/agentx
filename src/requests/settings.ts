import { existsSync, readFileSync } from "fs"
import { applyConfigMutation, findConfigPath, type MutationResult } from "@/daemon/config-mutator"
import { expandEnvVars, requestsConfigSchema } from "@/daemon/config"
import { HUMAN_CHANNELS } from "@/a2a/initiator"
import type { RequestSettings } from "./tracker"
import type { PlanSettings } from "./plans"
import type { CheckerSettings } from "./checkers"

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

export type RequestSettingsPatch = Partial<Omit<RequestSettings, "plans" | "checkers" | "headlines" | "statusDrift" | "catchPromises">> & {
  /** The switch and the cap. Provider, model and timeout are set in agentx.json. */
  catchPromises?: { enabled?: boolean; dailyCap?: number }
  /** Only the switch. Provider, model and timeout are set in agentx.json. */
  headlines?: { enabled?: boolean }
  plans?: Partial<PlanSettings>
  /** The checkers' kinds and pace. Repos and connectors are set in agentx.json. */
  checkers?: Partial<Pick<CheckerSettings, "enabled" | "checkEveryMinutes">>
}

export async function updateRequestSettings(
  patch: RequestSettingsPatch,
  opts: { configPath?: string; reload?: boolean } = {},
): Promise<MutationResult> {
  // Only a turn a person starts is recorded, so any other name (a typo,
  // say) would record nothing without a word.
  const unknown = (patch.channels ?? []).filter((c) => !HUMAN_CHANNELS.has(c.toLowerCase().split("@")[0]))
  if (unknown.length) {
    return { success: false, error: `unknown channel ${unknown.map((c) => `"${c}"`).join(", ")}: use ${[...HUMAN_CHANNELS].join(", ")}` }
  }
  return applyConfigMutation((cfg) => {
    const r = (cfg.requests ??= {})
    for (const key of ["enabled", "channels", "from", "staleAfterHours", "retentionDays", "settleHandedBack"] as const) {
      if (patch[key] !== undefined) r[key] = patch[key]
    }
    if (patch.plans) {
      const p = (r.plans ??= {})
      for (const key of ["enabled", "stallMinutes", "maxNudges", "approveKinds", "disabledAgents", "requireForWork", "requireOverMinutes"] as const) {
        if (patch.plans[key] !== undefined) p[key] = patch.plans[key]
      }
    }
    if (patch.headlines?.enabled !== undefined) (r.headlines ??= {}).enabled = patch.headlines.enabled
    if (patch.catchPromises) {
      const c = (r.catchPromises ??= {})
      for (const key of ["enabled", "dailyCap"] as const) {
        if (patch.catchPromises[key] !== undefined) c[key] = patch.catchPromises[key]
      }
    }
    if (patch.checkers) {
      const c = (r.checkers ??= {})
      for (const key of ["enabled", "checkEveryMinutes"] as const) {
        if (patch.checkers[key] !== undefined) c[key] = patch.checkers[key]
      }
    }
  }, { configPath: opts.configPath, reload: opts.reload })
}
