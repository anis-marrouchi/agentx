import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import { RunStore, WorkflowStore, WorkflowDispatcher, workflowSchema } from "../src/workflows"
import { stripSecrets } from "../src/workflows/strip-secrets"
import { GitLabAdapter } from "../src/channels/gitlab"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { AgentXDaemon } from "../src/daemon"

// A channel's agentMappings hold each agent's token. They reached run files
// through the on:gitlab-issue hook context. No credential field may reach a
// run file, the run API or a mesh peer, whatever put it in the payload.

const SECRET = "fake-secret-value-for-test"
const payload = () => ({
  project: "group/app",
  agentMappings: [{ agentId: "coder", gitlabUsernames: ["coder"], keywords: [], token: SECRET }],
})

describe("stripSecrets", () => {
  it("removes credential strings at any depth, by exact end of the name", () => {
    expect(stripSecrets({
      token: SECRET,
      gitlab_token: SECRET,
      "api-key": SECRET,
      nested: [{ webhookSecret: SECRET, keep: "yes" }],
      headers: { Authorization: SECRET },
    })).toEqual({ nested: [{ keep: "yes" }], headers: {} })
  })

  it("keeps usage counts, flags and fields that only start with a credential word", () => {
    const kept = {
      usage: { inputTokens: 12, outputTokens: 3, total_tokens: 15, token: 15 },
      hasSecret: false,
      tokenFile: "/run/secrets/x",
      text: "a word like token in text stays",
      none: null,
    }
    expect(stripSecrets(kept)).toEqual(kept)
  })
})

