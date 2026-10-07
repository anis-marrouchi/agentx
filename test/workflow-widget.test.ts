import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, rmSync } from "fs"
import { resolve } from "path"
import { Readable } from "stream"
import {
  RunStore,
  WorkflowStore,
  WorkflowDispatcher,
  workflowSchema,
  type AgentExecuteRequest,
  type WorkflowRun,
} from "../src/workflows"
import { TimerService } from "../src/workflows/timers"
import { DEFAULT_WIDGET_SETTINGS, ownerReplyText, widgetPlacement, widgetRows, widgetStateLabel, type NodeRun } from "../src/workflows/widget"
import { handleAppWorkflows, handleDashboardWidget, widgetAnswer, widgetSnapshot, type WidgetApiDeps } from "../src/daemon/workflow-widget-api"
import { renderWorkflowWidgetPage } from "../src/daemon/ui/pages/workflow-widget"
import { APP_FLEET_SCRIPT } from "../src/daemon/ui/pages/app-fleet.client"
import { widgetPatch, widgetUrl } from "../src/commands/workflow-widget"
import { isControlPost } from "../src/daemon/mesh-auth"

// The floating progress widget (#796): rows, answers, the owner's reply to
// a blocked step, the page and the CLI flags.

const at = (m: number) => new Date(Date.UTC(2026, 0, 2, 10, m)).toISOString()

function run(id: string, over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id, workflowId: "release", workflowVersion: 1, homeNode: "node-a", status: "paused",
    pending: [], context: {}, history: [], createdAt: at(0), updatedAt: at(1),
    meta: { title: `Run ${id}`, tags: [], followUp: true, approvedAtStart: false },
    ...over,
  } as WorkflowRun
}

const A = { node: "http://node-a:18800", nodeName: "node-a" }
const B = { node: "http://node-b:18800", nodeName: "node-b" }

const card = run("card", { pausedAt: { kind: "ownerDecision", nodeId: "approve", cardId: "c1", purpose: "ask" }, updatedAt: at(5) })
const blocked = run("blocked", {
  pausedAt: { kind: "agentStep", nodeId: "deploy", agentId: "builder", nudges: 2, maxNudges: 2, stallMs: 60_000, blocked: "needs a password" },
  meta: { title: "Deploy the site", tags: ["client:acme"], followUp: true, approvedAtStart: false, blocked: { nodeId: "deploy", reason: "needs a password", at: at(2) } },
  updatedAt: at(9),
})
const working = run("working", { pausedAt: { kind: "agentStep", nodeId: "verify", agentId: "checker", nudges: 0, maxNudges: 2, stallMs: 60_000 }, updatedAt: at(2) })
const reply = run("reply", { pausedAt: { kind: "replyWait", nodeId: "client_reply", channel: "telegram", chatId: "client-1", deadline: at(50), reminders: 0, maxReminders: 1 }, updatedAt: at(3) })
const running = run("running", { status: "running", pending: ["build"], meta: { tags: [], followUp: true, approvedAtStart: false }, updatedAt: at(4) })

describe("widgetRows", () => {
  const rows = widgetRows(
    [{ ...A, run: running }, { ...A, run: reply }, { ...A, run: working }, { ...B, run: blocked }, { ...A, run: card }],
    { title: (id) => (id === "release" ? "Release" : undefined), stepAgent: (wf, step) => (wf === "release" && step === "build" ? "builder" : undefined) },
  )

  it("puts what waits on the owner first, then oldest first", () => {
    expect(rows.map((r) => r.runId)).toEqual(["card", "blocked", "working", "reply", "running"])
  })

  it("names who each step waits for and how the owner answers", () => {
    const by = Object.fromEntries(rows.map((r) => [r.runId, r]))
    expect(by.card).toMatchObject({ owner: "you", state: "waiting-on-you", answer: { kind: "card", key: "card:c1" }, waitingOn: "your answer", node: A.node })
    expect(by.blocked).toMatchObject({ owner: "builder", state: "blocked", answer: { kind: "reply", agentId: "builder" }, step: "deploy", node: B.node, nodeName: "node-b", tags: ["client:acme"] })
    expect(by.working).toMatchObject({ owner: "checker", state: "waiting", answer: null })
    expect(by.reply).toMatchObject({ owner: "client-1", state: "waiting", answer: null })
    expect(by.running).toMatchObject({ owner: "builder", state: "running", step: "build", title: "Release" })
  })

  it("leaves out runs that are not followed, have ended, or are child runs, and shows a run once", () => {
    const out = widgetRows([
      { ...A, run: run("plain", { meta: { tags: [], followUp: false, approvedAtStart: false } }) },
      { ...A, run: run("done", { status: "completed" }) },
      { ...A, run: run("child", { parentRunId: "card" }) },
      { ...A, run: card },
      { ...B, run: card },
    ])
    expect(out.map((r) => [r.runId, r.node])).toEqual([["card", A.node]])
  })

  it("keeps only the tags asked for", () => {
    const runs: NodeRun[] = [{ ...A, run: card }, { ...B, run: blocked }]
    expect(widgetRows(runs, { tags: ["Client:Acme"] }).map((r) => r.runId)).toEqual(["blocked"])
    expect(widgetRows(runs, { tags: [] }).length).toBe(2)
  })
})

