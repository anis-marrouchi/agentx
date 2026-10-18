import { Command } from "commander"
import { existsSync, readFileSync } from "fs"
import chalk from "chalk"
import { openDb } from "@/storage/sqlite"
import { CLOSED_STATES, OPEN_STATES, RequestStore, type RequestRecord } from "@/requests/store"
import { LIST_MAX } from "@/requests/daemon-api"
import { startOfDay, todayRows } from "@/requests/today"
import { readRequestSettings, updateRequestSettings, type RequestSettingsPatch } from "@/requests/settings"
import { findConfigPath } from "@/daemon/config-mutator"
import { PlanStore, type PlanStep } from "@/requests/plan-store"
import { ownerStepAction, type OwnerStepAction } from "@/requests/plan-sweep"
import { DEFAULT_PLAN_SETTINGS } from "@/requests/plans"
import { CHECK_KINDS, DEFAULT_CHECKER_SETTINGS, describeCloseWhen, type CheckKind } from "@/requests/checkers"
import { activeStepAgentOf, STALL_GROUPS, stalledLoops, waitsOnWords } from "@/requests/loops"

// --- agentx requests — what you asked for that is not finished (#356) ---
//
// Reads and closes requests in .agentx/db.sqlite, the same file the daemon
// writes. Run it from the folder that holds agentx.json. This is an owner
// surface: it can drop a request, which agents cannot.

export const requests = new Command("requests")
  .description("what you asked agents for that is not finished, oldest first")

const STATE_LABEL: Record<string, string> = {
  in_progress: "in progress",
  waiting_owner: "waiting on you",
  waiting_other: "waiting on another agent",
  needs_attention: "needs attention",
  done: "done",
  declined: "declined",
  dropped: "dropped",
}

/** The plans beside the requests: opened only after store() said this is a node's folder. */
function planStore(): PlanStore | null {
  const db = openDb({ quiet: true })
  return db ? new PlanStore(db) : null
}

const STEP_COLOUR: Record<string, (s: string) => string> = {
  done: chalk.green, skipped: chalk.dim, blocked: chalk.red, active: chalk.cyan, pending: chalk.dim,
}

function printSteps(steps: PlanStep[]): void {
  for (const s of steps) {
    const colour = STEP_COLOUR[s.state] ?? chalk.dim
    const approval = s.needsApproval ? chalk.dim(` · approval ${s.approval}`) : ""
    const nudges = s.nudges ? chalk.dim(` · ${s.nudges} nudge${s.nudges === 1 ? "" : "s"}`) : ""
    console.log(`    ${s.idx}. ${s.name} ${chalk.dim(`(${s.agentId}, ${s.kind})`)} ${colour(`[${s.state}]`)}${approval}${nudges}`)
    console.log(chalk.dim(`       done when: ${s.doneWhen}`))
    if (s.evidence) console.log(chalk.green(`       ${s.evidence}`))
    if (s.note && (s.state === "blocked" || s.state === "skipped")) console.log(colour(`       ${s.note}`))
  }
}

function store(): RequestStore | null {
  // openDb creates the file: never do that in a folder that is not a node's.
  // The database file does not prove it is one: the usage recorder creates
  // it in a subfolder of an install before this runs. The config does.
  if (!existsSync(findConfigPath())) { console.error(chalk.red("  no agentx.json here: run this from the install folder, the one that holds agentx.json")); process.exitCode = 1; return null }
  const db = openDb()
  if (!db) { process.exitCode = 1; return null }
  return new RequestStore(db)
}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC"

function printRequest(r: RequestRecord): void {
  const colour = r.state === "needs_attention" ? chalk.red : r.state === "waiting_owner" ? chalk.yellow : chalk.dim
  console.log(`  ${chalk.cyan(r.id)}  ${colour(`[${STATE_LABEL[r.state] ?? r.state}]`)} ${chalk.dim(`${when(r.createdAt)} · ${r.channel} · ${r.agentId}`)}`)
  console.log(`    ${r.text.replace(/\s+/g, " ").trim().slice(0, 240)}`)
  if (r.state === "waiting_owner" && r.question) console.log(chalk.yellow(`    Question: ${r.question}`))
  if (r.state === "needs_attention" && r.attentionReason) console.log(chalk.red(`    ${r.attentionReason}`))
  if (r.promise && r.owedTo) console.log(chalk.dim(`    Promised to ${r.owedTo}`))
  if (r.dueAt) console.log((r.closedAt === null && Date.now() > r.dueAt ? chalk.red : chalk.dim)(`    Due ${when(r.dueAt)}`))
  if (r.closeWhen) {
    const v = r.verifyState ? ` [${r.verifyState}${r.verifyDetail ? `: ${r.verifyDetail}` : ""}]` : ""
    console.log((r.verifyState === "failed" || r.verifyState === "unverified" ? chalk.yellow : chalk.dim)(`    Closes when ${describeCloseWhen(r.closeWhen)}${v}`))
  }
  if (r.evidence) console.log(chalk.green(`    Evidence: ${r.evidence}`))
  if (r.closeReason) console.log(chalk.dim(`    Reason: ${r.closeReason}`))
}

