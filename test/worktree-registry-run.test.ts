import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #2102 review, through a real AgentRegistry turn with the runtime mocked:
// every agent is told its PR marker, worktrees or not; and an issue whose
// session existed before this turn stays in the checkout even when the
// turn rotates that session.

const calls = vi.hoisted(() => [] as Array<{ cwd?: string; system?: string; resume?: string }>)
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return {
    ...real,
    executeTask: (_def: any, task: any, _providers: any, _onDelta: any, _history: string, resumeSessionId?: string) => {
      calls.push({ cwd: task.cwd, system: task.systemPromptAppend, resume: resumeSessionId })
      return Promise.resolve({ content: "ok", duration: 1, claudeSessionId: resumeSessionId ?? "native-new" })
    },
  }
})
vi.mock("../src/agents/rotation-memo", () => ({
  extractRotationMemo: async () => ({ memo: undefined, reason: "test", durationMs: 0 }),
}))

import { AgentRegistry } from "../src/agents/registry"
import { remotePath } from "../src/agents/task-worktrees"
import { daemonConfigSchema } from "../src/daemon/config"

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim()

let base: string
let checkout: string
let repo: string
let lines: string[]
const prevCwd = process.cwd()

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "agentx-wt-run-"))
  const origin = join(base, "origin.git")
  checkout = join(base, "api")
  const url = `file://localhost${origin}`
  repo = remotePath(url)!
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin])
  execFileSync("git", ["clone", "-q", url, checkout])
  writeFileSync(join(checkout, "README.md"), "hello\n")
  git(checkout, "add", ".")
  git(checkout, "commit", "-q", "-m", "init")
  git(checkout, "push", "-q", "origin", "HEAD:main")
  git(checkout, "remote", "set-head", "origin", "main")
  process.chdir(base)
  calls.length = 0
  lines = []
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(base, { recursive: true, force: true })
})

function registry(worktrees: boolean): AgentRegistry {
  const config = daemonConfigSchema.parse({
    jobState: { enabled: false },
    node: { id: "t", name: "t" },
    agents: { coder: { name: "Coder", tier: "claude-code", workspace: checkout, worktrees: { enabled: worktrees } } },
  })
  return new AgentRegistry(config, (...a: unknown[]) => { lines.push(a.join(" ")) })
}

const turn = (r: AgentRegistry) =>
  r.execute({ message: "please fix it", agentId: "coder", context: { channel: "gitlab", chatId: `${repo}:issue:3`, sender: "Sam" } } as any)

describe("worktrees in a registry turn (#2102 review)", () => {
  it("tells an agent with worktrees off its PR marker", async () => {
    await turn(registry(false))
    expect(calls).toHaveLength(1)
    expect(calls[0].cwd).toBeUndefined()
    expect(calls[0].system).toContain("<!-- agentx:coder -->")
  })

  it("says the marker once in a worktree", async () => {
    await turn(registry(true))
    expect(calls[0].cwd).toBe(join(base, ".agentx-worktrees", "api", "issue-3"))
    expect(calls[0].system!.split("<!-- agentx:coder -->")).toHaveLength(2)
  })

  it("keeps an issue whose session this turn rotates in the checkout (B5)", async () => {
    const r = registry(true)
    const sessions = (r as any).sessions
    sessions.setClaudeSessionId("coder", "gitlab", `${repo}:issue:3`, "native-1")
    // Idle past staleMinutes (12 h): this turn starts a new session.
    sessions.getSession("coder", "gitlab", `${repo}:issue:3`).updatedAt = new Date(Date.now() - 13 * 3_600_000).toISOString()
    await turn(r)
    expect(calls).toHaveLength(1)
    expect(calls[0].resume).toBeUndefined()
    expect(calls[0].cwd).toBeUndefined()
    expect(existsSync(join(base, ".agentx-worktrees"))).toBe(false)
    expect(lines.join("\n")).toContain("in progress before worktrees (session)")
  })

  it("counts an earlier reply as a session for a runtime with no native one (B5)", async () => {
    const r = registry(true)
    const sessions = (r as any).sessions
    sessions.addAgentMessage("coder", "gitlab", `${repo}:issue:3`, "Looking into it.")
    await turn(r)
    expect(calls[0].cwd).toBeUndefined()
    expect(lines.join("\n")).toContain("in progress before worktrees (session)")
  })
})
