import { Command } from "commander"
import chalk from "chalk"
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import { applyConfigMutation, findConfigPath } from "@/daemon/config-mutator"
import { shippedTeam, shippedTeams } from "@/teams/catalog"
import { holdIfAgentCreated } from "@/agents/holds"
import {
  applyTeam,
  buildTeamPackage,
  fillPendingDelivery,
  ownerDestination,
  parseTeamPackage,
  teamConflicts,
  teamMembers,
  writeTeamSkills,
  type InstallPlan,
  type NotifyTarget,
  type TeamPackage,
} from "@/teams/package"

// --- agentx team — ready-made teams (#1164) ---
//
// A team is agents + their prompts and skills + the schedules that run on
// them + the channels they expect, in one file (src/teams/package.ts).
// `add` installs a shipped team or a file, `export` packs an installed team
// without its secrets, `import` is `add` from a file.

const TIERS = ["claude-code", "codex-cli", "opencode", "sdk", "orchestrator"]

function readConfig(configPath?: string): { path: string; config: any } {
  const path = findConfigPath(configPath)
  if (!existsSync(path)) {
    console.log(chalk.red(`  No config at ${path}. Run: agentx init`))
    process.exit(1)
  }
  return { path, config: JSON.parse(readFileSync(path, "utf-8")) }
}

function fail(message: string): never {
  console.log(chalk.red(`  ${message.split("\n").join("\n  ")}`))
  process.exit(1)
}

function readPackageFile(file: string): TeamPackage {
  const path = resolve(file)
  if (!existsSync(path)) fail(`No file at ${path}`)
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, "utf-8")) } catch (e: any) { fail(`${path} is not JSON: ${e.message}`) }
  try { return parseTeamPackage(raw) } catch (e: any) { fail(e.message) }
}

/** A shipped team by name, else a package file. */
function resolvePackage(nameOrFile: string): TeamPackage {
  const shipped = shippedTeam(nameOrFile)
  if (shipped) return shipped
  if (existsSync(resolve(nameOrFile)) || nameOrFile.endsWith(".json")) return readPackageFile(nameOrFile)
  fail(`No team named "${nameOrFile}". Run: agentx team list`)
}

interface AddOpts { tier?: string; provider?: string; timezone?: string; workspaces?: string; force?: boolean; dryRun?: boolean; config?: string }

