import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"

// --- agentx review-gate — the pre-merge review gate (#990) ---
//
//   agentx review-gate list [--days 7]               recent reviews and their cost
//   agentx review-gate replay <owner/repo> <pr…>     review past PRs, post nothing
//
// The replay is the seeded check: run it on PRs that later needed a
// same-day fix and see how many the reviewer would have flagged. Settings:
// `agentx config set quality.reviewGate.<key> <value>`.

export const reviewGateCmd = new Command()
  .name("review-gate")
  .description("independent pre-merge review of agent PRs against their linked issue")

interface Opts { node?: string; token?: string; config?: string }

function daemon(opts: Opts): { baseUrl: string; headers: Record<string, string> } {
  let baseUrl = opts.node || ""
  let token = opts.token || ""
  if (!baseUrl || !token) {
    try {
      const cfg = loadDaemonConfig(opts.config)
      if (!baseUrl) baseUrl = cfg.dashboard?.daemonUrl || ""
      if (!token) token = cfg.dashboard?.token || ""
    } catch { /* fall back to defaults */ }
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`
  return { baseUrl: (baseUrl || "http://localhost:18800").replace(/\/+$/, ""), headers }
}

async function request(opts: Opts, method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  const { baseUrl, headers } = daemon(opts)
  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
  } catch (e: any) {
    console.log(chalk.red(`  could not reach daemon at ${baseUrl}: ${e.message || e}`))
    process.exit(1)
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as any
    console.log(chalk.red(`  HTTP ${res.status}${data.error ? ` — ${data.error}` : ""}`))
    process.exit(1)
  }
  return res
}

const common = (c: Command) => c
  .option("-c, --config <path>", "daemon config file")
  .option("--node <url>", "daemon URL (defaults to dashboard.daemonUrl)")
  .option("--token <token>", "bearer token (defaults to dashboard.token)")

const paint = (state: string) => state === "success" ? chalk.green(state) : state === "failure" ? chalk.red(state) : chalk.yellow(state)

common(reviewGateCmd
  .command("list")
  .description("recent reviews, with what they cost and how long they took")
  .option("--days <n>", "how many days back", "7")
  .option("--replays", "include replayed reviews"))
  .action(async (opts) => {
    const q = new URLSearchParams({ days: String(opts.days) })
    if (opts.replays) q.set("replays", "1")
    const data = await (await request(opts, "GET", `/api/review-gate/reviews?${q}`)).json() as any
    const s = data.summary
    console.log(chalk.bold(`  Last ${data.days} days: ${s.reviews} reviews on ${s.prs} PRs`) +
      chalk.dim(` — ${s.byState.success} passed, ${s.byState.failure} failed, ${s.byState.error} errors`))
    console.log(chalk.dim(`  cost $${s.costUsd}${s.unpriced ? ` (+${s.unpriced} unpriced)` : ""}, ${s.minutes} min, ${s.tokens} tokens` +
      (s.p90SincePushMinutes !== undefined ? `, push → status p90 ${s.p90SincePushMinutes} min` : "")))
    for (const r of data.reviews) {
      console.log(`  ${r.at.slice(0, 16).replace("T", " ")}  ${r.repo}#${r.pr} ${r.sha.slice(0, 7)}  ${paint(r.state)}  ${chalk.dim(r.reason)}${r.replay ? chalk.dim(" (replay)") : ""}`)
    }
  })

common(reviewGateCmd
  .command("replay <repo> <prs...>")
  .description("review past PRs at their head commit without posting anything; counts how many get flagged"))
  .action(async (repo: string, prs: string[], opts) => {
    const res = await request(opts, "POST", "/api/review-gate/replay", { repo, prs: prs.map(Number) })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (value) buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const r = JSON.parse(line)
        if (r.done) console.log(chalk.bold(`  flagged ${r.flagged} of ${r.of}`))
        else if (r.error) console.log(`  #${r.pr}  ${chalk.yellow("error")}  ${chalk.dim(r.error)}`)
        else console.log(`  #${r.pr}  ${paint(r.state)}${r.flagged ? chalk.red(" flagged") : ""}  ${chalk.dim(r.reason)}`)
      }
      if (done) break
    }
  })
