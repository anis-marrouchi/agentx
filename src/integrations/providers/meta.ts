import { createHash } from "crypto"
import { safeProviderText } from "../oauth"
import type { OAuthGrant, ProviderContext, ProviderSpec, ReadTokenRequest } from "./types"

// --- Meta: Facebook Page and Instagram professional account insights (#1696 P2a) ---
//
// Sign-in: Facebook Login for Business on the owner's own Meta app. The code
// gives a short-lived user token (about an hour). afterConnect swaps it for
// a long-lived one (about 60 days) and records the permissions the owner
// actually granted (Meta does not list them in the token answer). Meta has
// no refresh token: the owner connects again before the expiry doctor shows.
//
// Reads:
//   - Instagram reads use the user token, as Meta's Instagram API with
//     Facebook Login expects.
//   - Facebook Page reads need a Page token. readToken derives it from the
//     user token (GET /{page_id}?fields=access_token), keeps it in memory
//     only, and fails with a clear message when the person who signed in
//     does not manage that Page.
//
// Metric names: current names only. page_impressions*, page_fans* and the
// Instagram `impressions` metric are gone (replaced by *_media_view and
// `views`), so they are not offered. Names are allow-listed: Meta answers
// 400 for a metric it does not know, and the agent sees that answer.

export const META_GRAPH_VERSION = "v24.0"
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`

const NUMERIC_ID = /[0-9]{1,30}/
/** A Page post id: <page id>_<post id>. */
const POST_ID = /[0-9]{1,30}_[0-9]{1,30}/
/** YYYY-MM-DD or a Unix timestamp, the two forms Graph accepts for since/until. */
const DAY_OR_UNIX = /[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{9,11}/

export const META_PAGE_METRICS = [
  "page_media_view",
  "page_total_media_view_unique",
  "page_follows",
  "page_daily_follows",
  "page_daily_follows_unique",
  "page_daily_unfollows_unique",
  "page_post_engagements",
  "page_video_views",
  "page_video_view_time",
  // Earnings: answered only for a monetised Page.
  "monetization_approximate_earnings",
  "page_daily_video_ad_break_earnings",
] as const

export const META_POST_METRICS = [
  "post_media_view",
  "post_total_media_view_unique",
  "post_reactions_by_type_total",
  "post_clicks",
  "post_video_views",
] as const

export const META_IG_ACCOUNT_METRICS = [
  "views",
  "reach",
  "total_interactions",
  "accounts_engaged",
  "likes",
  "comments",
  "shares",
  "saves",
  "replies",
  "follows_and_unfollows",
  "profile_links_taps",
  "follower_count",
  "follower_demographics",
  "engaged_audience_demographics",
] as const

export const META_IG_MEDIA_METRICS = [
  "views",
  "reach",
  "total_interactions",
  "likes",
  "comments",
  "shares",
  "saved",
  "profile_visits",
  "follows",
  "ig_reels_avg_watch_time",
  "ig_reels_video_view_total_time",
] as const

export const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
  "instagram_basic",
  "instagram_manage_insights",
]

/** Reads that must be sent with a Page token instead of the user token. */
const PAGE_TOKEN_READS = new Set(["page_insights", "page_posts", "post_insights"])

async function graphGet(f: typeof fetch, path: string, query: Record<string, string>, token: string): Promise<any> {
  const u = new URL(GRAPH + path)
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
  const res = await f(u.toString(), {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  })
  const text = await res.text()
  let data: any
  try { data = JSON.parse(text) } catch { data = {} }
  if (!res.ok) {
    const why = data?.error?.message || `HTTP ${res.status}`
    throw new Error(safeProviderText(String(why)).split(token).join("[redacted]"))
  }
  return data
}

/** Swap the short-lived user token for a long-lived one and record the
 *  permissions the owner granted. */
export async function metaAfterConnect(grant: OAuthGrant, ctx: ProviderContext): Promise<OAuthGrant> {
  const u = new URL(`${GRAPH}/oauth/access_token`)
  u.searchParams.set("grant_type", "fb_exchange_token")
  u.searchParams.set("client_id", ctx.clientId)
  u.searchParams.set("client_secret", ctx.clientSecret)
  u.searchParams.set("fb_exchange_token", grant.accessToken)
  const res = await ctx.fetch(u.toString(), { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000), redirect: "error" })
  const text = await res.text()
  let data: any
  try { data = JSON.parse(text) } catch { data = {} }
  if (!res.ok || typeof data?.access_token !== "string" || !data.access_token) {
    const why = data?.error?.message || `HTTP ${res.status}`
    throw new Error(`Meta refused the long-lived token swap: ${safeProviderText(String(why))}`)
  }
  const expiresIn = Number(data.expires_in)
  const accessToken: string = data.access_token
  let scopes = grant.scopes
  try {
    const perms = await graphGet(ctx.fetch, "/me/permissions", {}, accessToken)
    if (Array.isArray(perms?.data)) {
      scopes = perms.data.filter((p: any) => p?.status === "granted" && typeof p.permission === "string").map((p: any) => p.permission)
    }
  } catch { /* keep the scopes asked for; doctor then cannot flag a declined one */ }
  return {
    accessToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? ctx.now + expiresIn * 1000 : undefined,
    scopes,
    connectedAt: grant.connectedAt,
  }
}

// Page tokens, in memory only. Keyed on a hash of the user token so a
// reconnect (new user token) never reuses a Page token from the old one.
const PAGE_TOKEN_TTL_MS = 60 * 60_000
const PAGE_TOKEN_MAX = 200
const pageTokens = new Map<string, { token: string; until: number }>()

/** Forget derived Page tokens (tests, disconnect). */
export function clearMetaPageTokens(): void { pageTokens.clear() }

/** The Page a read is about: page_id, or the first part of a post id. */
export function pageIdFor(read: string, values: Readonly<Record<string, string>>): string | undefined {
  if (values.page_id) return values.page_id
  if (read === "post_insights" && values.post_id) return values.post_id.split("_")[0]
  return undefined
}

export async function metaReadToken(req: ReadTokenRequest): Promise<string> {
  if (!PAGE_TOKEN_READS.has(req.read)) return req.token
  const pageId = pageIdFor(req.read, req.values)
  if (!pageId || !/^[0-9]{1,30}$/.test(pageId)) throw new Error("this read needs a Page id (run the `pages` read to list them)")
  const key = createHash("sha256").update(req.token).digest("hex").slice(0, 32) + ":" + pageId
  const hit = pageTokens.get(key)
  if (hit && hit.until > req.now) return hit.token
  let data: any
  try {
    data = await graphGet(req.fetch, `/${pageId}`, { fields: "access_token" }, req.token)
  } catch (e: any) {
    throw new Error(`couldn't get a token for Page ${pageId}: ${e?.message ?? e}`)
  }
  const token = typeof data?.access_token === "string" ? data.access_token : ""
  if (!token) throw new Error(`the account that signed in does not manage Page ${pageId}, or did not grant pages_read_engagement for it. Run the \`pages\` read to see the Pages it manages`)
  if (pageTokens.size >= PAGE_TOKEN_MAX) pageTokens.delete(pageTokens.keys().next().value as string)
  pageTokens.set(key, { token, until: req.now + PAGE_TOKEN_TTL_MS })
  return token
}

