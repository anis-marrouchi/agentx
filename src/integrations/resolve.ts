// --- Per-agent integration credential resolver ---
//
// Given an agent's `integrations[]` registration in agentx.json, resolve the
// concrete credential (env-var lookup, keyring read, etc.) at use-time.
// Skills, channel adapters, and the action layer call into this instead of
// hard-coding env-var names.
//
// Secrets never live in the config; only references do. This module is the
// single chokepoint where references become values, so audit / redact /
// rotate logic can land here later without touching call sites.

import type { DaemonConfig } from "@/daemon/config"
import type { Integration } from "@/daemon/config"
import type { KeyringStore } from "./keyring"
import { integrationAccount, systemKeyring } from "./keyring"
import { refreshGrant } from "./oauth"
import { setDotenvKey } from "@/utils/dotenv"
import { resolve } from "path"
import type { OAuthGrant, ProviderSpec } from "./providers/types"

export type ResolvedStatus = "ok" | "env-unset" | "no-credential" | "kind-not-found" | "agent-not-found"

export interface ResolvedCredential {
  status: ResolvedStatus
  value?: string
  envVar?: string
  /** Surfaced in error logs; safe to log (never the secret itself). */
  reason?: string
}

/**
 * Look up an integration on an agent by `kind` (or `kind` + `label`). When
 * multiple integrations of the same kind exist, the caller should pass a
 * label to disambiguate; otherwise the first matching enabled entry wins.
 */
export function getIntegration(
  config: DaemonConfig,
  agentId: string,
  kind: string,
  label?: string,
): { agentId: string; integration: Integration } | null {
  const agent = config.agents?.[agentId]
  if (!agent) return null
  const list = (agent as any).integrations as Integration[] | undefined
  if (!Array.isArray(list)) return null
  const match = list.find(
    (i) => i.enabled !== false && i.kind === kind && (!label || i.label === label),
  )
  return match ? { agentId, integration: match } : null
}

/**
 * List every integration of a given kind across all agents. Useful for
 * webhook-routing UI ("which agents have hubspot?") and for skill loaders.
 */
export function findIntegrationsByKind(
  config: DaemonConfig,
  kind: string,
): Array<{ agentId: string; integration: Integration }> {
  const out: Array<{ agentId: string; integration: Integration }> = []
  for (const [agentId, agent] of Object.entries(config.agents ?? {})) {
    const list = (agent as any).integrations as Integration[] | undefined
    if (!Array.isArray(list)) continue
    for (const integration of list) {
      if (integration.enabled === false) continue
      if (integration.kind === kind) out.push({ agentId, integration })
    }
  }
  return out
}

/**
 * Resolve a specific credential field on an integration. The `key` is one
 * of the optional fields on credentialsSchema (`tokenEnv`, `apiKeyEnv`,
 * `privateAppTokenEnv`, etc.) OR `auth` for keyring directive.
 *
 * Resolution rules:
 *   - `*Env` keys → look up process.env[<value>]
 *   - `auth: "keyring"` → returns `{ status: "ok", value: undefined }` —
 *     skills are responsible for the actual keyring read (uses agentId+kind
 *     as the canonical entry name).
 *   - missing field → `{ status: "no-credential" }`
 */
export function resolveCredential(
  integration: Integration,
  key: keyof Integration["credentials"],
): ResolvedCredential {
  const creds = integration.credentials ?? {}
  const ref = (creds as any)[key]
  if (!ref) {
    return { status: "no-credential", reason: `integration "${integration.label}" has no ${String(key)} configured` }
  }
  // Keyring directive — caller (the skill) does the actual read.
  if (key === "auth" && ref === "keyring") {
    return { status: "ok" }
  }
  // Env-var ref.
  if (typeof ref === "string" && /^[A-Z][A-Z0-9_]*$/.test(ref)) {
    const value = process.env[ref]
    if (!value) {
      return {
        status: "env-unset",
        envVar: ref,
        reason: `env var ${ref} is unset (declared by integration "${integration.label}")`,
      }
    }
    return { status: "ok", value, envVar: ref }
  }
  // Anything else is a literal string field (e.g. sessionDir for whatsapp).
  if (typeof ref === "string") {
    return { status: "ok", value: ref }
  }
  return { status: "no-credential", reason: `unrecognized credential ref shape for ${String(key)}` }
}

/**
 * Convenience: resolve the agent + kind in one call.
 */
