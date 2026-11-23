import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { EventEmitter } from "events"
import { ensureDaemon, handleSetupFlowApi, type DaemonState, type SetupApiDeps } from "../src/daemon/setup-flow-api"
import { runWizard, wizardState } from "../src/daemon/setup-wizard"
import { firstAgentPayload, startOpenUrl } from "../src/commands/start-plan"
import { renderSetupPage, FIRST_TASK } from "../src/daemon/ui/pages/setup"
import { readDotenv } from "../src/utils/dotenv"
import { isLocalDaemon, sameNode } from "../src/daemon/setup-flow-daemon"
import { HUB_PATH } from "../src/daemon/ui/hub-name"

// The guided first run over HTTP (#2143): model account, first agent,
// first task answered, each error a plain sentence. The daemon and the
// model are fakes; the config and .env writes are real, in a temp folder.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-setup-api-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function fakeRes() {
  const res: any = { status: 0, body: null as any }
  res.writeHead = (s: number) => { res.status = s; return res }
  res.end = (b: string) => { res.body = JSON.parse(b) }
  return res
}
function fakeReq(method: string, headers: Record<string, string> = { "x-requested-with": "agentx-board" }): any {
  const r: any = new EventEmitter()
  r.method = method
  r.headers = headers
  return r
}

interface Fake {
  state: DaemonState
  loaded: string[]
  restartRequired: string[]
  calls: string[]
  thread: any[]
  startOk: boolean
}

