import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { crossFieldProblems, daemonConfigSchema } from "../src/daemon/config"
import { CronScheduler } from "../src/crons/scheduler"
import { shippedTeam, shippedTeams } from "../src/teams/catalog"
import {
  TEAM_FORMAT,
  applyTeam,
  buildTeamPackage,
  fillPendingDelivery,
  parseTeamPackage,
  teamConflicts,
  writeTeamSkills,
} from "../src/teams/package"

// Ready-made teams (#1164): a shipped team installs into a fresh config as
// working agents and schedules, and export → import on another install
// gives the same agents and schedules with no secrets in the file.

const TG_TOKEN = "1234567890:" + "A".repeat(35)
const GL_TOKEN = "glpat-" + "x".repeat(24)

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-teams-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function freshConfig(): any {
  return { node: { id: "demo-node", name: "Demo node" }, agents: {}, crons: {} }
}

function expectValid(config: any) {
  const parsed = daemonConfigSchema.safeParse(config)
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"))
  expect(crossFieldProblems(parsed.data)).toEqual([])
}

describe("shipped teams", () => {
  const teams = shippedTeams()

  it("ships at least three teams", () => {
    expect(teams.length).toBeGreaterThanOrEqual(3)
    expect(new Set(teams.map((t) => t.name)).size).toBe(teams.length)
  })

  it.each(teams.map((t) => [t.name, t] as const))("%s has a README that states its result", (name, t) => {
    const readme = readFileSync(resolve(__dirname, "../src/teams/catalog", name, "README.md"), "utf-8")
    expect(readme).toContain(`**Result:** ${t.result}`)
    for (const id of Object.keys(t.schedules)) expect(readme).toContain(id)
    for (const id of Object.keys(t.agents)) expect(readme).toContain(`\`${id}\``)
  })

  it.each(teams.map((t) => [t.name, t] as const))("%s installs into a fresh config as valid agents and schedules", (_name, t) => {
    const config = freshConfig()
    const plan = applyTeam(config, t, { workspaceRoot: join(dir, "agents"), timezone: "UTC" })
    expectValid(config)
    expect(plan.agents.map((a) => a.id).sort()).toEqual(Object.keys(t.agents).sort())
    expect(plan.schedules.sort()).toEqual(Object.keys(t.schedules).sort())
    for (const id of Object.keys(t.agents)) expect(config.agents[id].team).toBe(t.name)
    for (const id of Object.keys(t.schedules)) {
      expect(config.crons[id].enabled).toBe(true)
      expect(config.crons[id].model).toBeUndefined()
    }
    // Connecting the channel is the one manual step: nothing written for it.
    expect(config.channels).toBeUndefined()
    expect(plan.channels.length).toBeGreaterThan(0)
    for (const c of plan.channels) expect(c.step).toMatch(/agentx|channels\./)
  })

  it("refuses to install over agents or schedules already there", () => {
    const t = shippedTeam("client-inbox")!
    const config = freshConfig()
    config.agents.inbox = { name: "Mine", workspace: "/tmp/x" }
    expect(() => applyTeam(config, t, { workspaceRoot: dir })).toThrow(/agent "inbox"/)
    expect(config.agents.inbox.name).toBe("Mine")
    expect(config.crons).toEqual({})
  })

  it("writes each agent's skills where its runtime reads them", () => {
    const t = shippedTeam("dev-team")!
    const config = freshConfig()
    const plan = applyTeam(config, t, { workspaceRoot: dir })
    writeTeamSkills(t, plan)
    expect(existsSync(join(dir, "dev/.claude/skills/issue-to-merge-request/SKILL.md"))).toBe(true)
    expect(existsSync(join(dir, "reviewer/.claude/skills/merge-request-review/SKILL.md"))).toBe(true)

    const codex = freshConfig()
    const codexPlan = applyTeam(codex, t, { workspaceRoot: join(dir, "codex"), tier: "codex-cli" })
    writeTeamSkills(t, codexPlan)
    expect(existsSync(join(dir, "codex/dev/.agents/skills/issue-to-merge-request/SKILL.md"))).toBe(true)
  })
})