/** Add `pkg` to the config and write its workspaces; `agentx start --team` uses it too. */
export async function install(pkg: TeamPackage, opts: AddOpts): Promise<void> {
  if (opts.tier && !TIERS.includes(opts.tier)) fail(`--tier must be one of: ${TIERS.join(", ")}`)
  const { path, config } = readConfig(opts.config)
  const workspaceRoot = resolve(dirname(path), opts.workspaces ?? "agents")
  const taken = teamConflicts(config, pkg, { workspaceRoot, force: opts.force })
  if (taken.length) fail(`Already in this install: ${taken.join(", ")}.\nRemove them first (agentx agent remove <id>, agentx schedule remove <id>), choose another --workspaces folder, or edit the package's ids.`)

  let plan: InstallPlan | undefined
  const result = await applyConfigMutation((cfg) => {
    plan = applyTeam(cfg, pkg, { workspaceRoot, tier: opts.tier as any, provider: opts.provider, timezone: opts.timezone, force: opts.force })
  }, { configPath: path, dryRun: !!opts.dryRun })
  if (!result.success || !plan) fail(`Config save failed: ${result.error}`)

  console.log()
  console.log(`  ${chalk.bold(pkg.title)}${opts.dryRun ? chalk.yellow("  (dry run: nothing written)") : ""}`)
  console.log(chalk.dim(`  ${pkg.result}`))
  console.log()

  let kept: string[] = []
  if (!opts.dryRun) {
    const { setupWorkspace } = await import("@/agents/workspace-setup")
    const wikiSkill = wikiSkillSource()
    for (const a of plan.agents) {
      mkdirSync(a.workspace, { recursive: true })
      setupWorkspace(a.id, result.after && (result.after as any).agents[a.id], "19900", () => {})
      const wikiTarget = resolve(a.workspace, ".claude/skills/wiki/SKILL.md")
      if (wikiSkill && a.tier === "claude-code" && !existsSync(wikiTarget)) {
        mkdirSync(dirname(wikiTarget), { recursive: true })
        cpSync(wikiSkill, wikiTarget, { errorOnExist: true, force: false })
      }
    }
    kept = writeTeamSkills(pkg, plan).kept
  }
  // Added by an agent from its own shell: the new agents wait for the owner (#1169).
  const heldBy = opts.dryRun ? undefined : holdIfAgentCreated(dirname(path), plan.agents.map((a) => a.id))

  for (const a of plan.agents) {
    const skills = a.skills.length ? chalk.dim(`  skills: ${a.skills.join(", ")}`) : ""
    console.log(`  ${chalk.green("+")} agent ${chalk.cyan(a.id)} (${a.tier})${skills}`)
    console.log(chalk.dim(`      ${a.workspace}`))
  }
  for (const id of plan.schedules) {
    const job = (result.after as any).crons[id]
    console.log(`  ${chalk.green("+")} schedule ${chalk.cyan(id)} — ${job.schedule} (${job.timezone})${job.enabled ? "" : chalk.dim(" disabled")}`)
  }
  if (result.reloaded) console.log(chalk.dim("  (daemon hot-reloaded)"))
  if (heldBy) console.log(chalk.yellow(`  Added by agent "${heldBy}": these agents start once the owner approves each one (agentx approvals list).`))
  if (kept.length) {
    console.log(chalk.yellow(`  Kept ${kept.length} file${kept.length === 1 ? "" : "s"} already there instead of the team's version:`))
    for (const f of kept) console.log(chalk.dim(`      ${f}`))
  }

  if (plan.channels.length) {
    console.log()
    console.log(chalk.bold("  One step left: connect the channel"))
    // One step per channel kind: a GitLab project is connected once, and
    // the other agents are reached on it by @mention.
    const kinds = [...new Set(plan.channels.map((c) => c.kind))]
    for (const kind of kinds) {
      const of = plan.channels.filter((c) => c.kind === kind)
      console.log(`    ${of[0].step}`)
      for (const c of of) if (c.why) console.log(chalk.dim(`      ${c.agent}: ${c.why}`))
    }
  }
  const { delivery } = plan
  if (delivery.schedules.length) {
    console.log()
    if (delivery.to) {
      console.log(`  Results go to you on ${delivery.to.channel} (${delivery.to.chatId}): ${delivery.schedules.join(", ")}`)
    } else {
      console.log(chalk.bold("  Then tell AgentX where to send you the results"))
      console.log(`    ${delivery.schedules.join(", ")} will send ${delivery.schedules.length === 1 ? "its" : "their"} answers once you do one of these:`)
      console.log(`    agentx connect telegram   ${chalk.dim("(say yes when it offers to listen for your first message)")}`)
      console.log(`    agentx team notify ${pkg.name} telegram:<chat id>`)
    }
  }

  console.log()
}

