import { Command } from "commander"
import chalk from "chalk"
import { readFileSync } from "fs"
import { resolve } from "path"
import { findConfigPath } from "@/daemon/config-mutator"
import { calendarPath, readCalendar, upcoming } from "@/content/calendar"
import { listContentDrafts, PLATFORM_LABEL, readContentDraft, type ContentDraftStatus } from "@/content/drafts"
import { listSamples, pickSamples, voiceDir } from "@/content/voice"

// --- agentx content — posts drafted in your voice, held for your yes ---
//
// Read-only views of what the content agent works with: its drafts, the
// past posts it learns the voice from, and the calendar it fills. Deciding
// is `agentx approvals approve|reject content:<id>`, like every other
// approval (src/approvals/inbox.ts).

export const content = new Command("content")
  .description("posts drafted in your voice: drafts waiting for approval, voice samples, the content calendar")

function workspaceOf(agent: string): string {
  let cfg: any
  try { cfg = JSON.parse(readFileSync(findConfigPath(), "utf-8")) } catch {
    throw new Error("no agentx.json here: run this in the folder you run agentx from")
  }
  const ws = cfg?.agents?.[agent]?.workspace
  if (typeof ws !== "string" || !ws) throw new Error(`no agent "${agent}" in agentx.json`)
  return resolve(process.cwd(), ws)
}

function run(fn: () => void): void {
  try { fn() } catch (e: any) { console.error(chalk.red(`  ${e?.message ?? e}`)); process.exitCode = 1 }
}

content
  .command("drafts", { isDefault: true })
  .alias("ls")
  .description("drafts and what happened to them, newest last (default: the ones waiting)")
  .option("--all", "include posted, ready, rejected and failed drafts")
  .option("--json", "machine-readable output")
  .action((opts: { all?: boolean; json?: boolean }) => {
    const drafts = listContentDrafts(process.cwd(), opts.all ? undefined : "pending" as ContentDraftStatus)
    if (opts.json) { console.log(JSON.stringify(drafts, null, 2)); return }
    if (drafts.length === 0) { console.log(chalk.dim(`  no drafts ${opts.all ? "yet" : "waiting (--all shows decided ones)"}`)); return }
    for (const d of drafts) {
      console.log(`  ${chalk.cyan(`content:${d.id}`)}  ${chalk.dim(`[${d.status}] ${PLATFORM_LABEL[d.platform]} · from ${d.agent}${d.date ? ` · for ${d.date}` : ""}`)}`)
      console.log(`    ${d.topic ? chalk.bold(d.topic) + " · " : ""}${d.text.replace(/\s+/g, " ").slice(0, 100)}${d.text.length > 100 ? "…" : ""}`)
      console.log(chalk.dim(`    follows: ${d.samples.join(", ")}`))
      if (d.url) console.log(chalk.dim(`    posted: ${d.url}`))
      if (d.file) console.log(chalk.dim(`    ready to paste: ${d.file}`))
      if (d.error) console.log(chalk.red(`    ${d.error}`))
    }
    if (!opts.all) console.log(chalk.dim("\n  Approve: agentx approvals approve content:<id> [--text \"edited post\"] · Reject: agentx approvals reject content:<id>"))
  })

content
  .command("show")
  .description("one draft in full, with the voice samples it followed")
  .argument("<id>", "draft id, with or without the content: prefix")
  .action((raw: string) => run(() => {
    const id = raw.replace(/^content:/, "")
    const d = readContentDraft(process.cwd(), id)
    if (!d) throw new Error(`no content draft "${id}"`)
    console.log(`  ${chalk.cyan(`content:${d.id}`)}  ${chalk.dim(`[${d.status}] ${PLATFORM_LABEL[d.platform]} · from ${d.agent} · ${d.created_at.slice(0, 16).replace("T", " ")} UTC`)}`)
    if (d.topic) console.log(`  ${chalk.bold(d.topic)}${d.date ? chalk.dim(` · planned for ${d.date}`) : ""}`)
    console.log("")
    console.log(d.text.split("\n").map((l) => `    ${l}`).join("\n"))
    console.log("")
    console.log(`  ${chalk.green("Follows your past posts:")} ${d.samples.join(", ")}`)
    console.log(chalk.dim(`    in ${voiceDir(d.workspace)}`))
    if (d.url) console.log(`  Posted: ${d.url}`)
    if (d.file) console.log(`  Ready to paste: ${d.file}`)
    if (d.error) console.log(chalk.red(`  ${d.error}`))
  }))

content
  .command("voice")
  .description("the past posts an agent learns your voice from (voice/ in its workspace)")
  .requiredOption("--agent <id>", "the content agent, e.g. content")
  .option("--topic <words>", "show the samples closest to a topic")
  .action((opts: { agent: string; topic?: string }) => run(() => {
    const ws = workspaceOf(opts.agent)
    const all = listSamples(ws)
    console.log(chalk.dim(`  ${voiceDir(ws)}`))
    if (all.length === 0) { console.log(chalk.yellow("  no past posts yet: put a few in this folder, one post per .md or .txt file")); return }
    const shown = opts.topic ? pickSamples(ws, opts.topic, 5) : pickSamples(ws, "", all.length)
    console.log(`  ${all.length} past post(s)${opts.topic ? `; closest to "${opts.topic}":` : ":"}`)
    for (const s of shown) console.log(`    ${chalk.cyan(s.file)}  ${chalk.dim(s.excerpt.slice(0, 90))}`)
  }))

content
  .command("calendar")
  .description("an agent's content calendar (calendar.md in its workspace)")
  .requiredOption("--agent <id>", "the content agent, e.g. content")
  .option("--days <n>", "how many days ahead", "14")
  .action((opts: { agent: string; days: string }) => run(() => {
    const ws = workspaceOf(opts.agent)
    const entries = readCalendar(ws)
    console.log(chalk.dim(`  ${calendarPath(ws)}`))
    if (!entries) { console.log(chalk.yellow("  no calendar yet: the agent creates it on its first weekly run")); return }
    const next = upcoming(entries, new Date(), Math.max(1, Number(opts.days) || 14))
    if (next.length === 0) { console.log(chalk.dim(`  nothing planned in the next ${opts.days} days`)); return }
    for (const e of next) console.log(`    ${e.date}  ${e.platform.padEnd(8)}  ${chalk.dim(`[${e.status}]`)}  ${e.topic}`)
  }))
