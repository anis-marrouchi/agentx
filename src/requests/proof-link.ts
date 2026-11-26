import { checkIssue, type CommitReader, type ForgeReader } from "./checkers/issue"
import { checkUrl } from "./checkers/url"
import { safeFetch } from "./checkers/fetch-guard"
import type { CheckResult, IssueState } from "./checkers"

// --- Open a proof link and check it matches the claim (#2122) ---
//
// A close that names a link (a delegation that came back done, a promise
// kept) was stored with the link as text: nobody opened it. This opens
// it, once, with the checkers that already exist:
//
// - a GitHub or GitLab issue, pull or merge request, or commit link is
//   read through the forge API with the connector's own token, not by
//   scraping its page: it exists, and is merged or closed when the claim
//   says so;
// - any other http(s) link goes through the URL check (behind its fetch
//   guard): it answers 2xx, and holds the ref the claim names (a sha, an
//   issue or merge request number) when it names one.
//
// verified: the link shows it. failed: it does not (a 404 page, an MR not
// merged when the claim says merged). unverifiable: it could not be told
// (a private host, no connector, a timeout, not http, or a page that would
// not let us read it: 401, 403, 407, 429 or 5xx). Unverifiable never
// counts as a pass. Never throws.
//
// A failure is firm when the link itself shows the claim is false: the
// forge API gives another state or sha, or the page answers 404 or 410.
// "The ref is not on the page" is not firm: many pages build their text
// in the browser, and a plain fetch never sees it. Only a firm failure
// may refuse a close (requests.proofCheck.mode "block", PR 2 review C2).

export type ProofLinkState = "verified" | "failed" | "unverifiable"

export interface ProofLinkResult {
  state: ProofLinkState
  /** What was seen, or why it could not be checked. One line, for people. */
  detail: string
  /** Set on a failure the link itself shows: a wrong forge state or sha,
   *  or a 404 or 410 page. Only these may refuse a close. */
  firm?: true
}

export interface ProofLinkContext {
  /** Reads an issue or merge request through the connector. */
  forge?: ForgeReader
  /** Reads a commit through the connector. */
  commit?: CommitReader
  /** The GitLab connector's address. A GitLab-style link on another host
   *  is opened as a plain page: the connector's token is not for it. */
  gitlabUrl?: string | null
  /** The URL check's fetch. Unset: the guarded fetch. */
  fetch?: typeof fetch
}

const LINK_MAX = 1000
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"])

/** A forge item a link points at, or null when it is a plain page. */
export type ForgeLink =
  | { kind: "item"; provider: "github" | "gitlab"; ref: string; mr: boolean }
  | { kind: "commit"; provider: "github" | "gitlab"; project: string; sha: string }

export function forgeLinkOf(u: URL, gitlabUrl?: string | null): ForgeLink | null {
  const path = u.pathname.replace(/\/+$/, "")
  if (GITHUB_HOSTS.has(u.hostname.toLowerCase())) {
    const commit = path.match(/^\/([\w.-]+\/[\w.-]+)\/(?:commit|pull\/\d+\/commits)\/([0-9a-f]{7,40})$/i)
    if (commit) return { kind: "commit", provider: "github", project: commit[1], sha: commit[2] }
    const item = path.match(/^\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)(?:\/[\w-]+)?$/)
    if (item) return { kind: "item", provider: "github", ref: `${item[1]}#${item[3]}`, mr: item[2] === "pull" }
    return null
  }
  let gitlabHost: string | null = null
  try { gitlabHost = gitlabUrl ? new URL(gitlabUrl).host.toLowerCase() : null } catch { gitlabHost = null }
  if (!gitlabHost || u.host.toLowerCase() !== gitlabHost) return null
  const commit = path.match(/^\/(.+?)\/-\/commit\/([0-9a-f]{7,40})$/i)
  if (commit) return { kind: "commit", provider: "gitlab", project: commit[1], sha: commit[2] }
  const item = path.match(/^\/(.+?)\/-\/(issues|merge_requests)\/(\d+)(?:\/[\w-]+)?$/)
  if (item) return { kind: "item", provider: "gitlab", ref: `${item[1]}${item[2] === "merge_requests" ? "!" : "#"}${item[3]}`, mr: item[2] === "merge_requests" }
  return null
}

/** The state a claim says the item is in: merged, closed, or none. */
export function claimedState(claim: string, mr: boolean): IssueState | null {
  if (mr && /\bmerged\b/i.test(claim)) return "merged"
  if (/\b(merged|closed|fixed|resolved)\b/i.test(claim)) return "closed"
  return null
}

/** The ref a claim names, for a plain page to hold: a commit sha (with
 *  a letter in it, so a long number is not taken for one), else an issue
 *  ("#12") or merge request ("!12") number. Null when it names none. */
