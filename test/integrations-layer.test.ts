import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { DaemonConfig, Integration } from "../src/daemon/config"
import type { ProviderSpec } from "../src/integrations/providers/types"
import { buildAuthorizeRequest, parseCallback, safeProviderText, scopesFor, waitForLoopbackCallback } from "../src/integrations/oauth"
import { integrationAccount, memoryKeyring, systemKeyring } from "../src/integrations/keyring"
import { clearTokenCache, readStoredGrant, resolveAccessToken } from "../src/integrations/resolve"
import { allowedReads, buildReadUrl, MAX_BODY, readCatalog, runIntegrationRead } from "../src/integrations/read"
import { forgetGrant, signIn, storeGrant, tokenEnvName } from "../src/integrations/connect"
import { integrationStatus } from "../src/integrations/status"
import { handleIntegrationsApi } from "../src/integrations/daemon-api"
import { runIntegrationTool } from "../src/integrations/tool"
import { BUILTIN_PROVIDERS } from "../src/integrations/providers"
import { setDotenvKey } from "../src/utils/dotenv"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import { AGENTX_TOOL_NAMES, READ_TOOL_NAMES } from "../src/mcp/tool-names"
import { evaluateAutonomy } from "../src/guard/autonomy"

// A provider that exists only here: the layer must work with no real account.
const FAKE: ProviderSpec = {
  kind: "fake",
  title: "Fake Analytics",
  baseUrl: "https://api.fake.test/v1",
  oauth: {
    authorizeUrl: "https://auth.fake.test/authorize",
    tokenUrl: "https://auth.fake.test/token",
    scopes: ["stats.read", "profile.read"],
    optionalScopes: { revenue: ["money.read"] },
    authorizeParams: { access_type: "offline" },
  },
  reads: {
    account_report: {
      description: "Account totals for a period.",
      path: "/accounts/{accountId}/report",
      params: {
        accountId: { description: "Account id", required: true, fromMetadata: true, pattern: /[0-9]+/ },
        metric: { description: "Metrics", required: true, list: true, enum: ["views", "reach", "likes"] },
        since: { description: "Start date", pattern: /\d{4}-\d{2}-\d{2}/ },
        period: { description: "Granularity", enum: ["day", "week"], default: "day" },
      },
      fixedQuery: { format: "json" },
    },
    profile: { description: "The profile.", path: "/me", params: {} },
  },
}
const PROVIDERS = { fake: FAKE }
const NOW = 1_800_000_000_000

const integ = (over: Partial<Integration> = {}): Integration => ({
  kind: "fake",
  label: "Main",
  credentials: { clientIdEnv: "FAKE_CLIENT_ID", clientSecretEnv: "FAKE_CLIENT_SECRET", auth: "keyring" },
  metadata: { accountId: "42" },
  enabled: true,
  ...over,
})
const cfgWith = (i: Integration): DaemonConfig => ({ agents: { helper: { integrations: [i] } } } as unknown as DaemonConfig)
const ENV = { FAKE_CLIENT_ID: "cid", FAKE_CLIENT_SECRET: "csecret" }

