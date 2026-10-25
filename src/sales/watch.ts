import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

// --- Competitor watch (#1288) ---
//
// competitors.md lists the pages to watch, one per line:
//
//   - Example Rival | https://rival.example/pricing
//
// Each check fetches every page, reduces it to its lines of visible text and
// compares them with the last check. Only lines that appeared or went away
// are reported, each with the page's URL, so the brief says what changed and
// never repeats what was already there. The first check of a page only
// records it. Snapshots and the log of changes live in .agentx-sales/ in the
// agent's workspace; a page that cannot be fetched keeps its last snapshot.

export const COMPETITORS_FILE = "competitors.md"
const STATE_DIR = ".agentx-sales"
const SNAPSHOTS = "watch.json"
const CHANGES = "changes.jsonl"

/** Lines kept per page; the rest of a very long page is not compared. */
const MAX_LINES = 2000
/** Changed lines reported per page per check. */
const MAX_REPORTED = 10
const MAX_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000

export interface Competitor { name: string; url: string }

export interface PageChange {
  at: string
  name: string
  url: string
  added: string[]
  removed: string[]
}

export interface WatchResult {
  changes: PageChange[]
  /** Pages seen for the first time: recorded, nothing to compare yet. */
  baselined: Competitor[]
  failed: { competitor: Competitor; error: string }[]
  unchanged: number
}

export type PageFetcher = (url: string) => Promise<string>

export function parseCompetitors(text: string): Competitor[] {
  const out: Competitor[] = []
  for (const raw of text.split("\n")) {
    const url = raw.match(/https?:\/\/[^\s|<>)\]]+/i)?.[0]
    if (!url || !/^\s*[-*]\s+/.test(raw)) continue
    const name = raw.trim().replace(/^[-*]\s+/, "").split("|")[0].replace(url, "").replace(/[[\]()]/g, "").trim()
    out.push({ name: name || new URL(url).hostname, url })
  }
  return out
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }

/** The visible text of an HTML page, one trimmed line per block, duplicates dropped. */
export function pageLines(html: string): string[] {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(p|div|li|tr|h[1-6]|br|section|article|header|footer|main|ul|ol|table|dt|dd|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
  const seen = new Set<string>()
  const lines: string[] = []
  for (const l of text.split("\n")) {
    const t = l.replace(/\s+/g, " ").trim()
    if (t.length < 2 || seen.has(t)) continue
    seen.add(t)
    lines.push(t)
    if (lines.length >= MAX_LINES) break
  }
  return lines
}

interface Snapshot { lines: string[]; checkedAt: string }

function stateDir(workspace: string): string {
  const dir = join(workspace, STATE_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function readSnapshots(workspace: string): Record<string, Snapshot> {
  const path = join(workspace, STATE_DIR, SNAPSHOTS)
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, "utf-8")) } catch { return {} }
}

export async function defaultFetcher(url: string): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "agentx-competitor-watch", accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.text()
  return body.length > MAX_BYTES ? body.slice(0, MAX_BYTES) : body
}

/** Check every page in competitors.md once, record what changed, and return it. */
export async function checkCompetitors(workspace: string, fetcher: PageFetcher = defaultFetcher, now = new Date()): Promise<WatchResult> {
  const listPath = join(workspace, COMPETITORS_FILE)
  const competitors = existsSync(listPath) ? parseCompetitors(readFileSync(listPath, "utf-8")) : []
  const snapshots = readSnapshots(workspace)
  const result: WatchResult = { changes: [], baselined: [], failed: [], unchanged: 0 }
  const at = now.toISOString()

  for (const c of competitors) {
    let lines: string[]
    try {
      lines = pageLines(await fetcher(c.url))
    } catch (e: any) {
      result.failed.push({ competitor: c, error: String(e?.message ?? e) })
      continue
    }
    const before = snapshots[c.url]
    snapshots[c.url] = { lines, checkedAt: at }
    if (!before) { result.baselined.push(c); continue }
    const old = new Set(before.lines)
    const fresh = new Set(lines)
    const added = lines.filter((l) => !old.has(l))
    const removed = before.lines.filter((l) => !fresh.has(l))
    if (!added.length && !removed.length) { result.unchanged++; continue }
    result.changes.push({ at, name: c.name, url: c.url, added, removed })
  }

  if (competitors.length) {
    const dir = stateDir(workspace)
    writeFileSync(join(dir, SNAPSHOTS), JSON.stringify(snapshots))
    for (const ch of result.changes) appendFileSync(join(dir, CHANGES), JSON.stringify(ch) + "\n")
  }
  return result
}

/** Changes recorded at or after `since`, oldest first. */
export function changesSince(workspace: string, since: Date): PageChange[] {
  const path = join(workspace, STATE_DIR, CHANGES)
  if (!existsSync(path)) return []
  const from = since.getTime()
  return readFileSync(path, "utf-8").split("\n").flatMap((l) => {
    if (!l.trim()) return []
    try {
      const c = JSON.parse(l) as PageChange
      return Date.parse(c.at) >= from ? [c] : []
    } catch { return [] }
  })
}

const clip = (s: string) => (s.length > 160 ? s.slice(0, 159) + "…" : s)

/** Changes as brief lines, every line carrying the page's URL. */
export function formatChanges(changes: PageChange[]): string[] {
  const out: string[] = []
  for (const c of changes) {
    const link = `[${c.name}](${c.url})`
    const shown = [...c.added.map((l) => `- ${link} added: "${clip(l)}"`), ...c.removed.map((l) => `- ${link} removed: "${clip(l)}"`)]
    out.push(...shown.slice(0, MAX_REPORTED))
    if (shown.length > MAX_REPORTED) out.push(`- ${link}: ${shown.length - MAX_REPORTED} more changed lines`)
  }
  return out
}
