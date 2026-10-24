import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  bindPort, defaultPayload, loopbackUrl, onPath, pickEngine, readTeam, resolveHomeDir, summaryLines,
} from "../src/commands/onboard-logic"
import { runWizard } from "../src/daemon/setup-wizard"

// agentx onboard (#1170): the decisions behind one command to a running agent.

let tmp: string
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "agentx-onboard-")) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe("the team folder", () => {
  it("is --dir when given, relative to where the command runs", () => {
    expect(resolveHomeDir({ dir: "team", cwd: tmp, home: "/home/x" }).dir).toBe(path.join(tmp, "team"))
  })

  it("stays where an existing install is", () => {
    writeFileSync(path.join(tmp, "agentx.json"), "{}")
    expect(resolveHomeDir({ cwd: tmp, home: "/home/x" }).dir).toBe(tmp)
  })

  it("is ~/agentx for a new install, not whatever folder the terminal is in", () => {
    expect(resolveHomeDir({ cwd: tmp, home: "/home/x" }).dir).toBe(path.join("/home/x", "agentx"))
  })
})

describe("reading the team", () => {
  it("has no team before the wizard writes one, nor while the file is half written", () => {
    expect(readTeam(tmp).agents).toEqual([])
    writeFileSync(path.join(tmp, "agentx.json"), '{"agents": {')
    expect(readTeam(tmp).configured).toBe(false)
  })

  it("reads the agents, the daemon's address and Telegram from what the wizard wrote", () => {
    runWizard({ nodeName: "Demo team", agent: { id: "helper", name: "Helper", triggerWords: "@helper", tier: "sdk" } }, tmp)
    const team = readTeam(tmp)
    expect(team.agents).toEqual([{ id: "helper", name: "Helper" }])
    expect(team.bind).toBe("127.0.0.1:18800")
    expect(team.telegram).toBe(false)
  })

  it("turns a bind address into a loopback URL", () => {
    expect(loopbackUrl("0.0.0.0:18800")).toBe("http://127.0.0.1:18800")
    expect(loopbackUrl("127.0.0.1:19000")).toBe("http://127.0.0.1:19000")
    expect(bindPort("0.0.0.0:18801")).toBe(18801)
  })
})

describe("--yes picks an engine without asking", () => {
  const has = (...bins: string[]) => (b: string) => bins.includes(b)
  it("prefers a signed-in coding CLI, then an Anthropic key, else asks", () => {
    expect(pickEngine({ onPath: has("claude", "codex"), env: {} })).toBe("claude-code")
    expect(pickEngine({ onPath: has("codex"), env: {} })).toBe("codex-cli")
    expect(pickEngine({ onPath: has("opencode"), env: {} })).toBe("opencode")
    expect(pickEngine({ onPath: has(), env: { ANTHROPIC_API_KEY: "sk-test" } })).toBe("sdk")
    expect(pickEngine({ onPath: has(), env: {} })).toBeUndefined()
  })

  it("finds a program on PATH", () => {
    const bin = path.join(tmp, "bin")
    mkdirSync(bin)
    writeFileSync(path.join(bin, "claude"), "")
    expect(onPath("claude", { PATH: bin })).toBe(true)
    expect(onPath("codex", { PATH: bin })).toBe(false)
  })

  it("writes the same team the wizard would, and passes the key only to the API engine", () => {
    expect(defaultPayload("box", "claude-code", { ANTHROPIC_API_KEY: "sk-test" }).anthropicApiKey).toBeUndefined()
    expect(defaultPayload("box", "sdk", { ANTHROPIC_API_KEY: "sk-test" }).anthropicApiKey).toBe("sk-test")
    runWizard(defaultPayload("box", "claude-code", {}), tmp)
    expect(readTeam(tmp).agents).toEqual([{ id: "assistant", name: "Assistant" }])
  })
})

describe("the closing lines", () => {
  it("say which agent is answering, where, and where its files are", () => {
    const lines = summaryLines({
      team: { configured: true, agents: [{ id: "assistant", name: "Assistant" }, { id: "writer", name: "Writer" }], bind: "127.0.0.1:18800", telegram: true },
      daemonUrl: "http://127.0.0.1:18800", dashboardUrl: "http://127.0.0.1:4202", dir: "/home/x/agentx", cmd: "npx agentix-cli", seconds: 12,
    })
    expect(lines[0]).toBe("Your first agent, Assistant (@assistant), is answering at http://127.0.0.1:18800")
    expect(lines.join("\n")).toContain("http://127.0.0.1:4202/live")
    expect(lines.join("\n")).toContain("@writer")
    expect(lines.join("\n")).toContain("Telegram")
    expect(lines.join("\n")).toContain("/home/x/agentx")
    expect(lines.at(-1)).toContain("npx agentix-cli onboard")
  })
})

describe("the wizard under onboard", () => {
  it("tells the person onboard starts the daemon, not to start it themselves", () => {
    process.env.AGENTX_ONBOARD = "1"
    try {
      const r = runWizard({ nodeName: "Demo", agent: { id: "a", name: "A", triggerWords: "@a", tier: "sdk" } }, tmp)
      expect(r.onboard).toBe(true)
      expect(r.nextSteps.join(" ")).not.toContain("agentx daemon start")
    } finally {
      delete process.env.AGENTX_ONBOARD
    }
  })
})