requests
  .command("list", { isDefault: true })
  .alias("ls")
  .description("open requests, oldest first")
  .option("--json", "machine-readable output")
  .option("--stalled", "only the stalled ones (past their due time, or quiet too long), grouped by what they wait on")
  .action((opts: { json?: boolean; stalled?: boolean }) => {
    const s = store()
    if (!s) return
    if (opts.stalled) { printStalled(s, !!opts.json); return }
    const items = s.listOpen()
    if (opts.json) { console.log(JSON.stringify(items, null, 2)); return }
    if (!readRequestSettings().enabled) console.log(chalk.dim("  requests are off: turn them on with `agentx requests settings --enabled on`"))
    if (items.length === 0) { console.log(chalk.dim("  no open requests")); return }
    for (const r of items) printRequest(r)
    console.log(chalk.dim(`\n  ${items.length} open. Close one: agentx requests done <id> --evidence <link> · agentx requests drop <id>`))
  })

requests
  .command("today")
  .description("what you asked since 00:00 Tunis and where each one landed; no home first, in red")
  .option("--json", "machine-readable output, for the Desk and voice")
  .action((opts: { json?: boolean }) => {
    const s = store()
    if (!s) return
    const since = startOfDay(Date.now())
    const { items, total } = s.query({ states: [...OPEN_STATES, ...CLOSED_STATES], since, limit: LIST_MAX, newest: true })
    const plans = planStore()
    const rows = todayRows(items.map((r) => ({ ...r, links: s.links(r.id) })), { hasPlan: (id) => !!plans?.get(id) })
    const counts = {
      total, noHome: rows.filter((r) => r.noHome).length,
      open: rows.filter((r) => (OPEN_STATES as readonly string[]).includes(r.state)).length,
      done: rows.filter((r) => r.state === "done").length,
    }
    if (opts.json) { console.log(JSON.stringify({ since, counts, truncated: total > items.length, rows }, null, 2)); return }
    console.log(`  Since 00:00 Tunis: ${counts.total} request(s), ${counts.open} open, ${counts.done} done, ` +
      (counts.noHome ? chalk.red(`${counts.noHome} with no home`) : "all with a home"))
    if (total > items.length) console.log(chalk.dim(`  only the newest ${items.length} are listed`))
    for (const r of rows) {
      const where = r.noHome ? chalk.red("no home") : chalk.dim(r.landed.map((l) => `${l.kind} ${l.ref}`).join(" · "))
      console.log(`  ${(r.noHome ? chalk.red : chalk.white)(r.time)}  ${chalk.dim(`[${STATE_LABEL[r.state] ?? r.state}] ${r.owner}`)}  ${r.words}`)
      console.log(`         → ${where}  ${chalk.dim(r.id)}`)
    }
  })

/** This node's agent ids, from agentx.json. Empty when it cannot be read. */
function agentIds(): Set<string> {
  try { return new Set(Object.keys(JSON.parse(readFileSync(findConfigPath(), "utf-8"))?.agents ?? {})) } catch { return new Set() }
}

function printStalled(s: RequestStore, json: boolean): void {
  const agents = agentIds()
  const groups = stalledLoops(s.listOpen(), readRequestSettings().staleAfterHours, Date.now(), {
    isAgent: (id) => agents.has(id), activeStepAgent: activeStepAgentOf(planStore()),
  })
  if (json) {
    console.log(JSON.stringify(Object.fromEntries(STALL_GROUPS.map((g) => [g, groups[g].map((l) => ({ ...l.request, waitsOn: l.who, why: l.why }))])), null, 2))
    return
  }
  const title: Record<string, string> = { owner: "Waiting on you", agent: "Waiting on an agent", person: "Waiting on an outside person" }
  let n = 0
  for (const g of STALL_GROUPS) {
    if (!groups[g].length) continue
    console.log(chalk.bold(`\n  ${title[g]} (${groups[g].length})`))
    for (const l of groups[g]) {
      printRequest(l.request)
      console.log(chalk.red(`    Stalled: ${l.why}${g === "owner" ? "" : ` · waiting on ${waitsOnWords(g, l.who)}`}`))
      n++
    }
  }
  if (!n) { console.log(chalk.dim("  nothing is stalled")); return }
  console.log(chalk.dim(`\n  ${n} stalled. Close one by hand: agentx requests done <id> --reason <text> · agentx requests drop <id>`))
}

