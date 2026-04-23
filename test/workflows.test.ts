import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"
import {
  RunStore,
  WorkflowStore,
  WorkflowDispatcher,
  evaluateBranch,
  idempotencyKey,
  initialPendingFromTrigger,
  lintWorkflow,
  nextNodes,
  resolveHandler,
  workflowSchema,
  type Workflow,
  type AgentExecuteRequest,
  type AgentExecuteResponse,
} from "../src/workflows"
import { render, renderParams } from "../src/workflows/template"

const TEST_DIR = resolve(__dirname, "../.test-workflows")

function baseWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return workflowSchema.parse({
    id: "test-wf",
    version: 2,
    title: "Test WF",
    priority: 0,
    fanOut: false,
    nodes: [
      { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
      { id: "classify", type: "agent", config: { agentId: "classifier", prompt: "hi {{trigger.text}}" } },
      { id: "route",   type: "branch", config: {
        cases: [
          { when: { kind: "equals", params: { path: "classify.result", value: "ok" } }, to: "ok" },
        ],
        default: "fallback",
      } },
      { id: "reply_ok",   type: "action.send", config: { channel: "fake", chatId: "c1", text: "ok branch" } },
      { id: "reply_fail", type: "action.send", config: { channel: "fake", chatId: "c1", text: "fallback" } },
      { id: "done", type: "end", config: {} },
    ],
    edges: [
      { from: "trigger", to: "classify" },
      { from: "classify", to: "route" },
      { from: "route", fromPort: "ok",       to: "reply_ok" },
      { from: "route", fromPort: "fallback", to: "reply_fail" },
      { from: "reply_ok", to: "done" },
      { from: "reply_fail", to: "done" },
    ],
    envAllow: [],
    retention: { maxRuns: 500, maxDays: 90 },
    ...overrides,
  })
}

describe("workflowSchema", () => {
  it("parses a valid V2 workflow", () => {
    const wf = baseWorkflow()
    expect(wf.nodes).toHaveLength(6)
    expect(wf.edges).toHaveLength(6)
  })

  it("rejects v1 shape (states + transitions)", () => {
    const bad = {
      id: "old", title: "old", version: 1,
      states: { a: { agent: "x", prompt: "x" } },
      transitions: [],
      trigger: { source: "manual" },
    }
    expect(workflowSchema.safeParse(bad).success).toBe(false)
  })

  it("requires at least one node", () => {
    const bad = { id: "empty", version: 2, title: "t", priority: 0, nodes: [], edges: [], envAllow: [], retention: { maxRuns: 1, maxDays: 1 } }
    expect(workflowSchema.safeParse(bad).success).toBe(false)
  })
})

describe("lintWorkflow", () => {
  it("flags missing trigger", () => {
    const wf = baseWorkflow()
    const noTrigger: Workflow = { ...wf, nodes: wf.nodes.filter((n) => !n.type.startsWith("trigger.")) }
    const issues = lintWorkflow(noTrigger)
    expect(issues.some((i) => i.includes("trigger.*"))).toBe(true)
  })

  it("flags orphan edges", () => {
    const wf = baseWorkflow()
    const orphaned: Workflow = { ...wf, edges: [...wf.edges, { from: "nowhere", to: "done" }] }
    const issues = lintWorkflow(orphaned)
    expect(issues.some((i) => i.includes("missing node"))).toBe(true)
  })

  it("flags unreachable nodes", () => {
    const wf = baseWorkflow()
    const withOrphan: Workflow = {
      ...wf,
      nodes: [...wf.nodes, { id: "orphan", type: "end", config: {} }],
    }
    const issues = lintWorkflow(withOrphan)
    expect(issues.some((i) => i.includes("unreachable"))).toBe(true)
  })

  it("flags branch edges using undeclared ports", () => {
    const wf = baseWorkflow()
    const bad: Workflow = {
      ...wf,
      edges: [...wf.edges, { from: "route", fromPort: "undeclared", to: "done" }],
    }
    const issues = lintWorkflow(bad)
    expect(issues.some((i) => i.includes("undeclared"))).toBe(true)
  })
})

describe("engine: nextNodes + initialPending", () => {
  it("enqueues the trigger's successors on initial pending", () => {
    const wf = baseWorkflow()
    const init = initialPendingFromTrigger(wf)
    expect(init?.triggerId).toBe("trigger")
    expect(init?.pending).toEqual(["classify"])
  })

  it("branch dispatches only the selected port", () => {
    const wf = baseWorkflow()
    const r = nextNodes({ workflow: wf, fromNodeId: "route", selectedPort: "ok" })
    expect(r.nextPending).toEqual(["reply_ok"])
    const r2 = nextNodes({ workflow: wf, fromNodeId: "route", selectedPort: "fallback" })
    expect(r2.nextPending).toEqual(["reply_fail"])
  })

  it("linear nodes fire all outgoing edges", () => {
    const wf = baseWorkflow()
    const r = nextNodes({ workflow: wf, fromNodeId: "classify" })
    expect(r.nextPending).toEqual(["route"])
  })
})

describe("engine: evaluateBranch", () => {
  it("returns the matching case's `to`", () => {
    const wf = baseWorkflow()
    const branch = wf.nodes.find((n) => n.id === "route")!
    expect(evaluateBranch(branch, { classify: { result: "ok" } })).toBe("ok")
    expect(evaluateBranch(branch, { classify: { result: "unknown" } })).toBe("fallback")
  })
})

describe("idempotencyKey", () => {
  it("is stable + distinct per (runId, nodeId, eventId)", () => {
    const a = idempotencyKey("r1", "n1", "e1")
    const b = idempotencyKey("r1", "n1", "e1")
    const c = idempotencyKey("r1", "n2", "e1")
    const d = idempotencyKey("r1", "n1", "e2")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
  })
})

describe("template rendering", () => {
  it("resolves dotted paths", () => {
    expect(render("hi {{a.b}}", { a: { b: "x" } })).toBe("hi x")
    expect(render("missing {{a.missing}}", { a: {} })).toBe("missing ")
  })
  it("renderParams walks nested objects + arrays", () => {
    const out = renderParams(
      { body: "hi {{x}}", tags: ["t-{{x}}", 42], nested: { key: "{{x}}" } },
      { x: "world" },
    )
    expect(out).toEqual({ body: "hi world", tags: ["t-world", 42], nested: { key: "world" } })
  })
  it("env allowlist gates reads", () => {
    process.env.WF_TEST_ALLOWED = "ok"
    process.env.WF_TEST_SECRET = "nope"
    const out = render("{{env.WF_TEST_ALLOWED}} | {{env.WF_TEST_SECRET}}", {}, { envAllow: ["WF_TEST_ALLOWED"] })
    expect(out).toBe("ok | ")
    delete process.env.WF_TEST_ALLOWED
    delete process.env.WF_TEST_SECRET
  })
})