type Call = { url: string; init?: RequestInit }
function fakeFetch(handler: (url: URL, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Call[] = []
  const f = (async (input: any, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const r = handler(new URL(String(input)), init)
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body)
    return new Response(text, { status: r.status ?? 200, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  return { f, calls }
}

beforeEach(() => clearTokenCache())

describe("oauth", () => {
  it("builds an authorize URL with state, PKCE, scopes and extra params", () => {
    const req = buildAuthorizeRequest(FAKE, "cid", "http://localhost:19876/callback")
    const u = new URL(req.url)
    expect(u.origin + u.pathname).toBe("https://auth.fake.test/authorize")
    expect(u.searchParams.get("client_id")).toBe("cid")
    expect(u.searchParams.get("scope")).toBe("stats.read profile.read")
    expect(u.searchParams.get("state")).toBe(req.state)
    expect(u.searchParams.get("code_challenge_method")).toBe("S256")
    expect(u.searchParams.get("access_type")).toBe("offline")
    expect(req.verifier).toBeTruthy()
  })

  it("adds opt-in scopes and reports unknown ones", () => {
    expect(scopesFor(FAKE.oauth, ["revenue"]).scopes).toContain("money.read")
    expect(scopesFor(FAKE.oauth, ["nope"]).unknown).toEqual(["nope"])
  })

  it("checks the callback state and reports provider errors", () => {
    expect(parseCallback("http://localhost/callback?code=abc&state=s1", "s1")).toEqual({ code: "abc" })
    expect(parseCallback("http://localhost/callback?code=abc&state=other", "s1")).toHaveProperty("error")
    expect(parseCallback("http://localhost/callback?error=access_denied&state=s1", "s1")).toEqual({ error: "the provider said access_denied" })
  })

  it("takes the sign-in answer on loopback and shows a page", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const wait = waitForLoopbackCallback(port, "s1", 5000)
    await wait.ready
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=xyz&state=s1`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("AgentX is connected")
    expect(await wait.result).toEqual({ code: "xyz" })
  })

  it("keeps waiting when a callback carries another state", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const wait = waitForLoopbackCallback(port, "s1", 5000)
    await wait.ready
    expect((await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=forged`)).status).toBe(400)
    expect((await fetch(`http://127.0.0.1:${port}/callback?code=xyz&state=s1`)).status).toBe(200)
    expect(await wait.result).toEqual({ code: "xyz" })
  })

  it("cuts token-shaped text out of provider errors", () => {
    expect(safeProviderText("bad refresh_token=abc.def")).toBe("bad refresh_token=[redacted]")
    expect(safeProviderText("x " + "A".repeat(50))).toBe("x [redacted]")
  })
})

describe("connect", () => {
  it("signs in, exchanges the code with the verifier and stores the grant in the keyring", async () => {
    const { f, calls } = fakeFetch(() => ({ body: { access_token: "AT1", refresh_token: "RT1", expires_in: 3600, scope: "stats.read profile.read" } }))
    const grant = await signIn({
      agentId: "helper", spec: FAKE, integration: integ(), clientId: "cid", clientSecret: "csecret",
      redirectUri: "http://localhost:19876/callback", fetch: f, now: () => NOW,
      getCallback: async (url, state) => {
        expect(new URL(url).searchParams.get("state")).toBe(state)
        return { code: "the-code" }
      },
    })
    expect(grant).toMatchObject({ accessToken: "AT1", refreshToken: "RT1", expiresAt: NOW + 3_600_000, scopes: ["stats.read", "profile.read"], connectedAt: NOW })
    const form = new URLSearchParams(String(calls[0].init?.body))
    expect(form.get("grant_type")).toBe("authorization_code")
    expect(form.get("code")).toBe("the-code")
    expect(form.get("code_verifier")).toBeTruthy()

    const keyring = memoryKeyring()
    const saved = storeGrant("helper", integ({ credentials: { clientIdEnv: "FAKE_CLIENT_ID", clientSecretEnv: "FAKE_CLIENT_SECRET" } }), grant, "keyring", { keyring, writeEnv: () => { throw new Error("no env") } })
    expect(saved.integration.credentials.auth).toBe("keyring")
    expect(saved.integration.metadata).toMatchObject({ oauthScopes: "stats.read profile.read", oauthConnectedAt: NOW })
    expect(JSON.stringify(saved.integration)).not.toContain("RT1")
    expect(JSON.parse(keyring.get(integrationAccount("helper", "fake", "Main"))!).refreshToken).toBe("RT1")
  })

  it("fails on an unknown --with name and on a denied sign-in", async () => {
    const base = { agentId: "helper", spec: FAKE, integration: integ(), clientId: "c", clientSecret: "s", redirectUri: "http://localhost/callback" }
    await expect(signIn({ ...base, extras: ["nope"], getCallback: async () => ({ code: "x" }) })).rejects.toThrow(/unknown --with nope/)
    await expect(signIn({ ...base, getCallback: async () => ({ error: "the provider said access_denied" }) })).rejects.toThrow(/access_denied/)
  })

  it("stores in .env: a refresh token, or an access token with its expiry", () => {
    const written: Record<string, string> = {}
    const deps = { keyring: memoryKeyring(), writeEnv: (k: string, v: string) => { written[k] = v } }
    const base = integ({ credentials: { clientIdEnv: "A", clientSecretEnv: "B" } })
    const r1 = storeGrant("helper", base, { accessToken: "AT", refreshToken: "RT", scopes: [], connectedAt: NOW }, "env", deps)
    expect(r1.integration.credentials.refreshTokenEnv).toBe("FAKE_HELPER_REFRESH_TOKEN")
    expect(written.FAKE_HELPER_REFRESH_TOKEN).toBe("RT")
    const r2 = storeGrant("helper", base, { accessToken: "AT", expiresAt: NOW + 1000, scopes: [], connectedAt: NOW }, "env", deps)
    expect(r2.integration.credentials.tokenEnv).toBe("FAKE_HELPER_ACCESS_TOKEN")
    expect(r2.integration.metadata.oauthExpiresAt).toBe(NOW + 1000)
    expect(tokenEnvName("my-agent", "meta.page", true)).toBe("META_PAGE_MY_AGENT_REFRESH_TOKEN")
  })

  it("disconnect forgets the keyring entry and the env references", () => {
    const keyring = memoryKeyring({ [integrationAccount("helper", "fake", "Main")]: "{}" })
    const r = forgetGrant("helper", integ({ metadata: { accountId: "42", oauthScopes: "x", oauthConnectedAt: NOW } }), keyring)
    expect(r.removedFromKeyring).toBe(true)
    expect(keyring.entries.size).toBe(0)
    expect(r.integration.credentials.auth).toBeUndefined()
    expect(r.integration.metadata).toEqual({ accountId: "42" })
    const r2 = forgetGrant("helper", integ({ credentials: { refreshTokenEnv: "X_RT" } }), keyring)
    expect(r2.envLeft).toEqual(["X_RT"])
    expect(r2.integration.credentials.refreshTokenEnv).toBeUndefined()
  })
})

