import { execa } from "execa"
import type { PrRecord } from "./classify"

// --- Quality report: GitHub reads through the `gh` CLI ---
//
// `gh` carries the operator's own auth, so the command needs no token
// setting of its own. Every call here is read-only.

export type GhRunner = (args: string[]) => Promise<string>

export const runGh: GhRunner = async (args) => {
  const { stdout } = await execa("gh", args, { maxBuffer: 256 * 1024 * 1024 })
  return stdout
}

const DAY = 86_400_000

const PR_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title body createdAt mergedAt headRefName
        labels(first: 20) { nodes { name } }
        files(first: 100) { nodes { path } }
        closingIssuesReferences(first: 10) { nodes { number createdAt } }
        commits(first: 100) { nodes { commit { oid } } }
      }
    }
  }
}`

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10)

/** Inclusive 7-day [from, to] day ranges covering fromDay..toDay. */
export function weekChunks(fromDay: string, toDay: string): Array<[string, string]> {
  const chunks: Array<[string, string]> = []
  for (let t = Date.parse(fromDay); t <= Date.parse(toDay); t += 7 * DAY) {
    chunks.push([isoDay(t), isoDay(Math.min(t + 6 * DAY, Date.parse(toDay)))])
  }
  return chunks
}

/**
 * Merged PRs on `base` from `fromDay` to `toDay` (inclusive, UTC days).
 * The range is split into 7-day searches, run in parallel, because GitHub
 * search stops at 1,000 results.
 */
export async function fetchMergedPrs(
  repo: string, base: string, fromDay: string, toDay: string, gh: GhRunner = runGh,
): Promise<PrRecord[]> {
  const lists = await Promise.all(weekChunks(fromDay, toDay).map(async ([a, b]) => {
    const q = `repo:${repo} is:pr is:merged base:${base} merged:${a}..${b}`
    const out: PrRecord[] = []
    let cursor: string | null = null
    do {
      const args = ["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", `q=${q}`]
      if (cursor) args.push("-f", `cursor=${cursor}`)
      const res = JSON.parse(await gh(args))
      const search = res.data.search
      for (const n of search.nodes) if (n && n.number) out.push(toRecord(n))
      cursor = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null
    } while (cursor)
    return out
  }))
  const byNumber = new Map<number, PrRecord>()
  for (const p of lists.flat()) byNumber.set(p.number, p)
  return [...byNumber.values()].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))
}

function toRecord(n: any): PrRecord {
  return {
    number: n.number,
    title: n.title || "",
    body: n.body || "",
    createdAt: n.createdAt,
    mergedAt: n.mergedAt,
    headRefName: n.headRefName || "",
    labels: (n.labels?.nodes || []).map((l: any) => l.name),
    files: (n.files?.nodes || []).map((f: any) => f.path),
    closingIssues: (n.closingIssuesReferences?.nodes || []).map((i: any) => ({ number: i.number, createdAt: i.createdAt })),
    commits: (n.commits?.nodes || []).map((c: any) => c.commit.oid),
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }))
  return out
}

/**
 * CI minutes per PR: the sum of job durations of `workflow` runs whose head
 * commit is one of the PR's commits. Runs are listed from the oldest PR's
 * creation day (at most 30 days before `fromDay`) through `toDay`.
 */
export async function fetchCiMinutes(
  repo: string, prs: PrRecord[], fromDay: string, toDay: string,
  opts: { workflow?: string; gh?: GhRunner; cache?: Map<number, number> } = {},
): Promise<Map<number, number>> {
  const { workflow = "ci.yml", gh = runGh, cache = new Map<number, number>() } = opts
  const oldest = Math.min(...prs.map((p) => Date.parse(p.createdAt)), Date.parse(fromDay))
  const start = isoDay(Math.max(oldest, Date.parse(fromDay) - 30 * DAY))
  const prBySha = new Map<string, number>()
  for (const p of prs) for (const sha of p.commits) prBySha.set(sha, p.number)

  // Per 7-day chunk (GitHub stops a filtered run list at 1,000): the first
  // page gives the total, the rest are read in parallel.
  const listChunk = async ([a, b]: [string, string]) => {
    const page = async (n: number) => JSON.parse(await gh([
      "api", `repos/${repo}/actions/workflows/${workflow}/runs?created=${a}..${b}&per_page=100&page=${n}`,
    ]))
    const first = await page(1)
    const pages = Math.min(Math.ceil((first.total_count || 0) / 100), 10)
    const rest = await mapLimit(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2), 8, page)
    return [first, ...rest].flatMap((res) => res.workflow_runs || [])
  }
  const runs: Array<{ id: number; pr: number; done: boolean }> = []
  const seen = new Set<number>()
  for (const r of (await Promise.all(weekChunks(start, toDay).map(listChunk))).flat()) {
    const pr = prBySha.get(r.head_sha)
    if (pr !== undefined && !seen.has(r.id)) { seen.add(r.id); runs.push({ id: r.id, pr, done: r.status === "completed" }) }
  }

  const minutes = new Map<number, number>()
  for (const p of prs) minutes.set(p.number, 0)
  // A completed run's jobs never change, so `cache` (run id → minutes)
  // saves one call per run on the next report.
  const perRun = await mapLimit(runs, 32, async (run) => {
    const hit = cache.get(run.id)
    if (hit !== undefined) return hit
    const res = JSON.parse(await gh(["api", `repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100`]))
    let ms = 0
    for (const j of res.jobs || []) {
      if (j.started_at && j.completed_at) ms += Math.max(0, Date.parse(j.completed_at) - Date.parse(j.started_at))
    }
    const min = ms / 60_000
    if (run.done) cache.set(run.id, min)
    return min
  })
  runs.forEach((run, i) => minutes.set(run.pr, (minutes.get(run.pr) || 0) + perRun[i]))
  return minutes
}

/** `owner/name` of the current checkout's origin, or null. */
export async function detectRepo(): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["remote", "get-url", "origin"])
    const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\/?$/.exec(stdout.trim())
    return m ? m[1] : null
  } catch {
    return null
  }
}
