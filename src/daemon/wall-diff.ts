import type { RequestRecord, RequestStore } from "@/requests/store"
import { createReviewGateGitHub } from "@/quality/review-gate-github"
import { createReviewGateGitLab } from "@/quality/review-gate-gitlab"
import { capDiff, parseUnifiedDiff } from "./diff-parse"
import { HUB_NAME } from "./ui/hub-name"
import { forgeHomeOf, type ForgeHome } from "./wall-forge-state"

// --- The Hub's Diff view (#2102) ---
//
// A request mostly lives on an issue (HOME_KINDS, requests/store.ts), and
// the work on it lands in one or more pull or merge requests. A post whose
// home is a GitHub or GitLab issue, or already a PR or MR, finds those:
//   - the PR/MR links in the request's own record: its home, evidence,
//     words, owner's note, proof links, request links and the agent's last
//     answer;
//   - on GitHub, the issue timeline's cross-references from a pull request
//     of the same repository; on GitLab, the issue's related merge
//     requests.
// Open ones first; the list is kept per request for PRS_TTL_MS.
//
//   GET  /api/admin/wall/diff?id=<request id>[&pr=<ref>]
//        {prs: [{ref, title, state, headSha}], ref, provider, title, state,
//        headSha, files, truncated}: the PRs found, and the diff of `pr`
//        (one of them) or else the first open one, parsed into files, hunks
//        and numbered lines (diff-parse.ts), at most DIFF_LINES_MAX lines.
//        No PR found: prs is empty and ref null.
//   POST /api/admin/wall/diff-comments  {id, pr?, headSha?, comments: [{file, side, line, text, code?}]}
//        the comments as one message to the agent that has the request,
//        exactly as a comment on the post goes (wall-actions.ts). The
//        message names the commit the lines were read at; when the PR's
//        head has moved since, it says so and the answer has moved: true.
//
// Both are under /api/admin/, so a post kept on a mesh peer is read and
// commented on at that peer, through the board's peer proxy, as a Wall
// comment is.

export const WALL_DIFF_PATH = "/api/admin/wall/diff"
/** The most diff lines one answer carries. */
export const DIFF_LINES_MAX = 3000
export const DIFF_COMMENTS_MAX = 50
export const DIFF_COMMENT_TEXT_MAX = 2000
/** The longest code line a comment quotes. */
const CODE_MAX = 300
/** How long the PRs found for a request are kept. */
export const PRS_TTL_MS = 60_000
/** The most PRs looked up for one request. */
const PRS_MAX = 10

/** The forge home of a post that has or may have a diff: a GitHub or
 *  GitLab issue, pull request or merge request. Null: no forge home. */
export function diffHomeOf(r: Pick<RequestRecord, "home" | "channel" | "chatId">, gitlabUrl: string | null | undefined): ForgeHome | null {
  return forgeHomeOf({ home: r.home, group: { channel: r.channel, chatId: r.chatId } }, gitlabUrl)
}

/** One PR or MR of a post, as the Hub shows it. */
export interface WallPr {
  /** "owner/repo#12" or "group/project!12". */
  ref: string
  title: string
  /** open, closed, merged, or unknown when it could not be read. */
  state: string
  headSha: string | null
}

export interface FoundPr extends WallPr { home: ForgeHome }

type PrInfo = { title: string; state: string; headSha: string | null }

/** The forge reads of the Diff view. */
export interface WallForge {
  /** A PR's or MR's title, state and head commit, read now. */
  pull: (home: ForgeHome) => Promise<PrInfo>
  /** The PRs or MRs that name this issue on the forge. */
  linked: (issue: ForgeHome) => Promise<Array<PrInfo & { home: ForgeHome }>>
  /** The unified diff: the review gate's getDiff for its forge. */
  diff: (home: ForgeHome) => Promise<string>
}

export interface WallDiffDeps {
  store: Pick<RequestStore, "get" | "links"> & Partial<Pick<RequestStore, "lastAnswer">>
  gitlabUrl: string | null | undefined
  forge: WallForge
  now?: () => number
  /** The PRs found per request; default: one kept for the process. */
  cache?: Map<string, { at: number; prs: FoundPr[] }>
}

