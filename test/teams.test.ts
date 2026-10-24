import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { crossFieldProblems, daemonConfigSchema } from "../src/daemon/config"
import { shippedTeam, shippedTeams } from "../src/teams/catalog"
import {
  TEAM_FORMAT,
  applyTeam,
  buildTeamPackage,
  parseTeamPackage,
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
