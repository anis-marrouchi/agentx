import { execFile } from "child_process"
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { localClock } from "@/approvals/sweep"
import type { DaemonConfig } from "@/daemon/config"

// --- The weekly quality report on the epic issue (#994, part of #987) ---
//
// Every Monday the daemon runs the quality report (#988) for the week that
// just ended and posts it as one comment on the epic. The comment carries
// a hidden marker naming its week, so a re-run edits that comment instead
// of adding a second one. A week that fails is retried and logged on every
// try; a week the daemon was down for is named in the next comment and in
// the log. Nothing is skipped without a trace.
//
// The repo is public: the comment must carry no cost amounts and no names.
// The report runs with --public; the text is checked again here and is
// not posted when it fails the check.

export type QualityReportSettings = DaemonConfig["qualityReport"]
export type GateSetting = QualityReportSettings["gates"][number]

const DAY = 86_400_000
/** A failed week is tried again after this long, not every minute. */
export const RETRY_MS = 3_600_000

// --- Weeks ---

/** ISO week of a "YYYY-MM-DD" date: "2026-W42". */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  const day = (d.getUTCDay() + 6) % 7 // Monday = 0
  const thursday = new Date(d.getTime() + (3 - day) * DAY)
  const year = thursday.getUTCFullYear()
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const week1Monday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY
  const n = Math.floor((thursday.getTime() - week1Monday) / (7 * DAY)) + 1
  return `${year}-W${String(n).padStart(2, "0")}`
}

/** Monday and Sunday ("YYYY-MM-DD") of an ISO week. */
export function weekRange(week: string): { from: string; to: string } {
  const m = /^(\d{4})-W(\d{2})$/.exec(week)
  if (!m) throw new Error(`not an ISO week: ${week}`)
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4))
  const monday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY + (Number(m[2]) - 1) * 7 * DAY
  const fmt = (t: number) => new Date(t).toISOString().slice(0, 10)
  return { from: fmt(monday), to: fmt(monday + 6 * DAY) }
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
}

/** The ISO weeks strictly between two weeks, oldest first. */
export function weeksBetween(after: string, before: string): string[] {
  const out: string[] = []
  let monday = addDays(weekRange(after).from, 7)
  const stop = weekRange(before).from
  while (monday < stop && out.length < 520) {
    out.push(isoWeek(monday))
    monday = addDays(monday, 7)
  }
  return out
}

/** Which week's report is due now, if any. The report covers the last
 *  complete week; it is due from the configured Monday time on, and stays
 *  due all week until it is posted, so a daemon that was down on Monday
 *  posts it when it comes back. */
export function weeklyDue(
  s: Pick<QualityReportSettings, "time" | "timezone">,
  state: QualityState,
  now: number,
): { due: boolean; week: string; skipped: string[] } {
  const { date, minutes } = localClock(now, s.timezone)
  const week = isoWeek(addDays(date, -7))
  const [h, m] = s.time.split(":").map(Number)
  const isMonday = weekRange(isoWeek(date)).from === date
  const pastTime = !isMonday || minutes >= h * 60 + m
  const posted = state.lastPosted === week
  const backingOff = state.failure?.week === week && now - Date.parse(state.failure.at) < RETRY_MS
  const skipped = state.lastPosted && state.lastPosted < week ? weeksBetween(state.lastPosted, week) : []
  return { due: pastTime && !posted && !backingOff, week, skipped }
}

// --- Gates ---

/** How a gate stood during a week, for the comment. */
export function gateState(g: GateSetting, week: string): string {
  const { from, to } = weekRange(week)
  if (g.since > to) return "off"
  if (g.until && g.until < from) return `off since ${g.until}`
  if (g.until && g.until <= to) return `on ${g.since}, off ${g.until}`
  if (g.since >= from) return `on from ${g.since}`
  return `on (since ${g.since})`
}