describe("page helpers", () => {
  const screen = { availLeft: 0, availTop: 25, availWidth: 1440, availHeight: 875 }
  it("places the small window in the chosen corner", () => {
    expect(widgetPlacement("top-right", 360, 420, screen)).toEqual({ left: 1064, top: 41 })
    expect(widgetPlacement("top-left", 360, 420, screen)).toEqual({ left: 16, top: 41 })
    expect(widgetPlacement("bottom-right", 360, 420, screen)).toEqual({ left: 1064, top: 464 })
    expect(widgetPlacement("bottom-left", 360, 420, screen)).toEqual({ left: 16, top: 464 })
  })
  it("never places it off the screen", () => {
    expect(widgetPlacement("bottom-right", 2000, 2000, screen)).toEqual({ left: 0, top: 25 })
  })
  it("labels states in plain words", () => {
    expect(["waiting-on-you", "blocked", "waiting", "running"].map(widgetStateLabel)).toEqual(["Needs you", "Blocked", "Waiting", "Running"])
  })
  it("tells the agent what the owner said and how to report", () => {
    const text = ownerReplyText(blocked, "deploy", "The password is in the vault.")
    expect(text).toContain('[Workflow "Deploy the site", step "deploy"]')
    expect(text).toContain("The password is in the vault.")
    expect(text).toContain('agentx_workflow {action:"done", runId:"blocked", step:"deploy"')
  })
})

function deps(over: Partial<WidgetApiDeps> = {}, runs: NodeRun[] = [{ ...A, run: card }, { ...B, run: blocked }, { ...A, run: working }]): WidgetApiDeps {
  return {
    settings: () => ({ ...DEFAULT_WIDGET_SETTINGS }),
    nodeRuns: async () => ({ runs, unreachable: ["http://node-c:18800"] }),
    decide: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    reply: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    ...over,
  }
}

describe("widgetSnapshot", () => {
  it("returns the rows and the nodes it could not read", async () => {
    const s = await widgetSnapshot(deps())
    expect(s.enabled).toBe(true)
    expect(s.rows.map((r) => r.runId)).toEqual(["card", "blocked", "working"])
    expect(s.unreachable).toEqual(["http://node-c:18800"])
  })
  it("uses the configured tags, or the one asked for", async () => {
    expect((await widgetSnapshot(deps({ settings: () => ({ ...DEFAULT_WIDGET_SETTINGS, tags: ["client:acme"] }) }))).rows.map((r) => r.runId)).toEqual(["blocked"])
    expect((await widgetSnapshot(deps(), "client:acme")).rows.map((r) => r.runId)).toEqual(["blocked"])
  })
  it("shows nothing when the widget is off", async () => {
    const nodeRuns = vi.fn()
    const s = await widgetSnapshot(deps({ settings: () => ({ ...DEFAULT_WIDGET_SETTINGS, enabled: false }), nodeRuns }))
    expect(s).toMatchObject({ enabled: false, rows: [] })
    expect(nodeRuns).not.toHaveBeenCalled()
  })
})