export function resolveAgentCredential(
  config: DaemonConfig,
  agentId: string,
  kind: string,
  key: keyof Integration["credentials"],
  label?: string,
): ResolvedCredential {
  const found = getIntegration(config, agentId, kind, label)
  if (!found) {
    return {
      status: "kind-not-found",
      reason: `agent "${agentId}" has no integration of kind "${kind}"${label ? ` with label "${label}"` : ""}`,
    }
  }
  return resolveCredential(found.integration, key)
}

// --- OAuth access tokens for provider-backed integrations (#1696) ---
//
// Where an integration's grant lives, in order:
//   - `auth: "keyring"`: the OS keyring entry for (agent, kind, label),
//     holding the whole grant (access + refresh token, expiry, scopes).
//   - `refreshTokenEnv`: a refresh token in the environment (.env); access
//     tokens are fetched with it and kept in memory only. A rotated refresh
//     token is written back to .env (and the process env).
//   - `tokenEnv`: a static access token (no refresh).
// Access tokens are refreshed here, at use time, a minute before they
// expire. Nothing in this section returns or logs a refresh token.

export interface TokenDeps {
  keyring?: KeyringStore
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Persist a rotated refresh token for a `refreshTokenEnv` integration.
   *  Default: the .env in the folder AgentX runs in. */
  writeEnv?: (key: string, value: string) => void
}

export type StoredGrant =
  | { ok: true; source: "keyring" | "refresh-env" | "token-env"; grant: OAuthGrant }
  | { ok: false; status: "not-connected" | "env-unset"; reason: string }

export type AccessToken =
  | { status: "ok"; token: string; expiresAt?: number }
  | { status: "not-connected" | "env-unset" | "expired" | "no-client" | "refresh-failed"; reason: string }

const EARLY_MS = 60_000

/** The command that (re)connects an integration. */
export function connectCommand(agentId: string, i: Integration): string {
  return `agentx agent integrations connect ${agentId} ${i.kind}${i.label !== i.kind ? ` --label "${i.label}"` : ""}`
}

const metaNum = (i: Integration, k: string): number | undefined => {
  const v = Number(i.metadata?.[k])
  return Number.isFinite(v) && v > 0 ? v : undefined
}

/** Scopes recorded at connect time (metadata.oauthScopes, space-separated). */
export function recordedScopes(i: Integration): string[] {
  const v = i.metadata?.oauthScopes
  return typeof v === "string" ? v.split(/\s+/).filter(Boolean) : []
}

/** Read the stored grant for an integration. The result holds secrets: pass
 *  it on to the token logic only, never to a response or a log line. */
export function readStoredGrant(agentId: string, i: Integration, deps: TokenDeps = {}): StoredGrant {
  const creds = i.credentials ?? {}
  const env = deps.env ?? process.env
  const connectedAt = metaNum(i, "oauthConnectedAt") ?? 0
  if (creds.auth === "keyring") {
    const keyring = deps.keyring ?? systemKeyring()
    const raw = keyring.available() ? keyring.get(integrationAccount(agentId, i.kind, i.label)) : null
    if (!raw) return { ok: false, status: "not-connected", reason: `no token in the OS keyring for ${i.kind} "${i.label}": run ${connectCommand(agentId, i)}` }
    try {
      const grant = JSON.parse(raw) as OAuthGrant
      if (typeof grant?.accessToken !== "string") throw new Error("bad shape")
      return { ok: true, source: "keyring", grant: { ...grant, scopes: Array.isArray(grant.scopes) ? grant.scopes : [] } }
    } catch {
      return { ok: false, status: "not-connected", reason: `the keyring entry for ${i.kind} "${i.label}" is unreadable: connect again` }
    }
  }
  if (creds.refreshTokenEnv) {
    const v = env[creds.refreshTokenEnv]
    if (!v) return { ok: false, status: "env-unset", reason: `env var ${creds.refreshTokenEnv} is unset (declared by integration "${i.label}")` }
    return { ok: true, source: "refresh-env", grant: { accessToken: "", refreshToken: v, scopes: recordedScopes(i), connectedAt } }
  }
  if (creds.tokenEnv) {
    const v = env[creds.tokenEnv]
    if (!v) return { ok: false, status: "env-unset", reason: `env var ${creds.tokenEnv} is unset (declared by integration "${i.label}")` }
    return { ok: true, source: "token-env", grant: { accessToken: v, expiresAt: metaNum(i, "oauthExpiresAt"), scopes: recordedScopes(i), connectedAt } }
  }
  return { ok: false, status: "not-connected", reason: `integration "${i.label}" has no token: run ${connectCommand(agentId, i)}` }
}

