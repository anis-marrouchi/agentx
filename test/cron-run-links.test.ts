import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CronScheduler, runLinkIds } from "../src/crons/scheduler"
import { readCronRunHistory } from "../src/crons/run-history"
import { AgentRegistry } from "../src/agents/registry"
import { MESH_OPS_SCRIPT } from "../src/daemon/ui/pages/mesh-ops.client"
import { renderTaskPage } from "../src/daemon/ui/pages/task"

// A scheduled run used to be a black box: the run file held the outcome and
// a summary, but not the task that produced it, so nothing could open it,
// watch it, or continue it. What must hold now:
//   - an agent-dispatched run persists the dashboard task id (plus trace and
//     provider session when known), and history reads them back;
//   - a command run persists none, because no agent ever ran;
//   - the overview links runs to the node's Task page;
//   - Send on a finished cron run resumes its cron:<jobId> chat, and only
//     cron runs — other channels have a person who would never see the reply.

let dir: string
const prevCwd = process.cwd()

function scheduler(crons: Record<string, any>, registry: any) {
  return new CronScheduler({ crons, agents: {}, notifications: {} } as any, registry as any)
}

/** A registry that behaves like registry.execute: stamps both ids on the task. */
function linkingRegistry(response: Record<string, unknown>) {
  return {
    execute: vi.fn(async (task: any) => {
      task.taskId = "trace-01"
      task.runningTaskId = "1700000000000-abc123"
      return { duration: 5, ...response }
    }),
  }
}

function onlyRun(jobId: string) {
  const runs = readdirSync(join(dir, ".agentx/cron/runs", jobId))
  expect(runs).toHaveLength(1)
  return JSON.parse(readFileSync(join(dir, ".agentx/cron/runs", jobId, runs[0]), "utf-8"))
}

const job = (extra: Record<string, unknown> = {}) => ({
  enabled: true, schedule: "0 3 * * *", timezone: "UTC", agent: "ops-agent",
  prompt: "Summarise yesterday", timeout: 30, onError: ["log"], ...extra,
})

describe("cron runs record the task that ran them", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-cron-links-"))
    process.chdir(dir)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  })

  it("persists taskId, traceId and sessionId for an agent run", async () => {
    const registry = linkingRegistry({ content: "done", claudeSessionId: "sess-9" })
    const s: any = scheduler({ brief: job() }, registry)
    s.scheduleNext = () => {}
    s.running = true
    await s.executeJob("brief")

    const rec = onlyRun("brief")
    expect(rec.taskId).toBe("1700000000000-abc123")
    expect(rec.traceId).toBe("trace-01")
    expect(rec.sessionId).toBe("sess-9")
    // The dispatch still targets the per-job cron chat the ids belong to.
    expect(registry.execute.mock.calls[0][0].context).toEqual({ channel: "cron", chatId: "cron:brief" })
  })

  it("persists the ids on a failed run too — failures are what people open", async () => {
    const registry = linkingRegistry({ content: "", error: "boom" })
    const s: any = scheduler({ brief: job() }, registry)
    s.scheduleNext = () => {}
    s.scheduleRetry = () => {}
    s.running = true
    await s.executeJob("brief")

    const rec = onlyRun("brief")
    expect(rec.success).toBe(false)
    expect(rec.taskId).toBe("1700000000000-abc123")
  })

  it("omits the ids when the run never started (queued, or no slot)", async () => {
    const registry = { execute: vi.fn(async () => ({ content: "", error: "__queued__:collect:1" })) }
    const s: any = scheduler({ brief: job() }, registry)
    s.scheduleNext = () => {}
    s.scheduleRetry = () => {}
    s.running = true
    await s.executeJob("brief")

    const rec = onlyRun("brief")
    expect(rec).not.toHaveProperty("taskId")
    expect(rec).not.toHaveProperty("traceId")
    expect(rec).not.toHaveProperty("sessionId")
  })

  it("records no task for a command job", async () => {
    const registry = linkingRegistry({ content: "never" })
    const s: any = scheduler({ probe: job({ prompt: "", command: "echo hi" }) }, registry)
    s.scheduleNext = () => {}
    s.running = true
    await s.executeJob("probe")

    expect(registry.execute).not.toHaveBeenCalled()
    expect(onlyRun("probe")).not.toHaveProperty("taskId")
  })

  it("persists the ids for a missed-run catch-up", async () => {
    const registry = linkingRegistry({ content: "caught up", codexSessionId: "thread-2" })
    const s: any = scheduler({ brief: job() }, registry)
    await s.executeMissedRuns([{ jobId: "brief", missedAt: new Date("2026-01-01T03:00:00Z") }])

    const rec = onlyRun("brief")
    expect(rec.taskId).toBe("1700000000000-abc123")
    expect(rec.sessionId).toBe("thread-2")
  })

  it("reads the persisted ids back through run history", async () => {
    const registry = linkingRegistry({ content: "done", opencodeSessionId: "oc-1" })
    const s: any = scheduler({ brief: job() }, registry)
    s.scheduleNext = () => {}
    s.running = true
    await s.executeJob("brief")

    const date = new Date().toISOString().slice(0, 10)
    const runs = await readCronRunHistory({ date, timezone: "UTC", runsDir: join(dir, ".agentx/cron/runs") })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      jobId: "brief", status: "success",
      taskId: "1700000000000-abc123", traceId: "trace-01", sessionId: "oc-1",
    })
  })
})