describe("RunStore (V2)", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it("creates a run, records executions, and reconstructs state", () => {
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const run = runs.create({
      workflowId: "wf", initialPending: ["classify"],
      entityRef: { backend: "manual", id: "x" },
      initialContext: { trigger: { text: "hi" } },
    })
    expect(run.homeNode).toBe("node-a")
    expect(run.pending).toEqual(["classify"])
    expect(run.context.trigger.text).toBe("hi")

    const key = idempotencyKey(run.id, "classify", "evt-1")
    runs.recordExecution({
      runId: run.id,
      entry: { at: new Date().toISOString(), nodeId: "classify", inputKeys: ["trigger"], status: "ok", output: { result: "ok" }, idempotencyKey: key },
      nextPending: ["route"],
      context: { ...run.context, classify: { result: "ok" } },
    })

    const reloaded = runs.get(run.id)!
    expect(reloaded.history).toHaveLength(1)
    expect(reloaded.pending).toEqual(["route"])
    expect(reloaded.context.classify.result).toBe("ok")
  })

  it("drops duplicate executions by idempotency key", () => {
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const run = runs.create({ workflowId: "wf", initialPending: ["a"], entityRef: { backend: "manual", id: "x" } })
    const key = idempotencyKey(run.id, "a", "evt-1")
    runs.recordExecution({
      runId: run.id,
      entry: { at: new Date().toISOString(), nodeId: "a", inputKeys: [], status: "ok", idempotencyKey: key },
      nextPending: [],
    })
    // Re-record with the same key: should be a no-op.
    const after = runs.recordExecution({
      runId: run.id,
      entry: { at: new Date().toISOString(), nodeId: "a", inputKeys: [], status: "ok", idempotencyKey: key },
      nextPending: [],
    })
    expect(after?.history).toHaveLength(1)
  })

  it("tracks entity -> run mapping and clears on completion", () => {
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const ref = { backend: "manual" as const, id: "entity-1" }
    const run = runs.create({ workflowId: "wf", initialPending: ["a"], entityRef: ref })
    expect(runs.getActiveByEntity(ref)).toBe(run.id)
    runs.setStatus(run.id, "completed")
    expect(runs.getActiveByEntity(ref)).toBeNull()
  })
})

describe("resolveHandler", () => {
  it("knows Phase 1 node types", () => {
    for (const t of ["trigger.channel", "trigger.manual", "agent", "branch", "action.send", "action.createIssue", "end"]) {
      expect(resolveHandler(t)).toBeDefined()
    }
  })
  it("returns undefined for unknown types", () => {
    expect(resolveHandler("not-a-real-type")).toBeUndefined()
  })
})

describe("WorkflowDispatcher integration", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it("walks a manual-triggered flow end-to-end", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    const wf = store.save(baseWorkflow({
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "classify", type: "agent", config: { agentId: "cls", prompt: "hi {{trigger.text}}" } },
        { id: "reply",   type: "action.send", config: { channel: "fake", chatId: "c1", text: "replied: {{classify.reply}}" } },
        { id: "done",    type: "end", config: {} },
      ],
      edges: [
        { from: "trigger", to: "classify" },
        { from: "classify", to: "reply" },
        { from: "reply", to: "done" },
      ],
    }))
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })

    const sends: Array<{ chatId: string; text: string }> = []
    const channels = {
      fake: { send: async (m: { chatId: string; text: string }) => { sends.push(m); return "msg-1" } },
    }
    const agents = {
      execute: async (_: AgentExecuteRequest): Promise<AgentExecuteResponse> =>
        ({ content: "RESULT: ok\nhello world", taskId: "t1", durationMs: 10 }),
    }
    const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels, agents })

    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e1" },
      event: { id: "evt-1", payload: { text: "hello" } },
    })

    // Give the background walk a beat to complete.
    await new Promise((r) => setTimeout(r, 30))

    const list = runs.list({ workflowId: wf.id })
    expect(list).toHaveLength(1)
    const final = list[0]
    expect(final.status).toBe("completed")
    const steps = final.history.map((h) => h.nodeId)
    expect(steps).toEqual(["classify", "reply", "done"])
    expect(sends).toHaveLength(1)
    expect(sends[0].text).toContain("hello world")
  })

  it("branch routes the walker down the matching port", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    store.save(baseWorkflow())
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })

    const sends: Array<{ chatId: string; text: string }> = []
    const channels = {
      fake: { send: async (m: { chatId: string; text: string }) => { sends.push(m); return "msg" } },
    }
    const agents = {
      execute: async (): Promise<AgentExecuteResponse> => ({ content: "RESULT: ok", taskId: "t", durationMs: 1 }),
    }
    const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels, agents })

    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e1" },
      event: { id: "evt-1", payload: { text: "hi" } },
    })
    await new Promise((r) => setTimeout(r, 30))

    const final = runs.list()[0]
    const ids = final.history.map((h) => h.nodeId)
    expect(ids).toContain("reply_ok")
    expect(ids).not.toContain("reply_fail")
  })

  it("forwards to home node when run is owned remotely", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    store.save(baseWorkflow())
    // Seed a run owned by a different node so the dispatcher's home-node
    // check forwards instead of walking.
    const remote = new RunStore({ baseDir: TEST_DIR, nodeId: "node-b" })
    remote.create({ workflowId: "test-wf", initialPending: [], entityRef: { backend: "manual", id: "e-remote" } })

    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const forwarded: Array<{ peer: string; workflowId: string }> = []
    const agents = {
      execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }),
    }
    const dispatcher = new WorkflowDispatcher({
      store, runs, nodeId: "node-a", channels: {}, agents,
      forwarder: {
        forwardTransition: async (peer, payload) => {
          forwarded.push({ peer, workflowId: payload.workflowId })
        },
      },
    })

    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-remote" },
      event: { id: "evt-x", payload: { text: "hi" } },
    })
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0].peer).toBe("node-b")
  })

  it("broadcasts trigger to mesh peers on local-origin dispatch only", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    store.save(baseWorkflow({
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "trigger", to: "done" }],
    }))
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const broadcasts: any[] = []
    const dispatcher = new WorkflowDispatcher({
      store, runs, nodeId: "node-a", channels: {},
      agents: { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) },
      forwarder: {
        forwardTransition: async () => {},
        broadcastTrigger: async (p) => { broadcasts.push(p) },
      },
    })

    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-1" },
      event: { id: "evt-1", payload: {} },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(broadcasts).toHaveLength(1)

    // Remote-origin must not re-broadcast (echo guard)
    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-2" },
      event: { id: "evt-2", payload: {} },
      fromRemote: { peer: "node-b" },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(broadcasts).toHaveLength(1)
  })

  it("matchByTrigger requires mesh.allowRemote when dispatch is fromRemote", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    store.save(baseWorkflow({
      id: "local-only",
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "whatsapp-message" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "trigger", to: "done" }],
    }))
    store.save(baseWorkflow({
      id: "remote-ok",
      mesh: { allowRemote: true },
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "whatsapp-message" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "trigger", to: "done" }],
    }))
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const dispatcher = new WorkflowDispatcher({
      store, runs, nodeId: "node-a", channels: {},
      agents: { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) },
    })

    const r = await dispatcher.dispatch({
      trigger: { source: "whatsapp-message" },
      entityRef: { backend: "whatsapp", id: "e-3" },
      event: { id: "evt-3", payload: {} },
      fromRemote: { peer: "clawd-server" },
    })
    expect(r.claimed.map((w) => w.id)).toEqual(["remote-ok"])
  })

  it("sendHandler falls back to mesh forwardChannelSend when channel is non-local", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    store.save(baseWorkflow({
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "reply", type: "action.send", config: { channel: "remote-wa", chatId: "21624000000", text: "hi" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "trigger", to: "reply" }, { from: "reply", to: "done" }],
    }))
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const forwarded: any[] = []
    const dispatcher = new WorkflowDispatcher({
      store, runs, nodeId: "node-a",
      channels: {}, // no local channel
      agents: { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) },
      forwarder: {
        forwardTransition: async () => {},
        forwardChannelSend: async (p) => { forwarded.push(p); return { messageId: "remote-msg-1" } },
      },
    })

    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-fwd" },
      event: { id: "evt-fwd", payload: {} },
    })
    await new Promise((r) => setTimeout(r, 30))

    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]).toMatchObject({ channel: "remote-wa", chatId: "21624000000", text: "hi" })
    const final = runs.list()[0]
    expect(final.status).toBe("completed")
    const replyEntry = final.history.find((h) => h.nodeId === "reply")
    expect(replyEntry?.output).toMatchObject({ messageId: "remote-msg-1", viaMesh: true })
  })

  it("reports claimed workflows so the router can skip its default reply", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    store.save(baseWorkflow({
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "reply", type: "action.send", config: { channel: "fake", chatId: "c1", text: "hi" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [
        { from: "trigger", to: "reply" },
        { from: "reply", to: "done" },
      ],
    }))
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const channels = { fake: { send: async () => "m" } }
    const agents = { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) }
    const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels, agents })

    const result = await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-claim" },
      event: { id: "evt-1", payload: { text: "hi" } },
    })
    expect(result.claimed).toHaveLength(1)
    expect(result.claimed[0].id).toBe("test-wf")
    expect(result.runs).toHaveLength(1)
  })

  it("does not claim when trigger filter doesn't match", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    store.save(baseWorkflow())
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const dispatcher = new WorkflowDispatcher({
      store, runs, nodeId: "node-a",
      channels: {},
      agents: { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) },
    })
    const result = await dispatcher.dispatch({
      trigger: { source: "nope-not-a-source" },
      entityRef: { backend: "manual", id: "e-x" },
      event: { id: "evt-1", payload: {} },
    })
    expect(result.claimed).toHaveLength(0)
    expect(result.runs).toHaveLength(0)
  })
})

