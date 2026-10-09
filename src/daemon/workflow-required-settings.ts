import { existsSync, readFileSync } from "fs"
import { applyConfigMutation, findConfigPath, type MutationResult } from "./config-mutator"
import { expandEnvVars } from "./config"
import { REQUIRED_DEFAULTS, type RequiredSettings } from "@/workflows/required"

// --- workflows.required settings: read and change them in agentx.json (#858) ---
//
// Shared by `agentx workflow required` and the dashboard's Workflows page,
// so both validate through the config schema and both reload the daemon.

export interface RequiredSettingsView extends RequiredSettings {
  /** workflows.enabled: nothing is required while the engine is off. */
  engine: boolean
}

export function readRequiredSettings(configPath?: string): RequiredSettingsView {
  const path = findConfigPath(configPath)
  let raw: any = {}
  if (existsSync(path)) {
    try { raw = expandEnvVars(JSON.parse(readFileSync(path, "utf-8"))) } catch { raw = {} }
  }
  const r = raw?.workflows?.required ?? {}
  const agents: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(r.agents ?? {})) if (typeof v === "boolean") agents[k] = v
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : REQUIRED_DEFAULTS.enabled,
    agents,
    exemptQuestions: typeof r.exemptQuestions === "boolean" ? r.exemptQuestions : REQUIRED_DEFAULTS.exemptQuestions,
    retentionDays: Number.isInteger(r.retentionDays) && r.retentionDays >= 0 ? r.retentionDays : REQUIRED_DEFAULTS.retentionDays,
    engine: raw?.workflows?.enabled === true,
  }
}

export interface RequiredSettingsPatch {
  enabled?: boolean
  exemptQuestions?: boolean
  /** Days ended task runs are kept; 0 keeps them all (#883). */
  retentionDays?: number
  /** One agent's override: true, false, or null to follow `enabled` again. */
  agent?: { id: string; value: boolean | null }
}

/** Turning it on (for all, or for one agent) also turns the workflow
 *  engine on: a required workflow needs it. */
export async function updateRequiredSettings(
  patch: RequiredSettingsPatch,
  opts: { configPath?: string; reload?: boolean } = {},
): Promise<MutationResult> {
  if (patch.retentionDays !== undefined && !(Number.isInteger(patch.retentionDays) && patch.retentionDays >= 0 && patch.retentionDays <= 3650)) {
    return { success: false, error: "retentionDays is a whole number of days from 0 to 3650" }
  }
  if (patch.agent && !/^[A-Za-z0-9_.@-]{1,80}$/.test(patch.agent.id)) {
    return { success: false, error: `"${patch.agent.id}" is not an agent id` }
  }
  return applyConfigMutation((cfg) => {
    const wf = (cfg.workflows ??= {})
    const r = (wf.required ??= {})
    if (patch.enabled !== undefined) r.enabled = patch.enabled
    if (patch.exemptQuestions !== undefined) r.exemptQuestions = patch.exemptQuestions
    if (patch.retentionDays !== undefined) r.retentionDays = patch.retentionDays
    if (patch.agent) {
      const agents = (r.agents ??= {})
      if (patch.agent.value === null) delete agents[patch.agent.id]
      else agents[patch.agent.id] = patch.agent.value
    }
    if (patch.enabled === true || patch.agent?.value === true) wf.enabled = true
  }, { configPath: opts.configPath, reload: opts.reload })
}
