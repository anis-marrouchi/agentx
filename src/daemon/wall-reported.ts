import { redactSecrets } from "@/agents/memory-trust"
import { summarize } from "@/requests/card-view"
import { forgeHeaders, parseRef, type ForgeConnectors } from "@/requests/checkers/issue"
import { failureSignature, WALL_PREFIX } from "./wall-api"
import { forgeCache, isForgeError, LATE_QUICK, type ForgeAnswer, type ForgeCacheOptions } from "./wall-forge-cache"

// --- The Wall's reported failures (#1186) ---
//
// A reporting job (a cron that watches something) opens an issue on a
// forge for each incident and tags it with a label. With
// `wall.reportedIssues` set, the Failures tab reads the open issues with
// that label, one GET per configured project, and shows one row per dedupe
// signature: how many, last seen, and a link to the newest. The signature
// is the first capture of `titleSignature` on the title, else the title
// normalized like the tab's own errors. Read only, through this node's
// forge connector (its token stays here), cached and time-boxed like the
// forge state (wall-forge-cache.ts). Unset: nothing is read.

const PAGE = 100
const TIMEOUT_MS = 10_000
const TITLE_MAX = 300

export interface ReportedSource { forge: "github" | "gitlab"; project: string }

export interface ReportedIssuesConfig {
  label: string
  titleSignature?: string
  sources: ReportedSource[]
}

export interface ReportedIssue {
  /** "owner/repo#12". */
  ref: string
  title: string
  url: string
  updatedAt: number
}

/** One page of open labelled issues, newest first. `truncated`: there may be more. */
export interface ReportedPage { issues: ReportedIssue[]; truncated: boolean }

export type ReportedReader = (source: ReportedSource, label: string) => Promise<ForgeAnswer<ReportedPage>>

export interface WallReportedGroup {
  signature: string
  count: number
  /** Newest updated_at in the group. */
  lastAt: number
  /** The newest issue of the group. */
  ref: string
  title: string
  url: string
}

export interface WallReported {
  label: string
  groups: WallReportedGroup[]
  /** Projects that could not be read this time, and why. */
  unread: Array<ReportedSource & { why: string }>
  /** Projects with more open issues than one page: only the newest are grouped. */
  truncated: ReportedSource[]
}

/** The open issues with the label on one project, over the forge's REST API. */
export function reportedReader(connectors: ForgeConnectors, doFetch: typeof fetch = fetch): ReportedReader {
  return async (source, label) => {
    if (!parseRef(source.forge, `${source.project}#1`)) return { error: "not a project path" }
    const l = encodeURIComponent(label)
    let url: string
    if (source.forge === "github") {
      const c = connectors.github
      if (!c) return { error: "no github connector on this node" }
      url = `${c.apiUrl.replace(/\/$/, "")}/repos/${source.project}/issues?state=open&labels=${l}&sort=updated&direction=desc&per_page=${PAGE}`
    } else {
      const c = connectors.gitlab
      if (!c) return { error: "no gitlab connector on this node" }
      url = `${c.url.replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(source.project)}/issues?state=opened&labels=${l}&order_by=updated_at&sort=desc&per_page=${PAGE}`
    }
    let res: Response
    try {
      res = await doFetch(url, { headers: forgeHeaders(source.forge, connectors), signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e: any) {
      return { error: `could not be reached: ${String(e?.message ?? e).slice(0, 120)}` }
    }
    if (!res.ok) return { error: res.status === 404 ? "not found (or not visible to the connector)" : `HTTP ${res.status}` }
    const body: any = await res.json().catch(() => null)
    if (!Array.isArray(body)) return { error: "no issue list in the answer" }
    const issues = body.flatMap((x: any): ReportedIssue[] => {
      if (!x || x.pull_request) return []
      const n = Number(source.forge === "github" ? x.number : x.iid)
      const link = String((source.forge === "github" ? x.html_url : x.web_url) ?? "")
      if (!Number.isInteger(n) || !/^https?:\/\//i.test(link)) return []
      const at = Date.parse(String(x.updated_at ?? ""))
      return [{ ref: `${source.project}#${n}`, title: String(x.title ?? "").slice(0, TITLE_MAX), url: link, updatedAt: Number.isFinite(at) ? at : 0 }]
    })
    return { issues, truncated: body.length >= PAGE }
  }
}

/** The reporter's dedupe signature: the first capture of the pattern on
 *  the title, else the normalized title. */
export function signatureOf(title: string, pattern: RegExp | null): string {
  const got = pattern?.exec(title)?.[1]?.trim()
  return got ? got.slice(0, 120) : failureSignature(title)
}

/** One row per signature, newest first. */
export function groupReported(issues: ReportedIssue[], pattern: RegExp | null): WallReportedGroup[] {
  const groups = new Map<string, WallReportedGroup>()
  for (const i of issues) {
    const sig = signatureOf(i.title, pattern)
    const newest = { lastAt: i.updatedAt, ref: i.ref, title: redactSecrets(summarize(i.title, 200)), url: i.url }
    const g = groups.get(sig)
    if (!g) groups.set(sig, { signature: redactSecrets(sig), count: 1, ...newest })
    else {
      g.count++
      if (i.updatedAt > g.lastAt) Object.assign(g, newest)
    }
  }
  return [...groups.values()].sort((a, b) => b.lastAt - a.lastAt)
}

export interface WallReportedSource {
  /** A quick read waits only briefly (#1442). */
  read(quick?: boolean): Promise<WallReported>
  /** True while a read started earlier has not answered yet. */
  busy(): boolean
}

/** The cached, time-boxed source of reported failures for the Wall. */
export function wallReported(cfg: ReportedIssuesConfig, read: ReportedReader, opts: ForgeCacheOptions = {}): WallReportedSource {
  const pattern = cfg.titleSignature ? new RegExp(cfg.titleSignature) : null
  const cache = forgeCache<ReportedSource, ReportedPage>((s) => read(s, cfg.label), opts)
  return {
    busy: cache.busy,
    async read(quick) {
      const refs = new Map(cfg.sources.map((s) => [`${s.forge}:${s.project}`, s] as const))
      const reads = await cache.readAll(refs, quick)
      const issues: ReportedIssue[] = []
      const unread: WallReported["unread"] = []
      const truncated: ReportedSource[] = []
      for (const [key, s] of refs) {
        const got = reads.get(key)
        const source = { forge: s.forge, project: s.project }
        if (!got || got.kind !== "answer") { unread.push({ ...source, why: got?.kind === "late" ? (quick ? LATE_QUICK : "did not answer in time") : "not read yet" }); continue }
        if (isForgeError(got.answer)) { unread.push({ ...source, why: got.answer.error }); continue }
        issues.push(...got.answer.issues)
        if (got.answer.truncated) truncated.push(source)
      }
      return { label: cfg.label, groups: groupReported(issues, pattern), unread, truncated }
    },
  }
}

/** The Wall's list reply with `reported` set, when the source is configured.
 *  Threads and other paths, and a node without the setting, are unchanged. */
export async function withReported(
  reply: { status: number; body: unknown }, path: string, source: WallReportedSource | null, quick?: boolean,
): Promise<{ status: number; body: unknown }> {
  if (!source || reply.status !== 200 || path !== WALL_PREFIX || !reply.body || typeof reply.body !== "object") return reply
  return { ...reply, body: { ...reply.body, reported: await source.read(quick) } }
}
