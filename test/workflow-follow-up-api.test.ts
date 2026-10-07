import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, rmSync } from "fs"
import { resolve } from "path"
import { RunStore, WorkflowStore, WorkflowDispatcher, workflowSchema, parseYamlWorkflow, type AgentExecuteResponse, type WorkflowRun } from "../src/workflows"
import { TimerService } from "../src/workflows/timers"
import { TEMPLATES, readTemplate } from "../src/workflows/templates"
import { buildWorkflow, progressGroups, runSummary, workflowHintText } from "../src/workflows/follow-up"
import { handleFollowUpApi, type FollowUpApiDeps } from "../src/workflows/follow-up-api"
import { runWorkflowTool } from "../src/workflows/follow-up-tool"

// agentx_workflow and the /follow-up endpoints (#788): matching a saved
// workflow, starting one (the owner is told which), building one from the
// owner's words, reporting a step done, proposing a template, progress by
// tag.

const TEST_DIR = resolve(__dirname, "../.test-workflow-follow-up-api")

const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition not met in time")
    await new Promise((r) => setTimeout(r, 10))
  }
}

function setup(opts: { reply?: string; settings?: Partial<FollowUpApiDeps["settings"]> } = {}) {
  const store = new WorkflowStore({ baseDir: TEST_DIR })
  const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
  const told: string[] = []
  const cards: string[] = []
  const links: Array<[string, string]> = []
  const proposals: string[] = []
  const sends: string[] = []
  const dispatcher = new WorkflowDispatcher({
    store, runs, nodeId: "node-a",
    timers: new TimerService({ baseDir: resolve(TEST_DIR, "_t") }),
    channels: { telegram: { send: async (m: { text: string }) => { sends.push(m.text); return "m" } } },
    agents: { execute: async (): Promise<AgentExecuteResponse> => ({ content: opts.reply ?? "RESULT: done" }) },
    owner: {
      notify: async (text) => { told.push(text) },
      ask: async (input) => { cards.push(input.ask); return { cardId: `c${cards.length}` } },
    },
  })
  const deps: FollowUpApiDeps = {
    dispatcher, store, runs,
    settings: { enabled: true, agents: {}, stallMinutes: 30, maxNudges: 2, approval: "step", ...opts.settings },
    hasAgent: (id) => ["lead", "builder", "quiet"].includes(id),
    runningTurn: (id, proof) => (proof.taskId === `task-${id}` ? { channel: "telegram", chatId: "owner-chat" } : null),
    liveRequest: () => "req-1",
    linkRequest: (r, run) => { links.push([r, run]) },
    notifyOwner: async (text) => { told.push(text) },
    proposeCard: async (wf) => { proposals.push(wf.id); return { cardId: "p1" } },
  }
  const post = (body: Record<string, unknown>, agentId = "lead") =>
    handleFollowUpApi("POST", "/follow-up", { agentId, ...body }, deps, { taskId: `task-${agentId}` })
  return { store, runs, dispatcher, deps, told, cards, links, proposals, sends, post }
}

function saveChase(store: WorkflowStore, extra: Record<string, unknown> = {}) {
  store.save(workflowSchema.parse({
    id: "chase-document", title: "Chase a signed document from an employee",
    description: "Ask an employee for a signed document and wait for it",
    nodes: [
      { id: "start", type: "trigger.manual" },
      { id: "ask", type: "person.message", config: { to: "{{start.name}}", channel: "telegram", chatId: "{{start.chat}}", text: "Please send the signed document." } },
      { id: "doc", type: "person.wait", config: { reminds: "ask", timeout: "2d" } },
      { id: "done", type: "end" },
    ],
    edges: [{ from: "start", to: "ask" }, { from: "ask", to: "doc" }, { from: "doc", to: "done" }],
    ...extra,
  }))
}

beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