describe("results reach the owner", () => {
  const OWNER = { channel: "telegram", chatId: "2000", accountId: "sales" }
  const prevCwd = process.cwd()
  afterEach(() => { process.chdir(prevCwd) })

  /** Run cron `id` of `config` once, as the daemon would, and return what it delivered. */
  async function runOnce(config: any, id: string, answer: string) {
    process.chdir(dir)
    const parsed = daemonConfigSchema.parse(config)
    const registry = { execute: vi.fn(async () => ({ duration: 5, content: answer })) }
    const s: any = new CronScheduler(parsed as any, registry as any, undefined, () => {})
    s.scheduleNext = () => {}
    s.scheduleRetry = () => {}
    s.running = true
    const deliver = vi.fn(async () => {})
    s.setDeliverCallback(deliver)
    await s.executeJob(id)
    return deliver
  }

  it("team add, then connect telegram: Monday's drafts are delivered", async () => {
    const t = shippedTeam("sales-follow-up")!
    const config = freshConfig()
    const plan = applyTeam(config, t, { workspaceRoot: join(dir, "agents"), timezone: "UTC" })
    // No chat to report to yet: the schedule waits for one.
    expect(plan.delivery).toEqual({ schedules: ["sales-monday-follow-ups"], to: undefined })
    expect(config.crons["sales-monday-follow-ups"].deliverResult).toBe(true)
    expect(config.crons["sales-monday-follow-ups"].notify).toBeUndefined()
    expectValid(config)

    // What `connect telegram` writes once it has captured the owner's chat.
    config.notifications = { destination: OWNER }
    expect(fillPendingDelivery(config, OWNER)).toEqual(["sales-monday-follow-ups"])
    expect(config.crons["sales-monday-follow-ups"].notify).toEqual(OWNER)
    expect(config.crons["sales-monday-follow-ups"].onError).toContain("notify")
    expectValid(config)

    const deliver = await runOnce(config, "sales-monday-follow-ups", "2 leads are quiet.")
    expect(deliver).toHaveBeenCalledWith("sales-monday-follow-ups", "sales", "2 leads are quiet.", expect.any(String))
  })

  it("reports straight to the owner's chat when it is already set", () => {
    for (const t of shippedTeams()) {
      const config = freshConfig()
      config.notifications = { destination: OWNER }
      const plan = applyTeam(config, t, { workspaceRoot: join(dir, t.name) })
      expect(plan.delivery.to).toEqual(OWNER)
      expect(plan.delivery.schedules.sort()).toEqual(Object.keys(t.schedules).sort())
      for (const id of Object.keys(t.schedules)) expect(config.crons[id].notify).toEqual(OWNER)
      expectValid(config)
    }
  })

  it("leaves schedules alone that report elsewhere or not at all", () => {
    const config = freshConfig()
    config.agents = { a: { name: "A", team: "demo" }, solo: { name: "Solo" } }
    config.crons = {
      mine: { enabled: true, schedule: "0 9 * * *", agent: "a", prompt: "x", notify: { channel: "telegram", chatId: "9" }, deliverResult: true },
      quiet: { enabled: true, schedule: "0 9 * * *", agent: "a", prompt: "x" },
      failures: { enabled: true, schedule: "0 9 * * *", agent: "a", prompt: "x", deliverResult: false },
      waiting: { enabled: true, schedule: "0 9 * * *", agent: "a", prompt: "x", deliverResult: true },
      // Same shape, written by hand for an agent outside any team.
      handWritten: { enabled: true, schedule: "0 9 * * *", agent: "solo", prompt: "x", deliverResult: true },
    }
    expect(fillPendingDelivery(config, OWNER)).toEqual(["waiting"])
    expect(config.crons.handWritten.notify).toBeUndefined()
    // `team notify` names its schedules, so it is not limited to team agents.
    expect(fillPendingDelivery(config, OWNER, { ids: ["handWritten"] })).toEqual(["handWritten"])
    expect(config.crons.mine.notify.chatId).toBe("9")
    expect(config.crons.quiet.notify).toBeUndefined()
    expect(config.crons.failures.notify).toBeUndefined()
  })

  it("exports whether a schedule reports, never where", () => {
    const pkg: any = {
      format: TEAM_FORMAT, name: "demo", title: "Demo", result: "x",
      agents: { helper: { name: "Helper" } },
      schedules: { s: { agent: "helper", schedule: "0 9 * * *", prompt: "x", deliver: false } },
    }
    const config = freshConfig()
    applyTeam(config, parseTeamPackage(pkg), { workspaceRoot: dir })
    expect(config.crons.s.deliverResult).toBeUndefined()
    expect(buildTeamPackage(config, "demo").schedules.s.deliver).toBe(false)
  })
})

