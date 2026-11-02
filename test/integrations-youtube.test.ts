import { beforeEach, describe, expect, it } from "vitest"
import type { DaemonConfig, Integration } from "../src/daemon/config"
import { BUILTIN_PROVIDERS, providerFor } from "../src/integrations/providers"
import { YOUTUBE, YOUTUBE_REVENUE_SCOPE, YOUTUBE_SCOPES } from "../src/integrations/providers/youtube"
import { buildAuthorizeRequest } from "../src/integrations/oauth"
import { signIn } from "../src/integrations/connect"
import { integrationAccount, memoryKeyring } from "../src/integrations/keyring"
import { clearTokenCache, resolveAccessToken } from "../src/integrations/resolve"
import { buildReadUrl, runIntegrationRead } from "../src/integrations/read"
import { integrationStatus } from "../src/integrations/status"

// YouTube spec (#1696 P2b), against a fake Google API: no real account needed.

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const UPLOADS = "UU" + "a".repeat(22)

type Call = { url: URL; init?: RequestInit }
function fakeGoogle(handler: (url: URL, init?: RequestInit) => { status?: number; body: unknown }) {
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
  kind: "youtube",
  label: "youtube",
  credentials: { clientIdEnv: "YT_CLIENT_ID", clientSecretEnv: "YT_CLIENT_SECRET", auth: "keyring" },
  metadata: { oauthConnectedAt: NOW, playlistId: UPLOADS },
  enabled: true,
  ...over,
})
const cfgWith = (i: Integration): DaemonConfig => ({ agents: { helper: { integrations: [i] } } } as unknown as DaemonConfig)
const ENV = { YT_CLIENT_ID: "client-id", YT_CLIENT_SECRET: "client-secret" }

function connectedKeyring(expiresAt = NOW + HOUR, scopes = YOUTUBE_SCOPES) {
  const keyring = memoryKeyring()
  keyring.set(integrationAccount("helper", "youtube", "youtube"), JSON.stringify({ accessToken: "ACCESS", refreshToken: "REFRESH", expiresAt, scopes, connectedAt: NOW }))
  return keyring
}

beforeEach(() => { clearTokenCache() })

describe("youtube provider spec", () => {
  it("is registered under the kind youtube", () => {
    expect(providerFor("youtube")).toBe(YOUTUBE)
    expect(BUILTIN_PROVIDERS.youtube.kind).toBe("youtube")
  })

  it("asks for read-only scopes, offline, with PKCE; revenue only on opt-in", () => {
    const u = new URL(buildAuthorizeRequest(YOUTUBE, "client-id", "http://localhost:19876/callback").url)
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(u.searchParams.get("scope")).toBe(YOUTUBE_SCOPES.join(" "))
    expect(u.searchParams.get("access_type")).toBe("offline")
    expect(u.searchParams.get("prompt")).toBe("consent")
    expect(u.searchParams.get("code_challenge_method")).toBe("S256")
    for (const s of YOUTUBE_SCOPES) expect(s).toMatch(/readonly$/)
    expect(YOUTUBE.oauth.optionalScopes).toEqual({ revenue: [YOUTUBE_REVENUE_SCOPE] })
  })

  it("keeps revenue metrics out of the plain report", () => {
    const plain = YOUTUBE.reads.report.params.metrics.enum ?? []
    expect(plain.some((m) => /revenue|cpm|monetized|adImpressions/i.test(m))).toBe(false)
    expect(YOUTUBE.reads.revenue_report.scopes).toContain(YOUTUBE_REVENUE_SCOPE)
  })
})

describe("youtube connect", () => {
  it("stores the refresh token and the scopes Google granted", async () => {
    const { f } = fakeGoogle((url) => {
      if (url.href === "https://oauth2.googleapis.com/token") {
        return { body: { access_token: "ACCESS", refresh_token: "REFRESH", expires_in: 3599, scope: YOUTUBE_SCOPES.join(" "), token_type: "Bearer" } }
      }
      return { status: 404, body: {} }
    })
    const grant = await signIn({
      agentId: "helper", spec: YOUTUBE, integration: integ({ credentials: {}, metadata: {} }), clientId: "client-id", clientSecret: "client-secret",
      redirectUri: "http://localhost:19876/callback", fetch: f, now: () => NOW, extras: ["revenue"],
      getCallback: async (authorizeUrl) => {
        expect(new URL(authorizeUrl).searchParams.get("scope")).toBe([...YOUTUBE_SCOPES, YOUTUBE_REVENUE_SCOPE].join(" "))
        return { code: "the-code" }
      },
    })
    expect(grant).toMatchObject({ accessToken: "ACCESS", refreshToken: "REFRESH", expiresAt: NOW + 3_599_000, scopes: YOUTUBE_SCOPES })
  })
})