describe("token resolution", () => {
  const account = integrationAccount("helper", "fake", "Main")

  it("uses a stored access token until a minute before it expires", async () => {
    const keyring = memoryKeyring({ [account]: JSON.stringify({ accessToken: "AT", refreshToken: "RT", expiresAt: NOW + 600_000, scopes: [], connectedAt: NOW }) })
    const { f, calls } = fakeFetch(() => ({ body: {} }))
    const r = await resolveAccessToken("helper", integ(), FAKE, { keyring, fetch: f, env: ENV, now: () => NOW })
    expect(r).toEqual({ status: "ok", token: "AT", expiresAt: NOW + 600_000 })
    expect(calls).toHaveLength(0)
  })

  it("refreshes an expired token, keeps the refresh token and writes the grant back", async () => {
    const keyring = memoryKeyring({ [account]: JSON.stringify({ accessToken: "OLD", refreshToken: "RT", expiresAt: NOW + 30_000, scopes: ["stats.read"], connectedAt: 1 }) })
    const { f, calls } = fakeFetch(() => ({ body: { access_token: "NEW", expires_in: 3600 } }))
    const deps = { keyring, fetch: f, env: ENV, now: () => NOW }
    const [a, b] = await Promise.all([resolveAccessToken("helper", integ(), FAKE, deps), resolveAccessToken("helper", integ(), FAKE, deps)])
    expect(a).toMatchObject({ status: "ok", token: "NEW" })
    expect(b).toMatchObject({ status: "ok", token: "NEW" })
    expect(calls).toHaveLength(1) // concurrent callers share one refresh
    const form = new URLSearchParams(String(calls[0].init?.body))
    expect(form.get("grant_type")).toBe("refresh_token")
    expect(form.get("refresh_token")).toBe("RT")
    const stored = JSON.parse(keyring.get(account)!)
    expect(stored).toMatchObject({ accessToken: "NEW", refreshToken: "RT", scopes: ["stats.read"], connectedAt: 1 })
    // Cached in memory now: no second refresh.
    await resolveAccessToken("helper", integ(), FAKE, deps)
    expect(calls).toHaveLength(1)
  })

  it("refreshes from a refresh token in the environment", async () => {
    const { f } = fakeFetch(() => ({ body: { access_token: "FROM_ENV", expires_in: 3600 } }))
    const i = integ({ credentials: { clientIdEnv: "FAKE_CLIENT_ID", clientSecretEnv: "FAKE_CLIENT_SECRET", refreshTokenEnv: "FAKE_RT" } })
    const r = await resolveAccessToken("helper", i, FAKE, { env: { ...ENV, FAKE_RT: "RT" }, fetch: f, now: () => NOW })
    expect(r).toMatchObject({ status: "ok", token: "FROM_ENV" })
  })

  it("writes a rotated refresh token back to .env and the process env", async () => {
    const { f } = fakeFetch(() => ({ body: { access_token: "FROM_ENV", refresh_token: "RT2", expires_in: 3600 } }))
    const i = integ({ credentials: { clientIdEnv: "FAKE_CLIENT_ID", clientSecretEnv: "FAKE_CLIENT_SECRET", refreshTokenEnv: "FAKE_RT_ROT" } })
    const env: NodeJS.ProcessEnv = { ...ENV, FAKE_RT_ROT: "RT1" }
    const written: [string, string][] = []
    const r = await resolveAccessToken("helper", i, FAKE, { env, fetch: f, now: () => NOW, writeEnv: (k, v) => written.push([k, v]) })
    expect(r).toMatchObject({ status: "ok", token: "FROM_ENV" })
    expect(written).toEqual([["FAKE_RT_ROT", "RT2"]])
    expect(env.FAKE_RT_ROT).toBe("RT2")
  })

  it("explains what is wrong without a token in the reason", async () => {
    const keyring = memoryKeyring()
    const notConnected = await resolveAccessToken("helper", integ(), FAKE, { keyring, env: ENV, now: () => NOW })
    expect(notConnected).toMatchObject({ status: "not-connected" })
    expect((notConnected as any).reason).toContain('agentx agent integrations connect helper fake --label "Main"')

    keyring.set(account, JSON.stringify({ accessToken: "AT", expiresAt: NOW - 1, scopes: [], connectedAt: 1 }))
    expect(await resolveAccessToken("helper", integ(), FAKE, { keyring, env: ENV, now: () => NOW })).toMatchObject({ status: "expired" })

    clearTokenCache()
    keyring.set(account, JSON.stringify({ accessToken: "AT", refreshToken: "SECRET_RT", expiresAt: NOW - 1, scopes: [], connectedAt: 1 }))
    expect(await resolveAccessToken("helper", integ(), FAKE, { keyring, env: {}, now: () => NOW })).toMatchObject({ status: "no-client" })

    const { f } = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }))
    const failed = await resolveAccessToken("helper", integ(), FAKE, { keyring, env: ENV, fetch: f, now: () => NOW })
    expect(failed.status).toBe("refresh-failed")
    expect(JSON.stringify(failed)).not.toContain("SECRET_RT")
  })

  it("reads env tokens and reports unset vars", () => {
    expect(readStoredGrant("helper", integ({ credentials: { tokenEnv: "FAKE_AT" } }), { env: {} })).toMatchObject({ ok: false, status: "env-unset" })
    expect(readStoredGrant("helper", integ({ credentials: { tokenEnv: "FAKE_AT" }, metadata: { oauthExpiresAt: NOW + 5 } }), { env: { FAKE_AT: "x" } }))
      .toMatchObject({ ok: true, source: "token-env", grant: { accessToken: "x", expiresAt: NOW + 5 } })
  })
})