describe("WorkflowStore", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it("writes + reads V2 workflows", () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    const wf = baseWorkflow()
    store.save(wf)
    const got = store.get(wf.id)
    expect(got?.id).toBe(wf.id)
    expect(got?.version).toBe(2)
    expect(got?.nodes).toHaveLength(6)
  })

  it("validateAll reports lint issues", () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    // Write a workflow with an unreachable node by bypassing save()
    const bad = baseWorkflow({
      nodes: [
        ...baseWorkflow().nodes,
        { id: "orphan", type: "end", config: {} },
      ],
    })
    writeFileSync(resolve(TEST_DIR, `${bad.id}.json`), JSON.stringify(bad, null, 2))
    const results = store.validateAll()
    expect(results[0].isValid).toBe(false)
    expect(results[0].issues.some((i) => i.includes("unreachable"))).toBe(true)
  })
})

describe("example workflow: whatsapp-client-support", () => {
  it("parses + lints cleanly", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wf = require("../examples/workflows/whatsapp-client-support.json")
    const parsed = workflowSchema.safeParse(wf)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const issues = lintWorkflow(parsed.data)
      expect(issues).toEqual([])
    }
  })
})

// --- Phase 2: checkpoint pause/resume + label verbs + transform -----------

describe("Phase 2: transform node", () => {
  it("resolves a dotted path into { value }", async () => {
    const handler = resolveHandler("transform")!
    const result = await handler({
      workflow: baseWorkflow(),
      run: {
        id: "r", workflowId: "w", workflowVersion: 2 as const, homeNode: "n", status: "running",
        context: { upstream: { nested: { greeting: "hi" } } }, pending: [], history: [],
        entityRef: { backend: "manual", id: "e" }, createdAt: "", updatedAt: "",
      },
      node: { id: "t", type: "transform", config: { path: "upstream.nested.greeting" } },
      channels: {}, agents: { execute: async () => ({ content: "" }) }, log: () => {},
    })
    expect(result.output).toEqual({ value: "hi" })
  })

  it("renders a template object against context", async () => {
    const handler = resolveHandler("transform")!
    const result = await handler({
      workflow: baseWorkflow(),
      run: {
        id: "r", workflowId: "w", workflowVersion: 2 as const, homeNode: "n", status: "running",
        context: { trigger: { sender: { name: "Alice" } } }, pending: [], history: [],
        entityRef: { backend: "manual", id: "e" }, createdAt: "", updatedAt: "",
      },
      node: { id: "t", type: "transform", config: { template: { greeting: "hello {{trigger.sender.name}}" } } },
      channels: {}, agents: { execute: async () => ({ content: "" }) }, log: () => {},
    })
    expect(result.output).toEqual({ greeting: "hello Alice" })
  })
})

describe("Phase 2: action.setLabel + action.readLabel", () => {
  it("calls adapter.setLabels with rendered params + agent id", async () => {
    const calls: Array<{ project: string; iid: string; add: string[]; remove: string[]; agentId?: string }> = []
    const channels = {
      gitlab: {
        setLabels: async (a: { project: string; kind?: string; iid: string; add?: string[]; remove?: string[]; agentId?: string }) => {
          calls.push({ project: a.project, iid: a.iid, add: a.add ?? [], remove: a.remove ?? [], agentId: a.agentId })
          return [...(a.add ?? [])]
        },
      },
    }
    const handler = resolveHandler("action.setLabel")!
    const result = await handler({
      workflow: baseWorkflow({ envAllow: [] }),
      run: {
        id: "r", workflowId: "w", workflowVersion: 2 as const, homeNode: "n", status: "running",
        context: { trigger: { project: "noqta/web", issue: { iid: "42" } } }, pending: [], history: [],
        entityRef: { backend: "gitlab", id: "noqta/web#42" }, createdAt: "", updatedAt: "",
      },
      node: {
        id: "label-it", type: "action.setLabel",
        config: { channel: "gitlab", project: "{{trigger.project}}", iid: "{{trigger.issue.iid}}", add: ["Triage"], remove: ["New"] },
      },
      channels, agents: { execute: async () => ({ content: "" }) }, log: () => {},
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ project: "noqta/web", iid: "42", add: ["Triage"], remove: ["New"], agentId: undefined })
    expect(result.output).toEqual({ labels: ["Triage"], add: ["Triage"], remove: ["New"] })
  })

  it("action.readLabel exposes { labels: [...] }", async () => {
    const channels = {
      gitlab: { getLabels: async () => ["Triage", "bug"] },
    }
    const handler = resolveHandler("action.readLabel")!
    const result = await handler({
      workflow: baseWorkflow(),
      run: {
        id: "r", workflowId: "w", workflowVersion: 2 as const, homeNode: "n", status: "running",
        context: {}, pending: [], history: [],
        entityRef: { backend: "gitlab", id: "noqta/web#42" }, createdAt: "", updatedAt: "",
      },
      node: {
        id: "read-it", type: "action.readLabel",
        config: { channel: "gitlab", project: "noqta/web", iid: "42" },
      },
      channels, agents: { execute: async () => ({ content: "" }) }, log: () => {},
    })
    expect(result.output).toEqual({ labels: ["Triage", "bug"] })
  })
})

