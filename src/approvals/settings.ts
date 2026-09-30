import { existsSync, readFileSync } from "fs"
import { applyConfigMutation, findConfigPath, type MutationResult } from "@/daemon/config-mutator"
import { approvalsConfigSchema, expandEnvVars } from "@/daemon/config"
import type { ApprovalSettings } from "./sweep"

// --- Approvals settings: read and change `approvals` in agentx.json ---
//
// Shared by `agentx approvals settings` and the dashboard's settings form,
// so both validate the same way (through the config schema) and both
// hot-reload the daemon.

export function readApprovalSettings(configPath?: string): ApprovalSettings {
  const path = findConfigPath(configPath)
  let raw: any = {}
  if (existsSync(path)) {
    try { raw = expandEnvVars(JSON.parse(readFileSync(path, "utf-8"))) } catch { raw = {} }
  }
  const parsed = approvalsConfigSchema.safeParse(raw?.approvals)
  return (parsed.success ? parsed.data : approvalsConfigSchema.parse(undefined)) as ApprovalSettings
}

/** What can be changed. `destination: null` clears it (back to notifications.destination). */
export interface ApprovalSettingsPatch {
  defaultExpiryDays?: number
  maxExpiryDays?: number
  laterHours?: number
  notifyAgent?: boolean
  digestEnabled?: boolean
  digestTime?: string
  digestTimezone?: string | null
  destination?: { channel: string; chatId: string; accountId?: string } | null
  popupEnabled?: boolean
  popupSpeak?: boolean
  /** null clears it (back to the system voice). */
  popupVoice?: string | null
  /** "" for no sound. */
  popupSound?: string
  popupTimeoutSeconds?: number
  popupStyle?: "card" | "dialog"
  popupTheme?: "system" | "light" | "dark"
  checkinEnabled?: boolean
  checkinTimes?: string[]
  checkinDailyAt?: string
  checkinLists?: string[]
  /** null clears it. */
  checkinAgent?: string | null
}

/** "channel:chatId". Everything after the first ":" is the chat id, which may contain ":" itself. */
export function parseDestination(value: string): { channel: string; chatId: string; accountId?: string } | null {
  const i = value.indexOf(":")
  if (i <= 0 || i === value.length - 1) return null
  return { channel: value.slice(0, i).trim(), chatId: value.slice(i + 1).trim() }
}

export async function updateApprovalSettings(
  patch: ApprovalSettingsPatch,
  opts: { configPath?: string; reload?: boolean } = {},
): Promise<MutationResult> {
  return applyConfigMutation((cfg) => {
    const a = (cfg.approvals ??= {})
    if (patch.defaultExpiryDays !== undefined) a.defaultExpiryDays = patch.defaultExpiryDays
    if (patch.maxExpiryDays !== undefined) a.maxExpiryDays = patch.maxExpiryDays
    if (patch.laterHours !== undefined) a.laterHours = patch.laterHours
    if (patch.notifyAgent !== undefined) a.notifyAgent = patch.notifyAgent
    const d = (a.digest ??= {})
    if (patch.digestEnabled !== undefined) d.enabled = patch.digestEnabled
    if (patch.digestTime !== undefined) d.time = patch.digestTime
    if (patch.digestTimezone === null) delete d.timezone
    else if (patch.digestTimezone !== undefined) d.timezone = patch.digestTimezone
    if (patch.destination === null) delete d.destination
    else if (patch.destination !== undefined) d.destination = patch.destination
    const p = (a.popup ??= {})
    if (patch.popupEnabled !== undefined) p.enabled = patch.popupEnabled
    if (patch.popupSpeak !== undefined) p.speak = patch.popupSpeak
    if (patch.popupVoice === null) delete p.voice
    else if (patch.popupVoice !== undefined) p.voice = patch.popupVoice
    if (patch.popupSound !== undefined) p.sound = patch.popupSound
    if (patch.popupTimeoutSeconds !== undefined) p.timeoutSeconds = patch.popupTimeoutSeconds
    if (patch.popupStyle !== undefined) p.style = patch.popupStyle
    if (patch.popupTheme !== undefined) p.theme = patch.popupTheme
    const c = (a.checkin ??= {})
    if (patch.checkinEnabled !== undefined) c.enabled = patch.checkinEnabled
    if (patch.checkinTimes !== undefined) c.times = patch.checkinTimes
    if (patch.checkinDailyAt !== undefined) c.dailyAt = patch.checkinDailyAt
    if (patch.checkinLists !== undefined) c.lists = patch.checkinLists
    if (patch.checkinAgent === null) delete c.agent
    else if (patch.checkinAgent !== undefined) c.agent = patch.checkinAgent
    const days = a.defaultExpiryDays ?? 3
    const max = a.maxExpiryDays ?? 30
    if (days > max) throw new Error(`defaultExpiryDays (${days}) can't be more than maxExpiryDays (${max})`)
  }, { configPath: opts.configPath, reload: opts.reload })
}
