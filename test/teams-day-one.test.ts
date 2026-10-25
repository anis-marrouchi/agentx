import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { daemonConfigSchema } from "../src/daemon/config"
import { checkAutonomyPayload } from "../src/guard/autonomy-enforce"
import { deliverCronResult } from "../src/daemon/delegation-wiring"
import { CronScheduler } from "../src/crons/scheduler"
import { shippedTeams } from "../src/teams/catalog"
import { applyTeam, fillPendingDelivery, writeTeamSkills } from "../src/teams/package"

// Day one for every shipped team (#1293): `team add`, the owner's chat
// connected, each schedule fired once on a stub model. Every schedule that
// reports reaches the owner's chat through the daemon's own delivery path,
// on a fake Telegram channel; the ones that report nowhere send nothing.

const OWNER = { channel: "telegram", chatId: "2000" }

let dir: string
const prevCwd = process.cwd()
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-day-one-")) })
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

/** A router with only a Telegram channel, recording what it sends. */
function fakeTelegram() {
  const sent: { channel: string; chatId: string; text: string; agentId?: string }[] = []
  const router = {
    getChannel: (n: string) => (n === "telegram" ? { name: n } : undefined),
    sendOutbound: async (msg: any) => { sent.push(msg) },
  }
  return { router, sent }
}

describe("day one: each shipped team's first results reach the owner", () => {
  it.each(shippedTeams().map((t) => [t.name, t] as const))("%s", async (_name, team) => {
    const config: any = { node: { id: "demo-node", name: "Demo node" }, agents: {}, crons: {} }
    const plan = applyTeam(config, team, { workspaceRoot: join(dir, "agents"), timezone: "UTC" })
    writeTeamSkills(team, plan)
    // What `connect telegram` writes once it has the owner's chat.
    config.notifications = { destination: OWNER }
    expect(fillPendingDelivery(config, OWNER).sort()).toEqual([...plan.delivery.schedules].sort())
    expect(plan.delivery.schedules.length).toBeGreaterThan(0)

    process.chdir(dir)
    const parsed = daemonConfigSchema.parse(config)
    // The stub model.
    const registry = { execute: vi.fn(async () => ({ duration: 5, content: "Here is the first result." })) }
    const { router, sent } = fakeTelegram()
    const wiring = { config: parsed, registry: registry as any, router: router as any, replies: undefined as any }
    const s: any = new CronScheduler(parsed as any, registry as any, undefined, () => {})
    s.scheduleNext = () => {}
    s.scheduleRetry = () => {}
    s.running = true
    s.setDeliverCallback((jobId: string, agent: string, text: string, runId: string) =>
      deliverCronResult(wiring as any, parsed.crons[jobId]?.notify as any, { jobId, agent, text, runId }))

    for (const id of Object.keys(team.schedules)) {
      const before = sent.length
      await s.executeJob(id)
      const agent = team.schedules[id].agent
      expect(registry.execute).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: agent }))
      if (plan.delivery.schedules.includes(id)) {
        expect(sent.slice(before)).toEqual([expect.objectContaining({ channel: "telegram", chatId: OWNER.chatId, agentId: agent, text: expect.stringContaining("Here is the first result.") })])
      } else {
        expect(sent.length).toBe(before)
      }
    }
  })

  // The stub model above never calls a tool, so it cannot see a report
  // schedule's call refused (#1352). A schedule cannot answer a permission
  // prompt and the shipped agents run in permissionMode "default" with no
  // allow list: the autonomy hook must answer "allow" itself, not defer.
  const REPORT_CALLS: Record<string, { tool_name: string; tool_input: Record<string, unknown> }[]> = {
    "sales-competitor-watch": [{ tool_name: "Bash", tool_input: { command: "agentx sales watch" } }],
    "sales-weekly-research": [
      { tool_name: "WebSearch", tool_input: { query: "demo query" } },
      { tool_name: "WebFetch", tool_input: { url: "https://example.com/", prompt: "x" } },
      { tool_name: "Bash", tool_input: { command: "agentx sales leads" } },
      { tool_name: "Read", tool_input: { file_path: "targets.md" } },
    ],
    "sales-daily-brief": [
      { tool_name: "Bash", tool_input: { command: "agentx sales leads --quiet-only" } },
      { tool_name: "Bash", tool_input: { command: "agentx sales changes" } },
    ],
    "sales-monday-follow-ups": [{ tool_name: "Bash", tool_input: { command: "agentx sales leads --quiet-only" } }],
    "content-weekly-drafts": [
      { tool_name: "mcp__agentx__agentx_content", tool_input: { action: "voice", topic: "demo" } },
      { tool_name: "mcp__agentx__agentx_content", tool_input: { action: "draft", platform: "linkedin", topic: "demo", samples: ["a.md"], text: "x" } },
    ],
  }
  it.each(Object.entries(REPORT_CALLS))("report schedule %s: the tool calls it needs are allowed outright", (id, calls) => {
    const team = shippedTeams().find((t) => t.schedules[id])
    expect(team?.schedules[id].autonomy).toBe("report")
    for (const call of calls) {
      const r = checkAutonomyPayload(call, { root: dir, agentId: team!.schedules[id].agent, level: "report", taskId: `T-${id}` })
      expect(r.blocked, `${id}: ${call.tool_name} ${JSON.stringify(call.tool_input)}`).toBeNull()
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("allow")
    }
  })

  it.each(shippedTeams().map((t) => [t.name] as const))("%s README says what the first result is and when it comes", (name) => {
    const readme = readFileSync(resolve(__dirname, "../src/teams/catalog", name, "README.md"), "utf-8")
    expect(readme).toMatch(/^\*\*First result:\*\* .*\d{2}:\d{2}/m)
  })
})
