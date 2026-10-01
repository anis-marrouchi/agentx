import { mutateAgentxConfig } from "@/daemon/config-mutate"

// --- Request status setting: `requestStatus.channels` in agentx.json (#383) ---
//
// Shared by `agentx request-status` and the dashboard's Channels tab, so
// both accept the same channels and write the same shape.

/** Channels that can show request status today. */
export const STATUS_CHANNELS = ["gitlab", "github"] as const

/** Turn request status on or off for one channel, in the raw config
 *  object. Returns what changed, in words. */
export function setStatusChannel(cfg: any, channel: string, on: boolean): string {
  const name = String(channel || "").trim().toLowerCase()
  if (!(STATUS_CHANNELS as readonly string[]).includes(name)) {
    throw new Error(`Request status works on ${STATUS_CHANNELS.join(" and ")}, not on "${channel}".`)
  }
  cfg.requestStatus = cfg.requestStatus && typeof cfg.requestStatus === "object" ? cfg.requestStatus : {}
  const current: string[] = Array.isArray(cfg.requestStatus.channels) ? cfg.requestStatus.channels.map((c: unknown) => String(c).toLowerCase()) : []
  cfg.requestStatus.channels = on ? [...new Set([...current, name])] : current.filter((c) => c !== name)
  return `request status on ${name} is ${on ? "on" : "off"}`
}

export function statusChannelsOf(cfg: any): string[] {
  return Array.isArray(cfg?.requestStatus?.channels) ? cfg.requestStatus.channels.map((c: unknown) => String(c).toLowerCase()) : []
}

/** Dashboard: POST /api/admin/channels/request-status { channel, enabled }. */
export function toggleRequestStatus(body: any): { summary: string } {
  const { summary } = mutateAgentxConfig((cfg) => setStatusChannel(cfg, body?.channel, !!body?.enabled))
  return { summary }
}