describe("starting a saved workflow", () => {
  it("records the run with its title, tags, starter and request, and tells the owner which workflow was chosen", async () => {
    const t = setup()
    saveChase(t.store)
    const r = await t.post({ action: "start", workflowId: "chase-document", title: "Contract from Sam", tags: ["Employee:Sam", "project:onboarding"], inputs: { name: "Sam", chat: "sam-1" } })
    expect(r.status).toBe(200)
    const run = (r.body as any).run
    expect(run.tags).toEqual(["employee:sam", "project:onboarding"])
    expect(run.startedBy).toBe("lead")
    expect(run.requestId).toBe("req-1")
    expect(t.links).toEqual([["req-1", run.runId]])
    expect(t.told[0]).toMatch(/lead chose the saved workflow "Chase a signed document from an employee" for "Contract from Sam" \[employee:sam, project:onboarding\]: ask \(person.message\) → doc \(person.wait\)/)
    // The message waits for the owner's approval card.
    await until(() => t.cards.length === 1)
    expect(t.runs.get(run.runId)?.context.start).toMatchObject({ name: "Sam", chat: "sam-1", requestedBy: "lead", channel: "telegram", chatId: "owner-chat" })
  })

  it("does not tell the owner first when the workflow starts on its own", async () => {
    const t = setup()
    saveChase(t.store, { autoStart: true })
    await t.post({ action: "start", workflowId: "chase-document", title: "x", inputs: { chat: "c" } })
    expect(t.told).toEqual([])
  })

  it("refuses a workflow that is switched off, a call from outside a running turn, and an agent it is off for", async () => {
    const t = setup({ settings: { agents: { quiet: false } } })
    saveChase(t.store, { state: "disabled" })
    expect((await t.post({ action: "start", workflowId: "chase-document" })).status).toBe(409)
    expect((await handleFollowUpApi("POST", "/follow-up", { action: "start", agentId: "lead", workflowId: "chase-document" }, t.deps, {})).status).toBe(403)
    const off = await t.post({ action: "start", workflowId: "chase-document" }, "quiet")
    expect(off.status).toBe(409)
    expect((off.body as any).error).toMatch(/off for quiet/)
  })
})