describe("named reads", () => {
  const keyring = () => memoryKeyring({ [integrationAccount("helper", "fake", "Main")]: JSON.stringify({ accessToken: "AT", scopes: [], connectedAt: 1 }) })

  it("builds the URL from the spec: path ids, metadata, defaults, fixed query", () => {
    const r = buildReadUrl(FAKE, FAKE.reads.account_report, { metric: "views, reach", since: "2026-10-01" }, { accountId: "42" })
    expect(r.ok && r.url.toString()).toBe("https://api.fake.test/v1/accounts/42/report?metric=views%2Creach&since=2026-10-01&period=day&format=json")
  })

  it("refuses parameters and values the spec does not allow", () => {
    const read = FAKE.reads.account_report
    expect(buildReadUrl(FAKE, read, { metric: "views", extra: "1" }, { accountId: "42" })).toMatchObject({ ok: false, error: expect.stringContaining('unknown parameter "extra"') })
    expect(buildReadUrl(FAKE, read, { metric: "views,revenue" }, { accountId: "42" })).toMatchObject({ ok: false, error: expect.stringContaining('"revenue" is not allowed') })
    expect(buildReadUrl(FAKE, read, { metric: "views", accountId: "../admin" }, {})).toMatchObject({ ok: false })
    // Dot segments pass the id pattern but would climb out of the path.
    // Checked on a path param without its own pattern, like the Meta reads.
    const insights = { description: "Insights.", path: "/{page}/insights", params: { page: { description: "Page id", required: true } } }
    for (const page of ["..", ".", "..."]) {
      expect(buildReadUrl(FAKE, insights, { page }, {})).toMatchObject({ ok: false, error: expect.stringContaining("plain id") })
    }
    const ok = buildReadUrl(FAKE, insights, { page: "a.b" }, {})
    expect(ok.ok && ok.url.toString()).toBe("https://api.fake.test/v1/a.b/insights")
    // A read whose own path climbs out of the base path is refused too.
    const climbs = { description: "Climbs.", path: "/../admin", params: {} }
    expect(buildReadUrl(FAKE, climbs, {}, {})).toMatchObject({ ok: false, error: expect.stringContaining("left the provider") })
    expect(buildReadUrl(FAKE, read, { metric: "views", since: "yesterday" }, { accountId: "42" })).toMatchObject({ ok: false })
    expect(buildReadUrl(FAKE, read, {}, { accountId: "42" })).toMatchObject({ ok: false, error: expect.stringContaining('"metric" is required') })
  })

  it("runs a GET with the bearer token and returns the body", async () => {
    const { f, calls } = fakeFetch(() => ({ body: { data: [{ name: "views", value: 10 }] } }))
    const r = await runIntegrationRead(cfgWith(integ()), { agentId: "helper", kind: "fake", read: "account_report", params: { metric: "views" } }, { providers: PROVIDERS, keyring: keyring(), fetch: f, env: ENV })
    expect(r).toMatchObject({ ok: true, status: 200, truncated: false })
    expect(calls[0].init?.method).toBe("GET")
    expect((calls[0].init?.headers as any).Authorization).toBe("Bearer AT")
  })

  it("can send the token as a query parameter and never echoes it back", async () => {
    const spec = { ...FAKE, tokenIn: "query" as const }
    const { f, calls } = fakeFetch(() => ({ body: { echoed: "AT" } }))
    const r = await runIntegrationRead(cfgWith(integ()), { agentId: "helper", kind: "fake", read: "profile" }, { providers: { fake: spec }, keyring: keyring(), fetch: f, env: ENV })
    expect(new URL(calls[0].url).searchParams.get("access_token")).toBe("AT")
    expect(r.ok && r.body).toBe('{"echoed":"[redacted]"}')
  })

  it("bounds the answer and maps provider errors to a next step", async () => {
    const big = fakeFetch(() => ({ body: "x".repeat(MAX_BODY + 10) }))
    const r = await runIntegrationRead(cfgWith(integ()), { agentId: "helper", kind: "fake", read: "profile" }, { providers: PROVIDERS, keyring: keyring(), fetch: big.f, env: ENV })
    expect(r).toMatchObject({ ok: true, truncated: true })
    expect(r.ok && r.body.length).toBe(MAX_BODY)

    const denied = fakeFetch(() => ({ status: 401, body: { error: { message: "Invalid OAuth access token." } } }))
    const e = await runIntegrationRead(cfgWith(integ()), { agentId: "helper", kind: "fake", read: "profile" }, { providers: PROVIDERS, keyring: keyring(), fetch: denied.f, env: ENV })
    expect(e).toMatchObject({ ok: false, status: 401, error: expect.stringContaining('Connect again: agentx agent integrations connect helper fake --label "Main"') })
  })

  it("respects metadata.reads, disabled entries and unknown kinds", async () => {
    const narrowed = integ({ metadata: { accountId: "42", reads: "profile" } })
    expect(allowedReads(narrowed, FAKE)).toEqual(["profile"])
    const deps = { providers: PROVIDERS, keyring: keyring(), env: ENV, fetch: fakeFetch(() => ({ body: {} })).f }
    expect(await runIntegrationRead(cfgWith(narrowed), { agentId: "helper", kind: "fake", read: "account_report", params: { metric: "views" } }, deps)).toMatchObject({ ok: false, status: 403 })
    expect(await runIntegrationRead(cfgWith(integ({ enabled: false })), { agentId: "helper", kind: "fake", read: "profile" }, deps)).toMatchObject({ ok: false, status: 404 })
    expect(await runIntegrationRead(cfgWith(integ()), { agentId: "helper", kind: "other", read: "profile" }, deps)).toMatchObject({ ok: false, status: 400 })
  })

  it("lists the reads with which params are still required", () => {
    const [entry] = readCatalog(cfgWith(integ()), "helper", PROVIDERS)
    expect(entry.reads.map((r) => r.name)).toEqual(["account_report", "profile"])
    const p = entry.reads[0].params
    expect(p.accountId.required).toBe(false) // comes from metadata
    expect(p.metric).toMatchObject({ required: true, allowed: ["views", "reach", "likes"] })
    expect(p.period.required).toBe(false) // has a default
  })
})

