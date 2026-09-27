import { describe, it, expect, vi } from "vitest"
import { Readable } from "stream"
import { handleAppFleet, summarizeNode, summarizeActivity, dateIn, PREVIEW_CHARS, type AppFleetDeps, type SnapshotNode } from "../src/daemon/app-fleet"

const long = "word ".repeat(200)

const node: SnapshotNode = {
  id: "http://node-a:18800", name: "node-a", url: "http://node-a:18800", reachable: true, uptimeSec: 60,
  restart: { state: "none" },
  agents: [{
    id: "helper", name: "Helper", tier: "claude-code", active: 1, errors: 0,
    lastSummary: { text: long, at: "2026-01-02T10:00:00Z", ok: true },
    runningTasks: [
      { id: "t-old", messagePreview: "older", channel: "telegram", startedAt: "2026-01-02T09:00:00Z" },
      { id: "t-new", messagePreview: long, channel: "app", startedAt: "2026-01-02T10:00:00Z" },
    ],
  }],
  crons: [
    { id: "digest", enabled: true, schedule: "0 9 * * *", agent: "helper", consecutiveErrors: 0 },
    { id: "stale", enabled: false, schedule: "0 3 * * *", agent: "helper", consecutiveErrors: 2 },
  ],
  cronRuns: [
    { jobId: "digest", startedAt: "2026-01-02T08:00:00Z", status: "failed", errorSummary: "boom" },
    { jobId: "digest", startedAt: "2026-01-02T09:00:00Z", status: "success", responseSummary: long },
  ],
}

function deps(over: Partial<AppFleetDeps> = {}): AppFleetDeps {
  return {
    snapshot: vi.fn(async () => ({ ts: "2026-01-02T10:00:00Z", nodes: [node] })),
    nodePost: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    approvals: vi.fn(async () => []),
    decide: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    ...over,
  }
}

async function call(d: AppFleetDeps, method: string, path: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any
  req.url = path
  req.headers = {}
  const out: { status?: number; body?: any } = {}
  const res: any = {
    writeHead(s: number) { out.status = s },
    end(b: string) { out.body = JSON.parse(b) },
  }
  const handled = await handleAppFleet(req, res, path.split("?")[0], method, "My phone", d)
  return { handled, ...out }
}

describe("summaries", () => {
  it("caps every free-text field and takes cron outcomes from run files", () => {
    const s = summarizeNode(node)
    expect(s.agents[0].last!.text!.length).toBeLessThanOrEqual(PREVIEW_CHARS)
    expect(s.crons.today).toEqual({ success: 1, failed: 1 })
    const digest = s.crons.items.find((c) => c.id === "digest")!
    expect(digest.last!.status).toBe("success")
    expect(digest.last!.text!.length).toBeLessThanOrEqual(PREVIEW_CHARS)
    expect(s.crons.items.find((c) => c.id === "stale")!.last).toBeUndefined()
    expect(s.restart).toBeUndefined()
  })

  it("lists running tasks newest first with the node they run on", () => {
    const tasks = summarizeActivity([node])
    expect(tasks.map((t) => t.taskId)).toEqual(["t-new", "t-old"])
    expect(tasks[0]).toMatchObject({ node: "http://node-a:18800", agentId: "helper" })
    expect(tasks[0].preview!.length).toBeLessThanOrEqual(PREVIEW_CHARS)
  })

  it("computes today in the phone's time zone", () => {
    expect(dateIn("Pacific/Kiritimati", new Date("2026-01-02T20:00:00Z"))).toBe("2026-01-03")
    expect(dateIn("UTC", new Date("2026-01-02T20:00:00Z"))).toBe("2026-01-02")
  })
})

describe("handleAppFleet", () => {
  it("serves the fleet with today's date in the given time zone", async () => {
    const d = deps()
    const r = await call(d, "GET", "/api/app/fleet?timezone=UTC")
    expect(r.status).toBe(200)
    expect(r.body.nodes[0].name).toBe("node-a")
    expect(d.snapshot).toHaveBeenCalledWith({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), timezone: "UTC" })
  })

  it("falls back to UTC for an unknown time zone", async () => {
    const d = deps()
    await call(d, "GET", "/api/app/activity?timezone=Not/AZone")
    expect(d.snapshot).toHaveBeenCalledWith(expect.objectContaining({ timezone: "UTC" }))
  })

  it("routes each action to the matching daemon route on the chosen node", async () => {
    const d = deps()
    await call(d, "POST", "/api/app/tasks/cancel", { node: "http://node-a:18800", taskId: "t 1" })
    expect(d.nodePost).toHaveBeenLastCalledWith("http://node-a:18800", "/api/tasks/t%201/cancel", { reason: "cancelled by operator (phone: My phone)" })
    await call(d, "POST", "/api/app/tasks/followup", { node: "n", taskId: "t", message: "also check the logs" })
    expect(d.nodePost).toHaveBeenLastCalledWith("n", "/api/tasks/t/followup", { message: "also check the logs", sender: "operator (phone: My phone)" })
    await call(d, "POST", "/api/app/nodes/restart", { node: "n" })
    expect(d.nodePost).toHaveBeenLastCalledWith("n", "/daemon/restart", {})
    await call(d, "POST", "/api/app/nodes/restart", { node: "n", cancel: true })
    expect(d.nodePost).toHaveBeenLastCalledWith("n", "/daemon/restart/cancel", {})
    await call(d, "POST", "/api/app/nodes/reload", { node: "n" })
    expect(d.nodePost).toHaveBeenLastCalledWith("n", "/reload", {})
    await call(d, "POST", "/api/app/crons/toggle", { node: "n", cronId: "digest", enabled: false })
    expect(d.nodePost).toHaveBeenLastCalledWith("n", "/crons/digest/enabled", { enabled: false })
    await call(d, "POST", "/api/app/approvals/decide", { node: "n", key: "card:c1", action: "yes" })
    expect(d.decide).toHaveBeenLastCalledWith("n", "card:c1", "yes")
  })

  it("passes the node's status and body through", async () => {
    const d = deps({ nodePost: vi.fn(async () => ({ status: 404, body: { error: "no running task" } })) })
    const r = await call(d, "POST", "/api/app/tasks/cancel", { node: "n", taskId: "gone" })
    expect(r).toMatchObject({ status: 404, body: { error: "no running task" } })
  })

  it("rejects incomplete requests before calling any node", async () => {
    const d = deps()
    expect((await call(d, "POST", "/api/app/tasks/cancel", { taskId: "t" })).status).toBe(400)
    expect((await call(d, "POST", "/api/app/tasks/followup", { node: "n", taskId: "t" })).status).toBe(400)
    expect((await call(d, "POST", "/api/app/crons/toggle", { node: "n", cronId: "x", enabled: "no" })).status).toBe(400)
    expect((await call(d, "POST", "/api/app/approvals/decide", { node: "n", key: "k", action: "maybe" })).status).toBe(400)
    expect(d.nodePost).not.toHaveBeenCalled()
    expect(d.decide).not.toHaveBeenCalled()
  })

  it("leaves other paths to the caller", async () => {
    const d = deps()
    expect((await call(d, "GET", "/api/app/me")).handled).toBe(false)
    expect((await call(d, "POST", "/api/app/chat", {})).handled).toBe(false)
    expect((await call(d, "DELETE", "/api/app/fleet")).handled).toBe(false)
  })
})
