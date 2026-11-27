// --- Settings › Channels and WhatsApp: what they read (#2101 ST3a) ---
//
// The channel parts of GET /api/admin/state. A secret comes as a `${NAME}`
// reference or `{ literal: true }` (admin-panel.ts secretRef), never as a
// value; secretName() shows the name only, and treats anything else, even
// a value an older daemon sent, as "Secret in file" (#2420, #2427). Plain
// data: no React, so the test reads it without a browser.
import type { AdminState } from "./data"
import type { Webhook } from "./work-data"

/** What a channel change says after it saves. */
export const RESTART = "Restart the daemon to apply: agentx daemon restart --when-idle"

export type SecretRef = string | { literal: true } | null | undefined
export interface TgAccount { id: string; botUsername?: string; agentBinding?: string; botTokenRef?: SecretRef }
export interface Mailbox { id: string; agent?: string; address?: string; imap?: string; smtp?: string; passwordRef?: SecretRef; allowFrom?: string[]; send?: string }
export interface WatchRule { id: string; agent: string; enabled?: boolean; chats?: string[]; senders?: string[]; quietHours?: { start: string; end: string }; prompt?: string }
export interface ChannelsState extends AdminState {
  telegram?: { enabled?: boolean; accounts?: TgAccount[] }
  email?: { enabled?: boolean; accounts?: Mailbox[] }
  slack?: { enabled?: boolean; botTokenRef?: SecretRef; appTokenRef?: SecretRef; agentBinding?: string }
  discord?: { enabled?: boolean; tokenRef?: SecretRef; agentBinding?: string }
  gitlab?: { enabled?: boolean; host?: string; webhookPort?: number; tokenRef?: SecretRef; routeCount?: number; agentMappingCount?: number }
  whatsapp?: { enabled?: boolean; sessionDir?: string; routeCount?: number }
  whatsappTriage?: { enabled?: boolean; secretEnv?: string; secretSet?: boolean; rules?: WatchRule[]; error?: string }
  webhooks?: Webhook[]
  daemonUrl?: string
}

/** A secret field: the .env variable's name, whether one is set, and
 *  whether the file holds the secret itself. Never the value. */
export function secretName(ref: SecretRef): { name: string; set: boolean; literal: boolean } {
  const m = typeof ref === "string" ? /^\$\{(\w+)\}$/.exec(ref) : null
  const set = !!ref && ref !== ""
  return { name: m ? m[1] : "", set, literal: set && !m }
}

export const CHANNEL_TABS = [
  ["telegram", "Telegram", "send"], ["email", "Email", "mail"], ["slack", "Slack", "hash"], ["discord", "Discord", "message-square"],
  ["gitlab", "GitLab", "git-merge"], ["github", "GitHub", "git-pull-request"], ["calls", "Calls", "phone"],
] as const
export type ChannelTab = (typeof CHANNEL_TABS)[number][0]

/** Which tabs show the "on" dot. */
export function channelsOn(s: ChannelsState | undefined): Set<ChannelTab> {
  const on = new Set<ChannelTab>()
  for (const k of ["telegram", "email", "slack", "discord", "gitlab"] as const) if (s?.[k]?.enabled) on.add(k)
  if (s?.webhooks?.some((w) => w.source === "github" && w.enabled !== false)) on.add("github")
  return on
}

/** 45 s, 6 min 05 s. */
export function callLength(s = 0): string {
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`
}

/** What a sweep says it did, in one line. */
export function sweepLine(dry: boolean, x: {
  scannedContacts?: number; scannedGroups?: number; dryRunEntries?: unknown[]; skippedUnchanged?: number; errors?: unknown[]
  wroteContacts?: number; wroteGroups?: number; wroteDmWindows?: number; wroteGroupWindows?: number
}): string {
  const wrote = (x.wroteContacts ?? 0) + (x.wroteGroups ?? 0) + (x.wroteDmWindows ?? 0) + (x.wroteGroupWindows ?? 0)
  return (dry ? "Dry run: " : "Done: ") + `${x.scannedContacts ?? 0} contacts and ${x.scannedGroups ?? 0} groups read, ` +
    (dry ? `${(x.dryRunEntries ?? []).length} entries would be written` : `${wrote} entries written`) + `, ${x.skippedUnchanged ?? 0} unchanged` +
    (x.errors?.length ? `, ${x.errors.length} failed` : "") + "."
}