describe("workflow run secrets", () => {
  let dir: string
  let store: WorkflowStore
  let runs: RunStore
  let server: Server | undefined
  const broadcastTrigger = vi.fn(async () => {})
  const fileText = () => readdirSync(runs.runsDir).map((f) => readFileSync(join(runs.runsDir, f), "utf8")).join("\n")

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-run-secrets-"))
    store = new WorkflowStore({ baseDir: dir })
    runs = new RunStore({ baseDir: dir, nodeId: "node-a" })
    broadcastTrigger.mockClear()
    store.save(workflowSchema.parse({
      id: "pickup",
      version: 2,
      title: "pickup",
      priority: 0,
      fanOut: false,
      nodes: [
        { id: "trigger", type: "trigger.hook", config: { source: "gitlab-issue", event: "on:gitlab-issue" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "trigger", to: "done" }],
      envAllow: [],
      retention: { maxRuns: 500, maxDays: 90 },
    }))
  })
  afterEach(async () => {
    if (server) {
      server.closeAllConnections?.()
      await new Promise<void>((r) => server!.close(() => r()))
      server = undefined
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const dispatcher = () => new WorkflowDispatcher({
    store, runs, nodeId: "node-a", channels: {},
    agents: { execute: async () => ({ content: "", taskId: "t", durationMs: 1 }) },
    forwarder: { forwardTransition: async () => {}, broadcastTrigger },
  })
  const fire = () => dispatcher().dispatchWorkflow({
    workflowId: "pickup",
    entityRef: { backend: "hook", id: "pickup:group/app#1" },
    event: { id: "e1", payload: payload() },
  })

  it("leaves no token in the run file, and keeps the rest of the mapping", async () => {
    const { run } = await fire()
    expect(run).toBeTruthy()
    expect(fileText()).not.toContain(SECRET)
    expect(fileText()).not.toContain('"token"')
    const trigger = runs.get(run!.id)!.context.trigger as ReturnType<typeof payload>
    expect(trigger.agentMappings[0]).toEqual({ agentId: "coder", gitlabUsernames: ["coder"], keywords: [] })
  })

  it("guards each store write when the caller passes a token straight in", () => {
    const run = runs.create({
      workflowId: "pickup", initialPending: ["done"],
      entityRef: { backend: "hook", id: "direct" },
      initialContext: { trigger: payload() },
    })
    expect(JSON.stringify(run)).not.toContain(SECRET)
    runs.recordExecution({
      runId: run.id,
      entry: { nodeId: "done", idempotencyKey: "k", at: new Date().toISOString(), output: { token: SECRET } } as never,
      nextPending: [],
      context: { trigger: payload() },
    })
    runs.setStatus(run.id, "completed")
    expect(fileText()).not.toContain(SECRET)
  })

  it("does not send a token to mesh peers", async () => {
    await dispatcher().dispatch({
      trigger: { source: "gitlab-issue", project: "group/app" },
      entityRef: { backend: "gitlab", id: "group/app#1" },
      event: { id: "e2", payload: payload() },
    })
    expect(broadcastTrigger).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(broadcastTrigger.mock.calls)).not.toContain(SECRET)
  })

  // A run file as an older version left it: a token on both kinds of line.
  // No dispatcher here: its next write would replace the context being read.
  const oldRunFile = () => {
    const run = runs.create({ workflowId: "pickup", initialPending: ["done"], entityRef: { backend: "hook", id: "old" } })
    const lines = [
      { v: 2, kind: "snapshot", run: { ...run, context: { trigger: payload() } } },
      {
        v: 2, kind: "exec", runId: run.id, pending: [], context: { trigger: payload() },
        entry: { nodeId: "done", idempotencyKey: "old", at: new Date().toISOString() },
      },
    ]
    appendFileSync(join(runs.runsDir, `${run.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    expect(fileText()).toContain(SECRET)
    return run
  }
  const serve = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
    server = createServer(handler)
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  }
  const config = () => daemonConfigSchema.parse({ node: { id: "node-a", name: "node-a" } })
  const dashboardCtx = (token?: string) =>
    ({ boards: [], sources: new Map(), config: config(), workflowRuns: runs, token }) as unknown as Ctx

  it("does not return a token from the dashboard's run routes, even from a file an older version wrote", async () => {
    const run = oldRunFile()
    const base = await serve((req, res) => { void handleBoardRequest(req, res, dashboardCtx()) })
    for (const path of [`/api/workflows/runs/${run.id}`, "/api/workflows/runs"]) {
      const res = await fetch(base + path)
      expect(res.status, path).toBe(200)
      const body = await res.text()
      expect(body, path).toContain(run.id)
      expect(body, path).not.toContain(SECRET)
    }
  })

  it("does not return a token from the daemon's run routes, even from a file an older version wrote", async () => {
    const run = oldRunFile()
    const daemon = Object.assign(Object.create(AgentXDaemon.prototype), {
      config: config(), workflowRuns: runs, workflowStore: store, log: () => {},
    })
    const base = await serve((req, res) => { void daemon.handleHttp(req, res) })
    for (const path of [`/api/workflows/runs/${run.id}`, "/api/workflows/runs"]) {
      const res = await fetch(base + path)
      expect(res.status, path).toBe(200)
      const body = await res.text()
      expect(body, path).toContain(run.id)
      expect(body, path).not.toContain(SECRET)
    }
  })

  it("the dashboard's run routes need the owner's credential when dashboard.token is set", async () => {
    const run = oldRunFile()
    const base = await serve((req, res) => { void handleBoardRequest(req, res, dashboardCtx("dash-token")) })
    for (const path of [`/api/workflows/runs/${run.id}`, "/api/workflows/runs"]) {
      expect((await fetch(base + path)).status, path).toBe(401)
    }
    const res = await fetch(`${base}/api/workflows/runs/${run.id}`, { headers: { Authorization: "Bearer dash-token" } })
    expect(res.status).toBe(200)
  })

  it("the GitLab issue hook context carries no token", async () => {
    const execute = vi.fn(async () => ({}))
    const adapter = new GitLabAdapter({
      webhookPort: 0, host: "https://gitlab.example.test", token: "unused", routes: [{ project: "group/app", agentId: "coder" }],
      agentMappings: payload().agentMappings,
    } as never, () => {}, { has: () => true, execute } as never) as any
    adapter.handler = async () => {}
    await adapter.handleIssue({
      object_kind: "issue",
      user: { name: "A", username: "a" },
      project: { path_with_namespace: "group/app" },
      object_attributes: { iid: 1, title: "t", description: "", state: "opened", action: "open", url: "u" },
    }, { writeHead: () => {}, end: () => {} })
    const ctx = (execute.mock.calls as unknown as Array<[string, Record<string, unknown>]>).find((c) => c[0] === "on:gitlab-issue")![1]
    expect(JSON.stringify(ctx)).not.toContain(SECRET)
    expect(ctx.agentMappings).toEqual([{ agentId: "coder", gitlabUsernames: ["coder"], keywords: [] }])
  })
})
