import { Command } from "commander"
import chalk from "chalk"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { loadDaemonConfig } from "@/daemon/config"
import { detectRepo, fetchCiMinutes, fetchMergedPrs } from "@/quality/github"
import { matchCosts, readTaskCosts } from "@/quality/cost"
import {
  buildReport, compareReports, renderReport, toPublic, QUALITY_REPORT_SCHEMA,
  type QualityReport, type Scope,
} from "@/quality/report"
import {
  VERDICT_MARKER, configToken, githubIssueComments, isoWeek, latestReport, parseVerdict, postWeekly,
  publicProblem, readBaseline, readQualityState, runReportCommand, upsertComment, verdictComment, writeQualityState,
} from "@/quality/epic-report"

// --- agentx quality ---
//
// Weekly engineering quality from merged PRs and AgentX usage (#988):
// fix share, regression fixes, lead time, CI minutes and model cost per PR.
// Every later quality gate (#987) is judged with this report, so the JSON
// shape is a contract — see src/quality/report.ts and
// docs/guides/quality-report.md.
//
// `weekly` and `verdict` post that report on the epic issue (#994). The
// daemon posts the weekly report by itself (qualityReport in agentx.json);
// `weekly` posts or previews one week by hand, `verdict` posts the owner's
// keep / tune / switch-off call per gate.

const DAY = 86_400_000
const BASELINE_DIR = ".agentx/quality/baselines"
const CI_CACHE_DIR = ".agentx/quality/ci-runs"
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const NAME_RE = /^[\w.-]{1,64}$/

export const quality = new Command()
  .name("quality")
  .description("engineering quality from merged PRs: fix share, regressions, lead time, CI and model cost; the weekly report on the epic")

quality
  .command("report")
  .description("per-week and per-area report of merged PRs on the base branch (reads GitHub through gh)")
  .option("--since <date>", "first merge day, YYYY-MM-DD (default: 20 days before --until)")
  .option("--until <date>", "last merge day, YYYY-MM-DD (default: today, UTC)")
  .option("--repo <owner/name>", "GitHub repository (default: the origin of this checkout)")
  .option("--base <branch>", "branch the PRs merged into", "main")
  .option("--scope <scope>", "which PRs the week and area rows count: agent | all", "agent")
  .option("--no-ci", "skip CI minutes (saves one GitHub call per CI run)")
  .option("--db <path>", "AgentX trace store to read model cost from", ".agentx/db.sqlite")
  .option("--public", "show cost only as % change vs --compare, never as an amount")
  .option("--save-baseline <name>", "store this report locally as a baseline")
  .option("--compare <name>", "show changes against a stored baseline")
  .option("--json", "JSON output (schema agentx.quality-report/v1)")
  .action(async (opts) => {
    try {
      const until: string = opts.until ?? new Date().toISOString().slice(0, 10)
      const since: string = opts.since ?? new Date(Date.parse(until) - 20 * DAY).toISOString().slice(0, 10)
      for (const [flag, v] of [["--since", since], ["--until", until]]) {
        if (!DATE_RE.test(v) || Number.isNaN(Date.parse(v))) throw new Error(`${flag} must be a date like 2026-01-31.`)
      }
      if (since > until) throw new Error("--since is after --until.")
      if (opts.scope !== "agent" && opts.scope !== "all") throw new Error("--scope must be agent or all.")
      for (const name of [opts.saveBaseline, opts.compare]) {
        if (name !== undefined && !NAME_RE.test(name)) throw new Error(`Baseline name "${name}": use letters, digits, dot, dash or underscore.`)
      }
      const baseline = opts.compare ? loadBaseline(opts.compare) : null

      const repo: string | null = opts.repo ?? await detectRepo()
      if (!repo) throw new Error("Could not tell which GitHub repository this is. Pass --repo owner/name.")

      // 72 h before the window, so a fix on day one can cite a PR merged just before it.
      const lookback = new Date(Date.parse(since) - 3 * DAY).toISOString().slice(0, 10)
      const all = await fetchMergedPrs(repo, opts.base, lookback, until)
      const from = Date.parse(`${since}T00:00:00Z`)
      const inWindow = all.filter((p) => Date.parse(p.mergedAt) >= from)

      let ciMinutes: Map<number, number> | undefined
      if (opts.ci) {
        const cache = loadCiCache(repo)
        ciMinutes = await fetchCiMinutes(repo, inWindow, since, until, { cache })
        saveCiCache(repo, cache)
      }
      const tasks = readTaskCosts(opts.db, repo, from - 30 * DAY, Date.parse(`${until}T23:59:59.999Z`))
      const cost = tasks ? matchCosts(inWindow, tasks) : new Map<number, number>()

      let report = buildReport(all, { repo, base: opts.base, since, until, scope: opts.scope as Scope }, { ciMinutes, cost })
      if (opts.saveBaseline) saveBaseline(opts.saveBaseline, report)
      if (baseline) report = compareReports(report, baseline, opts.compare)
      if (opts.public) report = toPublic(report)

      if (opts.json) { console.log(JSON.stringify(report, null, 2)); return }
      console.log(renderReport(report))
      if (!tasks) console.log(chalk.dim(`  No AgentX trace store at ${opts.db}; cost is unattributed. Run from the AgentX folder or pass --db.\n`))
      if (opts.saveBaseline) console.log(chalk.dim(`  Saved baseline "${opts.saveBaseline}" in ${BASELINE_DIR}.\n`))
    } catch (e: any) {
      const msg = String(e?.stderr || e?.message || e)
      console.error(chalk.red(`  ${msg.trim()}`))
      if (/gh auth login|not logged|ENOENT.*gh|spawn gh/i.test(msg)) {
        console.error(chalk.dim("  This command reads GitHub through the gh CLI. Install it and run: gh auth login"))
      }
      process.exitCode = 1
    }
  })