describe("install never takes over existing files", () => {
  it("refuses a workspace folder that already exists, unless --force", () => {
    const t = shippedTeam("dev-team")!
    mkdirSync(join(dir, "dev"))
    const config = freshConfig()
    expect(() => applyTeam(config, t, { workspaceRoot: dir })).toThrow(/folder .*dev \(already exists/)
    expect(config.agents).toEqual({})
    expect(config.crons).toEqual({})
    expect(() => applyTeam(config, t, { workspaceRoot: dir, force: true })).not.toThrow()
  })

  it("refuses another agent's workspace, even with --force", () => {
    const t = shippedTeam("dev-team")!
    const config = freshConfig()
    config.agents.mine = { name: "Mine", workspace: join(dir, "reviewer") }
    expect(teamConflicts(config, t, { workspaceRoot: dir, force: true })).toEqual([
      `folder ${join(dir, "reviewer")} (overlaps the workspace of agent "mine")`,
    ])
    expect(() => applyTeam(config, t, { workspaceRoot: dir, force: true })).toThrow(/workspace of agent "mine"/)

    // Nor a folder inside one, as with --workspaces pointing into it.
    const nested = freshConfig()
    nested.agents.mine = { name: "Mine", workspace: dir }
    expect(teamConflicts(nested, t, { workspaceRoot: join(dir, "agents"), force: true }).length).toBe(2)
  })

  it("keeps a hand-edited skill file instead of overwriting it", () => {
    const t = shippedTeam("dev-team")!
    const skill = join(dir, "dev/.claude/skills/issue-to-merge-request/SKILL.md")
    mkdirSync(join(skill, ".."), { recursive: true })
    writeFileSync(skill, "# my own version\n")
    const config = freshConfig()
    const plan = applyTeam(config, t, { workspaceRoot: dir, force: true })
    const { kept } = writeTeamSkills(t, plan)
    expect(kept).toEqual([skill])
    expect(readFileSync(skill, "utf-8")).toBe("# my own version\n")
    expect(existsSync(join(dir, "reviewer/.claude/skills/merge-request-review/SKILL.md"))).toBe(true)
  })

  it("never writes through a symlinked skill folder or file, with --force", () => {
    const t = shippedTeam("dev-team")!
    const outside = join(dir, "outside")
    mkdirSync(outside)
    const skills = join(dir, "dev/.claude/skills")
    mkdirSync(skills, { recursive: true })
    symlinkSync(outside, join(skills, "issue-to-merge-request"))
    const reviewerSkill = join(dir, "reviewer/.claude/skills/merge-request-review")
    mkdirSync(reviewerSkill, { recursive: true })
    symlinkSync(join(dir, "missing"), join(reviewerSkill, "SKILL.md")) // dangling
    const config = freshConfig()
    const plan = applyTeam(config, t, { workspaceRoot: dir, force: true })
    let kept: string[] = []
    expect(() => { kept = writeTeamSkills(t, plan).kept }).not.toThrow()
    expect(kept).toContain(join(skills, "issue-to-merge-request/SKILL.md"))
    expect(kept).toContain(join(reviewerSkill, "SKILL.md"))
    expect(readdirSync(outside)).toEqual([])
    expect(existsSync(join(dir, "missing"))).toBe(false)
  })

  it("refuses a second install under a team name already used", () => {
    const t = shippedTeam("client-inbox")!
    const config = freshConfig()
    config.agents.helper = { name: "Helper", workspace: join(dir, "helper"), team: "client-inbox" }
    expect(() => applyTeam(config, t, { workspaceRoot: dir })).toThrow(/team "client-inbox" \(agents helper\)/)
  })
})

describe("export then import", () => {
  /** An install where a team is working, with every kind of secret around it. */
  function workingInstall(): any {
    const t = shippedTeam("sales-follow-up")!
    const config = freshConfig()
    const plan = applyTeam(config, t, { workspaceRoot: join(dir, "a"), timezone: "Europe/Paris" })
    writeTeamSkills(t, plan)
    // A skill the owner added by hand, with a nested file.
    mkdirSync(join(dir, "a/sales/.claude/skills/pricing/notes"), { recursive: true })
    writeFileSync(join(dir, "a/sales/.claude/skills/pricing/SKILL.md"), "# Pricing\nUse notes/table.md.\n")
    writeFileSync(join(dir, "a/sales/.claude/skills/pricing/notes/table.md"), "| plan | price |\n")
    // The built-in wiki skill is not carried.
    mkdirSync(join(dir, "a/sales/.claude/skills/wiki"), { recursive: true })
    writeFileSync(join(dir, "a/sales/.claude/skills/wiki/SKILL.md"), "# wiki\n")

    config.agents.other = { name: "Not in the team", workspace: join(dir, "a/other") }
    config.channels = {
      telegram: { enabled: true, accounts: { sales: { token: TG_TOKEN, agentBinding: "sales", allowFrom: ["@someone"] } } },
      whatsapp: { enabled: true, defaultAgent: "other", routes: [{ contact: "+10000000001", agent: "sales" }] },
      gitlab: { enabled: true, token: GL_TOKEN, webhookSecret: "hook-secret-value", routes: [{ project: "group/app", agent: "other" }] },
    }
    config.crons["sales-monday-follow-ups"].notify = { channel: "telegram", chatId: "-100200300400" }
    config.crons["sales-monday-follow-ups"].fireToken = "${SALES_FIRE_TOKEN}"
    config.crons["sales-backup"] = { enabled: true, schedule: "0 3 * * *", agent: "sales", command: "pg_dump postgres://u:p@db/x", prompt: "" }
    config.crons["other-job"] = { enabled: true, schedule: "0 4 * * *", agent: "other", prompt: "not mine" }
    expectValid(config)
    return config
  }

  it("gives the same agents and schedules on another install, with no secrets in the file", () => {
    const source = workingInstall()
    const pkg = buildTeamPackage(source, "sales-follow-up", { title: "Sales", result: "Follow-ups every Monday." })
    const file = JSON.stringify(pkg, null, 2)

    // No secrets, no private routes, nothing that runs a shell.
    for (const leak of [TG_TOKEN, GL_TOKEN, "hook-secret-value", "+10000000001", "-100200300400", "SALES_FIRE_TOKEN", "pg_dump", "@someone", "group/app", "not mine"]) {
      expect(file).not.toContain(leak)
    }
    expect(Object.keys(pkg.agents)).toEqual(["sales"])
    expect(Object.keys(pkg.schedules)).toEqual(["sales-monday-follow-ups"])
    expect(Object.keys(pkg.agents.sales.skills).sort()).toEqual(["lead-follow-up", "pricing"])
    expect(pkg.agents.sales.skills.pricing["notes/table.md"]).toBe("| plan | price |\n")
    expect(pkg.channels).toEqual([{ kind: "telegram", agent: "sales" }, { kind: "whatsapp", agent: "sales" }])

    // Import on a second, fresh install.
    const imported = parseTeamPackage(JSON.parse(file))
    const target = freshConfig()
    const plan = applyTeam(target, imported, { workspaceRoot: join(dir, "b") })
    writeTeamSkills(imported, plan)
    expectValid(target)

    const pick = (a: any) => ({ name: a.name, tier: a.tier, model: a.model, systemPrompt: a.systemPrompt, mentions: a.mentions, team: a.team })
    expect(pick(target.agents.sales)).toEqual(pick(source.agents.sales))
    const job = (c: any) => ({ enabled: c.enabled, schedule: c.schedule, timezone: c.timezone, agent: c.agent, prompt: c.prompt, timeout: c.timeout, autonomy: c.autonomy, maxOutputTokens: c.maxOutputTokens })
    expect(job(target.crons["sales-monday-follow-ups"])).toEqual(job(source.crons["sales-monday-follow-ups"]))
    expect(target.crons["sales-monday-follow-ups"].timezone).toBe("Europe/Paris")
    expect(Object.keys(target.crons)).toEqual(["sales-monday-follow-ups"])
    expect(readFileSync(join(dir, "b/sales/.claude/skills/pricing/notes/table.md"), "utf-8")).toBe("| plan | price |\n")
    expect(existsSync(join(dir, "b/sales/.claude/skills/wiki"))).toBe(false)

    // Once its channels are connected there, exporting the imported team
    // gives the same package back.
    target.channels = {
      telegram: { enabled: true, accounts: { bot: { token: "${TG}", agentBinding: "sales" } } },
      whatsapp: { enabled: true, defaultAgent: "sales" },
    }
    expect(buildTeamPackage(target, "sales-follow-up", { title: "Sales", result: "Follow-ups every Monday." })).toEqual(pkg)
  })

  it("keeps the channels a team expects before they are connected", () => {
    const t = shippedTeam("client-inbox")!
    const config = freshConfig()
    applyTeam(config, t, { workspaceRoot: dir })
    expect(buildTeamPackage(config, "client-inbox").channels).toEqual([])
    expect(buildTeamPackage(config, "client-inbox", { expectedChannels: t.channels }).channels).toEqual(t.channels)
  })

  it("refuses to export a token pasted into a prompt", () => {
    const source = workingInstall()
    source.agents.sales.systemPrompt += `\nUse ${GL_TOKEN} for GitLab.`
    expect(() => buildTeamPackage(source, "sales-follow-up")).toThrow(/agents\.sales\.systemPrompt: looks like a GitLab token/)
  })

  it("skips symlinks: no loop, nothing from outside the workspace", () => {
    const source = workingInstall()
    const outside = join(dir, "outside")
    mkdirSync(outside)
    writeFileSync(join(outside, "secret.txt"), "outside-content")
    const pricing = join(dir, "a/sales/.claude/skills/pricing")
    symlinkSync(pricing, join(pricing, "notes/loop"))
    symlinkSync(join(outside, "secret.txt"), join(pricing, "secret.txt"))
    symlinkSync(outside, join(dir, "a/sales/.claude/skills/linked"))
    writeFileSync(join(outside, "SKILL.md"), "# linked\n")

    const pkg = buildTeamPackage(source, "sales-follow-up")
    expect(JSON.stringify(pkg)).not.toContain("outside-content")
    expect(Object.keys(pkg.agents.sales.skills).sort()).toEqual(["lead-follow-up", "pricing"])
    expect(Object.keys(pkg.agents.sales.skills.pricing).sort()).toEqual(["SKILL.md", "notes/table.md"])
  })

  it("exports a hand-picked set of agents with --agents", () => {
    const source = workingInstall()
    const pkg = buildTeamPackage(source, "mine", { agents: ["sales", "other"] })
    expect(Object.keys(pkg.agents).sort()).toEqual(["other", "sales"])
    expect(Object.keys(pkg.schedules).sort()).toEqual(["other-job", "sales-monday-follow-ups"])
    expect(() => buildTeamPackage(source, "nobody")).toThrow(/No agents belong to team "nobody"/)
  })
})

describe("package checks on import", () => {
  const base = () => ({
    format: TEAM_FORMAT,
    name: "demo",
    title: "Demo",
    result: "Something useful.",
    agents: { helper: { name: "Helper", systemPrompt: "Help." } },
    schedules: { "helper-daily": { agent: "helper", schedule: "0 9 * * *", prompt: "Say hi." } },
  })

  it("accepts a minimal package", () => {
    expect(parseTeamPackage(base()).agents.helper.mentions).toEqual([])
  })

  it("refuses keys a package never carries, such as a token", () => {
    const pkg: any = base()
    pkg.agents.helper.token = "${TOKEN}"
    expect(() => parseTeamPackage(pkg)).toThrow(/agents\.helper/)
    const job: any = base()
    job.schedules["helper-daily"].command = "rm -rf /"
    expect(() => parseTeamPackage(job)).toThrow(/schedules\.helper-daily/)
  })

  it("refuses a secret in any string", () => {
    const pkg: any = base()
    pkg.schedules["helper-daily"].prompt = `Post with ${TG_TOKEN}`
    expect(() => parseTeamPackage(pkg)).toThrow(/looks like a Telegram bot token/)
  })

  it("refuses skill files that leave the skill folder", () => {
    for (const path of ["../evil.md", "/etc/x", "a/../../b", "a\\b"]) {
      const pkg: any = base()
      pkg.agents.helper.skills = { s: { "SKILL.md": "# s", [path]: "x" } }
      expect(() => parseTeamPackage(pkg), path).toThrow(/inside the skill folder/)
    }
  })

  it("refuses schedules for agents outside the team and bad cron expressions", () => {
    const pkg: any = base()
    pkg.schedules["helper-daily"].agent = "ghost"
    expect(() => parseTeamPackage(pkg)).toThrow(/"ghost" is not an agent of this team/)
    const bad: any = base()
    bad.schedules["helper-daily"].schedule = "every day"
    expect(() => parseTeamPackage(bad)).toThrow(/cron/)
  })

  it("keeps a model only on the runtime it belongs to", () => {
    const pkg: any = base()
    pkg.agents.helper.tier = "claude-code"
    pkg.agents.helper.model = "claude-sonnet-4-6"
    const same = freshConfig()
    applyTeam(same, parseTeamPackage(pkg), { workspaceRoot: dir })
    expect(same.agents.helper.model).toBe("claude-sonnet-4-6")
    const moved = freshConfig()
    applyTeam(moved, parseTeamPackage(pkg), { workspaceRoot: dir, tier: "codex-cli" })
    expect(moved.agents.helper.tier).toBe("codex-cli")
    expect(moved.agents.helper.model).toBeUndefined()
  })
})
