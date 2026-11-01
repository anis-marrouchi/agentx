import { beforeEach, describe, expect, it } from "vitest"
import type { DaemonConfig, Integration } from "../src/daemon/config"
import { BUILTIN_PROVIDERS, providerFor } from "../src/integrations/providers"
import { META, META_GRAPH_VERSION, META_SCOPES, clearMetaPageTokens, pageIdFor } from "../src/integrations/providers/meta"
import { buildAuthorizeRequest } from "../src/integrations/oauth"
import { signIn, storeGrant } from "../src/integrations/connect"
import { integrationAccount, memoryKeyring } from "../src/integrations/keyring"
import { clearTokenCache, resolveAccessToken } from "../src/integrations/resolve"
import { buildReadUrl, readCatalog, runIntegrationRead } from "../src/integrations/read"
import { integrationStatus } from "../src/integrations/status"

// Meta spec (#1696 P2a), against a fake Graph API: no real account needed.

const NOW = 1_800_000_000_000
const DAY = 86_400_000
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`

type Call = { url: URL; init?: RequestInit }
function fakeGraph(handler: (url: URL, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Call[] = []
  const f = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    const r = handler(url, init)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  return { f, calls }
}
const auth = (c: Call) => (c.init?.headers as Record<string, string> | undefined)?.Authorization

const integ = (over: Partial<Integration> = {}): Integration => ({
  kind: "meta",
  label: "meta",
  credentials: { clientIdEnv: "META_CLIENT_ID", clientSecretEnv: "META_CLIENT_SECRET", auth: "keyring" },
  metadata: { oauthConnectedAt: NOW, page_id: "1001", ig_user_id: "1789" },
  enabled: true,
  ...over,
})
const cfgWith = (i: Integration): DaemonConfig => ({ agents: { helper: { integrations: [i] } } } as unknown as DaemonConfig)
const ENV = { META_CLIENT_ID: "app-id", META_CLIENT_SECRET: "app-secret" }

function connectedKeyring(expiresAt = NOW + 60 * DAY, scopes = META_SCOPES) {
  const keyring = memoryKeyring()
  keyring.set(integrationAccount("helper", "meta", "meta"), JSON.stringify({ accessToken: "USER_TOKEN", expiresAt, scopes, connectedAt: NOW }))
  return keyring
}

beforeEach(() => { clearTokenCache(); clearMetaPageTokens() })

describe("meta provider spec", () => {
  it("is registered under the kind meta", () => {
    expect(providerFor("meta")).toBe(META)
    expect(BUILTIN_PROVIDERS.meta.kind).toBe("meta")
  })

  it("asks only for read permissions, comma-separated, without PKCE", () => {
    const u = new URL(buildAuthorizeRequest(META, "app-id", "http://localhost:19876/callback").url)
    expect(u.origin + u.pathname).toBe(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`)
    expect(u.searchParams.get("scope")).toBe("pages_show_list,pages_read_engagement,read_insights,instagram_basic,instagram_manage_insights")
    expect(u.searchParams.has("code_challenge")).toBe(false)
    for (const s of META_SCOPES) expect(s).not.toMatch(/manage_posts|publish|content_publish|messages|ads_management/)
  })

  it("offers no deprecated metric", () => {
    const all = Object.values(META.reads).flatMap((r) => Object.values(r.params).flatMap((p) => [...(p.enum ?? [])]))
    expect(all.some((m) => /^page_impressions|^page_fans|^page_fan_|^post_impressions|^impressions$|^post_engaged_users$/.test(m))).toBe(false)
    expect(META.reads.ig_account_insights.params.metric.enum).toContain("views")
    expect(META.reads.page_insights.params.metric.enum).toEqual(expect.arrayContaining(["page_media_view", "page_total_media_view_unique", "page_follows"]))
  })

  it("never lets a fixed field list ask for a Page token", () => {
    for (const r of Object.values(META.reads)) expect(r.fixedQuery?.fields ?? "").not.toContain("access_token")
  })
})

