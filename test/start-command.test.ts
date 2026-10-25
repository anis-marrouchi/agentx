import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { EventEmitter } from "events"
import {
  chatUrl, daemonBaseUrl, dashboardBaseUrl, existingConfigPath, firstAgentPayload, isSameInstall, pickAgent, FIRST_AGENT_ID,
} from "../src/commands/start-plan"
import { runWizard } from "../src/daemon/setup-wizard"
import { loadDaemonConfig } from "../src/daemon/config"
import { envRef, modelReadiness } from "../src/daemon/model-ready"
import { addDotenvKey, readDotenv } from "../src/utils/dotenv"
import { handleModelSetupApi, MODEL_KEY_PATH, MODEL_READY_PATH, type ModelSetupDeps } from "../src/daemon/model-setup-api"
import { parseAuthStatus } from "../src/utils/cli-login"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-start-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("agentx start: first config (#1163)", () => {
  it("creates one agent on Claude Code when the claude CLI is installed, else on the built-in engine with the Anthropic API", () => {
    expect(firstAgentPayload("box", true).agent).toMatchObject({ tier: "claude-code" })
    expect(firstAgentPayload("box", true).agent.provider).toBeUndefined()
    // Not "sdk": that engine needs @anthropic-ai/claude-agent-sdk, which the package does not ship.
    expect(firstAgentPayload("box", false).agent).toMatchObject({ tier: "orchestrator", provider: "claude" })
    expect(firstAgentPayload("  ", true).nodeName).toBe("My team")
  })

  it("writes a config the daemon loads, on the ports asked for, with no key in it", () => {
    runWizard(firstAgentPayload("box", false), dir, { daemonPort: 18810, dashboardPort: 4212 })
    const raw = JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))
    expect(raw.providers.claude.apiKey).toBe("${ANTHROPIC_API_KEY}")
    expect(raw.agents.assistant).toMatchObject({ tier: "orchestrator", provider: "claude" })
    // .env will hold the key: owner-only from the start.
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600)
    const cfg = loadDaemonConfig(join(dir, "agentx.json"))
    expect(cfg.node.bind).toBe("127.0.0.1:18810")
    expect(cfg.dashboard.port).toBe(4212)
    expect(cfg.dashboard.daemonUrl).toBe("http://localhost:18810")
    expect(pickAgent(cfg)).toBe(FIRST_AGENT_ID)
    expect(chatUrl(cfg, FIRST_AGENT_ID)).toBe("http://127.0.0.1:4212/admin/agents/assistant#chat")
    expect(existsSync(join(dir, "agents", FIRST_AGENT_ID, "CLAUDE.md"))).toBe(true)
  })

  it("keeps the wizard's default ports when none are asked for", () => {
    runWizard(firstAgentPayload("box", true), dir)
    const raw = JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))
    expect(raw.node.bind).toBe("127.0.0.1:18800")
    expect(raw.dashboard.port).toBe(4202)
  })

  it("finds an existing config, so a second run leaves it alone", () => {
    expect(existingConfigPath(dir)).toBeNull()
    writeFileSync(join(dir, "agentx.json"), "{}")
    expect(existingConfigPath(dir)).toBe(join(dir, "agentx.json"))
    rmSync(join(dir, "agentx.json"))
    writeFileSync(join(dir, ".env"), "")
    expect(existingConfigPath(dir)).toBeNull()
  })

  it("also finds .agentx/config.json, like the daemon", () => {
    const p = join(dir, ".agentx")
    mkdirSync(p)
    writeFileSync(join(p, "config.json"), "{}")
    expect(existingConfigPath(dir)).toBe(join(p, "config.json"))
  })
})

describe("agentx start: reuse (#1163)", () => {
  it("opens node.defaultAgent, else the first agent", () => {
    expect(pickAgent({ node: { defaultAgent: "b" }, agents: { a: {}, b: {} } })).toBe("b")
    expect(pickAgent({ node: { defaultAgent: "gone" }, agents: { a: {}, b: {} } })).toBe("a")
    expect(pickAgent({ agents: {} })).toBeNull()
  })

  it("turns any-address binds into a local URL", () => {
    expect(daemonBaseUrl({ node: { bind: "0.0.0.0:18800" } })).toBe("http://127.0.0.1:18800")
    expect(dashboardBaseUrl({ dashboard: { bind: "0.0.0.0", port: 4300 } })).toBe("http://127.0.0.1:4300")
    expect(dashboardBaseUrl({})).toBe("http://127.0.0.1:4202")
  })

  it("does not take another AgentX on the same port for this install", () => {
    expect(isSameInstall({ node: { id: "box" } }, { node: { id: "box" } })).toBe(true)
    expect(isSameInstall({ node: { id: "other" } }, { node: { id: "box" } })).toBe(false)
    expect(isSameInstall({}, { node: { id: "box" } })).toBe(true)
  })
})

