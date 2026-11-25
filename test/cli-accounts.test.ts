import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { changeCliAccounts, cliAccountsView, readCliAccounts, withCliAccountEnv } from "../src/agents/cli-accounts"
import { hubAccountsHtml, hubAccountsText } from "../src/daemon/ui/pages/hub-status"
import { renderWallPage } from "../src/daemon/ui/pages/wall"

// #2101 P9b: CLI account profiles and the switch for new runs.
let dir: string, file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cli-acct-")); file = join(dir, ".agentx", "cli-accounts.json") })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("profiles", () => {
  it("adds a profile with ~ expanded, picks it, and keeps the file owner-only", () => {
    changeCliAccounts({ provider: "claude", action: "add", name: "work", dir: "~/.claude-work" }, file, dir)
    const s = changeCliAccounts({ provider: "claude", action: "use", name: "work" }, file, dir)
    expect(s.claude).toEqual({ profiles: [{ name: "work", dir: join(dir, ".claude-work") }], active: "work" })
    expect(readCliAccounts(file)).toEqual(s)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
  it("removing the active profile falls back to default", () => {
    changeCliAccounts({ provider: "codex", action: "add", name: "alt", dir: "/tmp/codex-alt" }, file, dir)
    changeCliAccounts({ provider: "codex", action: "use", name: "alt" }, file, dir)
    expect(changeCliAccounts({ provider: "codex", action: "remove", name: "alt" }, file, dir).codex).toEqual({ profiles: [], active: "default" })
  })
  it("refuses unknown providers, bad names, duplicates, default as a name, a missing dir and unknown profiles", () => {
    const bad = (b: any, status: number) => { try { changeCliAccounts(b, file, dir); throw new Error("no throw") } catch (e: any) { expect(e.status).toBe(status) } }
    bad({ provider: "gemini", action: "use", name: "x" }, 400)
    bad({ provider: "claude", action: "add", name: "../x", dir: "/a" }, 400)
    bad({ provider: "claude", action: "add", name: "default", dir: "/a" }, 400)
    bad({ provider: "claude", action: "add", name: "w" }, 400)
    bad({ provider: "claude", action: "use", name: "nope" }, 404)
    changeCliAccounts({ provider: "claude", action: "add", name: "w", dir: "/a" }, file, dir)
    bad({ provider: "claude", action: "add", name: "w", dir: "/b" }, 409)
    bad({ provider: "claude", action: "wipe", name: "w" }, 400)
  })
  it("drops what a hand-edited file gets wrong", () => {
    mkdirSync(join(dir, ".agentx"), { recursive: true })
    writeFileSync(file, JSON.stringify({ claude: { profiles: [{ name: "ok", dir: "/x" }, { name: "rel", dir: "x" }, { name: "bad name", dir: "/y" }], active: "rel" }, other: {} }))
    expect(readCliAccounts(file)).toEqual({ claude: { profiles: [{ name: "ok", dir: "/x" }], active: "default" } })
    expect(readCliAccounts(join(dir, "missing.json"))).toEqual({})
  })
})

describe("the environment of a new CLI process", () => {
  const state = { claude: { profiles: [{ name: "work", dir: "/c/work" }], active: "work" }, codex: { profiles: [{ name: "alt", dir: "/x/alt" }], active: "default" } }
  it("sets the active profile's folder, and nothing for a provider on default", () => {
    const env = withCliAccountEnv({ PATH: "/bin" }, [], state)
    expect(env.CLAUDE_CONFIG_DIR).toBe("/c/work")
    expect(env.CODEX_HOME).toBeUndefined()
  })
  it("leaves a workspace's own setting alone", () => {
    expect(withCliAccountEnv({ CLAUDE_CONFIG_DIR: "/agent/own" }, ["CLAUDE_CONFIG_DIR"], state).CLAUDE_CONFIG_DIR).toBe("/agent/own")
  })
  it("never puts a credential in the view: names, folders and whether they exist", () => {
    const v = cliAccountsView(state, dir)
    expect(v.map((p) => p.provider)).toEqual(["claude", "codex"])
    expect(v[0].profiles[0]).toEqual({ name: "default", dir: join(dir, ".claude"), exists: false })
    expect(JSON.stringify(v)).not.toMatch(/token|key|secret/i)
  })
})

describe("the Hub's picker", () => {
  const view = cliAccountsView({ claude: { profiles: [{ name: "work", dir: "/c/<w>" }], active: "work" } }, "/home/x")
  const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  it("says each provider's active profile", () => {
    expect(hubAccountsText(view)).toBe("Claude Code: work · Codex: default")
  })
  it("draws a checked radio for the active one, Remove only for added ones, escaped", () => {
    const h = hubAccountsHtml(view, esc)
    expect(h).toContain('data-hsa-use="claude" value="work" checked>')
    expect(h).toContain("<code>/c/&lt;w&gt;</code>")
    expect(h.match(/data-hsa-rm=/g)).toHaveLength(1)
    expect(h).toContain('data-hsa-add="codex"')
  })
  it("is on the page, and only the owner's page asks for it", () => {
    const page = renderWallPage({ owner: true })
    expect(page).toContain('id="hs-acct"')
    expect(page).toContain("if (window.AX_WALL_SETTINGS) hsAccounts();")
  })
})

describe("persistent chats (review of 5ac450af)", () => {
  it("a workspace .env folder wins over the active profile", async () => {
    const { withWorkspaceCliAccountEnv } = await import("../src/utils/workspace-env")
    const ws = join(dir, "own-ws"); mkdirSync(ws)
    writeFileSync(join(ws, ".env"), "CLAUDE_CONFIG_DIR=/tmp/claude-own\nCODEX_HOME=/tmp/codex-own\n")
    const env = withWorkspaceCliAccountEnv({ CLAUDE_CONFIG_DIR: "/tmp/parent" }, ws)
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-own")
    expect(env.CODEX_HOME).toBe("/tmp/codex-own")
  })
  it("without one, the active profile applies", () => {
    changeCliAccounts({ provider: "claude", action: "add", name: "work", dir: "/tmp/claude-work" }, file, dir)
    const state = changeCliAccounts({ provider: "claude", action: "use", name: "work" }, file, dir)
    expect(withCliAccountEnv({ CLAUDE_CONFIG_DIR: "/tmp/parent" }, [], state).CLAUDE_CONFIG_DIR).toBe("/tmp/claude-work")
    expect(withCliAccountEnv({ CLAUDE_CONFIG_DIR: "/tmp/parent" }, ["CLAUDE_CONFIG_DIR"], state).CLAUDE_CONFIG_DIR).toBe("/tmp/parent")
  })
})