describe("Phase 3: action.react / editMessage / logTime / callHTTP", () => {
  const baseCtx = (config: Record<string, unknown>, channels: Record<string, unknown>, nodeType: string) => ({
    workflow: baseWorkflow({ envAllow: [] }),
    run: {
      id: "r", workflowId: "w", workflowVersion: 2 as const, homeNode: "n", status: "running" as const,
      context: { trigger: { chatId: "c1", messageId: "m1" } }, pending: [], history: [],
      entityRef: { backend: "manual", id: "e" }, createdAt: "", updatedAt: "",
    },
    node: { id: "act", type: nodeType as any, config },
    channels,
    agents: { execute: async () => ({ content: "" }) },
    log: () => {},
  })

  it("action.react calls adapter.react with chatId/messageId/emoji", async () => {
    const calls: Array<{ chatId: string; messageId: string; emoji: string }> = []
    const channels = {
      fake: { react: async (chatId: string, messageId: string, emoji?: string) => { calls.push({ chatId, messageId, emoji: emoji ?? "" }) } },
    }
    const handler = resolveHandler("action.react")!
    const r = await handler(baseCtx({ channel: "fake", chatId: "{{trigger.chatId}}", messageId: "{{trigger.messageId}}", emoji: "✅" }, channels, "action.react"))
    expect(calls).toEqual([{ chatId: "c1", messageId: "m1", emoji: "✅" }])
    expect(r.output).toEqual({ emoji: "✅" })
  })

  it("action.editMessage calls adapter.editMessage and returns { edited }", async () => {
    const channels = { fake: { editMessage: async () => true } }
    const handler = resolveHandler("action.editMessage")!
    const r = await handler(baseCtx({ channel: "fake", chatId: "c1", messageId: "m1", text: "updated" }, channels, "action.editMessage"))
    expect(r.output).toEqual({ edited: true })
  })

  it("action.logTime passes durationMs + resolved agentId to adapter", async () => {
    const calls: Array<{ chatId: string; durationMs: number; agentId?: string }> = []
    const channels = {
      gitlab: { logTimeSpent: async (chatId: string, durationMs: number, agentId?: string) => { calls.push({ chatId, durationMs, agentId }) } },
    }
    const handler = resolveHandler("action.logTime")!
    const r = await handler(baseCtx({ channel: "gitlab", chatId: "proj:issue:42", durationMs: 900000 }, channels, "action.logTime"))
    expect(calls).toEqual([{ chatId: "proj:issue:42", durationMs: 900000, agentId: undefined }])
    expect(r.output).toEqual({ durationMs: 900000 })
  })

  it("action.callHTTP fetches, parses JSON, exposes { ok, status, body }", async () => {
    // Patch globalThis.fetch in-place for the test.
    const originalFetch = global.fetch
    const fetchCalls: Array<{ url: string; method?: string; body?: unknown }> = []
    global.fetch = (async (url: string, init: any) => {
      fetchCalls.push({ url, method: init?.method, body: init?.body })
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ issue: 42 }),
      }
    }) as any
    try {
      const handler = resolveHandler("action.callHTTP")!
      const r = await handler(baseCtx({ url: "https://example.com/hook", method: "POST", body: { x: 1 } }, {}, "action.callHTTP"))
      expect(fetchCalls[0].url).toBe("https://example.com/hook")
      expect(r.output).toEqual({ ok: true, status: 201, body: { issue: 42 } })
    } finally {
      global.fetch = originalFetch
    }
  })
})

describe("Phase 3: trigger wiring helpers", () => {
  // Unit test the handler map — trigger.cron/hook/manual all route to the
  // passthrough handler (the real firing is scheduler-driven).
  it("trigger.cron, trigger.hook, trigger.manual all register", () => {
    expect(resolveHandler("trigger.cron")).toBeDefined()
    expect(resolveHandler("trigger.hook")).toBeDefined()
    expect(resolveHandler("trigger.manual")).toBeDefined()
    expect(resolveHandler("trigger.channel")).toBeDefined()
  })
})

describe("Phase 2: checkpoint pause + resume", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it("pauses on checkpoint and resumes on the next event", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    const wf = store.save(workflowSchema.parse({
      id: "pause-demo",
      version: 2,
      title: "pause demo",
      priority: 0,
      fanOut: false,
      envAllow: [],
      retention: { maxRuns: 10, maxDays: 10 },
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "first",   type: "action.send", config: { channel: "fake", chatId: "c", text: "hello" } },
        { id: "wait",    type: "checkpoint", config: { name: "await-reply", resumeMatch: {} } },
        { id: "after",   type: "action.send", config: { channel: "fake", chatId: "c", text: "goodbye {{wait.event.text}}" } },
        { id: "done",    type: "end", config: {} },
      ],
      edges: [
        { from: "trigger", to: "first" },
        { from: "first", to: "wait" },
        { from: "wait", to: "after" },
        { from: "after", to: "done" },
      ],
    }))
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const sends: Array<{ text: string }> = []
    const channels = { fake: { send: async (m: { text: string }) => { sends.push(m); return "mid" } } }
    const agents = { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) }
    const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels, agents })

    // First event — should run through "first" + pause at "wait".
    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-pause" },
      event: { id: "evt-1", payload: { text: "opening" } },
    })
    await new Promise((r) => setTimeout(r, 30))
    let paused = runs.list({ workflowId: wf.id })[0]
    expect(paused.status).toBe("paused")
    expect(paused.pausedAt?.nodeId).toBe("wait")
    expect(sends).toHaveLength(1)

    // Second event for the same entity — should resume and fire "after".
    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-pause" },
      event: { id: "evt-2", payload: { text: "world" } },
    })
    await new Promise((r) => setTimeout(r, 30))
    const final = runs.list({ workflowId: wf.id })[0]
    expect(final.status).toBe("completed")
    expect(sends).toHaveLength(2)
    expect(sends[1].text).toBe("goodbye world")
  })
})

// ---------------- Phase 1 BPM: userTask + subProcess + forms ----------------