describe("meta connect", () => {
  it("swaps the short-lived token for a long-lived one and records the permissions granted", async () => {
    const { f, calls } = fakeGraph((url) => {
      if (url.pathname.endsWith("/oauth/access_token") && url.searchParams.get("grant_type") === "fb_exchange_token") {
        expect(url.searchParams.get("fb_exchange_token")).toBe("SHORT")
        expect(url.searchParams.get("client_secret")).toBe("app-secret")
        return { body: { access_token: "LONG", token_type: "bearer", expires_in: 5_184_000 } }
      }
      if (url.pathname.endsWith("/oauth/access_token")) return { body: { access_token: "SHORT", token_type: "bearer", expires_in: 3600 } }
      if (url.pathname.endsWith("/me/permissions")) {
        return { body: { data: [
          { permission: "pages_show_list", status: "granted" },
          { permission: "read_insights", status: "granted" },
          { permission: "instagram_manage_insights", status: "declined" },
        ] } }
      }
      return { status: 404, body: {} }
    })
    const grant = await signIn({
      agentId: "helper", spec: META, integration: integ({ credentials: {}, metadata: {} }), clientId: "app-id", clientSecret: "app-secret",
      redirectUri: "http://localhost:19876/callback", fetch: f, now: () => NOW,
      getCallback: async () => ({ code: "the-code" }),
    })
    expect(grant).toEqual({ accessToken: "LONG", expiresAt: NOW + 5_184_000_000, scopes: ["pages_show_list", "read_insights"], connectedAt: NOW })
    expect(grant.refreshToken).toBeUndefined()
    expect(auth(calls[2])).toBe("Bearer LONG")
    expect(calls[2].url.searchParams.has("access_token")).toBe(false)

    // Stored in .env, the expiry is kept as a non-secret fact for doctor.
    const env: Record<string, string> = {}
    const saved = storeGrant("helper", integ({ credentials: { clientIdEnv: "META_CLIENT_ID", clientSecretEnv: "META_CLIENT_SECRET" }, metadata: {} }), grant, "env", {
      keyring: memoryKeyring(), writeEnv: (k, v) => { env[k] = v },
    })
    expect(env).toEqual({ META_HELPER_ACCESS_TOKEN: "LONG" })
    expect(saved.integration.metadata).toMatchObject({ oauthExpiresAt: NOW + 5_184_000_000, oauthScopes: "pages_show_list read_insights" })
  })

  it("fails without leaking a token when the swap is refused", async () => {
    const { f } = fakeGraph((url) => url.searchParams.get("grant_type") === "fb_exchange_token"
      ? { status: 400, body: { error: { message: "Invalid OAuth access token SHORT" } } }
      : { body: { access_token: "SHORT", expires_in: 3600 } })
    await expect(signIn({
      agentId: "helper", spec: META, integration: integ(), clientId: "app-id", clientSecret: "app-secret",
      redirectUri: "http://localhost:19876/callback", fetch: f, now: () => NOW, getCallback: async () => ({ code: "c" }),
    })).rejects.toThrow(/long-lived token swap/)
  })
})

describe("meta status", () => {
  it("does not refresh and warns a week before expiry", () => {
    const st = integrationStatus("helper", integ(), META, { keyring: connectedKeyring(NOW + 3 * DAY), env: ENV, now: () => NOW })
    expect(st).toMatchObject({ connected: true, refreshes: false, expiresAt: NOW + 3 * DAY })
    expect(st.problems.join(" ")).toMatch(/expires on .* connect again before then/)
  })

  it("names a declined permission", () => {
    const st = integrationStatus("helper", integ(), META, { keyring: connectedKeyring(undefined, META_SCOPES.filter((s) => s !== "read_insights")), env: ENV, now: () => NOW })
    expect(st.missingScopes).toEqual(["read_insights"])
  })

  it("asks for a reconnect once the long-lived token has run out", async () => {
    const r = await resolveAccessToken("helper", integ(), META, { keyring: connectedKeyring(NOW - DAY), env: ENV, now: () => NOW })
    expect(r).toMatchObject({ status: "expired" })
  })
})

