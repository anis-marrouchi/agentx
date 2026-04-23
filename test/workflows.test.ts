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