describe("BPM: userTask pause + submit resume", () => {
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it("pauses on userTask, persists a task record, resumes on submission", async () => {
    const { ActorStore } = await import("../src/actors/store")
    const { TaskStore } = await import("../src/workflows/task-store")
    const actors = new ActorStore({ baseDir: TEST_DIR })
    actors.saveActor({
      id: "actor:alice", name: "Alice",
      channels: [{ channel: "telegram", handle: "42", preferredForTasks: true }],
    } as any)

    const tasks = new TaskStore({ baseDir: resolve(TEST_DIR, "workflows") })
    const store = new WorkflowStore({ baseDir: resolve(TEST_DIR, "workflows") })
    const wf = store.save(workflowSchema.parse({
      id: "ut-demo",
      version: 2, title: "userTask demo", priority: 0, fanOut: false,
      envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "review",  type: "userTask", config: {
          assignTo: "actor:alice",
          title: "Review please",
          form: { title: "Review", fields: [
            { key: "score", label: "Score", type: "number", required: true, validate: { min: 0, max: 10 } },
            { key: "note",  label: "Note",  type: "long-text" },
          ], submitLabel: "Approve", secondaryAction: { key: "reject", label: "Reject" } },
        } },
        { id: "after",   type: "action.send", config: { channel: "fake", chatId: "c", text: "decided: {{review.action}} score={{review.values.score}}" } },
        { id: "done",    type: "end", config: {} },
      ],
      edges: [
        { from: "trigger", to: "review" },
        { from: "review",  to: "after" },
        { from: "after",   to: "done" },
      ],
    }))
    const runs = new RunStore({ baseDir: resolve(TEST_DIR, "workflows"), nodeId: "node-a" })
    const sends: Array<{ text: string }> = []
    const channels = { fake: { send: async (m: { text: string }) => { sends.push(m); return "m1" } } }
    const agents = { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) }
    const rendered: string[] = []
    const dispatcher = new WorkflowDispatcher({
      store, runs, nodeId: "node-a", channels, agents,
      actors, tasks,
      renderUserTask: async (t) => { rendered.push(t.id) },
    })

    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-ut" },
      event: { id: "evt-1", payload: { text: "go" } },
    })
    await new Promise((r) => setTimeout(r, 30))

    let paused = runs.list({ workflowId: wf.id })[0]
    expect(paused.status).toBe("paused")
    expect(paused.pausedAt?.kind).toBe("userTask")
    const openTasks = tasks.listOpen()
    expect(openTasks).toHaveLength(1)
    expect(openTasks[0].assignedTo).toEqual(["actor:alice"])
    expect(rendered).toEqual([openTasks[0].id])

    // Missing required field → rejected
    let bad = await dispatcher.submitTask(openTasks[0].id, { action: "primary", values: {} }, "actor:alice")
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.fieldErrors?.[0]?.field).toBe("score")

    // Valid submission → run resumes and completes.
    const good = await dispatcher.submitTask(openTasks[0].id, { action: "primary", values: { score: "8", note: "lgtm" } }, "actor:alice")
    expect(good.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    const final = runs.list({ workflowId: wf.id })[0]
    expect(final.status).toBe("completed")
    expect(sends).toHaveLength(1)
    expect(sends[0].text).toContain("decided: primary score=8")
    expect(tasks.listOpen()).toHaveLength(0)
  })

  it("resolves a role to its members and picks via assignmentStrategy", async () => {
    const { ActorStore } = await import("../src/actors/store")
    const actors = new ActorStore({ baseDir: TEST_DIR })
    actors.saveActor({ id: "actor:a", name: "A", channels: [{ channel: "telegram", handle: "1" }] } as any)
    actors.saveActor({ id: "actor:b", name: "B", channels: [{ channel: "telegram", handle: "2" }] } as any)
    actors.saveRole({ id: "role:reviewers", name: "Reviewers", members: [{ actor: "actor:a" }, { actor: "actor:b" }], assignmentStrategy: "all", rotationCursor: 0 } as any)
    expect(actors.pickAssignees({ kind: "role", id: "role:reviewers" })).toEqual(["actor:a", "actor:b"])

    actors.saveRole({ id: "role:reviewers", name: "Reviewers", members: [{ actor: "actor:a" }, { actor: "actor:b" }], assignmentStrategy: "first-available", rotationCursor: 0 } as any)
    expect(actors.pickAssignees({ kind: "role", id: "role:reviewers" })).toEqual(["actor:a"])
  })
})

describe("BPM: subProcess (nested workflows + depth cap)", () => {
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it("parent pauses, child runs, parent resumes on child end", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    store.save(workflowSchema.parse({
      id: "child-wf", version: 2, title: "child", priority: 0, fanOut: false,
      envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
      nodes: [
        { id: "trigger", type: "trigger.manual", config: {} },
        { id: "greet",   type: "action.send", config: { channel: "fake", chatId: "c", text: "child saw {{trigger.nick}}" } },
        { id: "done",    type: "end", config: {} },
      ],
      edges: [
        { from: "trigger", to: "greet" },
        { from: "greet", to: "done" },
      ],
    }))
    const parentWf = store.save(workflowSchema.parse({
      id: "parent-wf", version: 2, title: "parent", priority: 0, fanOut: false,
      envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
      nodes: [
        { id: "trigger",  type: "trigger.channel", config: { source: "manual" } },
        { id: "call",     type: "subProcess", config: {
          workflowId: "child-wf",
          inputMap: { trigger: { nick: "{{trigger.name}}" } },
          awaitCompletion: true,
        } },
        { id: "finish",   type: "action.send", config: { channel: "fake", chatId: "c", text: "parent done, child said {{call.output.messageId}}" } },
        { id: "done",     type: "end", config: {} },
      ],
      edges: [
        { from: "trigger", to: "call" },
        { from: "call",    to: "finish" },
        { from: "finish",  to: "done" },
      ],
    }))
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const sends: Array<{ text: string }> = []
    const channels = { fake: { send: async (m: { text: string }) => { sends.push(m); return "m-child" } } }
    const agents = { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) }
    const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels, agents })

    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-sp" },
      event: { id: "evt-1", payload: { name: "Alice" } },
    })
    // Give the dispatcher time for both parent pause + child walk + parent
    // resume + parent walk to complete.
    await new Promise((r) => setTimeout(r, 80))

    const all = runs.list()
    const parent = all.find((r) => r.workflowId === "parent-wf")!
    const child  = all.find((r) => r.workflowId === "child-wf")!
    expect(child.status).toBe("completed")
    expect(child.parentRunId).toBe(parent.id)
    expect(child.depth).toBe(1)
    expect(parent.status).toBe("completed")
    // Child saw the mapped input via {{trigger.nick}}.
    expect(sends[0].text).toBe("child saw Alice")
    // Parent saw the child's output bundle on the subProcess node.
    expect(sends[1].text).toContain("child said")
  })

  it("rejects child spawn when max depth is exceeded", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    // child-A calls child-B which has maxChildDepth=2 → child-B at depth 1
    // spawning child-B again (self) would be depth 2, which equals the cap,
    // so the spawn is refused.
    store.save(workflowSchema.parse({
      id: "recursive-wf", version: 2, title: "recursive", priority: 0, fanOut: false,
      envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
      maxChildDepth: 2,
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "recurse", type: "subProcess", config: { workflowId: "recursive-wf", awaitCompletion: true } },
        { id: "done",    type: "end", config: {} },
      ],
      edges: [
        { from: "trigger", to: "recurse" },
        { from: "recurse", to: "done" },
      ],
    }))
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const channels = {}
    const agents = { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) }
    const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels, agents })

    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-rec" },
      event: { id: "evt-1", payload: {} },
    })
    await new Promise((r) => setTimeout(r, 80))

    // Root run spawns level-1 child, which attempts level-2 child but
    // depth 1 + 1 = 2 === cap, so level-1 fails with the cap error.
    const all = runs.list({ workflowId: "recursive-wf" })
    const depth0 = all.find((r) => r.depth === 0)!
    const depth1 = all.find((r) => r.depth === 1)
    expect(depth1).toBeDefined()
    expect(depth1!.status).toBe("failed")
    const noteMatches = depth1!.history.some((h) => h.status === "failed" && (h.note ?? "").includes("max child workflow depth"))
    expect(noteMatches).toBe(true)
    // Root run is still paused waiting on the failed child; the resume on
    // failure is a Phase-2 refinement. For now we just verify the cap
    // enforcement fires and does not silently go deeper.
    expect(depth0.status).toBe("paused")
  })
})

