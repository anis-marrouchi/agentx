import type { Integration } from "@/daemon/config"
import { buildAuthorizeRequest, exchangeCode, scopesFor, type CallbackResult } from "./oauth"
import { integrationAccount, type KeyringStore } from "./keyring"
import type { OAuthGrant, ProviderSpec } from "./providers/types"

// --- `agentx agent integrations connect`: sign in once, store the grant ---
//
// The CLI wires this to a browser, a loopback callback (or a pasted
// address) and agentx.json. Kept apart so the whole flow runs in tests
// against a fake provider.

export interface ConnectInput {
  agentId: string
  spec: ProviderSpec
  integration: Integration
  clientId: string
  clientSecret: string
  redirectUri: string
  /** Names from spec.oauth.optionalScopes (e.g. "revenue"). */
  extras?: string[]
  /** Shows the sign-in address and resolves with what the redirect carried. */
  getCallback: (authorizeUrl: string, state: string) => Promise<CallbackResult>
  fetch?: typeof fetch
  now?: () => number
}

export async function signIn(input: ConnectInput): Promise<OAuthGrant> {
  const { scopes, unknown } = scopesFor(input.spec.oauth, input.extras)
  if (unknown.length) {
    const known = Object.keys(input.spec.oauth.optionalScopes ?? {})
    throw new Error(`unknown --with ${unknown.join(", ")}. ${known.length ? `Available: ${known.join(", ")}` : `${input.spec.title} has no optional scopes`}`)
  }
  const req = buildAuthorizeRequest(input.spec, input.clientId, input.redirectUri, scopes)
  const cb = await input.getCallback(req.url, req.state)
  if ("error" in cb) throw new Error(cb.error)
  return exchangeCode(input.spec, req, cb.code, {
    fetch: input.fetch ?? fetch,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    now: (input.now ?? Date.now)(),
  })
}

export type StoreMode = "keyring" | "env"

export interface StoreDeps {
  keyring: KeyringStore
  /** Writes KEY=value to .env, replacing an older value. */
  writeEnv: (key: string, value: string) => void
}

/** The env var a connect writes to, e.g. YOUTUBE_HELPER_REFRESH_TOKEN. */
export function tokenEnvName(agentId: string, kind: string, refresh: boolean): string {
  const up = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()
  return `${up(kind)}_${up(agentId)}_${refresh ? "REFRESH_TOKEN" : "ACCESS_TOKEN"}`
}

/** Store the grant and return the integration as it should be saved:
 *  where the token lives (credentials) and non-secret facts about it
 *  (metadata: scopes, connect time, expiry when it cannot refresh). */
export function storeGrant(agentId: string, i: Integration, grant: OAuthGrant, mode: StoreMode, deps: StoreDeps): { integration: Integration; where: string } {
  const credentials = { ...(i.credentials ?? {}) }
  const metadata: Record<string, string | number | boolean> = { ...(i.metadata ?? {}) }
  delete metadata.oauthExpiresAt
  let where: string
  if (mode === "keyring") {
    deps.keyring.set(integrationAccount(agentId, i.kind, i.label), JSON.stringify(grant))
    credentials.auth = "keyring"
    where = "the OS keyring"
  } else {
    delete credentials.auth
    if (grant.refreshToken) {
      const name = credentials.refreshTokenEnv ?? tokenEnvName(agentId, i.kind, true)
      deps.writeEnv(name, grant.refreshToken)
      credentials.refreshTokenEnv = name
      where = `.env as ${name}`
    } else {
      const name = credentials.tokenEnv ?? tokenEnvName(agentId, i.kind, false)
      deps.writeEnv(name, grant.accessToken)
      credentials.tokenEnv = name
      if (grant.expiresAt) metadata.oauthExpiresAt = grant.expiresAt
      where = `.env as ${name}`
    }
  }
  metadata.oauthScopes = grant.scopes.join(" ")
  metadata.oauthConnectedAt = grant.connectedAt
  return { integration: { ...i, credentials, metadata }, where }
}

/** Remove the stored grant: the keyring entry, the env references (the
 *  .env values themselves are left for the owner to delete) and the facts
 *  about it. The integration entry and its client stay. */
export function forgetGrant(agentId: string, i: Integration, keyring: KeyringStore):
  { integration: Integration; removedFromKeyring: boolean; envLeft: string[] } {
  const removedFromKeyring = i.credentials?.auth === "keyring" ? keyring.delete(integrationAccount(agentId, i.kind, i.label)) : false
  const credentials = { ...(i.credentials ?? {}) }
  const envLeft = [credentials.refreshTokenEnv, credentials.tokenEnv].filter((v): v is string => !!v)
  delete credentials.auth
  delete credentials.refreshTokenEnv
  delete credentials.tokenEnv
  const metadata = { ...(i.metadata ?? {}) }
  delete metadata.oauthScopes
  delete metadata.oauthConnectedAt
  delete metadata.oauthExpiresAt
  return { integration: { ...i, credentials, metadata }, removedFromKeyring, envLeft }
}