export function claimedRef(claim: string): string | null {
  const sha = claim.match(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i)
  if (sha) return sha[0]
  const ref = claim.match(/(?:^|[^\w&])([#!]\d+)\b/)
  return ref ? ref[1] : null
}

/** HTTP answers that mean the page is gone: the claim is false. Any
 *  other non-2xx (401, 403, 407, 429, 5xx...) means it could not be read. */
const GONE = new Set([404, 410])

/** The forge check's verdict: not met is a wrong state, which is firm. */
const fromIssueCheck = (r: CheckResult): ProofLinkResult =>
  r.verdict === "met" ? { state: "verified", detail: r.detail }
    : r.verdict === "not_met" ? { state: "failed", detail: r.detail, firm: true }
    : { state: "unverifiable", detail: r.detail }

/** The URL check's verdict, read with the HTTP status it got. checkUrl
 *  itself is left as it is: plan steps (#788) and loops (#1039) keep
 *  treating every non-2xx as not met. */
export function fromCheck(r: CheckResult, status: number | null): ProofLinkResult {
  if (r.verdict === "met") return { state: "verified", detail: r.detail }
  if (r.verdict !== "not_met") return { state: "unverifiable", detail: r.detail }
  if (status === null || (status >= 200 && status < 300)) return { state: "failed", detail: r.detail }
  return GONE.has(status) ? { state: "failed", detail: r.detail, firm: true } : { state: "unverifiable", detail: `${r.detail}: the page could not be read` }
}

/** Open `link` and check it shows what `claim` says. */
export async function checkProofLink(link: string, claim: string, ctx: ProofLinkContext = {}): Promise<ProofLinkResult> {
  const raw = (link ?? "").trim()
  let u: URL
  try { u = new URL(raw) } catch { return { state: "unverifiable", detail: `${raw.slice(0, 200) || "the proof"} is not a link` } }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { state: "unverifiable", detail: `${raw.slice(0, 200)} is not an http(s) link` }
  if (raw.length > LINK_MAX) return { state: "unverifiable", detail: `the link is longer than ${LINK_MAX} characters` }
  try {
    const forge = forgeLinkOf(u, ctx.gitlabUrl)
    if (forge?.kind === "commit") {
      if (!ctx.commit) return { state: "unverifiable", detail: `no ${forge.provider} connector on this node to read ${raw}` }
      const c = await ctx.commit(forge.provider, forge.project, forge.sha)
      if ("error" in c) return { state: "unverifiable", detail: `${raw}: ${c.error}` }
      return c.sha.toLowerCase().startsWith(forge.sha.toLowerCase())
        ? { state: "verified", detail: `${c.url} is commit ${c.sha.slice(0, 12)}` }
        : { state: "failed", detail: `${raw} is commit ${c.sha.slice(0, 12) || "unknown"}, not ${forge.sha}`, firm: true }
    }
    if (forge?.kind === "item") {
      const want = claimedState(claim ?? "", forge.mr)
      if (want) return fromIssueCheck(await checkIssue({ kind: "issue", provider: forge.provider, ref: forge.ref, state: want }, { forge: ctx.forge }))
      // No state claimed: that the item exists and the connector can read
      // it is what the link shows.
      if (!ctx.forge) return { state: "unverifiable", detail: `no ${forge.provider} connector on this node to read ${raw}` }
      const [, project, sign, n] = forge.ref.match(/^(.+)([#!])(\d+)$/)!
      const item = await ctx.forge(forge.provider, { project, number: Number(n), mr: sign === "!" || forge.mr }, { notes: false })
      if ("error" in item) return { state: "unverifiable", detail: `${forge.ref}: ${item.error}` }
      return { state: "verified", detail: `${item.url} is ${item.state}` }
    }
    const contains = claimedRef(claim ?? "")
    // The status the page answered, seen through the URL check's own fetch.
    let status: number | null = null
    const base = ctx.fetch ?? safeFetch
    const seen = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const res = await base(input, init)
      status = res.status
      return res
    }) as typeof fetch
    const r = await checkUrl({ kind: "url", url: raw, ...(contains ? { contains } : {}) }, { fetch: seen })
    return fromCheck(r, status)
  } catch (e: any) {
    return { state: "unverifiable", detail: `the link check failed: ${String(e?.message ?? e).slice(0, 200)}` }
  }
}

/** What a close records from the check: verified only when the link
 *  showed it; otherwise unverified, with the reason (#2122). */
export function proofVerify(r: ProofLinkResult): { state: "verified" | "unverified"; detail: string } {
  if (r.state === "verified") return { state: "verified", detail: `Link checked: ${r.detail}` }
  return { state: "unverified", detail: `${r.state === "failed" ? "Link did not check out" : "Link not checked"}: ${r.detail}` }
}
