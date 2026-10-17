import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"
import {
  VERDICT_MARKER, configToken, githubIssueComments, isoWeek, latestReport, parseVerdict, postWeekly,
  publicProblem, readQualityState, runReportCommand, upsertComment, verdictComment, writeQualityState,
} from "@/quality/epic-report"

// --- agentx quality — the weekly report on the epic and the gate verdict ---
//
// The daemon posts the weekly report by itself (qualityReport in
// agentx.json). `weekly` posts or previews one week by hand; `verdict`
// posts the owner's keep / tune / switch-off call per gate (#994).

function settings(configPath?: string) {
  const config = loadDaemonConfig(configPath)
  const s = config.qualityReport
  if (!s.repo || !s.issue) throw new Error("set qualityReport.repo and qualityReport.issue in agentx.json")
  return { config, s, repo: s.repo, issue: s.issue }
}

export const quality = new Command()
  .name("quality")
  .description("weekly quality report on the epic issue, and the per-gate verdict")

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
        runReport: (w) => runReportCommand(s.command, w, { cwd: process.cwd(), timeoutMs: s.timeoutSeconds * 1000 }),
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
      const state = readQualityState(process.cwd())
      const gh = githubIssueComments(repo, issue, async () => configToken(config))
      const reportId = state.comments?.[report.week]
      const body = verdictComment({
        verdicts: opts.gate.map(parseVerdict),
        gates: s.gates,
        report,
        reportUrl: reportId ? `https://github.com/${repo}/issues/${issue}#issuecomment-${reportId}` : undefined,
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