/** The wiki skill every agent gets from `agentx agent add`, dev or bundled. */
function wikiSkillSource(): string | null {
  const candidates = [
    resolve(process.cwd(), "src/wiki/SKILL.md"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../wiki/SKILL.md"),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

export const team = new Command()
  .name("team")
  .description("ready-made teams — list, add one in one step, export and import")

team
  .command("list")
  .alias("ls")
  .description("list the teams you can add, and the teams installed here")
  .option("-c, --config <path>", "path to agentx.json")
  .action((opts) => {
    const path = findConfigPath(opts.config)
    const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {}
    const installed = new Set<string>(Object.values(config.agents || {}).map((a: any) => a?.team).filter(Boolean))

    console.log()
    console.log(chalk.bold("  Teams you can add"))
    for (const t of shippedTeams()) {
      const mark = installed.has(t.name) ? chalk.green(" installed") : ""
      console.log(`  ${chalk.cyan(t.name)} — ${t.title}${mark}`)
      console.log(chalk.dim(`    ${t.result}`))
    }

    const own = [...installed].filter((n) => !shippedTeam(n)).sort()
    if (own.length) {
      console.log()
      console.log(chalk.bold("  Other teams installed here"))
      for (const n of own) console.log(`  ${chalk.cyan(n)} — ${teamMembers(config, n).join(", ")}`)
    }
    console.log()
    console.log(chalk.dim("  Add one: agentx team add <name>"))
    console.log()
  })

team
  .command("add <name>")
  .description("add a team: its agents, skills and schedules. <name> is a team from `team list` or a package file")
  .option("--tier <tier>", "runtime for every agent of the team (default: the package's, else claude-code)")
  .option("--timezone <tz>", "time zone for schedules that do not set one (default: this machine's)")
  .option("--workspaces <dir>", "folder for the agents' workspaces, next to agentx.json", "agents")
  .option("--force", "use workspace folders that already exist; files in them are never overwritten")
  .option("--dry-run", "show what would be added, write nothing")
  .option("-c, --config <path>", "path to agentx.json")
  .action(async (name: string, opts: AddOpts) => {
    await install(resolvePackage(name), opts)
  })

team
  .command("import <file>")
  .description("add a team from a package file made by `team export`")
  .option("--tier <tier>", "runtime for every agent of the team (default: the package's, else claude-code)")
  .option("--timezone <tz>", "time zone for schedules that do not set one (default: this machine's)")
  .option("--workspaces <dir>", "folder for the agents' workspaces, next to agentx.json", "agents")
  .option("--force", "use workspace folders that already exist; files in them are never overwritten")
  .option("--dry-run", "show what would be added, write nothing")
  .option("-c, --config <path>", "path to agentx.json")
  .action(async (file: string, opts: AddOpts) => {
    await install(readPackageFile(file), opts)
  })

team
  .command("notify <name> [target]")
  .description('send the answers of a team\'s schedules to you. [target]: "me" (notifications.destination, the default) or "channel:chatId[:accountId]"')
  .option("-c, --config <path>", "path to agentx.json")
  .action(async (name: string, target: string | undefined, opts) => {
    const { path, config } = readConfig(opts.config)
    const members = teamMembers(config, name)
    if (!members.length) fail(`No agents belong to team "${name}". Run: agentx team list`)
    const to = parseNotifyTarget(target ?? "me", config)
    const ids = Object.entries(config.crons || {})
      .filter(([, c]: any) => members.includes(c?.agent) && c.deliverResult === true)
      .map(([id]) => id)
    if (!ids.length) fail(`Team "${name}" has no schedules that report to you.`)
    let set: string[] = []
    const result = await applyConfigMutation((cfg) => {
      set = fillPendingDelivery(cfg, to, { ids, replace: true })
    }, { configPath: path })
    if (!result.success) fail(`Config save failed: ${result.error}`)
    console.log(chalk.green(`  Results of ${set.join(", ")} now go to ${to.channel} (${to.chatId})`))
    if (result.reloaded) console.log(chalk.dim("  (daemon hot-reloaded)"))
  })

function parseNotifyTarget(target: string, config: any): NotifyTarget {
  if (target === "me") {
    const dest = ownerDestination(config)
    if (!dest) fail(`No notifications.destination yet. Run: agentx connect telegram, or give "channel:chatId".`)
    return dest
  }
  const [channel, chatId, accountId] = target.split(":")
  if (!channel || !chatId) fail(`Not a target: ${target} (use "me" or "channel:chatId[:accountId]")`)
  return accountId ? { channel, chatId, accountId } : { channel, chatId }
}

team
  .command("export <name>")
  .description("write a team to one file you can share: agents, prompts, skills, schedules, channel kinds. No channel config, tokens checked")
  .option("-o, --output <file>", "file to write; - prints it (default: <name>.team.json)")
  .option("--agents <ids...>", "agents to export (default: the agents installed with this team)")
  .option("--title <text>", "title shown in `team list`")
  .option("--result <text>", "one line: the result this team delivers")
  .option("--description <text>", "a few lines on how the team works")
  .option("-c, --config <path>", "path to agentx.json")
  .action((name: string, opts) => {
    const { config } = readConfig(opts.config)
    const shipped = shippedTeam(name)
    let pkg: TeamPackage
    try {
      pkg = buildTeamPackage(config, name, {
        agents: opts.agents,
        title: opts.title ?? shipped?.title,
        result: opts.result ?? shipped?.result,
        description: opts.description ?? shipped?.description,
        expectedChannels: shipped?.channels,
      })
    } catch (e: any) {
      fail(e.message)
    }
    const json = JSON.stringify(pkg, null, 2) + "\n"
    if (opts.output === "-") {
      process.stdout.write(json)
      return
    }
    const out = resolve(opts.output ?? `${name}.team.json`)
    writeFileSync(out, json)
    const n = Object.keys(pkg.agents).length
    const s = Object.keys(pkg.schedules).length
    console.log(chalk.green(`  Team "${name}" written to ${out}`))
    console.log(chalk.dim(`  ${n} agent${n === 1 ? "" : "s"}, ${s} schedule${s === 1 ? "" : "s"}; no chat ids, contacts, routes or commands`))
    console.log(chalk.dim("  Common token formats were checked; read the prompts and skills for passwords before you share it."))
    console.log(chalk.dim(`  On the other install: agentx team import ${out.split("/").pop()}`))
  })