describe("model readiness (#1163)", () => {
  const base = (agent: any, providers: any = {}) => ({ rawConfig: { agents: { a: agent }, providers }, agentId: "a", env: {}, dotenv: {}, hasBinary: () => false })

  it("asks for the CLI login when the engine's CLI is missing", () => {
    const r = modelReadiness(base({ tier: "claude-code" }))
    expect(r).toMatchObject({ ready: false, need: "cli", cli: "claude" })
    expect(modelReadiness({ ...base({ tier: "claude-code" }), hasBinary: (b) => b === "claude" }).ready).toBe(true)
  })

  it("asks for the login when the CLI is installed but logged out, and trusts an unknown status", () => {
    const installed = { ...base({ tier: "claude-code" }), hasBinary: () => true }
    const out = modelReadiness({ ...installed, cliLoggedIn: () => false })
    expect(out).toMatchObject({ ready: false, need: "cli", cli: "claude" })
    expect(out.hint).toContain("not logged in")
    expect(modelReadiness({ ...installed, cliLoggedIn: () => true }).ready).toBe(true)
    expect(modelReadiness({ ...installed, cliLoggedIn: () => null }).ready).toBe(true)
  })

  it("reads loggedIn from `claude auth status`, and nothing else", () => {
    expect(parseAuthStatus('{"loggedIn": false, "authMethod": "none"}')).toBe(false)
    expect(parseAuthStatus('{"loggedIn": true}')).toBe(true)
    expect(parseAuthStatus("Logged in as someone")).toBeNull()
    expect(parseAuthStatus('{"other": 1}')).toBeNull()
  })

  it("asks for a key named by ${VAR}, and is ready once env or .env has it", () => {
    const input = base({ tier: "sdk" }, { claude: { apiKey: "${ANTHROPIC_API_KEY}" } })
    expect(modelReadiness(input)).toMatchObject({ ready: false, need: "key", envVar: "ANTHROPIC_API_KEY" })
    expect(modelReadiness({ ...input, env: { ANTHROPIC_API_KEY: "k" } }).ready).toBe(true)
    expect(modelReadiness({ ...input, dotenv: { ANTHROPIC_API_KEY: "k" } }).ready).toBe(true)
  })

  it("accepts a literal key and does not ask for one on a keyless orchestrator", () => {
    expect(modelReadiness(base({ tier: "sdk" }, { claude: { apiKey: "literal" } })).ready).toBe(true)
    expect(modelReadiness(base({ tier: "orchestrator" })).ready).toBe(true)
  })

  it("reports an unknown agent", () => {
    expect(modelReadiness({ ...base({ tier: "sdk" }), agentId: "nope" }).ready).toBe(false)
  })

  it("reads ${VAR} references only", () => {
    expect(envRef("${X_Y}")).toBe("X_Y")
    expect(envRef("abc")).toBeNull()
    expect(envRef(undefined)).toBeNull()
  })
})

describe(".env helper (#1163)", () => {
  it("creates .env with mode 600 and never replaces a key that has a value", () => {
    const p = join(dir, ".env")
    expect(addDotenvKey(p, "ANTHROPIC_API_KEY", "one")).toBe(true)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(addDotenvKey(p, "ANTHROPIC_API_KEY", "two")).toBe(false)
    expect(readDotenv(p).ANTHROPIC_API_KEY).toBe("one")
  })

  it("appends to an existing file and refuses bad names or multi-line values", () => {
    const p = join(dir, ".env")
    writeFileSync(p, "A=1", { mode: 0o644 })
    expect(addDotenvKey(p, "B", "2")).toBe(true)
    expect(readFileSync(p, "utf-8")).toBe("A=1\nB=2\n")
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(() => addDotenvKey(p, "bad-name", "x")).toThrow()
    expect(() => addDotenvKey(p, "C", "x\ny")).toThrow()
  })
})

// --- The dashboard routes the chat's "no model yet" box calls ---

function fakeRes() {
  const res: any = { status: 0, body: null as any }
  res.writeHead = (s: number) => { res.status = s; return res }
  res.end = (b: string) => { res.body = JSON.parse(b) }
  return res
}
function fakeReq(method: string): any {
  const r: any = new EventEmitter()
  r.method = method
  return r
}