/** The OAuth client of an integration (clientIdEnv / clientSecretEnv). */
export function resolveClient(i: Integration, env: NodeJS.ProcessEnv = process.env):
  { ok: true; clientId: string; clientSecret: string } | { ok: false; reason: string } {
  const c = i.credentials ?? {}
  if (!c.clientIdEnv || !c.clientSecretEnv) return { ok: false, reason: `integration "${i.label}" needs credentials.clientIdEnv and credentials.clientSecretEnv (the app's client id and secret)` }
  const clientId = env[c.clientIdEnv]
  const clientSecret = env[c.clientSecretEnv]
  if (!clientId) return { ok: false, reason: `env var ${c.clientIdEnv} is unset (the app's client id)` }
  if (!clientSecret) return { ok: false, reason: `env var ${c.clientSecretEnv} is unset (the app's client secret)` }
  return { ok: true, clientId, clientSecret }
}

const tokenCache = new Map<string, { token: string; expiresAt?: number }>()
const inflight = new Map<string, Promise<AccessToken>>()

/** Forget cached access tokens (tests, disconnect). */
export function clearTokenCache(): void { tokenCache.clear(); inflight.clear() }

/** A usable access token for a provider-backed integration, refreshed when
 *  it is about to expire. */
export async function resolveAccessToken(
  agentId: string,
  i: Integration,
  spec: ProviderSpec,
  deps: TokenDeps = {},
): Promise<AccessToken> {
  const now = (deps.now ?? Date.now)()
  // A reconnect changes oauthConnectedAt, which drops the old cache entry.
  const key = [agentId, i.kind, i.label, String(i.metadata?.oauthConnectedAt ?? "")].join("\u0000")
  const cached = tokenCache.get(key)
  if (cached && (!cached.expiresAt || cached.expiresAt - EARLY_MS > now)) return { status: "ok", ...cached }
  const running = inflight.get(key)
  if (running) return running
  const p = (async (): Promise<AccessToken> => {
    const stored = readStoredGrant(agentId, i, deps)
    if (!stored.ok) return { status: stored.status, reason: stored.reason }
    const g = stored.grant
    if (g.accessToken && (!g.expiresAt || g.expiresAt - EARLY_MS > now)) {
      tokenCache.set(key, { token: g.accessToken, expiresAt: g.expiresAt })
      return { status: "ok", token: g.accessToken, expiresAt: g.expiresAt }
    }
    if (!g.refreshToken || spec.oauth.refresh === "none") {
      return { status: "expired", reason: `the ${spec.title} token for "${i.label}" has expired: run ${connectCommand(agentId, i)}` }
    }
    const client = resolveClient(i, deps.env ?? process.env)
    if (!client.ok) return { status: "no-client", reason: client.reason }
    try {
      const next = await refreshGrant(spec, g, { fetch: deps.fetch ?? fetch, clientId: client.clientId, clientSecret: client.clientSecret, now })
      if (stored.source === "keyring") {
        const keyring = deps.keyring ?? systemKeyring()
        try { keyring.set(integrationAccount(agentId, i.kind, i.label), JSON.stringify(next)) } catch { /* the new token still works for this process */ }
      } else if (stored.source === "refresh-env" && i.credentials?.refreshTokenEnv && next.refreshToken && next.refreshToken !== g.refreshToken) {
        const envKey = i.credentials.refreshTokenEnv
        ;(deps.env ?? process.env)[envKey] = next.refreshToken
        const writeEnv = deps.writeEnv ?? ((k: string, v: string) => setDotenvKey(resolve(process.cwd(), ".env"), k, v))
        try { writeEnv(envKey, next.refreshToken) } catch { /* the new token still works until a restart */ }
      }
      tokenCache.set(key, { token: next.accessToken, expiresAt: next.expiresAt })
      return { status: "ok", token: next.accessToken, expiresAt: next.expiresAt }
    } catch (e: any) {
      return { status: "refresh-failed", reason: `${e?.message ?? e}. If it keeps failing, connect again: ${connectCommand(agentId, i)}` }
    }
  })()
  inflight.set(key, p)
  try { return await p } finally { inflight.delete(key) }
}