describe("BPM: form validator", () => {
  it("coerces, validates, and reports per-field errors", async () => {
    const { validateSubmission } = await import("../src/forms/validator")
    const schema = {
      id: "f1", title: "f1",
      fields: [
        { key: "n", label: "Number", type: "number", required: true, validate: { min: 1, max: 10 }, defaultValue: undefined },
        { key: "e", label: "Email",  type: "text", required: true, validate: { pattern: "^[^@]+@[^@]+$" } },
      ],
      submitLabel: "Go",
    } as any
    const bad = validateSubmission(schema, { action: "primary", values: { n: "nope", e: "bad" } })
    expect(bad.ok).toBe(false)
    const fields = bad.errors.map((e) => e.field).sort()
    expect(fields).toEqual(["e", "n"])

    const good = validateSubmission(schema, { action: "primary", values: { n: "5", e: "a@b" } })
    expect(good.ok).toBe(true)
    expect(good.values).toEqual({ n: 5, e: "a@b" })
  })
})

describe("BPM Phase 2: gateway.parallel (fanOut + join)", () => {
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it("fires the join node exactly once after every upstream arrives", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    store.save(workflowSchema.parse({
      id: "parallel-demo", version: 2, title: "parallel", priority: 0, fanOut: false,
      envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "fan",     type: "gateway.parallel", config: { mode: "fanOut" } },
        { id: "a",       type: "action.send", config: { channel: "fake", chatId: "c", text: "branch a" } },
        { id: "b",       type: "action.send", config: { channel: "fake", chatId: "c", text: "branch b" } },
        { id: "c",       type: "action.send", config: { channel: "fake", chatId: "c", text: "branch c" } },
        { id: "join",    type: "gateway.parallel", config: { mode: "join" } },
        { id: "after",   type: "action.send", config: { channel: "fake", chatId: "c", text: "joined" } },
        { id: "done",    type: "end", config: {} },
      ],
      edges: [
        { from: "trigger", to: "fan" },
        { from: "fan", to: "a" },
        { from: "fan", to: "b" },
        { from: "fan", to: "c" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "c", to: "join" },
        { from: "join", to: "after" },
        { from: "after", to: "done" },
      ],
    }))
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const sends: Array<{ text: string }> = []
    const channels = { fake: { send: async (m: { text: string }) => { sends.push(m); return "m" } } }
    const agents = { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) }
    const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels, agents })

    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-par" },
      event: { id: "evt-1", payload: {} },
    })
    await new Promise((r) => setTimeout(r, 80))

    const final = runs.list()[0]
    expect(final.status).toBe("completed")
    const byNode = final.history.map((h) => h.nodeId)
    // All three branches + one join + one after + one end.
    expect(byNode.filter((n) => n === "a")).toHaveLength(1)
    expect(byNode.filter((n) => n === "b")).toHaveLength(1)
    expect(byNode.filter((n) => n === "c")).toHaveLength(1)
    expect(byNode.filter((n) => n === "join")).toHaveLength(1)
    expect(byNode.filter((n) => n === "after")).toHaveLength(1)
    expect(sends.map((s) => s.text).sort()).toEqual(["branch a", "branch b", "branch c", "joined"].sort())
  })
})

describe("BPM Phase 2: timer service + signal bus", () => {
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it("timer.boundary pauses the run and resumes when the timer fires", async () => {
    const { TimerService } = await import("../src/workflows/timers")
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    store.save(workflowSchema.parse({
      id: "timer-demo", version: 2, title: "timer", priority: 0, fanOut: false,
      envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "before",  type: "action.send", config: { channel: "fake", chatId: "c", text: "before" } },
        { id: "wait",    type: "timer.boundary", config: { after: "PT1S" } },
        { id: "after",   type: "action.send", config: { channel: "fake", chatId: "c", text: "after fired at {{wait.firedAt}}" } },
        { id: "done",    type: "end", config: {} },
      ],
      edges: [
        { from: "trigger", to: "before" },
        { from: "before",  to: "wait" },
        { from: "wait",    to: "after" },
        { from: "after",   to: "done" },
      ],
    }))
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const sends: Array<{ text: string }> = []
    const channels = { fake: { send: async (m: { text: string }) => { sends.push(m); return "m" } } }
    const agents = { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) }
    const timers = new TimerService({ baseDir: resolve(TEST_DIR, "_timer-base"), tickIntervalMs: 50 })
    const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels, agents, timers })
    timers.start()

    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-tm" },
      event: { id: "evt-1", payload: {} },
    })
    await new Promise((r) => setTimeout(r, 60))
    // After the initial walk we should be paused on the timer.
    let snap = runs.list()[0]
    expect(snap.status).toBe("paused")
    expect(snap.pausedAt?.kind).toBe("timerWait")

    // Wait for the tick loop to fire and resume.
    await new Promise((r) => setTimeout(r, 1500))
    timers.stop()

    const final = runs.list()[0]
    expect(final.status).toBe("completed")
    expect(sends).toHaveLength(2)
    expect(sends[1].text).toContain("after fired at")
  })

  it("signal.emit resumes a matching signal.wait in the same workflow", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    store.save(workflowSchema.parse({
      id: "signal-demo", version: 2, title: "signal", priority: 0, fanOut: false,
      envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "wait",    type: "signal.wait", config: { name: "approved", scope: "workflow" } },
        { id: "ok",      type: "action.send", config: { channel: "fake", chatId: "c", text: "got signal {{wait.name}}" } },
        { id: "done",    type: "end", config: {} },
      ],
      edges: [
        { from: "trigger", to: "wait" },
        { from: "wait",    to: "ok" },
        { from: "ok",      to: "done" },
      ],
    }))
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const sends: Array<{ text: string }> = []
    const channels = { fake: { send: async (m: { text: string }) => { sends.push(m); return "m" } } }
    const agents = { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) }
    const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels, agents })

    await dispatcher.dispatch({
      trigger: { source: "manual" },
      entityRef: { backend: "manual", id: "e-sig" },
      event: { id: "evt-1", payload: {} },
    })
    await new Promise((r) => setTimeout(r, 40))
    let paused = runs.list()[0]
    expect(paused.status).toBe("paused")
    expect(paused.pausedAt?.kind).toBe("signalWait")

    // Emit the signal — should fire resume.
    dispatcher.emitSignal({ name: "approved", scope: "workflow", workflowId: "signal-demo" })
    await new Promise((r) => setTimeout(r, 40))

    const final = runs.list()[0]
    expect(final.status).toBe("completed")
    expect(sends[0].text).toBe("got signal approved")
  })

  it("signal.wait in scope=workflow ignores signals from other workflows", async () => {
    const { SignalBus, matchesSignal } = await import("../src/workflows/signals")
    const ok = matchesSignal(
      { name: "x", scope: "workflow", workflowId: "a", match: {} },
      { name: "x", scope: "workflow", workflowId: "a", payload: {}, emittedAt: "t" },
    )
    expect(ok).toBe(true)
    const cross = matchesSignal(
      { name: "x", scope: "workflow", workflowId: "a", match: {} },
      { name: "x", scope: "workflow", workflowId: "b", payload: {}, emittedAt: "t" },
    )
    expect(cross).toBe(false)
    const global = matchesSignal(
      { name: "x", scope: "global", workflowId: "a", match: {} },
      { name: "x", scope: "global", workflowId: "b", payload: {}, emittedAt: "t" },
    )
    expect(global).toBe(true)
    // Sanity: unused import usage.
    expect(typeof SignalBus).toBe("function")
  })
})