export type Reply = { status: number; body: unknown }

const PRS_CACHE = new Map<string, { at: number; prs: FoundPr[] }>()

const githubPr = (project: string, n: number): ForgeHome => ({ provider: "github", ref: { project, number: n, mr: true }, key: `${project}#${n}` })
const gitlabMr = (project: string, n: number): ForgeHome => ({ provider: "gitlab", ref: { project, number: n, mr: true }, key: `${project}!${n}` })
const forgeName = (h: Pick<ForgeHome, "provider">) => (h.provider === "github" ? "GitHub" : "GitLab")

/** The PR/MR links in some text, on the home's forge. */
export function prLinksIn(texts: Array<string | null | undefined>, provider: ForgeHome["provider"], gitlabUrl: string | null | undefined): ForgeHome[] {
  const out: ForgeHome[] = []
  let gitlab: RegExp | null = null
  if (provider === "gitlab" && gitlabUrl) {
    try {
      const host = new URL(gitlabUrl).host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      gitlab = new RegExp(`https?://${host}/([\\w.-]+(?:/[\\w.-]+)+)/-/merge_requests/(\\d+)`, "gi")
    } catch { /* no GitLab address: no GitLab links */ }
  }
  for (const t of texts) {
    if (!t) continue
    if (provider === "github") for (const m of t.matchAll(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi)) out.push(githubPr(m[1], Number(m[2])))
    else if (gitlab) for (const m of t.matchAll(gitlab)) out.push(gitlabMr(m[1], Number(m[2])))
  }
  return out
}

/** The request's PRs and MRs, open first (see the top of this file). */
export async function findPrs(r: RequestRecord, home: ForgeHome, deps: WallDiffDeps): Promise<FoundPr[]> {
  const cache = deps.cache ?? PRS_CACHE
  const now = deps.now?.() ?? Date.now()
  const key = `${r.id}\n${home.key}`
  const kept = cache.get(key)
  if (kept && now - kept.at < PRS_TTL_MS) return kept.prs
  const found = new Map<string, FoundPr>()
  const keep = (h: ForgeHome, info: PrInfo) => { if (!found.has(h.key)) found.set(h.key, { ref: h.key, title: info.title, state: info.state, headSha: info.headSha, home: h }) }
  let answer: string | null = null
  try { answer = deps.store.lastAnswer?.(r.id)?.text ?? null } catch { /* no traces here */ }
  const texts = [r.home?.link, r.evidence, r.text, r.ownerNote, answer, ...(r.deliverableProofs ?? []).map((p) => p.link), ...deps.store.links(r.id).map((l) => l.ref)]
  const named = [...(home.ref.mr ? [home] : []), ...prLinksIn(texts, home.provider, deps.gitlabUrl)]
    .filter((h, i, all) => all.findIndex((o) => o.key === h.key) === i).slice(0, PRS_MAX)
  for (const h of named) keep(h, await deps.forge.pull(h).catch(() => ({ title: "", state: "unknown", headSha: null })))
  if (!home.ref.mr) {
    try {
      for (const p of (await deps.forge.linked(home)).slice(0, PRS_MAX)) keep(p.home, p)
    } catch (e) {
      // With nothing found, the forge's silence is the answer's error.
      if (!found.size) throw e
    }
  }
  const prs = [...found.values()].sort((a, b) => Number(b.state === "open") - Number(a.state === "open"))
  cache.set(key, { at: now, prs })
  return prs
}

const publicPr = (p: FoundPr): WallPr => ({ ref: p.ref, title: p.title, state: p.state, headSha: p.headSha })

