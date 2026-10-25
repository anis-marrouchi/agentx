import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { daemonConfigSchema } from "../src/daemon/config"
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

  it.each(shippedTeams().map((t) => [t.name] as const))("%s README says what the first result is and when it comes", (name) => {
    const readme = readFileSync(resolve(__dirname, "../src/teams/catalog", name, "README.md"), "utf-8")
    expect(readme).toMatch(/^\*\*First result:\*\* .*\d{2}:\d{2}/m)
  })
})