describe("model setup API (#1163)", () => {
  let reloads: number
  let deps: ModelSetupDeps
  let body: any
  beforeEach(() => {
    runWizard(firstAgentPayload("box", false), dir)
    reloads = 0
    body = {}
    deps = { dir, env: {}, hasBinary: () => false, cliLoggedIn: () => null, readBody: async () => body, reloadDaemon: async () => { reloads++ } }
  })

  it("says the agent needs a key, then saves it to .env and reloads the daemon", async () => {
    let res = fakeRes()
    expect(await handleModelSetupApi(fakeReq("GET"), res, MODEL_READY_PATH, new URLSearchParams("agent=assistant"), deps)).toBe(true)
    expect(res.body).toMatchObject({ ready: false, need: "key", envVar: "ANTHROPIC_API_KEY" })

    body = { agent: "assistant", key: "sk-test-123" }
    res = fakeRes()
    await handleModelSetupApi(fakeReq("POST"), res, MODEL_KEY_PATH, new URLSearchParams(), deps)
    expect(res.status).toBe(200)
    expect(res.body.ready).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain("sk-test-123")
    expect(reloads).toBe(1)
    expect(readDotenv(join(dir, ".env")).ANTHROPIC_API_KEY).toBe("sk-test-123")
    expect(readFileSync(join(dir, "agentx.json"), "utf-8")).not.toContain("sk-test-123")
  })

  it("does not overwrite a key that is already set", async () => {
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=old\n")
    body = { agent: "assistant", key: "new" }
    const res = fakeRes()
    await handleModelSetupApi(fakeReq("POST"), res, MODEL_KEY_PATH, new URLSearchParams(), deps)
    expect(res.body.ready).toBe(true)
    expect(readDotenv(join(dir, ".env")).ANTHROPIC_API_KEY).toBe("old")
    expect(reloads).toBe(0)
  })

  it("refuses an empty or multi-word key, and a key for a CLI engine", async () => {
    body = { agent: "assistant", key: "two words" }
    let res = fakeRes()
    await handleModelSetupApi(fakeReq("POST"), res, MODEL_KEY_PATH, new URLSearchParams(), deps)
    expect(res.status).toBe(400)

    const cfg = JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))
    cfg.agents.assistant.tier = "claude-code"
    writeFileSync(join(dir, "agentx.json"), JSON.stringify(cfg))
    body = { agent: "assistant", key: "sk-x" }
    res = fakeRes()
    await handleModelSetupApi(fakeReq("POST"), res, MODEL_KEY_PATH, new URLSearchParams(), deps)
    expect(res.status).toBe(409)
    expect(existsSync(join(dir, ".env")) ? readDotenv(join(dir, ".env")).ANTHROPIC_API_KEY : undefined).toBeUndefined()
  })

  it("leaves other paths to the dashboard", async () => {
    expect(await handleModelSetupApi(fakeReq("GET"), fakeRes(), "/api/admin/config", new URLSearchParams(), deps)).toBe(false)
  })
})

// --- The agent page's chat, through the dashboard ---

import { AGENT_CHAT_PATH, handleAgentChatApi } from "../src/daemon/agent-chat-api"

describe("agent page chat through the dashboard (#1163)", () => {
  const call = async (body: any, fetchImpl: any) => {
    const res = fakeRes()
    const handled = await handleAgentChatApi(fakeReq("POST"), res, AGENT_CHAT_PATH, {
      daemonUrl: "http://127.0.0.1:18871/", token: "tok", readBody: async () => body, fetch: fetchImpl,
    })
    return { handled, res }
  }

  it("forwards the message to the daemon's /task with the dashboard token and returns the reply", async () => {
    let seen: any
    const { res } = await call({ agent: "assistant", message: " hi " }, async (url: string, init: any) => {
      seen = { url, init }
      return new Response(JSON.stringify({ content: "hello" }), { status: 200 })
    })
    expect(seen.url).toBe("http://127.0.0.1:18871/task")
    expect(seen.init.headers.Authorization).toBe("Bearer tok")
    expect(JSON.parse(seen.init.body)).toMatchObject({ agent: "assistant", message: "hi", context: { channel: "test-drive" } })
    expect(res.body).toEqual({ content: "hello" })
  })

  it("passes on the agent's error, and says when the daemon is down", async () => {
    let r = await call({ agent: "a", message: "x" }, async () => new Response(JSON.stringify({ content: "", error: "No API key" }), { status: 200 }))
    expect(r.res.status).toBe(502)
    expect(r.res.body.error).toBe("No API key")
    r = await call({ agent: "a", message: "x" }, async () => { throw new Error("ECONNREFUSED") })
    expect(r.res.body.error).toContain("ECONNREFUSED")
  })

  it("needs an agent and a message, and only handles its own POST", async () => {
    expect((await call({ agent: "a" }, async () => new Response("{}"))).res.status).toBe(400)
    expect(await handleAgentChatApi(fakeReq("GET"), fakeRes(), AGENT_CHAT_PATH, { daemonUrl: "x", readBody: async () => ({}) })).toBe(false)
  })
})