describe("building a workflow from the owner's words", () => {
  it("runs the steps in order, keeps the built workflow switched off, and can propose it as a template", async () => {
    const t = setup()
    const r = await t.post({
      action: "start", title: "Logo feedback", tags: ["client:example-co"],
      steps: [
        { id: "tell_me", type: "owner.notify", config: { text: "Asking the client about the logo." } },
        { id: "work", type: "agent", config: { agentId: "builder", prompt: "Prepare two logo options." } },
        { id: "done_note", type: "owner.notify", config: { text: "Options: {{work.reply}}" } },
      ],
    })
    expect(r.status).toBe(200)
    const body = r.body as any
    expect(body.built).toBe(true)
    await until(() => t.runs.get(body.run.runId)?.status === "completed")
    expect(t.told.slice(-2)).toEqual(["Asking the client about the logo.", "Options: RESULT: done"])
    const wf = t.store.get(body.run.workflowId)!
    expect(wf.state).toBe("disabled")
    expect(wf.tags).toContain("built-on-demand")

    const p = await t.post({ action: "propose", fromRun: body.run.runId, title: "Ask a client about a design" })
    expect(p.status).toBe(200)
    const kept = t.store.get((p.body as any).workflowId)!
    expect(kept).toMatchObject({ status: "review", state: "disabled", title: "Ask a client about a design" })
    expect(kept.tags).not.toContain("built-on-demand")
    expect(t.proposals).toEqual([kept.id])
  })

  it("refuses steps an agent may not use", () => {
    const r = buildWorkflow({ id: "x", title: "x", steps: [{ id: "s", type: "action.send", config: {} }] })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toMatch(/not one an agent may use/)
    const shell = buildWorkflow({ id: "x", title: "x", steps: [{ id: "s", type: "action.run", config: {} }] })
    expect(shell.ok).toBe(false)
  })

  it("joins steps with edges and ports when given", () => {
    const r = buildWorkflow({
      id: "ask-flow", title: "Ask",
      steps: [
        { id: "ask", type: "owner.ask", config: { ask: "Go?" } },
        { id: "go", type: "owner.notify", config: { text: "going" } },
        { id: "stop", type: "owner.notify", config: { text: "stopping" } },
      ],
      edges: [{ from: "ask", to: "go" }, { from: "ask", fromPort: "no", to: "stop" }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.workflow.edges[0]).toEqual({ from: "start", to: "ask" })
  })
})

describe("reporting a step", () => {
  it("done moves the run on; blocked needs a reason", async () => {
    const t = setup({ reply: "Deploy started." })
    t.store.save(workflowSchema.parse({
      id: "deploy", title: "Deploy",
      nodes: [{ id: "start", type: "trigger.manual" }, { id: "go", type: "agent", config: { agentId: "builder", prompt: "Deploy" } }, { id: "end", type: "end" }],
      edges: [{ from: "start", to: "go" }, { from: "go", to: "end" }],
    }))
    const r = await t.post({ action: "start", workflowId: "deploy", title: "Deploy 2.4" })
    const runId = (r.body as any).run.runId
    await until(() => t.runs.get(runId)?.pausedAt?.kind === "agentStep")
    expect((await t.post({ action: "blocked", runId }, "builder")).status).toBe(400)
    const done = await t.post({ action: "done", runId, step: "go", evidence: "https://example.com/deploys/1" }, "builder")
    expect(done.status).toBe(200)
    await until(() => t.runs.get(runId)?.status === "completed")
    expect(t.runs.get(runId)?.context.go).toMatchObject({ evidence: "https://example.com/deploys/1", result: "done" })
  })
})

describe("reads", () => {
  it("match ranks saved workflows for a request", async () => {
    const t = setup()
    saveChase(t.store)
    const r = await handleFollowUpApi("GET", "/follow-up/match?q=" + encodeURIComponent("chase the signed document from the new employee"), undefined, t.deps)
    const matches = (r.body as any).matches
    expect(matches[0].workflowId).toBe("chase-document")
    expect(matches[0].steps.map((s: any) => s.id)).toEqual(["ask", "doc"])
  })

  it("lists running follow-ups by tag, untagged last", async () => {
    const t = setup()
    saveChase(t.store)
    await t.post({ action: "start", workflowId: "chase-document", title: "A", tags: ["employee:sam"], inputs: { name: "Sam", chat: "1" } })
    await t.post({ action: "start", workflowId: "chase-document", title: "B", inputs: { chat: "2" } })
    await until(() => t.cards.length === 2)
    const r = await handleFollowUpApi("GET", "/follow-up", undefined, t.deps)
    const groups = (r.body as any).groups
    expect(groups.map((g: any) => g.tag)).toEqual(["employee:sam", "untagged"])
    expect(groups[0].rows[0]).toMatchObject({ title: "A", step: "ask", waitingOn: "your approval to send to Sam" })
  })
})

describe("the agent tool", () => {
  it("posts with the caller's run headers and words the result for the agent", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ run: { runId: "r1", title: "T", step: "ask", waitingOn: "your answer" }, built: false, awaitingApproval: false }), { status: 200 })
    }) as unknown as typeof fetch
    const text = await runWorkflowTool({ action: "start", workflowId: "chase-document", title: "T" }, {
      daemonUrl: "http://127.0.0.1:1", fetch: fakeFetch,
      env: { AGENTX_AGENT_ID: "lead", AGENTX_TASK_ID: "task-lead" } as NodeJS.ProcessEnv,
    })
    expect(text).toMatch(/Started run r1 "T"/)
    expect(text).toMatch(/Do not run its steps by hand/)
    expect(calls[0].url).toBe("http://127.0.0.1:1/follow-up")
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ action: "start", agentId: "lead", workflowId: "chase-document" })
  })

  it("turns a daemon refusal into text", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ error: "no workflow \"x\"" }), { status: 404 })) as unknown as typeof fetch
    const text = await runWorkflowTool({ action: "start", workflowId: "x", callerAgentId: "lead" }, { daemonUrl: "http://h", fetch: fakeFetch, env: {} as NodeJS.ProcessEnv })
    expect(text).toBe('Error: no workflow "x"')
  })
})

