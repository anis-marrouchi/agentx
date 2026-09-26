// `channels.ntfy` as the CLI and the dashboard edit it: one write rule for
// both, and a read-back that never echoes the topic or token. On the
// public ntfy.sh the topic IS the credential, so the dashboard learns only
// whether one is set.

export interface NtfyBlock {
  enabled?: boolean
  server?: string
  topic?: string
  token?: string
  [key: string]: unknown
}

export interface NtfyStatus {
  enabled: boolean
  server: string
  topicSet: boolean
  tokenSet: boolean
}

const DEFAULT_SERVER = "https://ntfy.sh"

export function ntfyStatus(block: NtfyBlock | undefined): NtfyStatus {
  return {
    enabled: !!block?.enabled,
    server: block?.server || DEFAULT_SERVER,
    topicSet: !!block?.topic,
    tokenSet: !!block?.token,
  }
}

/**
 * Apply a change to a stored `channels.ntfy` block. A topic or token may
 * be a `${VAR}` placeholder, which the daemon expands from the
 * environment. An empty token removes it; an empty topic is refused,
 * because the channel cannot deliver without one.
 */
export function patchNtfy(current: NtfyBlock | undefined, patch: Record<string, unknown>): NtfyBlock {
  const next: NtfyBlock = { ...(current ?? {}) }
  if ("enabled" in patch) next.enabled = Boolean(patch.enabled)
  if ("server" in patch) {
    const server = String(patch.server).trim().replace(/\/+$/, "")
    if (!/^https?:\/\/\S+$/.test(server)) throw new Error("ntfy server must be an http(s) URL")
    next.server = server
  }
  if ("topic" in patch) {
    const topic = String(patch.topic).trim()
    if (!topic) throw new Error("ntfy topic cannot be empty")
    next.topic = topic
  }
  if ("token" in patch) {
    const token = String(patch.token ?? "").trim()
    if (token) next.token = token
    else delete next.token
  }
  if (next.enabled && !next.topic) throw new Error("set a topic before enabling ntfy")
  return next
}
