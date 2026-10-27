// --- The Build's source: one public repository's activity on one day ---
//
// Only what anyone can see on GitHub without signing in: pull requests
// opened and merged, issues opened and closed. A private repository is
// refused, not filtered: the prototype only airs public work (#1471).
//
// What never goes on air, whatever the repository:
//   - people: no author, assignee or reviewer is read at all, and @handles
//     and email addresses are cut out of titles;
//   - money: amounts ($12, 30 EUR, €4.50) are cut out of titles;
//   - links: a title is spoken and shown, never followed.

export interface BuildPr {
  number: number
  title: string
  openedToday: boolean
  mergedToday: boolean
  /** Still open at the end of the day. */
  open: boolean
  draft: boolean
  /** From the pull request itself; unknown when it was not read. */
  additions?: number
  deletions?: number
  changedFiles?: number
}

export interface BuildIssue {
  number: number
  title: string
  openedToday: boolean
  closedToday: boolean
  open: boolean
}

export interface BuildActivity {
  repo: string
  /** YYYY-MM-DD in the machine's time zone. */
  day: string
  prs: BuildPr[]
  issues: BuildIssue[]
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

const API = "https://api.github.com"
/** Pull requests read for their size; the main story is picked among them. */
const SIZED = 6

/** Start and end of a local day, as epoch ms. */
export function dayBounds(day: string): [number, number] {
  const [y, m, d] = day.split("-").map(Number)
  const start = new Date(y, m - 1, d).getTime()
  return [start, new Date(y, m - 1, d + 1).getTime()]
}

/** Today as YYYY-MM-DD in the machine's time zone. */
export function localDay(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** A title with people, money and links taken out. */
export function scrubTitle(title: string): string {
  return String(title)
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "")
    .replace(/(^|[^\w])@[\w-]+(\/[\w-]+)?/g, "$1")
    .replace(/[$€£¥]\s?\d[\d,.]*\s?[kKmM]?/g, "")
    .replace(/\b\d[\d,.]*\s?(USD|EUR|GBP|TND|dollars?|euros?)\b/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
}

const within = (iso: string | null | undefined, [a, b]: [number, number]) => {
  if (!iso) return false
  const t = Date.parse(iso)
  return t >= a && t < b
}

/** Read one day of a public repository. Throws on a private repository
 *  or an API error; the caller says so and makes nothing. */
export async function readBuildActivity(repo: string, day: string, opts: { token?: string; fetch?: Fetch } = {}): Promise<BuildActivity> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`not a GitHub repository: ${repo} (want owner/name)`)
  const f = opts.fetch ?? fetch
  const get = async (path: string): Promise<any> => {
    const res = await f(`${API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "agentx-tv",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`)
    return res.json()
  }

  const meta = await get(`/repos/${repo}`)
  if (meta?.private !== false) throw new Error(`${repo} is not public; The Build only airs public repositories`)

  const bounds = dayBounds(day)
  const [start, end] = bounds

  // Pull requests, newest update first, until they are older than the day.
  const prs: BuildPr[] = []
  for (let page = 1; page <= 5; page++) {
    const list: any[] = await get(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`)
    for (const p of list) {
      const openedToday = within(p.created_at, bounds)
      const mergedToday = within(p.merged_at, bounds)
      if (!openedToday && !mergedToday) continue
      const closedBy = (iso: string | null) => !!iso && Date.parse(iso) < end
      prs.push({
        number: Number(p.number),
        title: scrubTitle(p.title),
        openedToday,
        mergedToday,
        open: !closedBy(p.closed_at) && !closedBy(p.merged_at),
        draft: !!p.draft,
      })
    }
    if (list.length < 100 || Date.parse(list.at(-1)?.updated_at ?? 0) < start) break
  }

  // Issues (the issues list also carries pull requests; those are skipped).
  const issues: BuildIssue[] = []
  const since = new Date(start).toISOString()
  for (let page = 1; page <= 5; page++) {
    const list: any[] = await get(`/repos/${repo}/issues?state=all&since=${encodeURIComponent(since)}&per_page=100&page=${page}`)
    for (const i of list) {
      if (i.pull_request) continue
      const openedToday = within(i.created_at, bounds)
      const closedToday = within(i.closed_at, bounds)
      if (!openedToday && !closedToday) continue
      issues.push({
        number: Number(i.number),
        title: scrubTitle(i.title),
        openedToday,
        closedToday,
        open: !i.closed_at || Date.parse(i.closed_at) >= end,
      })
    }
    if (list.length < 100) break
  }

  // Size of the merged pull requests, for the main story. A failed read
  // leaves the size unknown; the story falls back to the newest merge.
  for (const p of prs.filter((x) => x.mergedToday).slice(0, SIZED)) {
    try {
      const d = await get(`/repos/${repo}/pulls/${p.number}`)
      p.additions = Number(d.additions) || 0
      p.deletions = Number(d.deletions) || 0
      p.changedFiles = Number(d.changed_files) || 0
    } catch { /* size unknown */ }
  }

  prs.sort((a, b) => b.number - a.number)
  issues.sort((a, b) => b.number - a.number)
  return { repo, day, prs, issues }
}