describe("meta reads", () => {
  const deps = (handler: Parameters<typeof fakeGraph>[0]) => {
    const g = fakeGraph(handler)
    return { g, deps: { providers: BUILTIN_PROVIDERS, keyring: connectedKeyring(), env: ENV, now: () => NOW, fetch: g.f } }
  }

  it("lists Pages with the user token and a fixed field list", async () => {
    const { g, deps: d } = deps(() => ({ body: { data: [{ id: "1001", name: "Example Page", instagram_business_account: { id: "1789", username: "example" } }] } }))
    const r = await runIntegrationRead(cfgWith(integ()), { agentId: "helper", kind: "meta", read: "pages" }, d)
    expect(r).toMatchObject({ ok: true })
    expect(g.calls[0].url.pathname).toBe(`/${META_GRAPH_VERSION}/me/accounts`)
    expect(g.calls[0].url.searchParams.get("fields")).toBe("id,name,category,instagram_business_account{id,username}")
    expect(auth(g.calls[0])).toBe("Bearer USER_TOKEN")
  })

  it("reads Page insights with a derived Page token, cached in memory, and cuts it from the answer", async () => {
    const { g, deps: d } = deps((url) => {
      if (url.pathname === `/${META_GRAPH_VERSION}/1001` && url.searchParams.get("fields") === "access_token") return { body: { access_token: "PAGE_TOKEN", id: "1001" } }
      if (url.pathname === `/${META_GRAPH_VERSION}/1001/insights`) return { body: { data: [{ name: "page_media_view", values: [{ value: 12 }] }], echo: "PAGE_TOKEN" } }
      return { status: 404, body: {} }
    })
    const req = { agentId: "helper", kind: "meta", read: "page_insights", params: { metric: "page_media_view,page_follows", since: "2026-10-01", until: "2026-10-31" } }
    const r = await runIntegrationRead(cfgWith(integ()), req, d)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.body).toContain("page_media_view")
      expect(r.body).not.toContain("PAGE_TOKEN")
    }
    expect(auth(g.calls[0])).toBe("Bearer USER_TOKEN")
    const insights = g.calls[1]
    expect(auth(insights)).toBe("Bearer PAGE_TOKEN")
    expect(insights.url.searchParams.get("metric")).toBe("page_media_view,page_follows")
    expect(insights.url.searchParams.get("period")).toBe("day")
    expect(insights.url.searchParams.has("page_id")).toBe(false)

    await runIntegrationRead(cfgWith(integ()), req, d)
    expect(g.calls.filter((c) => c.url.searchParams.get("fields") === "access_token")).toHaveLength(1)
  })

  it("derives the Page from a post id", async () => {
    expect(pageIdFor("post_insights", { post_id: "1001_555" })).toBe("1001")
    const { g, deps: d } = deps((url) => url.searchParams.get("fields") === "access_token"
      ? { body: { access_token: "PAGE_TOKEN" } }
      : { body: { data: [] } })
    const r = await runIntegrationRead(cfgWith(integ()), { agentId: "helper", kind: "meta", read: "post_insights", params: { post_id: "1001_555", metric: "post_media_view" } }, d)
    expect(r.ok).toBe(true)
    expect(g.calls[0].url.pathname).toBe(`/${META_GRAPH_VERSION}/1001`)
    expect(g.calls[1].url.pathname).toBe(`/${META_GRAPH_VERSION}/1001_555/insights`)
  })

  it("explains when the account does not manage the Page", async () => {
    const { g, deps: d } = deps(() => ({ body: { id: "2002" } }))
    const r = await runIntegrationRead(cfgWith(integ()), { agentId: "helper", kind: "meta", read: "page_insights", params: { page_id: "2002", metric: "page_follows" } }, d)
    expect(r).toMatchObject({ ok: false, status: 403 })
    if (!r.ok) {
      expect(r.error).toMatch(/does not manage Page 2002/)
      expect(r.error).not.toContain("USER_TOKEN")
    }
    expect(g.calls).toHaveLength(1)
  })

  it("reads Instagram insights with the user token and the account id from metadata", async () => {
    const { g, deps: d } = deps(() => ({ body: { data: [] } }))
    const r = await runIntegrationRead(cfgWith(integ()), { agentId: "helper", kind: "meta", read: "ig_account_insights", params: { metric: "views,reach", metric_type: "total_value", period: "day" } }, d)
    expect(r.ok).toBe(true)
    expect(g.calls).toHaveLength(1)
    expect(g.calls[0].url.pathname).toBe(`/${META_GRAPH_VERSION}/1789/insights`)
    expect(auth(g.calls[0])).toBe("Bearer USER_TOKEN")
  })

  it("refuses retired metrics, bad ids and unknown parameters before calling Meta", async () => {
    const { g, deps: d } = deps(() => ({ body: {} }))
    const cfg = cfgWith(integ())
    for (const params of [
      { metric: "page_impressions" },
      { metric: "page_follows", page_id: "../me" },
      { metric: "page_follows", fields: "access_token" },
    ]) {
      const r = await runIntegrationRead(cfg, { agentId: "helper", kind: "meta", read: "page_insights", params }, d)
      expect(r).toMatchObject({ ok: false, status: 400 })
    }
    const ig = await runIntegrationRead(cfg, { agentId: "helper", kind: "meta", read: "ig_media_insights", params: { media_id: "1", metric: "impressions" } }, d)
    expect(ig).toMatchObject({ ok: false, status: 400 })
    expect(g.calls).toHaveLength(0)
  })

  it("accepts dates or Unix times for since and until", () => {
    const ok = buildReadUrl(META, META.reads.page_insights, { metric: "page_follows", since: "1790000000", until: "2026-10-31" }, { page_id: "1001" })
    expect(ok.ok).toBe(true)
    const bad = buildReadUrl(META, META.reads.page_insights, { metric: "page_follows", since: "last week" }, { page_id: "1001" })
    expect(bad.ok).toBe(false)
  })

  it("shows the reads in the catalog, narrowed by metadata.reads", () => {
    const all = readCatalog(cfgWith(integ()), "helper")
    expect(all[0].reads.map((r) => r.name)).toEqual(["pages", "page_insights", "page_posts", "post_insights", "ig_account_insights", "ig_media", "ig_media_insights"])
    expect(all[0].reads.find((r) => r.name === "page_insights")?.params.page_id.required).toBe(false)
    const some = readCatalog(cfgWith(integ({ metadata: { reads: "pages,ig_account_insights" } })), "helper")
    expect(some[0].reads.map((r) => r.name)).toEqual(["pages", "ig_account_insights"])
  })
})