describe("widgetAnswer", () => {
  it("answers a decision card on the node that holds it", async () => {
    const d = deps()
    expect(await widgetAnswer({ node: A.node, runId: "card", step: "approve", key: "card:c1", action: "yes" }, d, "operator (test)")).toEqual({ status: 200, body: { ok: true } })
    expect(d.decide).toHaveBeenCalledWith(A.node, "card:c1", "yes", "operator (test)")
  })
  it("hands a reply to the blocked step's node", async () => {
    const d = deps()
    await widgetAnswer({ node: B.node, runId: "blocked", step: "deploy", action: "reply", text: "  It is in the vault. " }, d, "operator (test)")
    expect(d.reply).toHaveBeenCalledWith(B.node, "blocked", "deploy", "It is in the vault.", "operator (test)")
  })
  it("refuses an answer to a step that no longer waits on the owner", async () => {
    const d = deps()
    expect((await widgetAnswer({ node: A.node, runId: "working", step: "verify", action: "yes" }, d, "x")).status).toBe(409)
    expect((await widgetAnswer({ node: A.node, runId: "gone", step: "x", action: "yes" }, d, "x")).status).toBe(409)
    // The right run on the wrong node is not that run.
    expect((await widgetAnswer({ node: B.node, runId: "card", step: "approve", key: "card:c1", action: "yes" }, d, "x")).status).toBe(409)
    expect(d.decide).not.toHaveBeenCalled()
  })
  it("refuses an answer meant for another step or another card of the same run", async () => {
    const d = deps()
    // The run moved on to a new card (or a new step) since the view was drawn.
    expect((await widgetAnswer({ node: A.node, runId: "card", step: "approve", key: "card:old", action: "yes" }, d, "x")).status).toBe(409)
    expect((await widgetAnswer({ node: A.node, runId: "card", step: "earlier", key: "card:c1", action: "yes" }, d, "x")).status).toBe(409)
    expect((await widgetAnswer({ node: B.node, runId: "blocked", step: "earlier", action: "reply", text: "go" }, d, "x")).status).toBe(409)
    expect(d.decide).not.toHaveBeenCalled()
    expect(d.reply).not.toHaveBeenCalled()
  })
  it("sends a card that offers choices to the Approvals inbox", async () => {
    const d = deps({ hasChoices: (wf, step) => wf === "release" && step === "approve" })
    const s = await widgetSnapshot(d)
    expect(s.rows[0].answer).toEqual({ kind: "card", key: "card:c1", choices: true })
    expect((await widgetAnswer({ node: A.node, runId: "card", step: "approve", key: "card:c1", action: "yes" }, d, "x")).status).toBe(400)
    expect(d.decide).not.toHaveBeenCalled()
  })
  it("refuses the wrong kind of answer, an empty reply and bad input", async () => {
    const d = deps()
    expect((await widgetAnswer({ node: A.node, runId: "card", step: "approve", key: "card:c1", action: "reply", text: "hi" }, d, "x")).status).toBe(400)
    expect((await widgetAnswer({ node: B.node, runId: "blocked", step: "deploy", action: "yes" }, d, "x")).status).toBe(400)
    expect((await widgetAnswer({ node: B.node, runId: "blocked", step: "deploy", action: "reply", text: " " }, d, "x")).status).toBe(400)
    expect((await widgetAnswer({ node: A.node, runId: "card", step: "approve", key: "card:c1", action: "later" }, d, "x")).status).toBe(400)
    expect((await widgetAnswer({ runId: "card", step: "approve", action: "yes" }, d, "x")).status).toBe(400)
    expect(d.decide).not.toHaveBeenCalled()
    expect(d.reply).not.toHaveBeenCalled()
  })
  it("refuses answers while the widget is off", async () => {
    const d = deps({ settings: () => ({ ...DEFAULT_WIDGET_SETTINGS, enabled: false }) })
    expect((await widgetAnswer({ node: A.node, runId: "card", step: "approve", key: "card:c1", action: "yes" }, d, "x")).status).toBe(409)
  })
})

async function call(handler: typeof handleDashboardWidget | typeof handleAppWorkflows, d: WidgetApiDeps, method: string, path: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any
  req.url = path
  req.headers = {}
  const out: { status?: number; body?: any } = {}
  const res: any = { writeHead(s: number) { out.status = s }, end(b: string) { out.body = JSON.parse(b) } }
  const handled = handler === handleAppWorkflows
    ? await handleAppWorkflows(req, res, path.split("?")[0], method, "My phone", d)
    : await handleDashboardWidget(req, res, path.split("?")[0], method, d)
  return { handled, ...out }
}