describe("words for the owner and the agent", () => {
  it("the hint names the workflow and how to start it", () => {
    expect(workflowHintText({ id: "chase-document", title: "Chase", autoStart: false })).toMatch(/agentx_workflow \{action:"start", workflowId:"chase-document"/)
  })

  it("the summary lists each step with its proof, and why a run stopped", () => {
    const run = {
      id: "r1", workflowId: "w", status: "failed", meta: { title: "Ship 2.4", tags: ["client:example-co"], followUp: true, approvedAtStart: false, startedBy: "lead" },
      history: [
        { at: "t", nodeId: "deploy", status: "ok", output: { evidence: "https://example.com/d/1" }, idempotencyKey: "a", inputKeys: [] },
        { at: "t", nodeId: "reply", status: "failed", note: "stopped: no reply before the deadline", idempotencyKey: "b", inputKeys: [] },
      ],
    } as unknown as WorkflowRun
    const s = runSummary(run, null)
    expect(s.title).toBe("Workflow did not finish: Ship 2.4")
    expect(s.message).toContain("✓ deploy (https://example.com/d/1)")
    expect(s.message).toContain("Why: stopped: no reply before the deadline")
    expect(s.message).toContain("About: client:example-co")
  })

  it("progressGroups ignores runs that are not followed or have ended", () => {
    const base = { workflowId: "w", pending: [], history: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", parentRunId: null }
    const groups = progressGroups([
      { ...base, id: "a", status: "paused", meta: { followUp: true, tags: ["idea:x"] } },
      { ...base, id: "b", status: "completed", meta: { followUp: true, tags: ["idea:x"] } },
      { ...base, id: "c", status: "paused" },
    ] as unknown as WorkflowRun[])
    expect(groups).toEqual([{ tag: "idea:x", rows: [expect.objectContaining({ runId: "a" })] }])
  })
})

describe("the release template", () => {
  it("deploys, verifies, waits for the owner's yes, then tells the client and sums up once", async () => {
    expect(TEMPLATES.map((x) => x.name)).toContain("release-follow-up")
    const t = setup()
    const yaml = readTemplate("release-follow-up").replace(/__ID__/g, "release").replace(/__TITLE__/g, "Release").replace(/__AGENT__/g, "builder")
    t.store.save(workflowSchema.parse(parseYamlWorkflow(yaml)))
    const ended: WorkflowRun[] = []
    const dispatcher = new WorkflowDispatcher({
      store: t.store, runs: t.runs, nodeId: "node-a",
      timers: new TimerService({ baseDir: resolve(TEST_DIR, "_t2") }),
      channels: { telegram: { send: async (m: { text: string }) => { t.sends.push(m.text); return "m" } } },
      agents: { execute: async (): Promise<AgentExecuteResponse> => ({ content: "Checked, live.\nRESULT: done" }) },
      owner: { notify: async () => {}, ask: async () => ({ cardId: "card-r" }) },
      onRunEnded: (r) => { ended.push(r) },
    })
    const { run } = await dispatcher.startRun({ workflowId: "release", inputs: { release: "2.4", url: "https://example.com", client: "Example Co", clientChannel: "telegram", clientChatId: "55" } })
    await until(() => t.runs.get(run!.id)?.pausedAt?.kind === "ownerDecision")
    expect(t.sends).toEqual([])
    await dispatcher.resumeFromCard({ id: "card-r", status: "decided", verdict: "yes", origin: { kind: "workflow", runId: run!.id, nodeId: "tell_client" } })
    await until(() => ended.length === 1)
    expect(t.sends).toEqual(["Hello Example Co, release 2.4 is now live at https://example.com."])
    expect(ended[0].status).toBe("completed")
  })
})
