import { existsSync, readFileSync } from "fs"
import { applyConfigMutation, findConfigPath, type MutationResult } from "@/daemon/config-mutator"
import { expandEnvVars, wacliConfigSchema, type DaemonConfig } from "@/daemon/config"

// --- WhatsApp triage settings: read and change `wacli` in agentx.json ---
//
// Shared by `agentx wacli` and the dashboard, so both validate through the
// config schema and both hot-reload the daemon. The secret itself is never
// returned; only whether one is set.

export type WacliConfig = DaemonConfig["wacli"]
export type WacliRuleConfig = WacliConfig["rules"][number]

export function readWacliConfig(configPath?: string): WacliConfig {
  const path = findConfigPath(configPath)
  let raw: any = {}
  if (existsSync(path)) {
    try { raw = expandEnvVars(JSON.parse(readFileSync(path, "utf-8"))) } catch { raw = {} }
  }
  const parsed = wacliConfigSchema.safeParse(raw?.wacli)
  return parsed.success ? parsed.data : wacliConfigSchema.parse(undefined)
}

/** What the CLI and dashboard show: everything but the secret. */
export function wacliSummary(cfg: WacliConfig): Omit<WacliConfig, "secret"> & { secretSet: boolean } {
  const { secret, ...rest } = cfg
  return { ...rest, secretSet: !!(secret || process.env[cfg.secretEnv]) }
}

export interface WacliSettingsPatch {
  enabled?: boolean
  batchSeconds?: number
  secretEnv?: string
  /** null clears it. */
  binary?: string | null
  account?: string | null
  media?: boolean
}

export function updateWacliSettings(patch: WacliSettingsPatch, opts: { configPath?: string; reload?: boolean } = {}): Promise<MutationResult> {
  return applyConfigMutation((cfg) => {
    const w = (cfg.wacli ??= {})
    for (const k of ["enabled", "batchSeconds", "secretEnv", "media"] as const) {
      if (patch[k] !== undefined) w[k] = patch[k]
    }
    for (const k of ["binary", "account"] as const) {
      if (patch[k] === null) delete w[k]
      else if (patch[k] !== undefined) w[k] = patch[k]
    }
  }, opts)
}

/** Add a rule, or replace the one with the same id. */
export function saveWacliRule(rule: Record<string, unknown>, opts: { configPath?: string; reload?: boolean } = {}): Promise<MutationResult> {
  return applyConfigMutation((cfg) => {
    const w = (cfg.wacli ??= {})
    const rules: any[] = (w.rules ??= [])
    const i = rules.findIndex((r) => r?.id === rule.id)
    if (i >= 0) rules[i] = rule
    else rules.push(rule)
  }, opts)
}

export function removeWacliRule(id: string, opts: { configPath?: string; reload?: boolean } = {}): Promise<MutationResult> {
  return applyConfigMutation((cfg) => {
    const rules: any[] = cfg.wacli?.rules ?? []
    const i = rules.findIndex((r) => r?.id === id)
    if (i < 0) throw new Error(`no rule "${id}"`)
    rules.splice(i, 1)
  }, opts)
}

/** "22:00-07:00" → { start, end }. */
export function parseQuietHours(value: string): { start: string; end: string } | null {
  const m = /^\s*(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s*$/.exec(value)
  return m ? { start: m[1], end: m[2] } : null
}