requests
  .command("show <id>")
  .description("one request and the runs, delegations and cards linked to it")
  .action((id: string) => {
    const s = store()
    if (!s) return
    const r = s.get(id)
    if (!r || r.state === "candidate") { console.error(chalk.red(`  no request "${id}"`)); process.exitCode = 1; return }
    printRequest(r)
    console.log(chalk.dim(`    Last activity ${when(r.updatedAt)}${r.closedAt ? ` · closed ${when(r.closedAt)}` : ""}`))
    for (const l of s.links(id)) console.log(chalk.dim(`    ${l.kind} ${l.ref} (${when(l.at)})`))
    const plans = planStore()
    const plan = plans?.get(id)
    if (!plans || !plan) return
    console.log(`\n  Plan ${chalk.dim(`[${plan.state}] by ${plan.createdBy}, ${when(plan.createdAt)}`)}`)
    printSteps(plans.steps(id))
    console.log("\n  Log")
    for (const e of plans.events(id)) console.log(chalk.dim(`    ${when(e.at)}  ${e.step ? `step ${e.step} ` : ""}${e.kind}: ${e.detail}`))
  })

requests
  .command("step <id> <step>")
  .description("move a step of a request's plan on: --retry, --skip or --done")
  .option("--retry", "hand the step to its agent again, with a fresh count of nudges (approves a message whose card expired)")
  .option("--skip", "leave the step out; the plan goes on with the next one")
  .option("--done", "mark the step done yourself")
  .option("--note <text>", "why, or the evidence for --done")
  .action((id: string, step: string, opts: { retry?: boolean; skip?: boolean; done?: boolean; note?: string }) => {
    const chosen = (["retry", "skip", "done"] as const).filter((k) => opts[k])
    if (chosen.length !== 1) { console.error(chalk.red("  give one of --retry, --skip or --done")); process.exitCode = 1; return }
    const s = store()
    if (!s) return
    const plans = planStore()
    if (!plans) { process.exitCode = 1; return }
    const n = Number(step)
    const err = ownerStepAction(s, plans, { requestId: id, step: n, action: chosen[0] as OwnerStepAction, detail: opts.note }, Date.now())
    if (err) { console.error(chalk.red(`  ${err}`)); process.exitCode = 1; return }
    console.log(chalk.green(`  ✓ step ${n} of ${id}: ${chosen[0] === "retry" ? "handed over again" : chosen[0] === "skip" ? "skipped" : "done"}`) + chalk.dim(" (the daemon goes on within a minute)"))
    printSteps(plans.steps(id))
  })

function closeCommand(name: "done" | "drop", description: string, flag: string, missing: string): void {
  const cmd = requests
    .command(`${name} <id>`)
    .description(description)
    .option(flag, name === "done" ? "link to the proof: PR, issue, message, deploy" : "why it is dropped")
  if (name === "done") cmd.option("--reason <text>", "close it by hand without a link, saying why (\"checked by hand\"); also closes a loop its check cannot verify")
  cmd.action((id: string, opts: { evidence?: string; reason?: string }) => {
      const s = store()
      if (!s) return
      // The owner's hand close (#1039): the record says it skipped any check.
      const detail = name === "done"
        ? opts.evidence ?? (opts.reason ? `closed by owner: ${opts.reason}` : undefined)
        : opts.reason ?? "dropped by the owner"
      if (!detail) { console.error(chalk.red(`  ${missing}`)); process.exitCode = 1; return }
      const r = s.get(id)
      if (!r || r.state === "candidate") { console.error(chalk.red(`  no request "${id}"`)); process.exitCode = 1; return }
      if (!s.close(id, name === "done" ? "done" : "dropped", detail, Date.now())) {
        console.error(chalk.red(`  ${id} is already closed (${STATE_LABEL[r.state] ?? r.state})`)); process.exitCode = 1; return
      }
      console.log(chalk.green(`  ✓ ${id} ${name === "done" ? "closed as done" : "dropped"}`))
    })
}
closeCommand("done", "close a request as finished, with a link to the evidence or the reason", "--evidence <link>", "a finished request needs --evidence <link> or --reason <text>")
closeCommand("drop", "drop a request you no longer want", "--reason <text>", "")