const since = { description: "Start: YYYY-MM-DD or a Unix time", pattern: DAY_OR_UNIX }
const until = { description: "End: YYYY-MM-DD or a Unix time", pattern: DAY_OR_UNIX }

export const META: ProviderSpec = {
  kind: "meta",
  title: "Meta (Facebook and Instagram)",
  baseUrl: GRAPH,
  oauth: {
    authorizeUrl: `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`,
    tokenUrl: `${GRAPH}/oauth/access_token`,
    scopes: META_SCOPES,
    scopeSeparator: ",",
    // The app secret is sent with the code; Meta's manual login flow does
    // not need PKCE for a confidential client.
    pkce: false,
    refresh: "none",
    afterConnect: metaAfterConnect,
  },
  readToken: metaReadToken,
  reads: {
    pages: {
      description: "The Facebook Pages the signed-in account manages, with each Page's linked Instagram professional account. Use it to find page_id and ig_user_id.",
      path: "/me/accounts",
      params: {
        limit: { description: "How many Pages (1-100)", pattern: /[1-9][0-9]?|100/, default: "25" },
      },
      fixedQuery: { fields: "id,name,category,instagram_business_account{id,username}" },
      scopes: ["pages_show_list"],
    },
    page_insights: {
      description: "Facebook Page totals: views, unique viewers, follows, engagement, video, and earnings for a monetised Page.",
      path: "/{page_id}/insights",
      params: {
        page_id: { description: "Facebook Page id (from the `pages` read, or metadata.page_id)", required: true, fromMetadata: true, pattern: NUMERIC_ID },
        metric: { description: "Comma-separated metrics", required: true, list: true, enum: META_PAGE_METRICS },
        period: { description: "Granularity", enum: ["day", "week", "days_28", "month", "lifetime", "total_over_range"], default: "day" },
        since,
        until,
      },
      scopes: ["read_insights", "pages_read_engagement"],
    },
    page_posts: {
      description: "Recent posts of a Facebook Page (id, time, link). Use it to find post_id.",
      path: "/{page_id}/posts",
      params: {
        page_id: { description: "Facebook Page id", required: true, fromMetadata: true, pattern: NUMERIC_ID },
        limit: { description: "How many posts (1-100)", pattern: /[1-9][0-9]?|100/, default: "25" },
        since,
        until,
      },
      fixedQuery: { fields: "id,created_time,permalink_url,status_type" },
      scopes: ["pages_read_engagement"],
    },
    post_insights: {
      description: "Totals for one Facebook Page post: views, unique viewers, reactions, clicks, video views.",
      path: "/{post_id}/insights",
      params: {
        post_id: { description: "Post id, <page id>_<post id> (from `page_posts`)", required: true, pattern: POST_ID },
        metric: { description: "Comma-separated metrics", required: true, list: true, enum: META_POST_METRICS },
      },
      scopes: ["read_insights", "pages_read_engagement"],
    },
    ig_account_insights: {
      description: "Instagram professional account totals: views, reach, interactions, followers, and audience demographics.",
      path: "/{ig_user_id}/insights",
      params: {
        ig_user_id: { description: "Instagram account id (from the `pages` read, or metadata.ig_user_id)", required: true, fromMetadata: true, pattern: NUMERIC_ID },
        metric: { description: "Comma-separated metrics", required: true, list: true, enum: META_IG_ACCOUNT_METRICS },
        period: { description: "Granularity", enum: ["day", "lifetime"], default: "day" },
        metric_type: { description: "total_value (one number) or time_series (per day)", enum: ["total_value", "time_series"] },
        breakdown: { description: "Split the totals (demographics and some totals only)", enum: ["age", "city", "country", "gender", "media_product_type", "follow_type", "contact_button_type"] },
        timeframe: { description: "Window for demographics", enum: ["this_week", "this_month", "prev_month", "last_14_days", "last_30_days", "last_90_days"] },
        since,
        until,
      },
      scopes: ["instagram_basic", "instagram_manage_insights"],
    },
    ig_media: {
      description: "Recent posts, reels and stories of an Instagram professional account (id, type, time, link, likes, comments). Use it to find media_id.",
      path: "/{ig_user_id}/media",
      params: {
        ig_user_id: { description: "Instagram account id", required: true, fromMetadata: true, pattern: NUMERIC_ID },
        limit: { description: "How many items (1-100)", pattern: /[1-9][0-9]?|100/, default: "25" },
        since,
        until,
      },
      fixedQuery: { fields: "id,media_type,media_product_type,timestamp,permalink,like_count,comments_count" },
      scopes: ["instagram_basic"],
    },
    ig_media_insights: {
      description: "Totals for one Instagram post or reel: views, reach, interactions, saves, shares, and reel watch time.",
      path: "/{media_id}/insights",
      params: {
        media_id: { description: "Instagram media id (from `ig_media`)", required: true, pattern: NUMERIC_ID },
        metric: { description: "Comma-separated metrics", required: true, list: true, enum: META_IG_MEDIA_METRICS },
      },
      scopes: ["instagram_basic", "instagram_manage_insights"],
    },
  },
}
