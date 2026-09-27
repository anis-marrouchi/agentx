// `channels.push` as `agentx notifications push` edits it, plus a
// read-back for `agentx notifications show`. Keys never live here: they are
// in channels.push.keysFile, written by `agentx app push-keys`.

import { pushKeysPath, readPushKeys } from "@/channels/push-keys"

/** Where `agentx notify` and Focus digests go when no channel is given:
 *  notifications.channel if set, else push when it is enabled, else ntfy. */
export function defaultNotifyChannel(cfg: {
  notifications?: { channel?: string }
  channels?: { push?: { enabled?: boolean } }
} | undefined): string {
  return cfg?.notifications?.channel || (cfg?.channels?.push?.enabled ? "push" : "ntfy")
}

export interface PushBlock {
  enabled?: boolean
  subject?: string
  relayTo?: string
  keysFile?: string
  [key: string]: unknown
}

export interface PushStatus {
  enabled: boolean
  /** "host" sends to phones itself; "relay" forwards to relayTo. */
  role: "host" | "relay"
  relayTo?: string
  subjectSet: boolean
  keysSet: boolean
}

export function pushStatus(block: PushBlock | undefined, baseDir = process.cwd()): PushStatus {
  return {
    enabled: !!block?.enabled,
    role: block?.relayTo ? "relay" : "host",
    ...(block?.relayTo ? { relayTo: block.relayTo } : {}),
    subjectSet: !!block?.subject,
    keysSet: !!readPushKeys(pushKeysPath(block?.keysFile, baseDir)),
  }
}

/**
 * Apply a change to a stored `channels.push` block. An empty relayTo makes
 * this node the host again. A host can't be enabled without a subject,
 * because push services reject messages that carry no contact.
 */
export function patchPush(current: PushBlock | undefined, patch: Record<string, unknown>): PushBlock {
  const next: PushBlock = { ...(current ?? {}) }
  if ("enabled" in patch) next.enabled = Boolean(patch.enabled)
  if ("subject" in patch) {
    const subject = String(patch.subject).trim()
    if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) throw new Error("push subject must be mailto:you@example.com or an https:// URL")
    next.subject = subject
  }
  if ("relayTo" in patch) {
    const relayTo = String(patch.relayTo ?? "").trim()
    if (relayTo) next.relayTo = relayTo
    else delete next.relayTo
  }
  if (next.enabled && !next.relayTo && !next.subject) throw new Error("set --subject (or --relay-to) before enabling push")
  return next
}