/** The date of week 3's end: 21 days after the first gate went on. */
export function verdictDueDate(gates: GateSetting[]): string | undefined {
  const first = gates.map((g) => g.since).sort()[0]
  return first ? addDays(first, 20) : undefined
}

// --- The public check ---

const MONEY = /[$€£¥]\s?\d|\d\s?(?:USD|EUR|GBP|usd|eur|gbp|dollars?|euros?)\b/
const HANDLE = /(^|[^\w`/.-])@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\b/m
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/

/** Why the text can't go on a public issue, or undefined when it can. */
export function publicProblem(text: string): string | undefined {
  const money = MONEY.exec(text)
  if (money) return `contains a cost amount ("${money[0]}"); the public report gives cost as a percentage change only`
  if (EMAIL.test(text)) return "contains an email address"
  const handle = HANDLE.exec(text)
  if (handle) return `contains a name ("${handle[0].trim()}")`
  return undefined
}

// --- The comment ---

export const weekMarker = (week: string) => `<!-- agentx:quality-report week=${week} -->`
export const VERDICT_MARKER = "<!-- agentx:quality-verdict -->"

/** The report as a code block: it is a fixed-width table, which Markdown
 *  would otherwise fold into one paragraph. The fence is longer than any
 *  run of backticks in the text, so the text can't close it. */
export function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length))
  const fence = "`".repeat(Math.max(3, longest + 1))
  return `${fence}text\n${text.replace(/^\n+|\s+$/g, "")}\n${fence}`
}

export function weeklyComment(opts: {
  week: string
  report: string
  gates: GateSetting[]
  /** Weeks with no comment because the daemon was not running. */
  skipped?: string[]
  /** Weeks with no comment because every try failed. */
  failed?: string[]
  verdictDue?: boolean
}): string {
  const { from, to } = weekRange(opts.week)
  const lines = [weekMarker(opts.week), `## Quality report, ${opts.week} (${from} to ${to})`, ""]
  lines.push("### Gates this week", "")
  if (!opts.gates.length) lines.push("No gates were on. This week counts as baseline.", "")
  else {
    lines.push("| Gate | State |", "|---|---|")
    for (const g of opts.gates) lines.push(`| ${g.label ?? g.id} | ${gateState(g, opts.week)} |`)
    lines.push("")
  }
  lines.push("### Numbers", "", fenced(opts.report), "")
  if (opts.failed?.length) {
    lines.push(`> No report was posted for ${opts.failed.join(", ")}: every try failed (see \`[quality]\` in the daemon log). Run \`agentx quality weekly --week <week>\` to post one.`, "")
  }
  if (opts.skipped?.length) {
    lines.push(`> No report was posted for ${opts.skipped.join(", ")}: the daemon was not running when it was due. Run \`agentx quality weekly --week <week>\` to post one.`, "")
  }
  if (opts.verdictDue) {
    lines.push("> Week 3 with the gates on is over. The keep / tune / switch-off verdict per gate is due: `agentx quality verdict`.", "")
  }
  lines.push("_Posted by the AgentX daemon every Monday. Cost is shown as a percentage change only._")
  return lines.join("\n")
}

// --- State ---

export interface QualityState {
  /** The last week whose comment is on the epic. */
  lastPosted?: string
  /** The last failed try, for the retry delay. */
  failure?: { week: string; at: string; error: string }
  /** Weeks whose last try failed, with when: a week that is never posted
   *  is then named as failed, not as missed while the daemon was down. */
  failed?: Record<string, string>
  /** Comment ids by week, so a re-run edits the same comment. */
  comments?: Record<string, number>
  verdictComment?: number
}

export const qualityDir = (root: string) => resolve(root, ".agentx/quality")
const stateFile = (root: string) => resolve(qualityDir(root), "state.json")
export const reportFile = (root: string, week: string) => resolve(qualityDir(root), "reports", `${week}.md`)

export function readQualityState(root: string): QualityState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(root), "utf-8"))
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

