import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CronScheduler } from "../src/crons/scheduler"
import { readCronRunHistory } from "../src/crons/run-history"
import { renderMeshPage } from "../src/daemon/ui/pages/mesh"
import { MESH_OPS_SCRIPT } from "../src/daemon/ui/pages/mesh-ops.client"

// A cron run used to persist its outcome but not the task that produced it,
// so the mesh overview could not open, watch or steer it. The scheduler now
// records the ids the registry assigns, and the overview links to /tasks/:id.

let dir: string
const prevCwd = process.cwd()

const JOB = {
  enabled: true, schedule: "0 3 * * *", timezone: "UTC", agent: "coo-agent",
  prompt: "daily brief", timeout: 30, onError: ["log"],
}

function scheduler(crons: Record<string, any>, registry: any) {
  return new CronScheduler(
    { crons, agents: {}, notifications: {} } as any,
    registry as any,
  )
}

async function runOnce(s: any, jobId: string) {
  s.scheduleNext = () => {}
  s.running = true
  await s.executeJob(jobId)
}

function runFile(jobId: string): any {
  const runsDir = join(dir, ".agentx/cron/runs", jobId)
  const files = readdirSync(runsDir)
  expect(files).toHaveLength(1)
  return JSON.parse(readFileSync(join(runsDir, files[0]), "utf-8"))
}

describe("cron run task ids", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-cron-link-"))
    process.chdir(dir)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  })

  it("persists the task, trace and session ids the registry assigned", async () => {
    // The registry writes both ids onto the task object it is handed.
    const registry = {
      execute: vi.fn(async (task: any) => {
        task.runningTaskId = "1790000000000-abc123"
        task.taskId = "01TRACEULID"
        return { content: "done", duration: 5, claudeSessionId: "sess-1" }
      }),
    }
    await runOnce(scheduler({ brief: JOB }, registry), "brief")

    expect(registry.execute.mock.calls[0][0].context).toEqual({ channel: "cron", chatId: "cron:brief" })
    const rec = runFile("brief")
    expect(rec).toMatchObject({ taskId: "1790000000000-abc123", traceId: "01TRACEULID", sessionId: "sess-1" })

    const runs = await readCronRunHistory({
      date: new Date().toISOString().slice(0, 10),
      timezone: "UTC",
      runsDir: join(dir, ".agentx/cron/runs"),
    })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ taskId: "1790000000000-abc123", traceId: "01TRACEULID", sessionId: "sess-1" })
  })

  it("records no task id when the run happened elsewhere (mesh peer)", async () => {
    const registry = { execute: vi.fn(async () => ({ content: "done", duration: 5, viaMesh: "peer" })) }
    await runOnce(scheduler({ brief: JOB }, registry), "brief")
    const rec = runFile("brief")
    expect(rec).not.toHaveProperty("taskId")
    expect(rec).not.toHaveProperty("sessionId")
  })

  it("records no task id for a command job", async () => {
    const registry = { execute: vi.fn() }
    await runOnce(scheduler({ probe: { ...JOB, command: "echo hi" } }, registry), "probe")
    expect(registry.execute).not.toHaveBeenCalled()
    expect(runFile("probe")).not.toHaveProperty("taskId")
  })
})

describe("mesh overview run link", () => {
  // runLink lives inside the page's IIFE; lift its source out and run it.
  const src = MESH_OPS_SCRIPT.match(/function runLink\([\s\S]*?\n  \}/)?.[0]
  const runLink = new Function(`${src}; return runLink`)()
  const node = { url: "http://10.0.0.2:18800" }
  const job = { id: "brief", agent: "coo-agent" }

  it("parses every inline script on the rendered page", () => {
    const html = renderMeshPage({})
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(scripts.length).toBeGreaterThan(0)
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
  })

  it("links a running cron task live on its own node", () => {
    const agent = { name: "COO", runningTasks: [
      { id: "other", channel: "telegram", chatId: "cron:brief" },
      { id: "live-1", channel: "cron", chatId: "cron:brief" },
    ] }
    const link = runLink(node, job, { taskId: "old" }, agent)
    expect(link.label).toContain("live")
    expect(link.href).toBe("/tasks/live-1?node=http%3A%2F%2F10.0.0.2%3A18800&agent=coo-agent&name=COO&channel=cron")
  })

  it("links the latest persisted run as archived", () => {
    const link = runLink(node, job, { taskId: "t 1" }, { name: "COO", runningTasks: [] })
    expect(link.href).toBe("/tasks/t%201?node=http%3A%2F%2F10.0.0.2%3A18800&agent=coo-agent&name=COO&channel=cron&archived=1")
  })

  it("gives no link without a task id (command jobs, no run yet)", () => {
    expect(runLink(node, job, { status: "success" }, undefined)).toBeNull()
    expect(runLink(node, job, undefined, { runningTasks: [] })).toBeNull()
  })
})