describe("BPM: example workflow parses + lints", () => {
  it("grant-application.json is a valid V2 workflow", () => {
    const raw = JSON.parse(require("fs").readFileSync(resolve(__dirname, "../examples/workflows/grant-application.json"), "utf-8"))
    const parsed = workflowSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(lintWorkflow(parsed.data)).toEqual([])
  })

  it("grant-closure-letter.json is a valid V2 workflow", () => {
    const raw = JSON.parse(require("fs").readFileSync(resolve(__dirname, "../examples/workflows/grant-closure-letter.json"), "utf-8"))
    const parsed = workflowSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(lintWorkflow(parsed.data)).toEqual([])
  })
})

// ---------------- Phase 3: KPIs + renderers + CLI primitives ----------------

describe("BPM Phase 3: KPI aggregation", () => {
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it("computes per-actor open count, avg duration, and SLA breach rate", async () => {
    const { TaskStore, computeKpis } = await import("../src/workflows/task-store")
    const tasks = new TaskStore({ baseDir: resolve(TEST_DIR, "wf") })
    // Open task assigned to alice.
    tasks.create({
      runId: "r1", workflowId: "wf", nodeId: "n1", title: "t1",
      assignee: "actor:alice", assignedTo: ["actor:alice"],
      form: { title: "f", fields: [], submitLabel: "ok" } as any,
    })
    // Archived + completed task submitted by alice 60s after creation; on time.
    const completedOnTime = tasks.create({
      runId: "r2", workflowId: "wf", nodeId: "n1", title: "t2",
      assignee: "actor:alice", assignedTo: ["actor:alice"],
      form: { title: "f", fields: [], submitLabel: "ok" } as any,
      dueAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    const createdAt1 = new Date(Date.parse(completedOnTime.createdAt) - 60_000).toISOString()
    tasks.save({
      ...completedOnTime,
      createdAt: createdAt1,
      status: "completed",
      submittedBy: "actor:alice",
      submittedAt: new Date().toISOString(),
    })
    // Archived + completed task that breached SLA (submittedAt > dueAt).
    const late = tasks.create({
      runId: "r3", workflowId: "wf", nodeId: "n1", title: "t3",
      assignee: "actor:alice", assignedTo: ["actor:alice"],
      form: { title: "f", fields: [], submitLabel: "ok" } as any,
      dueAt: new Date(Date.now() - 120_000).toISOString(),
    })
    tasks.save({
      ...late,
      createdAt: new Date(Date.now() - 300_000).toISOString(),
      status: "completed",
      submittedBy: "actor:alice",
      submittedAt: new Date().toISOString(),
    })

    const kpis = computeKpis(tasks)
    const alice = kpis.byActor.find((k) => k.actorId === "actor:alice")!
    expect(alice).toBeDefined()
    expect(alice.openTasks).toBe(1)
    expect(alice.completedTasks).toBe(2)
    expect(alice.avgDurationMs).toBeGreaterThan(0)
    expect(alice.breachedCount).toBe(1)
    expect(alice.slaBreachRate).toBeCloseTo(0.5, 2)
    expect(kpis.totals.openTasks).toBe(1)
    expect(kpis.totals.completedTasks).toBe(2)
  })
})

describe("BPM Phase 3: renderers", () => {
  it("Telegram renderer picks one-click buttons when form is approve/reject-shaped", async () => {
    const { ActorStore } = await import("../src/actors/store")
    const { TaskStore } = await import("../src/workflows/task-store")
    const { createTelegramTaskRenderer } = await import("../src/forms/renderers/telegram")
    rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true })
    const actors = new ActorStore({ baseDir: TEST_DIR })
    actors.saveActor({ id: "actor:alice", name: "Alice", channels: [{ channel: "telegram", handle: "42" }] } as any)
    const tasks = new TaskStore({ baseDir: resolve(TEST_DIR, "wf") })
    const task = tasks.create({
      runId: "r", workflowId: "w", nodeId: "n", title: "Approve invoice",
      assignee: "actor:alice", assignedTo: ["actor:alice"],
      form: {
        title: "f",
        fields: [],
        submitLabel: "Approve",
        secondaryAction: { key: "reject", label: "Reject" },
      } as any,
    })
    const sends: Array<{ kind: string; text: string; buttons?: any }> = []
    const render = createTelegramTaskRenderer({
      actors, tasks,
      inboxBaseUrl: "https://example.test",
      adapter: {
        sendMessage: async (m) => { sends.push({ kind: "text", text: m.text }); return "mid-1" },
        sendWithInlineButtons: async (a) => { sends.push({ kind: "buttons", text: a.text, buttons: a.buttons }); return "mid-2" },
      },
    })
    await render(task)
    expect(sends).toHaveLength(1)
    expect(sends[0].kind).toBe("buttons")
    expect(sends[0].buttons?.[0].url).toContain("/t/" + task.id + "/primary")
    expect(sends[0].buttons?.[1].url).toContain("/t/" + task.id + "/secondary")
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it("Telegram renderer falls back to plain text + inbox link for forms with required fields", async () => {
    const { ActorStore } = await import("../src/actors/store")
    const { TaskStore } = await import("../src/workflows/task-store")
    const { createTelegramTaskRenderer } = await import("../src/forms/renderers/telegram")
    rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true })
    const actors = new ActorStore({ baseDir: TEST_DIR })
    actors.saveActor({ id: "actor:bob", name: "Bob", channels: [{ channel: "telegram", handle: "9" }] } as any)
    const tasks = new TaskStore({ baseDir: resolve(TEST_DIR, "wf") })
    const task = tasks.create({
      runId: "r", workflowId: "w", nodeId: "n", title: "Score application",
      assignee: "actor:bob", assignedTo: ["actor:bob"],
      form: {
        title: "f",
        fields: [{ key: "score", label: "Score", type: "number", required: true } as any],
        submitLabel: "Submit",
      } as any,
    })
    const sends: Array<{ kind: string; text: string }> = []
    const render = createTelegramTaskRenderer({
      actors, tasks,
      inboxBaseUrl: "https://example.test",
      adapter: {
        sendMessage: async (m) => { sends.push({ kind: "text", text: m.text }); return "m" },
        sendWithInlineButtons: async () => "b",
      },
    })
    await render(task)
    expect(sends[0].kind).toBe("text")
    expect(sends[0].text).toContain("/inbox?actor=actor%3Abob")
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it("WhatsApp renderer emits one-click URL lines for approve/reject forms", async () => {
    const { ActorStore } = await import("../src/actors/store")
    const { TaskStore } = await import("../src/workflows/task-store")
    const { createWhatsappTaskRenderer } = await import("../src/forms/renderers/whatsapp")
    rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true })
    const actors = new ActorStore({ baseDir: TEST_DIR })
    actors.saveActor({ id: "actor:carol", name: "Carol", channels: [{ channel: "whatsapp", handle: "21698111111" }] } as any)
    const tasks = new TaskStore({ baseDir: resolve(TEST_DIR, "wf") })
    const task = tasks.create({
      runId: "r", workflowId: "w", nodeId: "n", title: "Release hotfix?",
      assignee: "actor:carol", assignedTo: ["actor:carol"],
      form: { title: "f", fields: [], submitLabel: "Ship", secondaryAction: { key: "hold", label: "Hold" } } as any,
    })
    const texts: string[] = []
    const render = createWhatsappTaskRenderer({
      actors, tasks,
      inboxBaseUrl: "https://ex.test",
      adapter: { send: async (m) => { texts.push(m.text); return "m" } },
    })
    await render(task)
    expect(texts[0]).toContain("https://ex.test/t/" + task.id + "/primary?actor=")
    expect(texts[0]).toContain("https://ex.test/t/" + task.id + "/secondary?actor=")
    rmSync(TEST_DIR, { recursive: true, force: true })
  })
})

