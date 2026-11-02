import type { ParamSpec, ProviderSpec } from "./types"

// --- YouTube: channel, uploads and YouTube Analytics reports (#1696 P2b) ---
//
// Sign-in: Google OAuth on the owner's own Google Cloud project, with PKCE
// and `access_type=offline` + `prompt=consent`, so a refresh token comes
// back on every connect. Access tokens last about an hour and are refreshed
// at use time by the layer. In the "Testing" publishing status Google ends
// refresh tokens after 7 days; doctor then shows "connect again".
//
// Reads:
//   - Data API v3 (www.googleapis.com/youtube/v3): the signed-in channel,
//     its uploads playlist, and video details. `mine=true` is fixed, so an
//     agent reads only the channel that signed in.
//   - Analytics API v2 (youtubeanalytics.googleapis.com/v2/reports):
//     `ids=channel==MINE` is fixed. Revenue metrics are a separate read
//     that needs the monetary scope (`connect --with revenue`); Google
//     answers 403 for it unless the channel is in the Partner Program.
//
// Impressions and click-through rate are not in the Analytics API (only in
// the bulk Reporting API), so they are not offered here.

const DATA_API = "https://www.googleapis.com/youtube/v3"
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2"

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
]
export const YOUTUBE_REVENUE_SCOPE = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly"

export const YOUTUBE_METRICS = [
  "views",
  "engagedViews",
  "redViews",
  "estimatedMinutesWatched",
  "estimatedRedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "likes",
  "dislikes",
  "comments",
  "shares",
  "subscribersGained",
  "subscribersLost",
  "videosAddedToPlaylists",
  "videosRemovedFromPlaylists",
  "cardClicks",
  "cardImpressions",
  "cardClickRate",
  // Demographics: with the ageGroup and/or gender dimension only.
  "viewerPercentage",
] as const

export const YOUTUBE_REVENUE_METRICS = [
  "estimatedRevenue",
  "estimatedAdRevenue",
  "grossRevenue",
  "estimatedRedPartnerRevenue",
  "monetizedPlaybacks",
  "playbackBasedCpm",
  "adImpressions",
  "cpm",
] as const

export const YOUTUBE_DIMENSIONS = [
  "day",
  "month",
  "video",
  "playlist",
  "country",
  "province",
  "ageGroup",
  "gender",
  "deviceType",
  "operatingSystem",
  "insightTrafficSourceType",
  "insightPlaybackLocationType",
  "subscribedStatus",
  "youtubeProduct",
  "creatorContentType",
  "sharingService",
  "liveOrOnDemand",
] as const

const VIDEO_ID = /[A-Za-z0-9_-]{11}/
/** The uploads playlist of a channel: UU + the channel id's tail. */
const UPLOADS_PLAYLIST = /UU[A-Za-z0-9_-]{22}/
const DAY = /[0-9]{4}-[0-9]{2}-[0-9]{2}/
const PAGE_TOKEN = /[A-Za-z0-9_-]{1,100}/
/** Report filters: video, country, subscribed status, creator content type,
 *  joined with `;` as the Analytics API expects. */
const FILTER = "(video==[A-Za-z0-9_-]{11}|country==[A-Z]{2}|subscribedStatus==(SUBSCRIBED|UNSUBSCRIBED)|creatorContentType==[A-Z_]{1,30})"
const FILTERS = new RegExp(`${FILTER}(;${FILTER}){0,3}`)

function reportParams(metrics: readonly string[]): Record<string, ParamSpec> {
  return {
    startDate: { description: "First day, YYYY-MM-DD", required: true, pattern: DAY },
    endDate: { description: "Last day, YYYY-MM-DD", required: true, pattern: DAY },
    metrics: { description: "Comma-separated metrics", required: true, list: true, enum: metrics },
    dimensions: { description: "Comma-separated dimensions, e.g. day, video, country, ageGroup,gender", list: true, enum: YOUTUBE_DIMENSIONS },
    filters: { description: "e.g. video==<id>, country==US, creatorContentType==SHORTS; join several with ;", pattern: FILTERS },
    sort: { description: "Comma-separated; a leading - sorts descending, e.g. -views", list: true, pattern: /-?[A-Za-z]{1,40}/ },
    maxResults: { description: "Rows (1-200), needed with the video dimension", pattern: /[1-9][0-9]?|1[0-9]{2}|200/ },
  }
}

export const YOUTUBE: ProviderSpec = {
  kind: "youtube",
  title: "YouTube",
  baseUrl: DATA_API,
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: YOUTUBE_SCOPES,
    optionalScopes: { revenue: [YOUTUBE_REVENUE_SCOPE] },
    // Without these Google sends a refresh token only on the first consent.
    authorizeParams: { access_type: "offline", prompt: "consent" },
  },
  reads: {
    channel: {
      description: "The channel that signed in: title, subscriber, view and video counts, and its uploads playlist id (contentDetails.relatedPlaylists.uploads).",
      path: "/channels",
      params: {
        part: { description: "Comma-separated parts", list: true, enum: ["snippet", "statistics", "contentDetails", "brandingSettings", "status", "topicDetails"], default: "snippet,statistics,contentDetails" },
      },
      fixedQuery: { mine: "true" },
      scopes: [YOUTUBE_SCOPES[0]],
    },
    uploads: {
      description: "Recent uploads of the channel (video id, title, publish time). Use it to find video ids.",
      path: "/playlistItems",
      params: {
        playlistId: { description: "Uploads playlist id, UU… (from the `channel` read, or metadata.playlistId)", required: true, fromMetadata: true, pattern: UPLOADS_PLAYLIST },
        maxResults: { description: "How many items (1-50)", pattern: /[1-9]|[1-4][0-9]|50/, default: "25" },
        pageToken: { description: "nextPageToken from the previous answer", pattern: PAGE_TOKEN },
      },
      fixedQuery: { part: "snippet,contentDetails" },
      scopes: [YOUTUBE_SCOPES[0]],
    },
    videos: {
      description: "Details and public counts (views, likes, comments) for up to 50 videos, plus duration and privacy status.",
      path: "/videos",
      params: {
        id: { description: "Comma-separated video ids (from `uploads`)", required: true, list: true, pattern: VIDEO_ID },
        part: { description: "Comma-separated parts", list: true, enum: ["snippet", "statistics", "contentDetails", "status"], default: "snippet,statistics,contentDetails" },
      },
      scopes: [YOUTUBE_SCOPES[0]],
    },
    report: {
      description: "YouTube Analytics for the channel: views, watch time, engagement, subscribers, and audience (viewerPercentage by ageGroup,gender). Split by day, video, country, traffic source, device or Shorts (creatorContentType).",
      baseUrl: ANALYTICS_API,
      path: "/reports",
      params: reportParams(YOUTUBE_METRICS),
      fixedQuery: { ids: "channel==MINE" },
      scopes: [YOUTUBE_SCOPES[1]],
    },
    revenue_report: {
      description: "Estimated revenue, ad revenue, CPM and monetized playbacks. Needs `connect --with revenue` and a Partner Program channel; otherwise YouTube answers 403.",
      baseUrl: ANALYTICS_API,
      path: "/reports",
      params: {
        ...reportParams(YOUTUBE_REVENUE_METRICS),
        currency: { description: "ISO 4217 currency, e.g. USD", pattern: /[A-Z]{3}/ },
      },
      fixedQuery: { ids: "channel==MINE" },
      scopes: [YOUTUBE_SCOPES[1], YOUTUBE_REVENUE_SCOPE],
    },
  },
}