function makeDeps(f: Fake, body: () => any, over: Partial<SetupApiDeps> = {}): SetupApiDeps {
  return {
    dir, env: {}, hasBinary: (b) => b === "claude", cliLoggedIn: () => true,
    readBody: async () => body(),
    daemon: {
      url: "http://127.0.0.1:18800",
      probe: async () => f.state,
      hasAgent: async (id) => f.loaded.includes(id),
      start: async () => { f.calls.push("start"); if (f.startOk) { f.state = "ours"; f.loaded = Object.keys(JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8")).agents) } return f.startOk },
      reload: async () => { f.calls.push("reload"); return { restartRequired: f.restartRequired } },
      restart: async () => { f.calls.push("restart"); f.loaded = Object.keys(JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8")).agents); return true },
    },
    assistant: async (method, path, b) => {
      f.calls.push(`${method} ${path}`)
      if (method === "POST") return { status: 200, body: { threadId: "t1", pending: true, sent: b } }
      return { status: 200, body: { messages: f.thread } }
    },
    ...over,
  }
}

async function call(deps: SetupApiDeps, method: string, path: string, headers?: Record<string, string>) {
  const res = fakeRes()
  const handled = await handleSetupFlowApi(fakeReq(method, headers), res, new URL(path, "http://x"), deps)
  return { handled, ...res }
}

describe("setup API: from nothing to a first answer", () => {
  it("connects, creates the agent, starts the daemon, sends the task and reads the answer", async () => {
    const f: Fake = { state: "down", loaded: [], restartRequired: [], calls: [], thread: [], startOk: true }
    let body: any = {}
    const deps = makeDeps(f, () => body)

    let r = await call(deps, "GET", "/api/setup/state")
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ model: { ready: true, engine: "claude-code" }, agent: null, daemon: false, hubChat: `${HUB_PATH}#chat=open` })

    body = { name: "Assistant", workspace: "" }
    r = await call(deps, "POST", "/api/setup/agent")
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ created: true, agent: { id: "assistant" }, daemon: "started" })
    expect(f.calls).toEqual(["start"])

    body = { message: FIRST_TASK }
    r = await call(deps, "POST", "/api/setup/first-task")
    expect(r.body).toMatchObject({ threadId: "t1", node: "http://127.0.0.1:18800", agent: "assistant" })
    expect(f.calls).toContain("POST /api/assistant")

    f.thread = [{ role: "user", content: FIRST_TASK, status: "done" }, { role: "assistant", status: "pending", taskId: "task-9" }]
    r = await call(deps, "GET", "/api/setup/first-task?thread=t1")
    expect(r.body).toEqual({ status: "pending", taskId: "task-9" })

    f.thread[1] = { role: "assistant", status: "done", content: "Hello! I can help." }
    r = await call(deps, "GET", "/api/setup/first-task?thread=t1")
    expect(r.body).toEqual({ status: "done", answer: "Hello! I can help." })
  })

  it("shows a failed run as a plain sentence, not the raw error", async () => {
    runWizard(firstAgentPayload("box", true), dir)
    const f: Fake = { state: "ours", loaded: ["assistant"], restartRequired: [], calls: [], thread: [], startOk: true }
    const deps = makeDeps(f, () => ({}))
    f.thread = [{ role: "assistant", status: "error", content: "Error: Credit balance is too low\n    at x (y.js:1:1)" }]
    const r = await call(deps, "GET", "/api/setup/first-task?thread=t1")
    expect(r.body.status).toBe("error")
    expect(r.body.error).toMatch(/no credits left/)
    expect(r.body.error).not.toContain("y.js")
  })

  it("saves a pasted key to .env and the running daemon picks it up", async () => {
    runWizard(firstAgentPayload("box", false), dir)
    const f: Fake = { state: "ours", loaded: ["assistant"], restartRequired: [], calls: [], thread: [], startOk: true }
    const deps = makeDeps(f, () => ({ key: "sk-ant-123" }), { hasBinary: () => false })
    let r = await call(deps, "GET", "/api/setup/state")
    expect(r.body.model).toMatchObject({ ready: false, keyVar: "ANTHROPIC_API_KEY" })
    r = await call(deps, "POST", "/api/setup/model-key")
    expect(r.status).toBe(200)
    expect(r.body.model.ready).toBe(true)
    expect(JSON.stringify(r.body)).not.toContain("sk-ant-123")
    expect(readDotenv(join(dir, ".env")).ANTHROPIC_API_KEY).toBe("sk-ant-123")
    expect(f.calls).toEqual(["reload"])
  })

  it("switches the agent to a ready account and restarts the daemon when the reload can't apply it", async () => {
    runWizard(firstAgentPayload("box", true), dir)
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-ant-x\n")
    const f: Fake = { state: "ours", loaded: ["assistant"], restartRequired: ["agents(tier)"], calls: [], thread: [], startOk: true }
    const deps = makeDeps(f, () => ({ engine: "api-key" }), { cliLoggedIn: () => false })
    const r = await call(deps, "POST", "/api/setup/engine")
    expect(r.status).toBe(200)
    expect(r.body.model.ready).toBe(true)
    expect(f.calls).toEqual(["reload", "restart"])
    expect(JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8")).agents.assistant.tier).toBe("orchestrator")
  })

  it("refuses an engine that is not the one offered", async () => {
    runWizard(firstAgentPayload("box", true), dir)
    const f: Fake = { state: "ours", loaded: ["assistant"], restartRequired: [], calls: [], thread: [], startOk: true }
    const r = await call(makeDeps(f, () => ({ engine: "codex-cli" })), "POST", "/api/setup/engine")
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/not ready on this computer/)
  })
})

describe("setup API: guards and errors", () => {
  const fresh = (): Fake => ({ state: "down", loaded: [], restartRequired: [], calls: [], thread: [], startOk: true })

  it("refuses a write without the board's header, so another site can't drive it", async () => {
    const f = fresh()
    const r = await call(makeDeps(f, () => ({ name: "A" })), "POST", "/api/setup/agent", {})
    expect(r.status).toBe(400)
    expect(f.calls).toEqual([])
    expect(wizardState(dir).configExists).toBe(false)
  })

  it("asks for each step in order, in plain words", async () => {
    const f = fresh()
    let r = await call(makeDeps(f, () => ({ message: "hi" })), "POST", "/api/setup/first-task")
    expect(r).toMatchObject({ status: 409, body: { error: "Create your agent first (step 2)." } })
    r = await call(makeDeps(f, () => ({ name: "A" }), { hasBinary: () => false }), "POST", "/api/setup/agent")
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/Connect a model account first/)
    runWizard(firstAgentPayload("box", true), dir)
    r = await call(makeDeps({ ...f, state: "ours", loaded: ["assistant"] }, () => ({ message: "  " })), "POST", "/api/setup/first-task")
    expect(r.body.error).toBe("Type a task for your agent first.")
  })

  it("says a port taken by another install before it writes any config", async () => {
    const f = { ...fresh(), state: "other-agentx" as DaemonState }
    const r = await call(makeDeps(f, () => ({ name: "A" })), "POST", "/api/setup/agent")
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/Port 18800 is used by another AgentX install/)
    expect(wizardState(dir).configExists).toBe(false)
    expect(f.calls).toEqual([])
  })

  it("says when the daemon would not start, and where its log is", async () => {
    const f = { ...fresh(), startOk: false }
    const r = await call(makeDeps(f, () => ({ name: "A" })), "POST", "/api/setup/agent")
    expect(r.status).toBe(504)
    expect(r.body.error).toContain(join(dir, ".agentx", "daemon.log"))
  })

  it("answers 405 for a known step with the wrong verb, and leaves other paths alone", async () => {
    const deps = makeDeps(fresh(), () => ({}))
    expect((await call(deps, "GET", "/api/setup/agent")).status).toBe(405)
    expect((await call(deps, "POST", "/api/setup/start-daemon")).handled).toBe(false)
  })
})

