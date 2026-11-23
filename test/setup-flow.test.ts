import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  checkModel, createFirstAgent, detectAccount, ensureWritable, firstAgent, plainError, saveModelKey, setupRedirect,
  switchEngine, workspacePath, CLAUDE_INSTALL, SetupError, type SetupEnv,
} from "../src/daemon/setup-flow"
import { runWizard } from "../src/daemon/setup-wizard"
import { firstAgentPayload } from "../src/commands/start-plan"
import { loadDaemonConfig } from "../src/daemon/config"
import { readDotenv } from "../src/utils/dotenv"
import { HUB_PATH } from "../src/daemon/ui/hub-name"

// The guided first run's decisions (#2143, new-user feedback 2026-11-23):
// which model account this computer has, the first agent made once, and a
// plain sentence for each failure. Nothing here is edited by hand.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-setup-flow-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function env(over: Partial<SetupEnv> = {}): SetupEnv {
  return { dir, env: {}, hasBinary: () => false, cliLoggedIn: () => null, ...over }
}
const claudeIn = { hasBinary: (b: string) => b === "claude", cliLoggedIn: () => true }
const raw = () => JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))

describe("step 1: the model account", () => {
  it("finds Claude Code signed in first, then a saved key, then Codex", () => {
    expect(detectAccount(env(claudeIn))).toMatchObject({ ready: true, engine: "claude-code" })
    // Unknown login state (an older CLI) counts as signed in, as start does.
    expect(detectAccount(env({ hasBinary: (b) => b === "claude", cliLoggedIn: () => null }))).toMatchObject({ ready: true, engine: "claude-code" })
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-ant-x\n")
    expect(detectAccount(env())).toMatchObject({ ready: true, engine: "api-key" })
    rmSync(join(dir, ".env"))
    expect(detectAccount(env({ hasBinary: (b) => b === "codex" }))).toMatchObject({ ready: true, engine: "codex-cli" })
  })

  it("gives the one command to run, and a key field, when nothing is there", () => {
    expect(detectAccount(env())).toMatchObject({ ready: false, command: CLAUDE_INSTALL, keyVar: "ANTHROPIC_API_KEY" })
    const notSignedIn = detectAccount(env({ hasBinary: (b) => b === "claude", cliLoggedIn: () => false }))
    expect(notSignedIn).toMatchObject({ ready: false, command: "claude" })
    expect(notSignedIn.message).toMatch(/not signed in/)
  })

  it("checks the agent's own engine once it exists, and offers an account that is ready", () => {
    runWizard(firstAgentPayload("box", true), dir)
    const c = checkModel(env({ hasBinary: (b) => b === "claude", cliLoggedIn: () => false }))
    expect(c).toMatchObject({ ready: false, engine: "claude-code", command: "claude" })
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-ant-x\n")
    expect(checkModel(env({ hasBinary: (b) => b === "claude", cliLoggedIn: () => false })).switchTo).toBe("api-key")
    expect(checkModel(env(claudeIn))).toMatchObject({ ready: true, engine: "claude-code" })
  })

  it("asks for a key for an agent on the API, and saves it to .env, never to agentx.json", () => {
    runWizard(firstAgentPayload("box", false), dir)
    expect(checkModel(env())).toMatchObject({ ready: false, engine: "api-key", keyVar: "ANTHROPIC_API_KEY" })
    saveModelKey(env(), "ANTHROPIC_API_KEY", "  sk-ant-abc  ")
    expect(readDotenv(join(dir, ".env")).ANTHROPIC_API_KEY).toBe("sk-ant-abc")
    expect(readFileSync(join(dir, "agentx.json"), "utf-8")).not.toContain("sk-ant-abc")
    expect(checkModel(env()).ready).toBe(true)
    // A second key replaces the first rather than leaving two lines.
    saveModelKey(env(), "ANTHROPIC_API_KEY", "sk-ant-new")
    expect(readFileSync(join(dir, ".env"), "utf-8").match(/ANTHROPIC_API_KEY=/g)).toHaveLength(1)
  })

  it("refuses a key that cannot be right, with a sentence saying why", () => {
    for (const bad of ["", "two words", "sk-proj-abc"]) {
      expect(() => saveModelKey(env(), "ANTHROPIC_API_KEY", bad)).toThrow(SetupError)
    }
    expect(() => saveModelKey(env(), "ANTHROPIC_API_KEY", "sk-proj-abc")).toThrow(/start with sk-ant-/)
    expect(existsSync(join(dir, ".env"))).toBe(false)
  })

  it("switches the agent to the ready account through the config writer", () => {
    runWizard(firstAgentPayload("box", true), dir)
    switchEngine(dir, "api-key")
    expect(raw().agents.assistant).toMatchObject({ tier: "orchestrator", provider: "claude" })
    switchEngine(dir, "codex-cli")
    expect(raw().agents.assistant.tier).toBe("codex-cli")
    expect(raw().agents.assistant.provider).toBeUndefined()
    expect(() => loadDaemonConfig(join(dir, "agentx.json"))).not.toThrow()
  })

  it("has nothing to switch before an agent exists", () => {
    expect(() => switchEngine(dir, "claude-code")).toThrow(/no agent yet/)
  })
})

