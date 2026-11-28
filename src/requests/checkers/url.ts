import type { CheckContext, CheckResult, UrlSpec } from "./index"
import { localUrlRefused, safeFetch } from "./fetch-guard"

// --- url: the address answers 2xx, and holds the text when one is given ---
//
// The plan-step URL check of #788, shared with loops (#1039). Not
// reachable is unverifiable: the address may simply not be up yet.
// The daemon's own fetch goes through the fetch guard (#2122): a private,
// loopback or link-local address, or a redirect to one, is refused and
// so unverifiable. A caller that gives its own fetch (tests) owns that.

export const CHECK_TIMEOUT_MS = 10_000
export const CHECK_BODY_MAX = 1_000_000
const URL_MAX = 1000
const CONTAINS_MAX = 200

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

export function parseUrlSpec(raw: Record<string, unknown>): UrlSpec | string {
  const url = str(raw.url)
  if (!/^https?:\/\/\S+$/i.test(url)) return "url must be an http(s) address"
  if (url.length > URL_MAX) return `url is longer than ${URL_MAX} characters`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "url must be an http(s) address"
  }
  // Refused when made, not when closed (#2535): the check would never run.
  const local = localUrlRefused(parsed)
  if (local) return local
  const contains = str(raw.contains)
  if (contains.length > CONTAINS_MAX) return `contains is longer than ${CONTAINS_MAX} characters`
  return { kind: "url", url, ...(contains ? { contains } : {}) }
}

export async function checkUrl(spec: UrlSpec, ctx: Pick<CheckContext, "fetch">): Promise<CheckResult> {
  const doFetch = ctx.fetch ?? safeFetch
  let res: Response
  try {
    res = await doFetch(spec.url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), redirect: "follow" })
  } catch (e: any) {
    return { verdict: "unverifiable", detail: `${spec.url} could not be reached: ${String(e?.message ?? e).slice(0, 200)}` }
  }
  if (!res.ok) return { verdict: "not_met", detail: `${spec.url} answered HTTP ${res.status}` }
  if (spec.contains) {
    const body = (await res.text()).slice(0, CHECK_BODY_MAX)
    if (!body.includes(spec.contains)) return { verdict: "not_met", detail: `${spec.url} answered without "${spec.contains}"` }
  }
  return { verdict: "met", detail: `${spec.url} answered${spec.contains ? ` with "${spec.contains}"` : ""}` }
}