export function writeQualityState(root: string, state: QualityState): void {
  const path = stateFile(root)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n")
  renameSync(tmp, path)
}

/** The newest stored weekly report, for the verdict to cite. */
export function latestReport(root: string): { week: string; text: string } | undefined {
  try {
    const weeks = readdirSync(resolve(qualityDir(root), "reports"))
      .filter((f) => /^\d{4}-W\d{2}\.md$/.test(f)).sort()
    const last = weeks.at(-1)
    if (!last) return undefined
    const week = last.slice(0, -3)
    return { week, text: readFileSync(reportFile(root, week), "utf-8") }
  } catch {
    return undefined
  }
}

// --- GitHub ---

export interface IssueComments {
  find(marker: string): Promise<{ id: number; url: string } | undefined>
  create(body: string): Promise<{ id: number; url: string }>
  update(id: number, body: string): Promise<{ id: number; url: string }>
}

/** Comments on one issue over the REST API. */
export function githubIssueComments(repo: string, issue: number, token: () => Promise<string | undefined>): IssueComments {
  const api = async (path: string, init: RequestInit = {}) => {
    const t = await token()
    if (!t) throw new Error("no GitHub token: set channels.github.token, tokenFile or GITHUB_TOKEN")
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    })
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`)
    return res.json() as Promise<any>
  }
  const shape = (c: any) => ({ id: Number(c.id), url: String(c.html_url ?? "") })
  return {
    async find(marker) {
      for (let page = 1; page <= 20; page++) {
        const list: any[] = await api(`/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`)
        const hit = list.find((c) => typeof c?.body === "string" && c.body.includes(marker))
        if (hit) return shape(hit)
        if (list.length < 100) return undefined
      }
      return undefined
    },
    create: async (body) => shape(await api(`/repos/${repo}/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body }) })),
    update: async (id, body) => shape(await api(`/repos/${repo}/issues/comments/${id}`, { method: "PATCH", body: JSON.stringify({ body }) })),
  }
}

/** Edit the comment carrying `marker` if there is one, else post it. The
 *  known id is tried first; the issue is searched when it is gone. */
export async function upsertComment(
  gh: IssueComments, marker: string, body: string, knownId?: number,
): Promise<{ id: number; url: string; created: boolean }> {
  if (knownId) {
    try { return { ...(await gh.update(knownId, body)), created: false } } catch { /* deleted: search */ }
  }
  const existing = await gh.find(marker)
  if (existing) return { ...(await gh.update(existing.id, body)), created: false }
  return { ...(await gh.create(body)), created: true }
}

/** The token for the CLI and the daemon's fallback: config, then env. */
export function configToken(config: Pick<DaemonConfig, "channels">): string | undefined {
  const gh = config.channels.github
  if (gh?.token) return gh.token
  if (gh?.tokenFile) {
    try { return readFileSync(gh.tokenFile, "utf-8").trim().split("\n")[0].trim() || undefined } catch { /* fall through */ }
  }
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined
}

// --- Running the report ---

/** The command line for a week: the configured command with the week's
 *  Monday and Sunday (`--since/--until`) and the baseline (`--compare`)
 *  added. A leading `agentx` runs this install's own CLI file with this
 *  Node, so the daemon's PATH does not matter. */
export function reportCommandLine(
  command: string[],
  week: string,
  baseline: string | undefined,
  proc: { execPath: string; argv: string[] } = process,
): string[] {
  const { from, to } = weekRange(week)
  const [bin, ...args] = command
  const cli = proc.argv[1] ? resolve(proc.argv[1]) : ""
  const head = bin === "agentx" && /\.[cm]?js$/.test(cli) ? [proc.execPath, cli] : [bin]
  return [...head, ...args, "--since", from, "--until", to, ...(baseline ? ["--compare", baseline] : [])]
}

/** Run the report command for a week and return its stdout. The week is
 *  also passed in the environment, for a custom command. */
