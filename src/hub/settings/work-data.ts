// --- Settings › Work: what Jobs, Approvals and Inbox read, and the pure sums (#2101 ST2b) ---
//
// The same endpoints the old Settings reads, so nothing new on the server:
//   Jobs       /api/admin/state (crons, sensors, hostJobs, webhooks,
//              daemonUrl, wikiNotes), /api/admin/wiki-notes/list
//              (wall-settings-jobs.client.ts)
//   Approvals  /api/admin/approvals and /api/admin/approvals/requests, for
//              their `settings` (wall-settings-approvals.client.ts)
//   Inbox      /api/admin/state's `notifications` (wall-settings-inbox.client.ts)
import cronstrue from "cronstrue"
import type { AdminState } from "./data"

export interface CronValue { why: string; metric: string }
export interface CronChange { field: string; old?: unknown; new?: unknown; by: string; reason?: string; at: string }
export interface Cron {
  id: string; schedule: string; agent: string; prompt?: string; enabled?: boolean; kind?: "agent" | "command"
  value?: CronValue; goal?: string; goalClosed?: { state: string }; until?: string; endedAt?: string
  lastVerdict?: { text: string; at: string }; goalLines?: string[]; changes?: CronChange[]
}
export interface Sensor {
  id: string; reading: string; every: string; targets: string[]; last: string; lastAt: number | null
  wakes: { at: string; level: string; target: string; reading: string; ok: boolean; error?: string }[]
}
export interface HostJob { label: string; owner: string; text: string }
export interface Webhook {
  id: string; source: string; agentId: string; secretEnv: string; description: string; enabled: boolean
  triggers: Record<string, string>; defaultWorkflow: string
}
export interface WikiNotes { enabled: boolean; inbox: string; crons: string[]; absorbAgent: string; maxNotesPerRun: number; maxDeferrals: number }
export interface WikiNote { id: string; status: string; from: string; date: string; change: string; handled?: { outcome: string; by: string; reason: string } }
export interface Notifications {
  longTaskThreshold: number
  destination: { channel: string; chatId: string; accountId?: string } | null
  on: { taskComplete: boolean; taskError: boolean; taskQueued: boolean }
  local: { banner?: boolean; sound?: boolean; soundName?: string; volume?: number; icon?: string }
  ntfy: { enabled: boolean; server: string; topicSet: boolean; tokenSet: boolean }
}
export interface WorkState extends AdminState {
  crons?: Cron[]; sensors?: Sensor[]; hostJobs?: HostJob[]; webhooks?: Webhook[]; daemonUrl?: string
  wikiNotes?: WikiNotes; notifications?: Notifications
}

export type Reach = "all" | "urgent" | "off"
export interface ApprovalSettings {
  defaultExpiryDays: number; maxExpiryDays: number; laterHours: number; notifyAgent: boolean
  digest: { enabled: boolean; time: string; destination?: { channel: string; chatId: string; accountId?: string } }
  desk: { phone: Reach; computer: Reach }
}
export interface RequestSettings {
  enabled: boolean; from: string[]; channels: string[]; staleAfterHours: number; retentionDays: number; headlines?: { enabled?: boolean }
  plans: { enabled?: boolean; stallMinutes?: number; maxNudges?: number; approveKinds?: string[]; disabledAgents?: string[]; requireForWork?: string[]; requireOverMinutes?: number }
  checkers: { enabled?: string[]; checkEveryMinutes?: number }
}

/** Presets for the schedule field, as the old guided builder offers. */
export const CRON_PRESETS: readonly (readonly [string, string])[] = [
  ["0 9 * * *", "Every day at 9:00"], ["0 9 * * 1-5", "Weekdays at 9:00"], ["0 9 * * 1", "Mondays at 9:00"],
  ["0 * * * *", "Every hour"], ["*/15 * * * *", "Every 15 minutes"],
]

/** A schedule in words: the preset's name, else cronstrue's, else nothing. */
export function cronHuman(expr: string): string {
  const e = expr.trim()
  const preset = CRON_PRESETS.find((p) => p[0] === e)
  if (preset) return preset[1]
  try { return cronstrue.toString(e, { use24HourTimeFormat: true, verbose: false }) } catch { return "" }
}

/** Why the job runs and what proves it, or what is missing (cron-value.ts). */
export function valueLine(c: Cron): { missing: string[]; why?: string; metric?: string; goal?: string; goalClosed?: string } {
  const missing: string[] = []
  if (!c.value?.why || !c.value?.metric) missing.push("No value line")
  if (c.goal && c.goalClosed) return { missing: [...missing, `goal ${c.goal} ${c.goalClosed.state}, disable?`], why: c.value?.why, metric: c.value?.metric }
  if (!c.goal && c.kind !== "command") missing.push(missing.length ? "no goal" : "No goal")
  return { missing, why: c.value?.why, metric: c.value?.metric, goal: c.goal }
}