describe("BPM Phase 3: ActorStore CLI primitives", () => {
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it("round-trips an actor + role through the store and resolves members", async () => {
    const { ActorStore } = await import("../src/actors/store")
    const store = new ActorStore({ baseDir: TEST_DIR })
    store.saveActor({ id: "actor:ann", name: "Ann", channels: [{ channel: "telegram", handle: "100" }] } as any)
    store.saveActor({ id: "actor:ben", name: "Ben", channels: [{ channel: "email", handle: "ben@x.test" }] } as any)
    store.saveRole({ id: "role:team", name: "Team", members: [{ actor: "actor:ann" }, { actor: "actor:ben" }], assignmentStrategy: "all", rotationCursor: 0 } as any)
    const members = store.resolveMembers({ kind: "role", id: "role:team" })
    expect(members.sort()).toEqual(["actor:ann", "actor:ben"])
    expect(store.channelFor("actor:ann", "telegram")).toBe("100")
    expect(store.channelFor("actor:ben", "email")).toBe("ben@x.test")
    // Round-robin updates the rotation cursor.
    store.saveRole({ id: "role:rr", name: "RR", members: [{ actor: "actor:ann" }, { actor: "actor:ben" }], assignmentStrategy: "round-robin", rotationCursor: 0 } as any)
    const picks = [
      store.pickAssignees({ kind: "role", id: "role:rr" })[0],
      store.pickAssignees({ kind: "role", id: "role:rr" })[0],
      store.pickAssignees({ kind: "role", id: "role:rr" })[0],
    ]
    expect(picks).toEqual(["actor:ann", "actor:ben", "actor:ann"])
  })
})

// ---------------- Phase 4: DMN rule node + Slack renderer ----------------

describe("BPM Phase 4: DMN rule node", () => {
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  it("first matching row selects the port; default fires when none match", async () => {
    const store = new WorkflowStore({ baseDir: TEST_DIR })
    store.save(workflowSchema.parse({
      id: "rule-demo", version: 2, title: "rule", priority: 0, fanOut: false,
      envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "classify", type: "rule", config: {
          inputs: ["{{trigger.tier}}", "{{trigger.amount}}"],
          rules: [
            { when: ["gold", ">100"], to: "vip",  output: { route: "vip" } },
            { when: ["*", ">50"],     to: "high", output: { route: "high" } },
          ],
          default: { to: "low", output: { route: "low" } },
        }},
        { id: "vip",  type: "action.send", config: { channel: "fake", chatId: "c", text: "VIP {{classify.route}}" } },
        { id: "high", type: "action.send", config: { channel: "fake", chatId: "c", text: "HIGH {{classify.route}}" } },
        { id: "low",  type: "action.send", config: { channel: "fake", chatId: "c", text: "LOW {{classify.route}}" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [
        { from: "trigger", to: "classify" },
        { from: "classify", fromPort: "vip",  to: "vip" },
        { from: "classify", fromPort: "high", to: "high" },
        { from: "classify", fromPort: "low",  to: "low" },
        { from: "vip",  to: "done" },
        { from: "high", to: "done" },
        { from: "low",  to: "done" },
      ],
    }))
    const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
    const sends: Array<{ text: string }> = []
    const channels = { fake: { send: async (m: { text: string }) => { sends.push(m); return "m" } } }
    const agents = { execute: async (): Promise<AgentExecuteResponse> => ({ content: "" }) }
    const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels, agents })

    const run = async (payload: Record<string, unknown>, id: string) => {
      await dispatcher.dispatch({
        trigger: { source: "manual" },
        entityRef: { backend: "manual", id },
        event: { id: "evt-" + id, payload },
      })
      await new Promise((r) => setTimeout(r, 30))
    }
    await run({ tier: "gold",   amount: "500" }, "e1")
    await run({ tier: "silver", amount: "75" },  "e2")
    await run({ tier: "bronze", amount: "5" },   "e3")

    const texts = sends.map((s) => s.text)
    expect(texts).toContain("VIP vip")
    expect(texts).toContain("HIGH high")
    expect(texts).toContain("LOW low")
  })

  it("lintWorkflow flags rule nodes with unknown outgoing ports", () => {
    const wf = workflowSchema.parse({
      id: "rule-bad", version: 2, title: "bad rule", priority: 0, fanOut: false,
      envAllow: [], retention: { maxRuns: 10, maxDays: 10 },
      nodes: [
        { id: "trigger", type: "trigger.channel", config: { source: "manual" } },
        { id: "classify", type: "rule", config: {
          inputs: ["{{trigger.x}}"],
          rules: [{ when: ["*"], to: "match", output: {} }],
          default: { to: "fallback", output: {} },
        }},
        { id: "match",    type: "end", config: {} },
        { id: "fallback", type: "end", config: {} },
      ],
      edges: [
        { from: "trigger", to: "classify" },
        { from: "classify", fromPort: "match",    to: "match" },
        { from: "classify", fromPort: "fallback", to: "fallback" },
        { from: "classify", fromPort: "undeclared", to: "match" },
      ],
    })
    const issues = lintWorkflow(wf)
    expect(issues.some((i) => i.includes("undeclared"))).toBe(true)
  })
})

describe("BPM Phase 4: Slack renderer", () => {
  it("emits one-click URLs for approve/reject forms and a deep link for input forms", async () => {
    const { ActorStore } = await import("../src/actors/store")
    const { TaskStore } = await import("../src/workflows/task-store")
    const { createSlackTaskRenderer } = await import("../src/forms/renderers/slack")
    rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true })
    const actors = new ActorStore({ baseDir: TEST_DIR })
    actors.saveActor({ id: "actor:dan", name: "Dan", channels: [{ channel: "slack", handle: "U12345" }] } as any)
    const tasks = new TaskStore({ baseDir: resolve(TEST_DIR, "wf") })
    const approveReject = tasks.create({
      runId: "r1", workflowId: "w", nodeId: "n", title: "Merge release?",
      assignee: "actor:dan", assignedTo: ["actor:dan"],
      form: { title: "f", fields: [], submitLabel: "Merge", secondaryAction: { key: "hold", label: "Hold" } } as any,
    })
    const fullForm = tasks.create({
      runId: "r2", workflowId: "w", nodeId: "n", title: "Risk review",
      assignee: "actor:dan", assignedTo: ["actor:dan"],
      form: {
        title: "Risk review",
        fields: [{ key: "note", label: "Notes", type: "long-text", required: true } as any],
        submitLabel: "Submit",
      } as any,
    })
    const texts: string[] = []
    const render = createSlackTaskRenderer({
      actors, tasks,
      inboxBaseUrl: "https://ex.test",
      adapter: { send: async (m) => { texts.push(m.text); return "m" } },
    })
    await render(approveReject)
    await render(fullForm)
    expect(texts[0]).toContain("https://ex.test/t/" + approveReject.id + "/primary?actor=")
    expect(texts[0]).toContain("https://ex.test/t/" + approveReject.id + "/secondary?actor=")
    expect(texts[1]).toContain("https://ex.test/inbox?actor=")
    expect(texts[1]).not.toContain("/t/")
    rmSync(TEST_DIR, { recursive: true, force: true })
  })
})