export function runReportCommand(
  command: string[], week: string, opts: { cwd: string; timeoutMs: number; baseline?: string },
): Promise<string> {
  const [bin, ...args] = reportCommandLine(command, week, opts.baseline)
  const { from, to } = weekRange(week)
  return new Promise((resolvePromise, reject) => {
    execFile(bin, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, AGENTX_QUALITY_WEEK: week, AGENTX_QUALITY_FROM: from, AGENTX_QUALITY_TO: to },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command.join(" ")} failed: ${(String(stderr).trim() || err.message).slice(0, 500)}`))
      else if (!String(stdout).trim()) reject(new Error(`${command.join(" ")} printed nothing`))
      else resolvePromise(String(stdout))
    })
  })
}

export interface WeeklyDeps {
  root: string
  settings: QualityReportSettings
  comments: IssueComments
  runReport: (week: string) => Promise<string>
  log: (msg: string) => void
  now?: number
}

export type WeeklyResult =
  | { status: "posted" | "updated"; week: string; url: string }
  | { status: "not-due" | "disabled" }
  | { status: "failed"; week: string; error: string }

/** Post the due week's report. With `week`, post that week whether or not
 *  it is due (the CLI, or a week that was missed). */
export async function postWeekly(deps: WeeklyDeps, opts: { week?: string; dryRun?: boolean } = {}): Promise<WeeklyResult & { body?: string }> {
  const { root, settings: s, log } = deps
  const now = deps.now ?? Date.now()
  const state = readQualityState(root)
  let week = opts.week
  let skipped: string[] = []
  let failed: string[] = []
  if (!week) {
    const due = weeklyDue(s, state, now)
    if (!due.due) return { status: "not-due" }
    week = due.week
    failed = due.skipped.filter((w) => state.failed?.[w])
    skipped = due.skipped.filter((w) => !state.failed?.[w])
    if (failed.length) log(`[quality] WARNING: no weekly report was posted for ${failed.join(", ")} (every try failed)`)
    if (skipped.length) log(`[quality] WARNING: no weekly report was posted for ${skipped.join(", ")} (daemon not running when due)`)
  }
  try {
    const report = await deps.runReport(week)
    const verdictOn = verdictDueDate(s.gates)
    const body = weeklyComment({
      week, report, gates: s.gates, skipped, failed,
      verdictDue: !!verdictOn && !state.verdictComment && verdictOn <= weekRange(week).to,
    })
    const problem = publicProblem(body)
    if (problem) throw new Error(`not posted: the report ${problem}`)
    if (opts.dryRun) return { status: "posted", week, url: "", body }
    mkdirSync(dirname(reportFile(root, week)), { recursive: true })
    writeFileSync(reportFile(root, week), report.trim() + "\n")
    const res = await upsertComment(deps.comments, weekMarker(week), body, state.comments?.[week])
    const next = readQualityState(root)
    next.comments = { ...next.comments, [week]: res.id }
    if (!next.lastPosted || week > next.lastPosted) next.lastPosted = week
    if (next.failure?.week === week) delete next.failure
    if (next.failed?.[week]) {
      const { [week]: _, ...rest } = next.failed
      next.failed = rest
    }
    writeQualityState(root, next)
    log(`[quality] weekly report ${week} ${res.created ? "posted" : "updated"}: ${res.url}`)
    return { status: res.created ? "posted" : "updated", week, url: res.url }
  } catch (e: any) {
    const error = String(e?.message ?? e)
    if (!opts.dryRun) {
      const next = readQualityState(root)
      next.failure = { week, at: new Date(now).toISOString(), error }
      next.failed = { ...next.failed, [week]: next.failure.at }
      writeQualityState(root, next)
    }
    log(`[quality] weekly report ${week} FAILED (retrying in ${RETRY_MS / 60_000} min): ${error}`)
    return { status: "failed", week, error }
  }
}

// --- The week-3 verdict ---

export type Verdict = "keep" | "tune" | "switch-off"
export interface GateVerdict { gate: string; verdict: Verdict; reason?: string }

/** The fix shares of the saved baseline report (#988), for the criteria. */
export interface BaselineShares {
  name: string
  since: string
  until: string
  agent: number | null
  all: number | null
}

export const baselineFile = (root: string, name: string) => resolve(qualityDir(root), "baselines", `${name}.json`)

/** Read the fix shares from a baseline saved with
 *  `agentx quality report --save-baseline <name>`. */
export function readBaseline(root: string, name: string): BaselineShares | undefined {
  try {
    const b = JSON.parse(readFileSync(baselineFile(root, name), "utf-8"))
    const share = (v: unknown) => (typeof v === "number" ? v : null)
    return { name, since: String(b.since), until: String(b.until), agent: share(b.totals?.agent?.fixShare), all: share(b.totals?.all?.fixShare) }
  } catch {
    return undefined
  }
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`)

function criteria(b: BaselineShares): string[] {
  return [
    `Fix share of merged agent PRs is below the ${b.since} to ${b.until} baseline (${pct(b.agent)} agent PRs, ${pct(b.all)} all non-release PRs).`,
    "Fixes landing ≤24 h after the PR they fix go down vs baseline.",
    "Model cost per merged PR rises by no more than 20% vs baseline.",
    "Median issue→merge lead time rises by no more than 1 h vs baseline.",
    "Every gate has a documented, tested config switch; a gate over its own cost/time budget is switched off.",
  ]
}

/** Parse "id=keep" or "id=tune:reason". */
export function parseVerdict(arg: string): GateVerdict {
  const m = /^([^=]+)=(keep|tune|switch-off|off)(?::(.*))?$/s.exec(arg.trim())
  if (!m) throw new Error(`"${arg}": use <gate>=keep|tune|switch-off[:reason]`)
  const verdict = (m[2] === "off" ? "switch-off" : m[2]) as Verdict
  return { gate: m[1].trim(), verdict, ...(m[3]?.trim() ? { reason: m[3].trim() } : {}) }
}

/** The verdict comment: the owner's call per gate, the criteria, and the
 *  numbers it rests on. Every gate in the config needs a verdict. */
export function verdictComment(opts: {
  verdicts: GateVerdict[]
  gates: GateSetting[]
  report: { week: string; text: string }
  reportUrl?: string
  baseline: BaselineShares
}): string {
  const missing = opts.gates.filter((g) => !opts.verdicts.some((v) => v.gate === g.id)).map((g) => g.id)
  if (missing.length) throw new Error(`no verdict for: ${missing.join(", ")}`)
  const unknown = opts.verdicts.filter((v) => !opts.gates.some((g) => g.id === v.gate)).map((v) => v.gate)
  if (unknown.length) throw new Error(`not a configured gate: ${unknown.join(", ")}`)
  const label = (id: string) => opts.gates.find((g) => g.id === id)?.label ?? id
  const lines = [VERDICT_MARKER, "## Week-3 verdict per gate", ""]
  lines.push("| Gate | On since | Verdict | Why |", "|---|---|---|---|")
  for (const v of opts.verdicts) {
    const g = opts.gates.find((x) => x.id === v.gate)!
    lines.push(`| ${label(v.gate)} | ${g.since} | **${v.verdict}** | ${(v.reason ?? "").replace(/\|/g, "\\|")} |`)
  }
  lines.push("", "### Success criteria", "", ...criteria(opts.baseline).map((c) => `- ${c}`), "")
  const src = opts.reportUrl ? `[${opts.report.week}](${opts.reportUrl})` : opts.report.week
  lines.push(`### Numbers (report ${src})`, "", fenced(opts.report.text), "")
  lines.push("_The verdicts are the owner's. A gate marked switch-off is turned off in its config switch._")
  return lines.join("\n")
}