describe("runLinkIds", () => {
  it("prefers the claude session, then codex, then opencode", () => {
    expect(runLinkIds({}, { codexSessionId: "c", opencodeSessionId: "o" })).toEqual({ sessionId: "c" })
    expect(runLinkIds({}, { claudeSessionId: "a", codexSessionId: "c" })).toEqual({ sessionId: "a" })
    expect(runLinkIds({}, {})).toEqual({})
  })
})

describe("continueFinishedTask", () => {
  function fakeRegistry(record: any, execute: (task: any) => Promise<any>) {
    return {
      getTaskRecord: vi.fn(() => record),
      execute: vi.fn(execute),
      log: () => {},
    }
  }
  const call = (fake: any, model?: (chatId: string) => string | undefined) =>
    AgentRegistry.prototype.continueFinishedTask.call(fake, "ops-agent", "old-1", "and tomorrow?", "operator", { model })

  it("resumes a finished cron run in its cron chat and returns the new task id", async () => {
    let finish!: () => void
    const fake = fakeRegistry({ channel: "cron", chatId: "cron:brief" }, (task) => {
      task.onStart?.("new-2")
      return new Promise((r) => { finish = () => r({ content: "ok" }) })
    })
    // Resolves on start, not on completion: the Task page follows the run live.
    const result = await call(fake, (chatId) => (chatId === "cron:brief" ? "model-x" : undefined))
    expect(result).toEqual({ ok: true, agentId: "ops-agent", channel: "cron", chatId: "cron:brief", taskId: "new-2", queued: false })
    const task = fake.execute.mock.calls[0][0]
    expect(task.context).toEqual({ channel: "cron", chatId: "cron:brief", sender: "operator" })
    expect(task.model).toBe("model-x")
    finish()
  })

  it("reports a queued turn when the agent is busy", async () => {
    const fake = fakeRegistry({ channel: "cron", chatId: "cron:brief" }, async () => ({ content: "", error: "__queued__:collect:1" }))
    expect(await call(fake)).toEqual({ ok: true, agentId: "ops-agent", channel: "cron", chatId: "cron:brief", queued: true })
  })

  it("reports an attached-session answer as delivered, not failed", async () => {
    const fake = fakeRegistry({ channel: "cron", chatId: "cron:brief" }, async () => ({ content: "done", viaAttachedSession: "sess-1" }))
    expect(await call(fake)).toEqual({ ok: true, agentId: "ops-agent", channel: "cron", chatId: "cron:brief", queued: false, answeredBy: "attached" })
  })

  it("still reports a refused run as a failure", async () => {
    const fake = fakeRegistry({ channel: "cron", chatId: "cron:brief" }, async () => ({ content: "", error: "rate limited" }))
    expect(await call(fake)).toEqual({ ok: false, status: 500, error: "rate limited" })
  })

  it("refuses finished runs from a channel with a person on the other end", async () => {
    const fake = fakeRegistry({ channel: "telegram", chatId: "42" }, async () => ({ content: "" }))
    expect(await call(fake)).toMatchObject({ ok: false, status: 409 })
    expect(fake.execute).not.toHaveBeenCalled()
  })

  it("404s an unknown task", async () => {
    const fake = fakeRegistry(null, async () => ({ content: "" }))
    expect(await call(fake)).toMatchObject({ ok: false, status: 404 })
  })
})

/** The inline script's body, so it can be compiled without a browser. The
 *  template-literal escape trap (`\n` collapsing inside inner strings) shows
 *  up here as a SyntaxError. */
function scriptBody(html: string, marker: string): string {
  const start = html.indexOf(marker)
  const open = html.lastIndexOf("<script>", start) + "<script>".length
  const close = html.indexOf("</script>", start)
  return html.slice(open, close)
}

describe("dashboard wiring", () => {
  it("links cron runs to the node's Task page, live and archived", () => {
    const js = scriptBody(MESH_OPS_SCRIPT, "RUN_LINK_LIMIT")
    expect(() => new Function(js)).not.toThrow()
    expect(js).toContain("'/tasks/'+encodeURIComponent(taskId)+'?node='+encodeURIComponent(x.node.url)")
    expect(js).toContain("&archived=1")
    expect(js).toContain("t.chatId==='cron:'+job.id")
    expect(js).toContain("x.job.kind==='command'")
  })

  it("lets an archived cron run send a follow-up that names its agent", () => {
    const html = renderTaskPage({ taskId: "t1", agentId: "ops-agent", nodeUrl: "http://node.test", archived: true })
    const js = scriptBody(html, "var composeEl")
    expect(() => new Function(js)).not.toThrow()
    expect(js).toContain("{ message: message, agent: agentId }")
    expect(js).toContain("rec.channel === 'cron'")
    expect(js).toContain("r.answeredBy === 'attached'")
    // Listeners are attached before the archived branch returns.
    expect(js.indexOf("sendBtn.addEventListener")).toBeLessThan(js.indexOf("if (root.getAttribute('data-archived'))"))
  })
})