describe("status", () => {
  it("reports connected, refresh, missing scopes and expiry without a token", () => {
    const account = integrationAccount("helper", "fake", "Main")
    const keyring = memoryKeyring({ [account]: JSON.stringify({ accessToken: "SECRET_AT", refreshToken: "SECRET_RT", scopes: ["stats.read"], connectedAt: NOW }) })
    const st = integrationStatus("helper", integ(), FAKE, { keyring, env: ENV, now: () => NOW })
    expect(st).toMatchObject({ connected: true, store: "keyring", refreshes: true, missingScopes: ["profile.read"] })
    expect(JSON.stringify(st)).not.toMatch(/SECRET/)

    keyring.set(account, JSON.stringify({ accessToken: "AT", expiresAt: NOW + 3 * 86_400_000, scopes: ["stats.read", "profile.read"], connectedAt: NOW }))
    const soon = integrationStatus("helper", integ(), FAKE, { keyring, env: ENV, now: () => NOW })
    expect(soon.connected).toBe(true)
    expect(soon.problems[0]).toMatch(/expires on/)

    const gone = integrationStatus("helper", integ(), FAKE, { keyring: memoryKeyring(), env: {}, now: () => NOW })
    expect(gone.connected).toBe(false)
    expect(gone.problems.join(" ")).toMatch(/FAKE_CLIENT_ID is unset/)
  })
})

