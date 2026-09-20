import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CronScheduler } from "../src/crons/scheduler"

// Crons that run a command instead of asking a model.
//
// Seven of this fleet's twenty-six crons were one shell command wrapped in
// an agent, and every one of them carried a paragraph like "Run this EXACT
// command. Do NOT substitute, rewrite, shorten, or fall back to
// alternative commands." That paragraph is a scar — it exists because
// models kept substituting — and no amount of prompt severity makes a
// language model a deterministic executor.
//
// Measured before this existed: ~$0.31 and ~24s per run to execute one
// `node script.js` and repeat ten lines of its output, on a 114k-token
// context for a job containing no judgement at all.
//
// What must hold: the command runs, the agent is never called, a failing
// command is reported rather than thrown, and failure handling is
// indistinguishable from the agent path so an operator learns one set of
// cron semantics rather than two.

let dir: string
const prevCwd = process.cwd()

function scheduler(crons: Record<string, any>, registry: any) {
  return new CronScheduler(
    { crons, agents: {}, notifications: {} } as any,
    registry as any,
  )
}

const registryThatMustNotRun = () => ({
  execute: vi.fn(async () => ({ content: "should never happen", duration: 1 })),
})

/** Run one job to completion without arming any timers. */
async function runOnce(s: any, jobId: string) {
  // scheduleNext would arm a real timer for the next occurrence; the job
  // body is what is under test.
  s.scheduleNext = () => {}
  s.running = true
  await s.executeJob(jobId)
}

describe("command crons", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-cron-"))
    process.chdir(dir)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  })

  it("runs the command and never calls the agent", async () => {
    const registry = registryThatMustNotRun()
    const s = scheduler({
      probe: {
        enabled: true, schedule: "0 3 * * *", timezone: "UTC", agent: "coo-agent",
        prompt: "", command: "echo hello-from-cron", timeout: 30, onError: ["log"],
      },
    }, registry)

    await runOnce(s, "probe")

    expect(registry.execute).not.toHaveBeenCalled()
    const runs = readdirSync(join(dir, ".agentx/cron/runs/probe"))
    expect(runs).toHaveLength(1)
    const rec = JSON.parse(readFileSync(join(dir, ".agentx/cron/runs/probe", runs[0]), "utf-8"))
    expect(rec.success).toBe(true)
    expect(rec.response).toContain("hello-from-cron")
  })

  it("treats a non-zero exit as a failure, not an exception", async () => {
    // A failing command is an ANSWER. Throwing would lose the output,
    // which is the only thing a person reads after something breaks.
    const registry = registryThatMustNotRun()
    const s = scheduler({
      probe: {
        enabled: true, schedule: "0 3 * * *", timezone: "UTC", agent: "coo-agent",
        prompt: "", command: "echo boom >&2; exit 3", timeout: 30, onError: ["log"],
      },
    }, registry)
    s.scheduleRetry = () => {}

    await runOnce(s, "probe")

    const runs = readdirSync(join(dir, ".agentx/cron/runs/probe"))
    const rec = JSON.parse(readFileSync(join(dir, ".agentx/cron/runs/probe", runs[0]), "utf-8"))
    expect(rec.success).toBe(false)
    expect(rec.error).toContain("exit 3")
    expect(rec.error).toContain("boom")
    expect(registry.execute).not.toHaveBeenCalled()
  })

  it("keeps only the tail of a long output", async () => {
    const registry = registryThatMustNotRun()
    const s = scheduler({
      probe: {
        enabled: true, schedule: "0 3 * * *", timezone: "UTC", agent: "coo-agent",
        prompt: "", command: "for i in $(seq 1 200); do echo line-$i; done",
        timeout: 30, onError: ["log"],
      },
    }, registry)

    await runOnce(s, "probe")

    const runs = readdirSync(join(dir, ".agentx/cron/runs/probe"))
    const rec = JSON.parse(readFileSync(join(dir, ".agentx/cron/runs/probe", runs[0]), "utf-8"))
    expect(rec.response).toContain("line-200")
    expect(rec.response).not.toContain("line-1\n")
    expect(rec.response.split("\n").length).toBeLessThanOrEqual(20)
  })

  it("still dispatches the agent when no command is set", async () => {
    // The command branch must not swallow ordinary prompt crons.
    const registry = {
      execute: vi.fn(async () => ({ content: "did the thing", duration: 5 })),
    }
    const s = scheduler({
      thinker: {
        enabled: true, schedule: "0 3 * * *", timezone: "UTC", agent: "coo-agent",
        prompt: "Summarise yesterday", timeout: 30, onError: ["log"],
      },
    }, registry)

    await runOnce(s, "thinker")

    expect(registry.execute).toHaveBeenCalledTimes(1)
    expect(registry.execute.mock.calls[0][0].message).toContain("Summarise yesterday")
  })

  it("treats a blank command as absent", async () => {
    const registry = {
      execute: vi.fn(async () => ({ content: "ok", duration: 1 })),
    }
    const s = scheduler({
      thinker: {
        enabled: true, schedule: "0 3 * * *", timezone: "UTC", agent: "coo-agent",
        prompt: "Do the thing", command: "   ", timeout: 30, onError: ["log"],
      },
    }, registry)

    await runOnce(s, "thinker")
    expect(registry.execute).toHaveBeenCalledTimes(1)
  })
})