quality
  .command("weekly")
  .description("post (or preview) the weekly report for a week; edits that week's comment if it exists")
  .option("--week <week>", "ISO week, e.g. 2026-W42 (default: last week)")
  .option("--dry-run", "print the comment instead of posting it")
  .option("-c, --config <path>", "config file")
  .action(async (opts: { week?: string; dryRun?: boolean; config?: string }) => {
    try {
      const { config, s, repo, issue } = settings(opts.config)
      const week = opts.week ?? isoWeek(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10))
      if (!/^\d{4}-W\d{2}$/.test(week)) throw new Error(`--week: use YYYY-Www, e.g. 2026-W42`)
      const res = await postWeekly({
        root: process.cwd(),
        settings: s,
        comments: githubIssueComments(repo, issue, async () => configToken(config)),
        runReport: (w) => runReportCommand(s.command, w, { cwd: process.cwd(), timeoutMs: s.timeoutSeconds * 1000, baseline: s.baseline, repo: s.repo }),
        log: (m) => console.error(chalk.dim(m)),
      }, { week, dryRun: opts.dryRun })
      if (res.status === "failed") { console.error(chalk.red(res.error)); process.exitCode = 1; return }
      if (opts.dryRun) { console.log(res.body); return }
      if ("url" in res) console.log(chalk.green(`${res.status}: ${res.url}`))
    } catch (e: any) {
      console.error(chalk.red(e?.message ?? e))
      process.exitCode = 1
    }
  })

quality
  .command("verdict")
  .description("post the keep / tune / switch-off verdict per gate on the epic, citing the latest weekly report")
  .requiredOption("-g, --gate <id=verdict[:reason]>", "one per gate, e.g. review=keep:\"fixes ≤24 h down 40%\"", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("--dry-run", "print the comment instead of posting it")
  .option("-c, --config <path>", "config file")
  .action(async (opts: { gate: string[]; dryRun?: boolean; config?: string }) => {
    try {
      const { config, s, repo, issue } = settings(opts.config)
      const report = latestReport(process.cwd())
      if (!report) throw new Error("no weekly report stored yet (.agentx/quality/reports): post one first with `agentx quality weekly`")
      const baseline = readBaseline(process.cwd(), s.baseline)
      if (!baseline) throw new Error(`no baseline "${s.baseline}" (.agentx/quality/baselines): save one with \`agentx quality report --since <date> --until <date> --save-baseline ${s.baseline}\``)
      const state = readQualityState(process.cwd())
      const gh = githubIssueComments(repo, issue, async () => configToken(config))
      const reportId = state.comments?.[report.week]
      const body = verdictComment({
        verdicts: opts.gate.map(parseVerdict),
        gates: s.gates,
        report,
        reportUrl: reportId ? `https://github.com/${repo}/issues/${issue}#issuecomment-${reportId}` : undefined,
        baseline,
      })
      const problem = publicProblem(body)
      if (problem) throw new Error(`not posted: the verdict ${problem}`)
      if (opts.dryRun) { console.log(body); return }
      const res = await upsertComment(gh, VERDICT_MARKER, body, state.verdictComment)
      writeQualityState(process.cwd(), { ...readQualityState(process.cwd()), verdictComment: res.id })
      console.log(chalk.green(`${res.created ? "posted" : "updated"}: ${res.url}`))
    } catch (e: any) {
      console.error(chalk.red(e?.message ?? e))
      process.exitCode = 1
    }
  })

function settings(configPath?: string) {
  const config = loadDaemonConfig(configPath)
  const s = config.qualityReport
  if (!s.repo || !s.issue) throw new Error("set qualityReport.repo and qualityReport.issue in agentx.json")
  return { config, s, repo: s.repo, issue: s.issue }
}

function baselinePath(name: string): string {
  return resolve(process.cwd(), BASELINE_DIR, `${name}.json`)
}

function saveBaseline(name: string, report: QualityReport): void {
  mkdirSync(resolve(process.cwd(), BASELINE_DIR), { recursive: true })
  writeFileSync(baselinePath(name), JSON.stringify(report, null, 2) + "\n")
}

function loadBaseline(name: string): QualityReport {
  const path = baselinePath(name)
  if (!existsSync(path)) throw new Error(`No baseline "${name}". Save one first with --save-baseline ${name}.`)
  const data = JSON.parse(readFileSync(path, "utf-8"))
  if (data.schema !== QUALITY_REPORT_SCHEMA) throw new Error(`Baseline "${name}" has schema ${data.schema}, expected ${QUALITY_REPORT_SCHEMA}.`)
  return data
}

// Minutes per finished CI run, per repository. Safe to delete at any time.
function ciCachePath(repo: string): string {
  return resolve(process.cwd(), CI_CACHE_DIR, `${repo.replace(/[^\w.-]/g, "_")}.json`)
}

function loadCiCache(repo: string): Map<number, number> {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(ciCachePath(repo), "utf-8"))).map(([k, v]) => [Number(k), Number(v)]))
  } catch {
    return new Map()
  }
}

function saveCiCache(repo: string, cache: Map<number, number>): void {
  try {
    mkdirSync(resolve(process.cwd(), CI_CACHE_DIR), { recursive: true })
    writeFileSync(ciCachePath(repo), JSON.stringify(Object.fromEntries(cache)))
  } catch {
    // A read-only folder only costs speed next time.
  }
}