/** The post, its PRs and the one asked for (else the first open one). */
export async function diffTarget(id: string, pr: string, deps: WallDiffDeps | null | undefined): Promise<Reply | { home: ForgeHome; prs: FoundPr[]; pick: FoundPr | null }> {
  const r = deps?.store.get(id)
  if (!deps || !r || r.state === "candidate") return { status: 404, body: { error: `no post "${id}" on this computer` } }
  const home = diffHomeOf(r, deps.gitlabUrl)
  if (!home) return { status: 400, body: { error: "not on a GitHub or GitLab issue, pull request or merge request" } }
  let prs: FoundPr[]
  try {
    prs = await findPrs(r, home, deps)
  } catch (e: any) {
    return { status: 502, body: { error: `${forgeName(home)} did not list the pull or merge requests: ${e?.message ?? e}` } }
  }
  if (!pr) return { home, prs, pick: prs[0] ?? null }
  const pick = prs.find((p) => p.ref === pr)
  if (!pick) return { status: 400, body: { error: `${pr} is not a pull or merge request of this post` } }
  return { home, prs, pick }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

export async function handleWallDiff(q: { id?: unknown; pr?: unknown }, deps: WallDiffDeps | null | undefined): Promise<Reply> {
  const id = str(q.id)
  if (!id) return { status: 400, body: { error: "send ?id=<post id>" } }
  const t = await diffTarget(id, str(q.pr), deps)
  if ("status" in t) return t
  const { home, prs, pick } = t
  if (!pick) return { status: 200, body: { prs: [], ref: null, provider: home.provider, title: null, state: null, headSha: null, files: [], truncated: false } }
  let text: string
  let head: PrInfo | null
  try {
    // The head is read again with the diff: the cached list may be a minute old.
    ;[text, head] = await Promise.all([deps!.forge.diff(pick.home), deps!.forge.pull(pick.home).catch(() => null)])
  } catch (e: any) {
    return { status: 502, body: { error: `${forgeName(home)} did not give the diff: ${e?.message ?? e}` } }
  }
  const { files, truncated } = capDiff(parseUnifiedDiff(text), DIFF_LINES_MAX)
  return { status: 200, body: { prs: prs.map(publicPr), ref: pick.ref, provider: pick.home.provider, title: pick.title, state: pick.state, headSha: head?.headSha ?? pick.headSha, files, truncated } }
}

/** The forge reads, with this node's forge tokens (forgeConnectorsOf). */
export function createWallForge(c: { githubToken?: string; gitlabUrl?: string | null; gitlabToken?: string }, fetchImpl: typeof fetch = fetch): WallForge {
  const gh = createReviewGateGitHub(async () => c.githubToken, fetchImpl)
  const gl = createReviewGateGitLab(c.gitlabUrl ?? "", () => c.gitlabToken, fetchImpl)
  const get = async (url: string, headers: Record<string, string>, what: string): Promise<any> => {
    const res = await fetchImpl(url, { headers: { "User-Agent": "AgentX", ...headers }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`${what}: ${res.status}`)
    return res.json()
  }
  const glBase = (c.gitlabUrl ?? "").replace(/\/+$/, "")
  const glState = (s: unknown) => (s === "opened" ? "open" : typeof s === "string" ? s : "unknown")
  return {
    async pull(home) {
      const p = await (home.provider === "github" ? gh : gl).getPullRequest(home.ref.project, home.ref.number)
      return { title: p.title, state: p.state, headSha: p.headSha ?? null }
    },
    async linked(issue) {
      if (issue.provider === "github") {
        if (!c.githubToken) throw new Error(`no GitHub token for ${issue.ref.project}`)
        const repo = issue.ref.project
        const path = `/repos/${repo}/issues/${issue.ref.number}/timeline`
        const out: Array<PrInfo & { home: ForgeHome }> = []
        for (let page = 1; page <= 3; page++) {
          const rows = await get(`https://api.github.com${path}?per_page=100&page=${page}`, {
            Authorization: `Bearer ${c.githubToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
          }, `GitHub GET ${path}`) as any[]
          for (const e of rows) {
            const src = e?.event === "cross-referenced" ? e.source?.issue : null
            if (!src?.pull_request || typeof src.number !== "number") continue
            if (String(src.repository?.full_name ?? "").toLowerCase() !== repo.toLowerCase()) continue
            const home = githubPr(repo, src.number)
            if (out.some((o) => o.home.key === home.key)) continue
            const state = src.state === "open" ? "open" : src.pull_request.merged_at ? "merged" : "closed"
            out.push({ home, title: String(src.title ?? ""), state, headSha: null })
          }
          if (rows.length < 100) break
        }
        // The timeline has no head commit: each PR's own read gives it.
        for (const p of out.slice(0, PRS_MAX)) p.headSha = (await gh.getPullRequest(repo, p.home.ref.number).catch(() => null))?.headSha ?? null
        return out
      }
      if (!glBase || !c.gitlabToken) throw new Error("no GitLab token (channels.gitlab.token)")
      const path = `/projects/${encodeURIComponent(issue.ref.project)}/issues/${issue.ref.number}/related_merge_requests`
      const rows = await get(`${glBase}/api/v4${path}?per_page=100`, { "PRIVATE-TOKEN": c.gitlabToken, Accept: "application/json" }, `GitLab GET ${path}`) as any[]
      return rows.filter((m) => typeof m?.iid === "number").map((m) => {
        const full = typeof m.references?.full === "string" ? m.references.full.split("!")[0] : ""
        return { home: gitlabMr(full || issue.ref.project, m.iid), title: String(m.title ?? ""), state: glState(m.state), headSha: typeof m.sha === "string" ? m.sha : null }
      })
    },
    diff: (home) => (home.provider === "github" ? gh : gl).getDiff(home.ref.project, home.ref.number),
  }
}

export interface DiffComment {
  file: string
  side: "old" | "new"
  line: number
  text: string
  code?: string
}

/** The comments of a diff-comments body, or why they are refused. */
export function parseDiffComments(v: unknown): { comments: DiffComment[] } | { error: string } {
  if (!Array.isArray(v) || v.length < 1 || v.length > DIFF_COMMENTS_MAX) return { error: `send 1 to ${DIFF_COMMENTS_MAX} comments` }
  const comments: DiffComment[] = []
  for (const [i, c] of v.entries()) {
    const n = i + 1
    if (!c || typeof c !== "object") return { error: `comment ${n} is not an object` }
    const file = typeof c.file === "string" ? c.file.trim() : ""
    const text = typeof c.text === "string" ? c.text.trim() : ""
    if (!file || file.length > 500) return { error: `comment ${n} needs its file` }
    if (c.side !== "old" && c.side !== "new") return { error: `comment ${n}: side is old or new` }
    if (!Number.isInteger(c.line) || c.line < 1) return { error: `comment ${n}: line is a positive whole number` }
    if (!text) return { error: `comment ${n} is empty` }
    if (text.length > DIFF_COMMENT_TEXT_MAX) return { error: `comment ${n} is longer than ${DIFF_COMMENT_TEXT_MAX} characters` }
    const code = typeof c.code === "string" ? c.code.replace(/\s+/g, " ").trim().slice(0, CODE_MAX) : ""
    comments.push({ file, side: c.side, line: c.line, text, ...(code ? { code } : {}) })
  }
  return { comments }
}

/** A commit sha as the Hub sends it back; anything else is dropped. */
export function shaOf(v: unknown): string | null {
  return typeof v === "string" && /^[0-9a-f]{7,64}$/i.test(v.trim()) ? v.trim().toLowerCase() : null
}

/** The one message the agent gets: the ref and the commit the lines were
 *  read at, each comment in order, a word when the head has moved since,
 *  then what to do with them. */
export function diffCommentsMessage(home: Pick<ForgeHome, "provider" | "key">, comments: DiffComment[], at: { commit?: string | null; movedTo?: string | null } = {}): string {
  const kind = home.provider === "github" ? "pull request" : "merge request"
  const blocks = comments.map((c, i) => [
    `${i + 1}. \`${c.file}:${c.line}\` (${c.side})`,
    ...(c.code ? [`> ${c.code}`] : []),
    c.text,
  ].join("\n"))
  return [
    `Review comments on ${home.key}${at.commit ? ` on commit ${at.commit.slice(0, 12)}` : ""}, from the ${HUB_NAME}:`,
    ...blocks,
    ...(at.movedTo ? [`Note: the ${home.provider === "github" ? "PR" : "MR"} has moved to ${at.movedTo.slice(0, 12)} since these lines were read.`] : []),
    `Please address ${comments.length === 1 ? "it" : `all ${comments.length} of them`} on the ${kind}'s branch, push, and reply here when done.`,
  ].join("\n\n")
}