describe("step 2: the first agent", () => {
  it("is created once, on the account found, in a config the daemon loads", () => {
    const out = createFirstAgent(env(claudeIn), { name: "Help Desk" })
    expect(out.created).toBe(true)
    expect(out.agent).toMatchObject({ id: "help-desk", name: "Help Desk", engine: "claude-code" })
    expect(out.agent.workspace).toBe(join(dir, "agents", "help-desk"))
    expect(existsSync(join(out.agent.workspace, "CLAUDE.md"))).toBe(true)
    const cfg = loadDaemonConfig(join(dir, "agentx.json"))
    expect(Object.keys(cfg.agents)).toEqual(["help-desk"])

    // Running the wizard again finds it and makes no second agent.
    const again = createFirstAgent(env(claudeIn), { name: "Other" })
    expect(again).toMatchObject({ created: false, agent: { id: "help-desk" } })
    expect(Object.keys(raw().agents)).toEqual(["help-desk"])
  })

  it("adds to a config that has no agent yet (the Docker image's empty team)", () => {
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({ node: { id: "box", name: "box" }, agents: {} }))
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-ant-x\n")
    const out = createFirstAgent(env(), {})
    expect(out.agent).toMatchObject({ id: "assistant", engine: "api-key" })
    expect(raw().node.defaultAgent).toBe("assistant")
  })

  it("waits for a model account before it creates anything", () => {
    expect(() => createFirstAgent(env(), { name: "A" })).toThrow(/Connect a model account first/)
    expect(existsSync(join(dir, "agentx.json"))).toBe(false)
  })

  it("puts the agent in the folder typed: relative to here, or under the home folder", () => {
    expect(workspacePath(dir, "", "a")).toBe(join(dir, "agents", "a"))
    expect(workspacePath(dir, "work/a", "a")).toBe(join(dir, "work", "a"))
    expect(workspacePath(dir, "~/Projects/a", "a")).toMatch(/\/Projects\/a$/)
    const out = createFirstAgent(env(claudeIn), { name: "A", workspace: "work/a" })
    expect(raw().agents.a.workspace).toBe(join(dir, "work", "a"))
    expect(out.agent.workspace).toBe(join(dir, "work", "a"))
  })

  it("says why a folder can't be used instead of failing later", () => {
    writeFileSync(join(dir, "file"), "x")
    expect(() => ensureWritable(join(dir, "file"))).toThrow(/is a file, not a folder/)
    const ro = join(dir, "ro")
    ensureWritable(ro)
    chmodSync(ro, 0o500)
    try {
      if (process.getuid?.() !== 0) expect(() => ensureWritable(ro)).toThrow(/can't write to the folder/)
    } finally { chmodSync(ro, 0o700) }
    expect(() => createFirstAgent(env(claudeIn), { name: "x".repeat(61) })).toThrow(/under 60/)
  })

  it("reads the agent the wizard is about: the default one", () => {
    expect(firstAgent(dir)).toBeNull()
    runWizard(firstAgentPayload("box", true), dir)
    expect(firstAgent(dir)).toMatchObject({ id: "assistant", engine: "claude-code" })
  })
})

describe("who is sent to /setup", () => {
  const none = { configExists: false, agentCount: 0 }
  const empty = { configExists: true, agentCount: 0 }
  const one = { configExists: true, agentCount: 1 }
  it("sends / and a person opening the Hub to the wizard while there is no agent", () => {
    expect(setupRedirect("/", none, {})).toBe("/setup")
    expect(setupRedirect("/", empty, {})).toBe("/setup")
    expect(setupRedirect(HUB_PATH, empty, { "sec-fetch-mode": "navigate" })).toBe("/setup")
    expect(setupRedirect(HUB_PATH, none, { accept: "text/html,application/xhtml+xml" })).toBe("/setup")
  })
  it("leaves scripts, other pages and an install with an agent alone", () => {
    expect(setupRedirect(HUB_PATH, empty, { accept: "*/*" })).toBeNull()
    expect(setupRedirect("/live", empty, { "sec-fetch-mode": "navigate" })).toBeNull()
    expect(setupRedirect("/", one, {})).toBeNull()
    expect(setupRedirect(HUB_PATH, one, { "sec-fetch-mode": "navigate" })).toBeNull()
  })
})

describe("errors as one plain sentence with the next step", () => {
  it.each([
    ["spawn claude ENOENT", /not installed.*npm install -g @anthropic-ai\/claude-code/],
    ["Credit balance is too low", /no credits left/],
    ["Invalid API key · Please run /login", /not signed in, or the key is wrong/],
    ["authentication_error: invalid x-api-key", /not signed in, or the key is wrong/],
    ["fetch failed", /background service is not running/],
    ['no agent "assistant" on this node', /has not loaded your agent/],
    ["assistant requires SQLite", /local database/],
    ["listen EADDRINUSE :::18800", /port AgentX uses is taken/],
  ])("%s", (raw, want) => {
    expect(plainError(raw)).toMatch(want)
  })
  it("never shows a stack trace: only the first line of an unknown error", () => {
    const e = new Error("boom happened\n    at foo (x.js:1:1)\n    at bar (y.js:2:2)")
    const s = plainError(e)
    expect(s).toContain("boom happened")
    expect(s).not.toContain("x.js")
  })
})