describe("routes", () => {
  it("serves the dashboard widget and names the widget as who answered", async () => {
    const d = deps()
    const got = await call(handleDashboardWidget, d, "GET", "/api/workflows/widget?tag=client:acme")
    expect(got.status).toBe(200)
    expect(got.body.rows.map((r: any) => r.runId)).toEqual(["blocked"])
    await call(handleDashboardWidget, d, "POST", "/api/workflows/widget/answer", { node: A.node, runId: "card", step: "approve", key: "card:c1", action: "no" })
    expect(d.decide).toHaveBeenCalledWith(A.node, "card:c1", "no", "operator (progress widget)")
    expect((await call(handleDashboardWidget, d, "GET", "/api/workflows/other")).handled).toBe(false)
  })
  it("serves the phone app and names the phone as who answered", async () => {
    const d = deps()
    expect((await call(handleAppWorkflows, d, "GET", "/api/app/workflows")).body.rows.length).toBe(3)
    await call(handleAppWorkflows, d, "POST", "/api/app/workflows/answer", { node: B.node, runId: "blocked", step: "deploy", action: "reply", text: "go" })
    expect(d.reply).toHaveBeenCalledWith(B.node, "blocked", "deploy", "go", "operator (phone: My phone)")
    expect((await call(handleAppWorkflows, d, "GET", "/api/app/fleet")).handled).toBe(false)
  })
  it("gates the daemon's answer route like cancel", () => {
    expect(isControlPost("/workflow-runs/r1/answer")).toBe(true)
    expect(isControlPost("/workflow-runs/r1/cancel")).toBe(true)
  })
})

describe("the pages", () => {
  it("the widget page carries its settings and a script that parses", () => {
    const html = renderWorkflowWidgetPage({ ...DEFAULT_WIDGET_SETTINGS, position: "bottom-left" })
    expect(html).toContain("Keep on top")
    expect(html).toContain("&quot;position&quot;:&quot;bottom-left&quot;")
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(scripts.length).toBe(2)
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
  })
  it("the phone app's Activity script still parses", () => {
    expect(() => new Function(APP_FLEET_SCRIPT)).not.toThrow()
    expect(APP_FLEET_SCRIPT).toContain("/api/app/workflows")
  })
})

describe("agentx workflow widget flags", () => {
  it("turns flags into a settings change", () => {
    expect(widgetPatch({ enabled: "off", position: "bottom-left", tags: "Client:Acme, project:site", size: "400x500", refreshSeconds: "20" })).toEqual({
      ok: true, patch: { enabled: false, position: "bottom-left", tags: ["client:acme", "project:site"], width: 400, height: 500, refreshSeconds: 20 },
    })
    expect(widgetPatch({ tags: "" })).toEqual({ ok: true, patch: { tags: [] } })
    expect(widgetPatch({})).toEqual({ ok: true, patch: {} })
  })
  it("refuses values out of range", () => {
    expect(widgetPatch({ enabled: "yes" }).ok).toBe(false)
    expect(widgetPatch({ position: "middle" }).ok).toBe(false)
    expect(widgetPatch({ size: "100x100" }).ok).toBe(false)
    expect(widgetPatch({ size: "big" }).ok).toBe(false)
    expect(widgetPatch({ refreshSeconds: "1" }).ok).toBe(false)
  })
  it("builds the address on this computer", () => {
    expect(widgetUrl(4202)).toBe("http://127.0.0.1:4202/workflows/widget")
    expect(widgetUrl(4202, "Client:Acme")).toBe("http://127.0.0.1:4202/workflows/widget?tag=client%3Aacme")
  })
})

// --- The owner's reply to a blocked step, on the engine ---

const TEST_DIR = resolve(__dirname, "../.test-workflow-widget")

