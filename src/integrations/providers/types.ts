// --- Provider spec: what AgentX needs to know about one outside API ---
//
// One file per API under src/integrations/providers/<kind>.ts. A spec is
// declarative: where to send the owner to sign in, which scopes to ask
// for, where the API lives, and a short list of named reads with the
// parameters (and parameter values) an agent may pass. Agents never build
// URLs themselves: they pick a read by name and the layer builds a GET.
//
// Adding an API = adding one spec file, registering it in ./index.ts, and
// tests. No change to the connect flow, token refresh, the agent tool,
// doctor or the dashboard.

export interface OAuthGrant {
  accessToken: string
  /** Absent for providers that do not issue one (Meta long-lived tokens). */
  refreshToken?: string
  /** Epoch ms when accessToken stops working; absent when it does not expire. */
  expiresAt?: number
  /** Scopes the provider says it granted (falls back to the scopes asked for). */
  scopes: string[]
  /** Epoch ms of the sign-in that produced this grant. */
  connectedAt: number
}

export interface ProviderContext {
  fetch: typeof fetch
  clientId: string
  clientSecret: string
  now: number
  /** Shows a non-fatal problem to the owner during connect (the CLI prints it). */
  warn?: (message: string) => void
}

export interface OAuthSpec {
  /** Where the owner's browser is sent to sign in and approve. */
  authorizeUrl: string
  /** Where codes and refresh tokens are exchanged for access tokens. */
  tokenUrl: string
  /** Scopes always requested. Read-only scopes only. */
  scopes: string[]
  /** Scopes requested only when the owner opts in (e.g. revenue). Keyed by a
   *  short name passed to `connect --with <name>`. */
  optionalScopes?: Record<string, string[]>
  /** How scopes are joined in the authorize URL. Default " ". */
  scopeSeparator?: string
  /** Send a PKCE challenge. Default true. */
  pkce?: boolean
  /** Extra query parameters for the authorize URL (e.g. Google's
   *  access_type=offline&prompt=consent so a refresh token comes back). */
  authorizeParams?: Record<string, string>
  /** Whether access tokens are refreshed with a refresh token. Default true.
   *  "none": the grant lasts until it expires and the owner reconnects. */
  refresh?: "refresh_token" | "none"
  /** Runs once after the code exchange: e.g. swap a short-lived Meta token
   *  for a long-lived one. Returns the grant to store. */
  afterConnect?: (grant: OAuthGrant, ctx: ProviderContext) => Promise<OAuthGrant>
}

export interface ParamSpec {
  description: string
  required?: boolean
  /** Allowed values. With `list`, each comma-separated item must be one. */
  enum?: readonly string[]
  /** The value is a comma-separated list (e.g. metric=a,b,c). */
  list?: boolean
  /** Format check for free values (ids, dates). Anchored by the caller. */
  pattern?: RegExp
  /** Used when the agent passes nothing. */
  default?: string
  /** Read the value from the integration's metadata key of the same name
   *  when the agent passes nothing (e.g. a page id set at connect time). */
  fromMetadata?: boolean
}

export interface ReadSpec {
  description: string
  /** Path under baseUrl. `{name}` is filled from the param of that name,
   *  which must be declared in `params` and is not sent as a query value. */
  path: string
  params: Record<string, ParamSpec>
  /** Fixed query values, not settable by the agent. */
  fixedQuery?: Record<string, string>
  /** Scopes this read needs; doctor flags reads whose scopes were not granted. */
  scopes?: string[]
}

export interface ProviderSpec {
  /** Matches `agents.<id>.integrations[].kind`. */
  kind: string
  /** Readable name for CLI and dashboard. */
  title: string
  oauth: OAuthSpec
  /** API root, no trailing slash. */
  baseUrl: string
  /** How the access token is sent. Default "header" (Authorization: Bearer). */
  tokenIn?: "header" | "query"
  /** Query parameter name when tokenIn is "query". Default "access_token". */
  tokenParam?: string
  reads: Record<string, ReadSpec>
  /** Swap the integration's token for the one a read needs, after the
   *  read's values were checked (e.g. Meta Page insights need a Page token
   *  derived from the user token). Returns the token to send; it is cut
   *  from answers like the integration's own. Throw with a token-free
   *  message when no such token can be had. */
  readToken?: (req: ReadTokenRequest) => Promise<string>
}

export interface ReadTokenRequest {
  read: string
  /** The read's checked values (path and query), after defaults and metadata. */
  values: Readonly<Record<string, string>>
  /** The integration's own access token. */
  token: string
  fetch: typeof fetch
  now: number
}
