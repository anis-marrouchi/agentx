// --- Settings: what the General pane reads, and the pure sums on it (#2101 ST1) ---
//
// The same endpoints the old Settings reads (wall-settings.client.ts), so
// nothing new on the server: /api/admin/state (agentx.json, secrets as
// refs), /api/admin/org (titles, paused and waiting), /api/live?quick=1
// (the machines) and /api/admin/tokens. Writes go to the same
// /api/admin/wall/settings/* paths, which keep the owner guard.

export interface StateAgent { id: string; name?: string; tier?: string; model?: string; access?: string }
export interface AdminState {
  exists?: boolean
  agents?: StateAgent[]
  wikiCurator?: { enabled?: boolean; agent?: string }
  [channel: string]: unknown
}
export interface OrgNode { id: string; title?: string; status?: string; reports?: OrgNode[] }
export interface OrgReply { exists?: boolean; roots?: OrgNode[]; outside?: OrgNode[] }
export interface LiveNode {
  name: string
  reachable?: boolean
  error?: string
  checking?: boolean
  version?: string
  stale?: boolean
  staleSince?: string
  restart?: { state?: string }
  agents?: { id?: string; name?: string }[]
  self?: boolean
}
export interface LiveReply { nodes?: LiveNode[] }
export interface TokenRow { revokedAt?: string | null; expiresAt?: string | null }

export const ENGINE_NAMES: Record<string, string> = {
  "claude-code": "Claude Code", "codex-cli": "Codex", opencode: "OpenCode", sdk: "Anthropic API (SDK)", orchestrator: "Orchestrator", "gemini-cli": "Gemini CLI",
}
/** The engines Add agent offers, as the old Settings does. */
export const ENGINE_CHOICES = ["claude-code", "codex-cli", "opencode", "sdk", "orchestrator"] as const

export function engineName(tier?: string): string {
  return ENGINE_NAMES[tier || "claude-code"] ?? tier ?? "Claude Code"
}

/** An agent's place in the org view: its title, and paused or waiting. */
export function orgNode(org: OrgReply | null | undefined, id: string): OrgNode | undefined {
  let found: OrgNode | undefined
  const walk = (list?: OrgNode[]) => list?.forEach((n) => { if (n.id === id) found = n; walk(n.reports) })
  walk(org?.roots); walk(org?.outside)
  return found
}

export const nodeChecking = (n: LiveNode) => !!n.checking
export const nodeDown = (n: LiveNode) => (!n.reachable || !!n.error) && !n.checking
export const restartWaiting = (n: LiveNode) => !nodeDown(n) && !!n.restart?.state && n.restart.state !== "none"

export interface Fix { key: string; tone: "err" | "warn"; text: string; help: string; action: string; href: string }

/** What needs the owner: a machine that does not answer, a restart that
 *  waits, an agent that waits for approval. Each with where to fix it. */
export function needsYou(live: LiveReply | null | undefined, agents: StateAgent[], org: OrgReply | null | undefined): Fix[] {
  const out: Fix[] = []
  for (const n of live?.nodes ?? []) {
    const who = (n.agents ?? []).map((a) => a.id || a.name).filter(Boolean).join(", ")
    if (nodeDown(n)) out.push({ key: "down-" + n.name, tone: "err", text: `${n.name} does not answer`, help: [n.error, who && `${who} run there`].filter(Boolean).join(" · ") || "Open Live to see why.", action: "Open Live", href: "#page=live" })
    else if (restartWaiting(n)) out.push({ key: "restart-" + n.name, tone: "warn", text: `${n.name} waits for a restart`, help: "Restart it on Live when its work is done.", action: "Open Live", href: "#page=live" })
  }
  for (const a of agents) {
    if (orgNode(org, a.id)?.status === "waiting") out.push({ key: "wait-" + a.id, tone: "warn", text: `${a.id} waits for your approval`, help: "It starts its first run once you approve it.", action: "Review", href: "#status=open&view=decide" })
  }
  return out
}

const CHANNELS = ["telegram", "whatsapp", "slack", "discord", "email", "gitlab"] as const
const CHANNEL_NAMES: Record<string, string> = { telegram: "Telegram", whatsapp: "WhatsApp", slack: "Slack", discord: "Discord", email: "Email", gitlab: "GitLab" }

/** Channels set up in agentx.json, and which of them are on. */
export function channelSummary(state: AdminState | null | undefined): { set: string[]; on: string[] } {
  const set = CHANNELS.filter((k) => {
    const c = state?.[k] as { enabled?: boolean; accounts?: unknown[]; tokenRef?: unknown; botTokenRef?: unknown; host?: unknown } | undefined
    return !!c && (!!c.enabled || !!c.accounts?.length || !!c.tokenRef || !!c.botTokenRef || !!c.host)
  })
  const on = set.filter((k) => (state?.[k] as { enabled?: boolean }).enabled)
  return { set: set.map((k) => CHANNEL_NAMES[k]), on: on.map((k) => CHANNEL_NAMES[k]) }
}

export function activeTokens(tokens: TokenRow[] | null | undefined, now = Date.now()): number | null {
  if (!Array.isArray(tokens)) return null
  return tokens.filter((t) => !t.revokedAt && !(t.expiresAt && Date.parse(t.expiresAt) < now)).length
}

/** Two letters for an agent's avatar. */
export function initials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean)
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase()
  return (words[0] || "?").slice(0, 2).toUpperCase()
}

/** Agent ids the daemon takes (the old Add agent form's rule). */
export const AGENT_ID = /^[a-z0-9_-]+$/
