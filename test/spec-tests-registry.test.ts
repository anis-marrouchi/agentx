import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #992 — how the registry wires spec tests into a cloud session launch:
// with the switch off nothing changes (no `gh` call, same prompt); with it
// on, the test agent starts only beside a new session that launched.

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  runSpecTests: vi.fn(),
  launch: vi.fn(),
}))
vi.mock("../src/agents/spec-tests", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, execProcess: mocks.exec, runSpecTests: mocks.runSpecTests }
})
vi.mock("../src/agents/cloud-sessions", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, launchCloudSession: mocks.launch }
})

import { AgentRegistry } from "../src/agents/registry"
import { buildCloudPrompt, type CloudRoute } from "../src/agents/cloud-sessions"
import { daemonConfigSchema } from "../src/daemon/config"

const ISSUE = { title: "Retry webhooks in src/daemon/webhooks.ts", body: "## Acceptance criteria\n- [ ] A 500 is retried." }
const MESSAGE = "Fix the webhook retries"

let dir: string
const prevCwd = process.cwd()
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-spec-reg-"))
  process.chdir(dir)
  mocks.exec.mockReset().mockResolvedValue({ code: 0, stdout: JSON.stringify(ISSUE), stderr: "" })
  mocks.runSpecTests.mockReset().mockResolvedValue({ status: "pushed" })
  mocks.launch.mockReset().mockResolvedValue({ ok: true, sessionId: "session_new", url: "https://example.invalid/s" })
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function setup(specTests: Record<string, unknown>) {
  const config = daemonConfigSchema.parse({
    node: { id: "test", name: "test" },
    agents: { coder: { name: "Coder", tier: "claude-code", workspace: dir, maxConcurrent: 1, cloudSessions: { enabled: true } } },
    quality: { specTests },
  })
  const registry = new AgentRegistry(config, () => {}) as any
  const route: CloudRoute = { route: "cloud", repo: "example-org/example-repo", kind: "issue", number: 42, cwd: dir }
  const run = (r: CloudRoute = route) => registry.runCloudSession(
    { workspace: dir, cloudSessions: { enabled: true } },
    { message: MESSAGE, agentId: "coder", context: { channel: "github", chatId: "example-org/example-repo#42" } },
    r,
    "trace-1",
  )
  return { route, run }
}

const ghCalls = () => mocks.exec.mock.calls.filter(([cmd]) => cmd === "gh")

describe("spec tests in the registry", () => {
  it("with the switch off, gh is not called and the cloud prompt is unchanged", async () => {
    const { route, run } = setup({ enabled: false })
    const res = await run()
    expect(res?.cloudSession).toMatchObject({ id: "session_new" })
    expect(ghCalls()).toEqual([])
    expect(mocks.launch).toHaveBeenCalledTimes(1)
    expect(mocks.launch.mock.calls[0][0].prompt).toBe(buildCloudPrompt(MESSAGE, route as any))
    expect(mocks.runSpecTests).not.toHaveBeenCalled()
  })

  it("with the switch on, a new session gets the instructions and the test agent starts", async () => {
    const { run } = setup({ enabled: true })
    await run()
    expect(ghCalls()).toHaveLength(1)
    expect(ghCalls()[0][1]).toEqual(expect.arrayContaining(["issue", "view", "42"]))
    expect(mocks.launch.mock.calls[0][0].prompt).toContain("spec-tests/issue-42")
    await vi.waitFor(() => expect(mocks.runSpecTests).toHaveBeenCalledTimes(1))
    const deps = mocks.runSpecTests.mock.calls[0][0]
    expect(deps).toMatchObject({ codeAgent: "coder", checkout: dir, input: { number: 42, title: ISSUE.title } })
  })

  it("does not start the test agent when the launch fails", async () => {
    mocks.launch.mockResolvedValue({ ok: false, reason: "not signed in" })
    const { run } = setup({ enabled: true })
    expect(await run()).toBeNull()
    await new Promise((r) => setTimeout(r, 20))
    expect(mocks.runSpecTests).not.toHaveBeenCalled()
  })

  it("does not start the test agent for a follow-up to an open session", async () => {
    const { run } = setup({ enabled: true })
    const followUp: CloudRoute = { route: "follow-up", session: { repo: "example-org/example-repo", number: 42, kind: "issue", sessionId: "session_old", url: "https://example.invalid/o", agentId: "coder", startedAt: Date.now(), cwd: dir } as any }
    await run(followUp)
    expect(ghCalls()).toEqual([])
    expect(mocks.launch.mock.calls[0][0].prompt).toBe(MESSAGE)
    await new Promise((r) => setTimeout(r, 20))
    expect(mocks.runSpecTests).not.toHaveBeenCalled()
  })

  it("does not start the test agent for an issue outside the pilot paths", async () => {
    mocks.exec.mockResolvedValue({ code: 0, stdout: JSON.stringify({ title: "Fix src/wiki search", body: "" }), stderr: "" })
    const { route, run } = setup({ enabled: true })
    await run()
    expect(mocks.launch.mock.calls[0][0].prompt).toBe(buildCloudPrompt(MESSAGE, route as any))
    await new Promise((r) => setTimeout(r, 20))
    expect(mocks.runSpecTests).not.toHaveBeenCalled()
  })
})