requests
  .command("settings")
  .description("show or change the requests settings")
  .option("--enabled <on|off>", "record and follow your requests")
  .option("--from <id,...>", "who counts as you on channels other people can reach, as channel:id (your login on GitLab and GitHub, your sender id elsewhere); \"none\" to clear")
  .option("--channels <name,...>", "channels to record on; \"all\" for every channel a person writes on")
  .option("--stale-hours <n>", "hours without activity before an open request comes back to you")
  .option("--retention-days <n>", "days a closed request is kept")
  .option("--plans <on|off>", "follow requests of two or more steps as tracked plans")
  .option("--stall-minutes <n>", "minutes without progress before a plan step's agent is nudged")
  .option("--max-nudges <n>", "nudges per step before it counts as blocked and you are told")
  .option("--approve-kinds <kind,...>", "step kinds you approve once when the plan is made; \"none\" to clear")
  .option("--plans-off-for <agent,...>", "agents that may not open a plan; \"none\" to clear")
  .option("--checks <kind,...>", `checks agents may use to close a loop (${CHECK_KINDS.join(", ")}); "none" to turn them all off`)
  .option("--check-every <minutes>", "how often each open loop's check runs")
  .action(async (opts: Record<string, string | undefined>) => {
    const patch: RequestSettingsPatch = {}
    try {
      const num = (flag: string, v: string | undefined) => {
        if (v === undefined) return undefined
        const n = Number(v)
        if (!(n > 0)) throw new Error(`${flag} must be a positive number`)
        return n
      }
      const list = (v: string | undefined, empty: string) =>
        v === undefined ? undefined : v === empty ? [] : v.split(",").map((x) => x.trim()).filter(Boolean)
      if (opts.enabled !== undefined) {
        if (opts.enabled !== "on" && opts.enabled !== "off") throw new Error("--enabled takes on or off")
        patch.enabled = opts.enabled === "on"
      }
      patch.from = list(opts.from, "none")
      patch.channels = list(opts.channels, "all")
      patch.staleAfterHours = num("--stale-hours", opts.staleHours)
      patch.retentionDays = num("--retention-days", opts.retentionDays)
      const plans: NonNullable<RequestSettingsPatch["plans"]> = {}
      if (opts.plans !== undefined) {
        if (opts.plans !== "on" && opts.plans !== "off") throw new Error("--plans takes on or off")
        plans.enabled = opts.plans === "on"
      }
      plans.stallMinutes = num("--stall-minutes", opts.stallMinutes)
      if (opts.maxNudges !== undefined) {
        const n = Number(opts.maxNudges)
        if (!Number.isInteger(n) || n < 0) throw new Error("--max-nudges must be a whole number, 0 or more")
        plans.maxNudges = n
      }
      plans.approveKinds = list(opts.approveKinds, "none")
      plans.disabledAgents = list(opts.plansOffFor, "none")
      if (Object.values(plans).some((v) => v !== undefined)) patch.plans = plans
      const checkers: NonNullable<RequestSettingsPatch["checkers"]> = {}
      const kinds = list(opts.checks, "none")
      if (kinds) {
        const bad = kinds.filter((k) => !(CHECK_KINDS as readonly string[]).includes(k))
        if (bad.length) throw new Error(`unknown check ${bad.join(", ")}: use ${CHECK_KINDS.join(", ")}`)
        checkers.enabled = kinds as CheckKind[]
      }
      checkers.checkEveryMinutes = num("--check-every", opts.checkEvery)
      if (Object.values(checkers).some((v) => v !== undefined)) patch.checkers = checkers
    } catch (e: any) {
      console.error(chalk.red(`  ${e.message}`)); process.exitCode = 1; return
    }
    if (Object.values(patch).some((v) => v !== undefined)) {
      const r = await updateRequestSettings(patch)
      if (!r.success) { console.error(chalk.red(`  ${r.error}`)); process.exitCode = 1; return }
      console.log(chalk.green("  ✓ saved") + (r.reloaded ? chalk.dim(" (daemon reloaded)") : ""))
    }
    const s = readRequestSettings()
    console.log(`  Requests                ${s.enabled ? "on" : "off"}`)
    console.log(`  Channels                ${s.channels.length ? s.channels.join(", ") : "every channel a person writes on"}`)
    console.log(`  Counts as you           ${s.from.length ? s.from.join(", ") : "only voice, the app and the dashboard on this machine"}`)
    console.log(`  Comes back after        ${s.staleAfterHours} hour(s) without activity`)
    console.log(`  Closed requests kept    ${s.retentionDays} day(s)`)
    const p = s.plans ?? DEFAULT_PLAN_SETTINGS
    console.log(`  Plans                   ${p.enabled ? "on" : "off"}`)
    console.log(`  Nudge a quiet step      after ${p.stallMinutes} minute(s), up to ${p.maxNudges} time(s)`)
    console.log(`  You approve up front    ${p.approveKinds.length ? p.approveKinds.join(", ") : "nothing"}`)
    console.log(`  Plans off for           ${p.disabledAgents.length ? p.disabledAgents.join(", ") : "no agent"}`)
    const c = s.checkers ?? DEFAULT_CHECKER_SETTINGS
    console.log(`  Loop checks             ${c.enabled.length ? c.enabled.join(", ") : "off"}, every ${c.checkEveryMinutes} minute(s)`)
    const repos = Object.keys(c.repos)
    console.log(`  Repos for git-ancestor  ${repos.length ? repos.join(", ") : "none (requests.checkers.repos in agentx.json)"}`)
  })