export const WEBHOOK_SOURCES: readonly (readonly [string, string])[] = [
  ["gitlab", "GitLab"], ["github", "GitHub"], ["sentry", "Sentry"], ["stripe", "Stripe"], ["vercel", "Vercel"], ["odoo", "Odoo"],
  ["hubspot", "HubSpot"], ["discord", "Discord"], ["slack", "Slack"], ["custom", "Custom"],
]
export const sourceName = (s: string) => WEBHOOK_SOURCES.find((x) => x[0] === s)?.[1] ?? s

export function hookUrl(base: string | undefined, w: Pick<Webhook, "agentId" | "source">): string {
  return String(base || "").replace(/\/+$/, "") + "/webhook/" + encodeURIComponent(w.agentId) + "/" + encodeURIComponent(w.source)
}

/** A signed source with no secret refuses every call, whatever its switch says. */
export function hookState(w: Webhook): "no-secret" | "on" | "off" {
  if (w.source !== "custom" && !w.secretEnv) return "no-secret"
  return w.enabled ? "on" : "off"
}

/** A .env variable name: only a name is sent, never a secret (old Inbox rule). */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const NTFY_SERVER = "https://ntfy.sh"
export const SOUNDS = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"] as const

/** The Inbox form, flat, so a draft is a diff of plain values. */
export interface InboxForm {
  channel: string; chat: string; account: string; done: boolean; failed: boolean; queued: boolean; long: string
  banner: boolean; sound: boolean; soundName: string; volume: string; icon: string
  ntfy: boolean; server: string; topic: string; token: string
}

export function inboxForm(n: Notifications | undefined): InboxForm {
  const d = n?.destination, l = n?.local ?? {}
  return {
    channel: d?.channel ?? "", chat: d?.chatId ?? "", account: d?.accountId ?? "",
    done: n?.on.taskComplete !== false, failed: n?.on.taskError !== false, queued: !!n?.on.taskQueued,
    long: String(n?.longTaskThreshold ?? 30),
    banner: l.banner !== false, sound: l.sound !== false, soundName: l.soundName || "Glass", volume: String(l.volume ?? 0.4), icon: l.icon ?? "",
    ntfy: !!n?.ntfy.enabled, server: n?.ntfy.server || NTFY_SERVER, topic: "", token: "",
  }
}

export const NTFY_KEYS = ["ntfy", "server", "topic", "token"] as const

/** The keys changed in the draft. */
export function inboxChanged(saved: InboxForm, draft: InboxForm): (keyof InboxForm)[] {
  return (Object.keys(saved) as (keyof InboxForm)[]).filter((k) => saved[k] !== draft[k])
}

/** The POST notifications body for a draft, or why it cannot be saved.
 *  Only a real ntfy change is sent: any write to channels.* asks for a
 *  daemon restart. */
export function inboxBody(saved: InboxForm, f: InboxForm): { body: Record<string, unknown>; restart: boolean } | { error: string } {
  if (!f.channel !== !f.chat.trim()) return { error: "Give the chat id, or set Channel to None." }
  if ((f.topic && !ENV_NAME.test(f.topic)) || (f.token && !ENV_NAME.test(f.token))) return { error: "Type the .env variable name, such as NTFY_TOPIC, not the secret itself." }
  const long = Number(f.long), volume = Number(f.volume)
  if (f.long.trim() === "" || !Number.isFinite(long) || long < 0) return { error: "The long-task ping takes seconds, 0 or more." }
  if (f.volume.trim() === "" || !Number.isFinite(volume) || volume < 0 || volume > 1) return { error: "Volume goes from 0 to 1." }
  const body: Record<string, unknown> = {
    on: { taskComplete: f.done, taskError: f.failed, taskQueued: f.queued },
    longTaskThreshold: long,
    local: { banner: f.banner, sound: f.sound, soundName: f.soundName || "Glass", volume, icon: f.icon.trim() },
  }
  const chat = f.chat.trim(), account = f.account.trim()
  if (f.channel !== saved.channel || chat !== saved.chat || account !== saved.account) {
    body.destination = f.channel ? { channel: f.channel, chatId: chat, ...(account ? { accountId: account } : {}) } : null
  }
  const ntfy: Record<string, unknown> = {}
  if (f.ntfy !== saved.ntfy) ntfy.enabled = f.ntfy
  if ((f.server.trim() || NTFY_SERVER) !== saved.server) ntfy.server = f.server.trim() || NTFY_SERVER
  if (f.topic) ntfy.topic = "${" + f.topic + "}"
  if (f.token) ntfy.token = "${" + f.token + "}"
  if (Object.keys(ntfy).length) body.ntfy = ntfy
  return { body, restart: !!body.ntfy }
}