describe("ensureDaemon", () => {
  const deps = (f: Fake) => makeDeps(f, () => ({}))
  it("names a port held by another install or program", async () => {
    await expect(ensureDaemon(deps({ state: "other-agentx", loaded: [], restartRequired: [], calls: [], thread: [], startOk: true }), { reload: false }))
      .rejects.toThrow(/another AgentX install.*--port 18810/)
    await expect(ensureDaemon(deps({ state: "other", loaded: [], restartRequired: [], calls: [], thread: [], startOk: true }), { reload: false }))
      .rejects.toThrow(/another program/)
  })

  it("restarts a running daemon that has not loaded a new agent (a reload can't add one)", async () => {
    runWizard(firstAgentPayload("box", true), dir)
    const f: Fake = { state: "ours", loaded: [], restartRequired: [], calls: [], thread: [], startOk: true }
    expect(await ensureDaemon(deps(f), { reload: true, agentId: "assistant" })).toBe("restarted")
    expect(f.calls).toEqual(["reload", "restart"])
    expect(await ensureDaemon(deps(f), { reload: false, agentId: "assistant" })).toBe("running")
  })

  it("takes a daemon for this folder's only when both name the same node", () => {
    expect(sameNode({ node: { id: "box" } }, { node: { id: "box" } })).toBe(true)
    // No config yet, or another install on the port: never ours, so it is not reloaded or restarted.
    expect(sameNode({ node: { id: "box" } }, {})).toBe(false)
    expect(sameNode({ node: { id: "box" } }, { node: { id: "other" } })).toBe(false)
    expect(sameNode({ node: {} }, { node: { id: "box" } })).toBe(false)
  })

  it("starts or restarts only a daemon on this machine, never a second one beside Docker's", () => {
    expect(isLocalDaemon("http://127.0.0.1:18800")).toBe(true)
    expect(isLocalDaemon("http://localhost:18800")).toBe(true)
    expect(isLocalDaemon("http://[::1]:18800")).toBe(true)
    expect(isLocalDaemon("http://daemon:18800")).toBe(false)
    expect(isLocalDaemon("not a url")).toBe(false)
  })
})

describe("install leads to the wizard", () => {
  const cfg = { dashboard: { port: 4202 } }
  it("agentx start opens /setup on a first run or with no model, else the chat", () => {
    expect(startOpenUrl(cfg, "assistant", { created: true, ready: true })).toBe("http://127.0.0.1:4202/setup")
    expect(startOpenUrl(cfg, "assistant", { created: false, ready: false })).toBe("http://127.0.0.1:4202/setup")
    expect(startOpenUrl(cfg, "assistant", { created: false, ready: true })).toBe("http://127.0.0.1:4202/admin/agents/assistant#chat")
  })

  it("the page shows the four steps, no hand edits, and no skip while there is no agent", () => {
    const html = renderSetupPage({ configExists: false, agentCount: 0, channelCount: 0 })
    for (const s of ["Connect your AI model account", "Create your first agent", "Give it a first task", "Open the chat in the Hub"]) expect(html).toContain(s)
    expect(html).toContain("Nothing to edit by hand")
    expect(html).not.toContain("Skip, open the Hub")
    expect(html).toContain("/api/setup/state")
    expect(renderSetupPage({ configExists: true, agentCount: 1, channelCount: 0 })).toContain("Skip, open the Hub")
  })
})
