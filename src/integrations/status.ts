import type { Integration } from "@/daemon/config"
import { readStoredGrant, recordedScopes, resolveClient, type TokenDeps } from "./resolve"
import type { ProviderSpec } from "./providers/types"

// --- Connection status of a provider-backed integration ---
//
// What doctor, `agentx agent integrations status` and the dashboard show:
// connected or not, where the token is kept, when it expires, and scopes
// the provider spec needs that the sign-in did not grant. Never the token.

export interface IntegrationStatus {
  connected: boolean
  /** keyring | refresh-env | token-env; absent when not connected. */
  store?: string
  /** Epoch ms the stored access token expires; absent when it refreshes or never expires. */
  expiresAt?: number
  /** True when an expired access token can be refreshed without the owner. */
  refreshes: boolean
  connectedAt?: number
  missingScopes: string[]
  /** Short, token-free sentences: what is wrong and how to fix it. */
  problems: string[]
}

export function integrationStatus(agentId: string, i: Integration, spec: ProviderSpec, deps: TokenDeps & { now?: () => number } = {}): IntegrationStatus {
  const now = (deps.now ?? Date.now)()
  const problems: string[] = []
  const client = resolveClient(i, deps.env ?? process.env)
  if (!client.ok) problems.push(client.reason)

  const stored = readStoredGrant(agentId, i, deps)
  if (!stored.ok) {
    problems.push(stored.reason)
    return { connected: false, refreshes: false, missingScopes: [], problems }
  }
  const g = stored.grant
  const refreshes = !!g.refreshToken && spec.oauth.refresh !== "none"
  const expiresAt = refreshes ? undefined : g.expiresAt
  if (expiresAt && expiresAt <= now) problems.push(`the token expired on ${new Date(expiresAt).toISOString().slice(0, 10)}: connect again`)
  else if (expiresAt && expiresAt - now < 7 * 86_400_000) problems.push(`the token expires on ${new Date(expiresAt).toISOString().slice(0, 10)}: connect again before then`)

  const granted = new Set(g.scopes.length ? g.scopes : recordedScopes(i))
  // Opt-in scopes (oauth.optionalScopes) are not "missing" when absent.
  const missingScopes = granted.size ? spec.oauth.scopes.filter((s) => !granted.has(s)) : []
  if (missingScopes.length) problems.push(`not granted: ${missingScopes.join(", ")}. Connect again and allow them`)

  return {
    connected: !expiresAt || expiresAt > now,
    store: stored.source,
    expiresAt,
    refreshes,
    connectedAt: g.connectedAt || undefined,
    missingScopes,
    problems,
  }
}