describe("youtube status", () => {
  it("refreshes, and names a declined scope but not the opt-in revenue one", () => {
    const st = integrationStatus("helper", integ(), YOUTUBE, { keyring: connectedKeyring(NOW + HOUR, [YOUTUBE_SCOPES[0]]), env: ENV, now: () => NOW })
    expect(st).toMatchObject({ connected: true, refreshes: true })
    expect(st.missingScopes).toEqual([YOUTUBE_SCOPES[1]])
  })

  it("refreshes an expired access token with the refresh token", async () => {
    const { f, calls } = fakeGoogle((url) => {
      if (url.href === "https://oauth2.googleapis.com/token") return { body: { access_token: "NEW", expires_in: 3599, token_type: "Bearer" } }
      return { status: 404, body: {} }
    })
    const r = await resolveAccessToken("helper", integ(), YOUTUBE, { keyring: connectedKeyring(NOW - HOUR), env: ENV, now: () => NOW, fetch: f })
    expect(r).toMatchObject({ status: "ok", token: "NEW" })
    expect(String(calls[0].init?.body)).toContain("grant_type=refresh_token")
  })
})

describe("youtube reads", () => {
  const deps = (handler: Parameters<typeof fakeGoogle>[0]) => {
    const g = fakeGoogle(handler)
    return { g, deps: { providers: BUILTIN_PROVIDERS, keyring: connectedKeyring(), env: ENV, now: () => NOW, fetch: g.f } }
  }

  it("reads only the channel that signed in", async () => {
    const { g, deps: d } = deps(() => ({ body: { items: [{ id: "UC" + "a".repeat(22) }] } }))
    const r = await runIntegrationRead(cfgWith(integ()), { agentId: "helper", kind: "youtube", read: "channel" }, d)
    expect(r).toMatchObject({ ok: true })
    expect(g.calls[0].url.href).toBe("https://www.googleapis.com/youtube/v3/channels?part=snippet%2Cstatistics%2CcontentDetails&mine=true")
    expect(auth(g.calls[0])).toBe("Bearer ACCESS")
  })

  it("an agent cannot ask for another channel", () => {
    const b = buildReadUrl(YOUTUBE, YOUTUBE.reads.channel, { id: "UCother" }, {})
    expect(b).toMatchObject({ ok: false })
  })

  it("lists uploads from the playlist in metadata", async () => {
    const { g, deps: d } = deps(() => ({ body: { items: [] } }))
    await runIntegrationRead(cfgWith(integ()), { agentId: "helper", kind: "youtube", read: "uploads", params: { maxResults: 10 } }, d)
    const u = g.calls[0].url
    expect(u.pathname).toBe("/youtube/v3/playlistItems")
    expect(u.searchParams.get("playlistId")).toBe(UPLOADS)
    expect(u.searchParams.get("maxResults")).toBe("10")
  })

  it("refuses a playlist that is not an uploads playlist", () => {
    expect(buildReadUrl(YOUTUBE, YOUTUBE.reads.uploads, { playlistId: "PL" + "a".repeat(22) }, {})).toMatchObject({ ok: false })
  })

  it("sends a report to the Analytics API for channel==MINE", async () => {
    const { g, deps: d } = deps(() => ({ body: { columnHeaders: [], rows: [["2026-10-01", 12]] } }))
    const params = { startDate: "2026-10-01", endDate: "2026-10-31", metrics: "views,estimatedMinutesWatched", dimensions: "day", filters: "creatorContentType==SHORTS", sort: "-views" }
    const r = await runIntegrationRead(cfgWith(integ()), { agentId: "helper", kind: "youtube", read: "report", params }, d)
    expect(r).toMatchObject({ ok: true })
    const u = g.calls[0].url
    expect(u.origin + u.pathname).toBe("https://youtubeanalytics.googleapis.com/v2/reports")
    expect(u.searchParams.get("ids")).toBe("channel==MINE")
    expect(u.searchParams.get("metrics")).toBe("views,estimatedMinutesWatched")
    expect(u.searchParams.get("filters")).toBe("creatorContentType==SHORTS")
  })

  it("refuses revenue metrics in the plain report, a bad date and a free-form filter", () => {
    const base = { startDate: "2026-10-01", endDate: "2026-10-31", metrics: "views" }
    expect(buildReadUrl(YOUTUBE, YOUTUBE.reads.report, { ...base, metrics: "estimatedRevenue" }, {})).toMatchObject({ ok: false })
    expect(buildReadUrl(YOUTUBE, YOUTUBE.reads.report, { ...base, startDate: "last week" }, {})).toMatchObject({ ok: false })
    expect(buildReadUrl(YOUTUBE, YOUTUBE.reads.report, { ...base, filters: "channel==UCother" }, {})).toMatchObject({ ok: false })
    expect(buildReadUrl(YOUTUBE, YOUTUBE.reads.report, { ...base, ids: "channel==UCother" }, {})).toMatchObject({ ok: false })
  })

  it("passes Google's 403 on revenue through with a scope hint", async () => {
    const { deps: d } = deps(() => ({ status: 403, body: { error: { message: "Forbidden" } } }))
    const params = { startDate: "2026-10-01", endDate: "2026-10-31", metrics: "estimatedRevenue", currency: "USD" }
    const r = await runIntegrationRead(cfgWith(integ()), { agentId: "helper", kind: "youtube", read: "revenue_report", params }, d)
    expect(r).toMatchObject({ ok: false, status: 403 })
    if (!r.ok) expect(r.error).toContain("scope")
  })
})