const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition not met in time")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("ownerReply", () => {
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  function setup(reply: (req: AgentExecuteRequest, n: number) => string) {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const timers = new TimerService({ baseDir: resolve(TEST_DIR, "_timer-base") })
    const turns: AgentExecuteRequest[] = []
    const told: string[] = []
    const ended: WorkflowRun[] = []
    const dispatcher = new WorkflowDispatcher({
      store, runs, nodeId: "node-a", timers,
      agents: { execute: async (req) => { turns.push(req); return { content: reply(req, turns.length) } } },
      owner: { notify: async (text) => { told.push(text) }, ask: async () => ({ cardId: "c" }) },
      followUp: () => ({ stallMinutes: 30, maxNudges: 2, approval: "step" as const }),
      onRunEnded: (r) => { ended.push(r) },
    })
    store.save(workflowSchema.parse({
      id: "one-step", title: "One step",
      nodes: [
        { id: "start", type: "trigger.manual" },
        { id: "deploy", type: "agent", config: { agentId: "builder", prompt: "Deploy" } },
        { id: "tell", type: "owner.notify", config: { text: "Deployed" } },
      ],
      edges: [{ from: "start", to: "deploy" }, { from: "deploy", to: "tell" }],
    }))
    return { dispatcher, runs, timers, turns, told, ended }
  }

  it("lifts the block, restarts reminders and gives the agent the answer", async () => {
    const h = setup((_req, n) => (n === 1 ? "The server needs a password I do not have.\nRESULT: blocked" : "Deployed with it.\nRESULT: done"))
    const { run: started } = await h.dispatcher.startRun({ workflowId: "one-step" })
    const id = started!.id
    await until(() => !!h.runs.get(id)?.meta?.blocked)
    expect(h.timers.list().some((t) => t.runId === id)).toBe(false)

    expect(await h.dispatcher.ownerReply({ runId: id, text: "It is in the vault under deploy.", by: "operator (progress widget)" })).toEqual({ ok: true })
    await until(() => h.turns.length === 2)
    expect(h.turns[1]).toMatchObject({ agentId: "builder", workflowRunId: id })
    expect(h.turns[1].message).toContain("It is in the vault under deploy.")
    expect(h.runs.get(id)!.history.some((e) => e.note === "answered by operator (progress widget)")).toBe(true)

    // The agent's RESULT: done on that turn moves the run on.
    await until(() => h.ended.length === 1)
    expect(h.runs.get(id)?.status).toBe("completed")
    expect(h.runs.get(id)?.meta?.blocked).toBeUndefined()
  })

  it("restarts reminders when the agent says nothing conclusive", async () => {
    const h = setup((_req, n) => (n === 1 ? "No access.\nRESULT: blocked" : "Looking into it."))
    const { run: started } = await h.dispatcher.startRun({ workflowId: "one-step" })
    const id = started!.id
    await until(() => !!h.runs.get(id)?.meta?.blocked)
    await h.dispatcher.ownerReply({ runId: id, text: "Try again now." })
    await until(() => h.turns.length === 2)
    const r = h.runs.get(id)!
    expect(r.pausedAt).toMatchObject({ kind: "agentStep", nudges: 0 })
    expect(r.pausedAt && "blocked" in r.pausedAt ? r.pausedAt.blocked : undefined).toBeUndefined()
    expect(h.timers.list().some((t) => t.runId === id)).toBe(true)
  })

  it("refuses a step that is not blocked, an empty answer and an unknown run", async () => {
    const h = setup(() => "Working on it.")
    const { run: started } = await h.dispatcher.startRun({ workflowId: "one-step" })
    const id = started!.id
    await until(() => h.runs.get(id)?.pausedAt?.kind === "agentStep")
    expect((await h.dispatcher.ownerReply({ runId: id, text: "hi" })).error).toMatch(/no blocked step/)
    expect((await h.dispatcher.ownerReply({ runId: id, text: "  " })).error).toMatch(/empty/)
    expect((await h.dispatcher.ownerReply({ runId: "nope", text: "hi" })).error).toMatch(/no run/)
    expect(h.turns.length).toBe(1)
  })

  it("refuses an answer meant for another step", async () => {
    const h = setup(() => "No access.\nRESULT: blocked")
    const { run: started } = await h.dispatcher.startRun({ workflowId: "one-step" })
    const id = started!.id
    await until(() => !!h.runs.get(id)?.meta?.blocked)
    expect((await h.dispatcher.ownerReply({ runId: id, nodeId: "tell", text: "go" })).error).toMatch(/blocked on step "deploy", not "tell"/)
    expect(await h.dispatcher.ownerReply({ runId: id, nodeId: "deploy", text: "go" })).toEqual({ ok: true })
  })
})