describe("daemon API and agent tool", () => {
  const keyring = () => memoryKeyring({ [integrationAccount("helper", "fake", "Main")]: JSON.stringify({ accessToken: "AT", scopes: [], connectedAt: 1 }) })

  it("serves the catalog and a read, refuses unknown agents and other methods", async () => {
    const cfg = cfgWith(integ())
    const deps = { providers: PROVIDERS, keyring: keyring(), env: ENV, fetch: fakeFetch(() => ({ body: { ok: 1 } })).f }
    const cat = await handleIntegrationsApi("GET", "/integrations/reads", undefined, new URLSearchParams("agent=helper"), cfg, deps)
    expect(cat.status).toBe(200)
    const read = await handleIntegrationsApi("POST", "/integrations/read", { agent: "helper", kind: "fake", read: "profile" }, new URLSearchParams(), cfg, deps)
    expect(read).toEqual({ status: 200, body: { status: 200, body: '{"ok":1}', truncated: false } })
    expect((await handleIntegrationsApi("GET", "/integrations/reads", undefined, new URLSearchParams("agent=ghost"), cfg, deps)).status).toBe(400)
    expect((await handleIntegrationsApi("DELETE", "/integrations/read", undefined, new URLSearchParams(), cfg, deps)).status).toBe(405)
  })

  it("the tool lists reads, runs one and passes errors on as text", async () => {
    const cfg = cfgWith(integ())
    const deps = { providers: PROVIDERS, keyring: keyring(), env: ENV, fetch: fakeFetch(() => ({ body: { views: 7 } })).f }
    const daemon = (async (input: any, init?: RequestInit) => {
      const u = new URL(String(input))
      const r = await handleIntegrationsApi(init?.method || "GET", u.pathname, init?.body ? JSON.parse(String(init.body)) : undefined, u.searchParams, cfg, deps)
      return new Response(JSON.stringify(r.body), { status: r.status })
    }) as typeof fetch
    const env = { AGENTX_AGENT_ID: "helper" }
    const list = await runIntegrationTool({}, { daemonUrl: "http://127.0.0.1:1", fetch: daemon, env })
    expect(list).toContain('fake "Main" (Fake Analytics)')
    expect(list).toContain("metric=views|reach|likes")
    expect(await runIntegrationTool({ kind: "fake", read: "account_report", params: { metric: "views" } }, { daemonUrl: "http://127.0.0.1:1", fetch: daemon, env })).toBe('{"views":7}')
    expect(await runIntegrationTool({ kind: "fake", read: "account_report", params: { metric: "money" } }, { daemonUrl: "http://127.0.0.1:1", fetch: daemon, env })).toMatch(/^Error: "money" is not allowed/)
    expect(await runIntegrationTool({ read: "profile" }, { daemonUrl: "http://127.0.0.1:1", fetch: daemon, env })).toMatch(/kind/)
    expect(await runIntegrationTool({}, { daemonUrl: "http://127.0.0.1:1", fetch: daemon, env: {} })).toMatch(/which agent/)
  })

  it("is mesh-gated, read-only and registered", () => {
    expect(isMeshGatedPath("/integrations/read")).toBe(true)
    expect(isMeshGatedPath("/integrations/reads")).toBe(true)
    expect(AGENTX_TOOL_NAMES).toContain("agentx_integration_read")
    expect(READ_TOOL_NAMES).toContain("agentx_integration_read")
    expect(Object.keys(BUILTIN_PROVIDERS)).toEqual(["meta"])
    // A read-only (report) routine, such as a weekly digest, may use it.
    expect(evaluateAutonomy("report", { tool: "mcp__agentx__agentx_integration_read" } as any)).toMatchObject({ allowed: true })
  })
})

describe("keyring and .env storage", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-integ-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("setDotenvKey replaces an older value and keeps other lines", () => {
    const p = join(dir, ".env")
    writeFileSync(p, "A=1\nFAKE_RT=old\nB=2\n")
    setDotenvKey(p, "FAKE_RT", "new")
    expect(readFileSync(p, "utf-8")).toBe("A=1\nB=2\nFAKE_RT=new\n")
    setDotenvKey(join(dir, "fresh.env"), "K", "v")
    expect(readFileSync(join(dir, "fresh.env"), "utf-8")).toContain("K=v")
  })

  it("passes values on stdin, base64-encoded, never on the command line", () => {
    const seen: Array<{ cmd: string; args: string[]; input?: string }> = []
    const run = (cmd: string, args: string[], input?: string) => {
      seen.push({ cmd, args, input })
      if (args[0] === "lookup") return { status: 0, stdout: Buffer.from('{"a":1}').toString("base64") + "\n" }
      return { status: 0, stdout: "" }
    }
    const linux = systemKeyring("linux", run)
    linux.set("acct", '{"secret":"s3cr3t"}')
    expect(seen[0].args.join(" ")).not.toContain("s3cr3t")
    expect(Buffer.from(seen[0].input!, "base64").toString()).toBe('{"secret":"s3cr3t"}')
    expect(linux.get("acct")).toBe('{"a":1}')

    const mac = systemKeyring("darwin", run)
    mac.set("acct", "s3cr3t")
    const last = seen[seen.length - 1]
    expect(last.args).toEqual(["-i"])
    expect(last.input).toContain(Buffer.from("s3cr3t").toString("base64"))
    expect(systemKeyring("win32", run).available()).toBe(false)
  })
})
