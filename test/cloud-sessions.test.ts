import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "events"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { execFileSync, spawn as realSpawn } from "child_process"
import {
  CLOUD_SESSIONS_DEFAULTS,
  CloudSessionStore,
  PTY_WRAPPER,
  buildCloudPrompt,
  cloudClaudeArgs,
  decideCloudRoute,
  dispatchCloudSession,
  launchCloudSession,
  parseCloudLaunchOutput,
  parseGitHubChatId,
  parseGitHubRemote,
  stripTerminalCodes,
  type CloudLaunchResult,
  type CloudRoute,
  type OpenCloudSession,
  type SpawnFn,
} from "../src/agents/cloud-sessions"
import { daemonConfigSchema } from "../src/daemon/config"

// #622 — an agent can run a GitHub coding task as a Claude cloud session.
// Off by default; GitHub-repo tasks only; a failed launch runs locally.

const REPO_DIR = "/srv/checkouts/example-repo"
const remotes: Record<string, string | undefined> = {
  [REPO_DIR]: "git@github.com:example-org/example-repo.git",
  "/srv/agents/coder": undefined,
  "/srv/checkouts/mirror": "https://gitlab.example.com/example-org/example-repo.git",
}
const remoteOf = (dir: string) => remotes[dir]

const agentOn = { tier: "claude-code", workspace: "/srv/agents/coder", cloudSessions: { ...CLOUD_SESSIONS_DEFAULTS, enabled: true } }
const githubIssue = { channel: "github", chatId: "example-org/example-repo:issue:42", runbookPath: REPO_DIR }

describe("decideCloudRoute", () => {
  it("is off by default: the task runs locally and nothing else changes", () => {
    const route = decideCloudRoute({ agent: { tier: "claude-code", workspace: REPO_DIR }, channelEnabled: true, context: githubIssue, remoteOf })
    expect(route).toEqual({ route: "local", reason: "cloud sessions are off for this agent" })
  })

  it("sends a GitHub issue task to the cloud when the agent and the channel are on", () => {
    const route = decideCloudRoute({ agent: agentOn, channelEnabled: true, context: githubIssue, remoteOf })
    expect(route).toEqual({ route: "cloud", repo: "example-org/example-repo", kind: "issue", number: 42, cwd: REPO_DIR })
  })

  it("accepts a pull request task too", () => {
    const route = decideCloudRoute({ agent: agentOn, channelEnabled: true, context: { ...githubIssue, chatId: "example-org/example-repo:pull:7" }, remoteOf })
    expect(route).toMatchObject({ route: "cloud", kind: "pull", number: 7 })
  })

  it("stays local when the channel setting is off", () => {
    const route = decideCloudRoute({ agent: agentOn, channelEnabled: false, context: githubIssue, remoteOf })
    expect(route).toMatchObject({ route: "local", reason: expect.stringContaining("github channel") })
  })

  it("stays local for every channel but GitHub", () => {
    for (const context of [
      { channel: "gitlab", chatId: "example-org/example-repo:issue:42", runbookPath: REPO_DIR },
      { channel: "telegram", chatId: "12345" },
      { channel: "cron", chatId: "nightly" },
      { channel: undefined, chatId: undefined },
    ]) {
      const route = decideCloudRoute({ agent: agentOn, channelEnabled: true, context, remoteOf })
      expect(route.route, context.channel).toBe("local")
    }
  })

  it("stays local for a push event on the GitHub channel: only issues and pull requests are coding tasks", () => {
    const route = decideCloudRoute({ agent: agentOn, channelEnabled: true, context: { channel: "github", chatId: "example-org/example-repo:push:refs/heads/main" }, remoteOf })
    expect(route).toMatchObject({ route: "local", reason: expect.stringContaining("not for a GitHub issue") })
  })

  it("stays local when the repository is not on GitHub: the checkout's origin is elsewhere", () => {
    const route = decideCloudRoute({ agent: agentOn, channelEnabled: true, context: { ...githubIssue, runbookPath: "/srv/checkouts/mirror" }, remoteOf })
    expect(route).toMatchObject({ route: "local", reason: expect.stringContaining("no checkout of example-org/example-repo") })
  })

  it("stays local when neither the project rule path nor the workspace is a checkout of the repository", () => {
    const route = decideCloudRoute({ agent: agentOn, channelEnabled: true, context: { ...githubIssue, runbookPath: undefined }, remoteOf })
    expect(route).toMatchObject({ route: "local", reason: expect.stringContaining("/srv/agents/coder") })
  })

  it("falls back to the agent workspace when it is the checkout", () => {
    const route = decideCloudRoute({ agent: { ...agentOn, workspace: REPO_DIR }, channelEnabled: true, context: { ...githubIssue, runbookPath: undefined }, remoteOf })
    expect(route).toMatchObject({ route: "cloud", cwd: REPO_DIR })
  })

  it("matches the repository name case-insensitively", () => {
    const route = decideCloudRoute({ agent: agentOn, channelEnabled: true, context: { ...githubIssue, chatId: "Example-Org/Example-Repo:issue:42" }, remoteOf })
    expect(route).toMatchObject({ route: "cloud", repo: "Example-Org/Example-Repo" })
  })

  it("refuses a checkout of a different GitHub repository", () => {
    const route = decideCloudRoute({ agent: agentOn, channelEnabled: true, context: { ...githubIssue, chatId: "example-org/other-repo:issue:1" }, remoteOf })
    expect(route.route).toBe("local")
  })

  it("stays local for agents that are not claude-code", () => {
    const route = decideCloudRoute({ agent: { ...agentOn, tier: "codex-cli" }, channelEnabled: true, context: githubIssue, remoteOf })
    expect(route).toMatchObject({ route: "local", reason: expect.stringContaining("codex-cli") })
  })

  it("forwards to the open session for the same issue instead of starting anything", () => {
    const session: OpenCloudSession = { repo: "example-org/example-repo", number: 42, kind: "issue", sessionId: "session_01OPEN", url: "https://claude.ai/code/session_01OPEN", agentId: "coder", startedAt: 1 }
    const route = decideCloudRoute({ agent: agentOn, channelEnabled: true, context: githubIssue, remoteOf, openSession: session })
    expect(route).toEqual({ route: "follow-up", session })
  })

  it("stays local once the daily cap is reached, and ignores a cap of 0", () => {
    const capped = { ...agentOn, cloudSessions: { ...agentOn.cloudSessions, maxPerDay: 3 } }
    expect(decideCloudRoute({ agent: capped, channelEnabled: true, context: githubIssue, remoteOf, launchesToday: 3 })).toMatchObject({ route: "local", reason: "daily cap of 3 cloud launches reached" })
    expect(decideCloudRoute({ agent: capped, channelEnabled: true, context: githubIssue, remoteOf, launchesToday: 2 }).route).toBe("cloud")
    expect(decideCloudRoute({ agent: agentOn, channelEnabled: true, context: githubIssue, remoteOf, launchesToday: 500 }).route).toBe("cloud")
  })
})

describe("parseGitHubRemote / parseGitHubChatId", () => {
  it("reads owner/repo from the usual remote shapes and nothing else", () => {
    for (const url of [
      "git@github.com:example-org/example-repo.git",
      "https://github.com/example-org/example-repo",
      "https://github.com/example-org/example-repo.git",
      "ssh://git@github.com/example-org/example-repo.git",
      "https://user@github.com/example-org/example-repo/",
      "github.com/example-org/example-repo",
    ]) expect(parseGitHubRemote(url), url).toBe("example-org/example-repo")
    for (const url of ["https://gitlab.com/example-org/example-repo.git", "git@example.com:a/b.git", "", undefined, "https://github.com/example-org"]) {
      expect(parseGitHubRemote(url), String(url)).toBeUndefined()
    }
  })

  it("reads the repository and number from a GitHub chat id", () => {
    expect(parseGitHubChatId("example-org/example-repo:issue:42")).toEqual({ repo: "example-org/example-repo", kind: "issue", number: 42 })
    expect(parseGitHubChatId("example-org/example-repo:pull:7")).toEqual({ repo: "example-org/example-repo", kind: "pull", number: 7 })
    for (const id of ["example-org/example-repo:push:refs/heads/main", "12345", "", undefined, "example-org/example-repo:issue:x", "example-org:issue:1"]) {
      expect(parseGitHubChatId(id), String(id)).toBeUndefined()
    }
  })
})

describe("parseCloudLaunchOutput", () => {
  it("finds the session id and URL under terminal colour codes and carriage returns", () => {
    const raw = "\x1b[1mCreating cloud session…\x1b[0m\r\n\x1b[32m✓\x1b[0m Session session_01ABCdef123 created\r\n  https://claude.ai/code/session_01ABCdef123\r\n"
    expect(parseCloudLaunchOutput(raw)).toEqual({ sessionId: "session_01ABCdef123", url: "https://claude.ai/code/session_01ABCdef123" })
    expect(stripTerminalCodes("\x1b]0;title\x07a\x1b[2Kb")).toBe("ab")
  })

  it("takes the id from the URL when it is not printed on its own", () => {
    expect(parseCloudLaunchOutput("Open https://claude.ai/code/session_01XYZ to follow along")).toEqual({ sessionId: "session_01XYZ", url: "https://claude.ai/code/session_01XYZ" })
  })

  it("finds nothing in unrelated output", () => {
    expect(parseCloudLaunchOutput("Not logged in. Run claude login first.")).toEqual({ sessionId: undefined, url: undefined })
  })
})

describe("cloudClaudeArgs / buildCloudPrompt", () => {
  it("creates a session with the prompt, or forwards to an open one", () => {
    expect(cloudClaudeArgs("fix it")).toEqual(["--cloud", "fix it"])
    expect(cloudClaudeArgs("more", "session_01A")).toEqual(["-p", "more", "--cloud", "session_01A"])
  })

  it("names the issue and asks for a pull request, and caps the length", () => {
    const prompt = buildCloudPrompt("Fix the login redirect", { repo: "example-org/example-repo", kind: "issue", number: 42 })
    expect(prompt.startsWith("Fix the login redirect")).toBe(true)
    expect(prompt).toContain("issue #42 in example-org/example-repo")
    expect(prompt).toContain("pull request that references #42")
    const long = buildCloudPrompt("x".repeat(200_000), { repo: "o/r", kind: "pull", number: 1 })
    expect(long.length).toBeLessThan(101_000)
    expect(long).toContain("[message cut at")
  })
})

/** A fake child process: output then exit, or an error event. */
function fakeSpawn(script: (proc: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: ReturnType<typeof vi.fn> }) => void): { spawn: SpawnFn; calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = []
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env })
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242, kill: vi.fn() })
    setTimeout(() => script(proc), 0)
    return proc as any
  }
  return { spawn, calls }
}

describe("launchCloudSession", () => {
  it("spawns claude --cloud under a pty in the checkout and returns the session", async () => {
    const { spawn, calls } = fakeSpawn((p) => {
      p.stdout.emit("data", Buffer.from("Session session_01ABC\n"))
      p.stdout.emit("data", Buffer.from("https://claude.ai/code/session_01ABC\n"))
      p.emit("close", 0)
    })
    const result = await launchCloudSession({ cwd: REPO_DIR, prompt: "Fix #42", env: { HOME: "/home/you" }, timeoutMs: 5_000, spawn })
    expect(result).toMatchObject({ ok: true, sessionId: "session_01ABC", url: "https://claude.ai/code/session_01ABC" })
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe("python3")
    expect(calls[0].args).toEqual(["-c", PTY_WRAPPER, "claude", "--cloud", "Fix #42"])
    expect(calls[0].cwd).toBe(REPO_DIR)
    expect(calls[0].env).toMatchObject({ HOME: "/home/you", NO_COLOR: "1" })
  })

  it("forwards a follow-up with -p to the open session", async () => {
    const { spawn, calls } = fakeSpawn((p) => p.emit("close", 0))
    const result = await launchCloudSession({ cwd: "/tmp", prompt: "also update the docs", sessionId: "session_01OPEN", env: {}, timeoutMs: 5_000, spawn })
    expect(result).toMatchObject({ ok: true, sessionId: "session_01OPEN" })
    expect(calls[0].args.slice(2)).toEqual(["claude", "-p", "also update the docs", "--cloud", "session_01OPEN"])
  })

  it("fails with the output tail when claude exits without a session", async () => {
    const { spawn } = fakeSpawn((p) => {
      p.stderr.emit("data", Buffer.from("Not logged in\n"))
      p.emit("close", 1)
    })
    const result = await launchCloudSession({ cwd: REPO_DIR, prompt: "x", env: {}, timeoutMs: 5_000, spawn })
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("exited with code 1") })
    expect((result as { reason: string }).reason).toContain("Not logged in")
  })

  it("fails when claude exits 0 but printed no session", async () => {
    const { spawn } = fakeSpawn((p) => { p.stdout.emit("data", "done\n"); p.emit("close", 0) })
    const result = await launchCloudSession({ cwd: REPO_DIR, prompt: "x", env: {}, timeoutMs: 5_000, spawn })
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("no session id or URL") })
  })

  it("fails when python3 is missing", async () => {
    const { spawn } = fakeSpawn((p) => p.emit("error", Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" })))
    const result = await launchCloudSession({ cwd: REPO_DIR, prompt: "x", env: {}, timeoutMs: 5_000, spawn })
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("python3 is not installed") })
  })

  it("gives up after the timeout and stops the process group", async () => {
    const killed: Array<[number, string]> = []
    const origKill = process.kill
    ;(process as any).kill = (pid: number, signal: string) => { killed.push([pid, signal]); return true }
    try {
      const { spawn } = fakeSpawn((p) => p.stdout.emit("data", "Creating session…\n"))
      const result = await launchCloudSession({ cwd: REPO_DIR, prompt: "x", env: {}, timeoutMs: 30, spawn })
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("did not print a session within") })
      expect(killed).toContainEqual([-4242, "SIGTERM"])
    } finally {
      ;(process as any).kill = origKill
    }
  })

  it("runs for real under python's pty: the child gets a terminal and its exit code is kept", async () => {
    let python = ""
    try { python = execFileSync("python3", ["-c", "import pty; print('ok')"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() } catch { /* no python here */ }
    if (python !== "ok") return
    const ok = await launchCloudSession({ cwd: tmpdir(), prompt: "ignored", env: { ...process.env }, timeoutMs: 10_000,
      // Replace `claude` by a shell script that behaves like it, through the real spawn.
      spawn: (cmd, args, o) => realSpawn(cmd, [args[0], args[1], "sh", "-c", "test -t 0 && echo 'Session: https://claude.ai/code/session_01REAL'"], o) })
    expect(ok).toMatchObject({ ok: true, sessionId: "session_01REAL" })
    const failed = await launchCloudSession({ cwd: tmpdir(), prompt: "ignored", env: { ...process.env }, timeoutMs: 10_000,
      spawn: (cmd, args, o) => realSpawn(cmd, [args[0], args[1], "sh", "-c", "echo nope; exit 3"], o) })
    expect(failed).toMatchObject({ ok: false, reason: expect.stringContaining("code 3") })
  })
})

describe("CloudSessionStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentx-cloud-"))
  const file = join(dir, ".agentx", "cloud-sessions.json")
  const base: OpenCloudSession = { repo: "example-org/example-repo", number: 42, kind: "issue", sessionId: "session_01A", url: "https://claude.ai/code/session_01A", agentId: "coder", startedAt: Date.parse("2026-10-04T10:00:00Z") }

  it("keeps a launched session open for openHours, then forgets it", () => {
    const store = new CloudSessionStore(file)
    store.record(base)
    const t = base.startedAt
    expect(store.open("example-org/example-repo", 42, 24, t + 60_000)?.sessionId).toBe("session_01A")
    expect(store.open("Example-Org/Example-Repo", 42, 24, t + 23 * 3600_000)?.sessionId).toBe("session_01A")
    expect(store.open("example-org/example-repo", 42, 24, t + 25 * 3600_000)).toBeUndefined()
    expect(store.open("example-org/example-repo", 43, 24, t)).toBeUndefined()
    // Survives a restart: a new store reads the file.
    expect(new CloudSessionStore(file).open("example-org/example-repo", 42, 24, t)?.url).toBe(base.url)
    expect(JSON.parse(readFileSync(file, "utf8")).sessions).toHaveLength(1)
  })

  it("counts today's launches per agent, and close() forgets an issue", () => {
    const store = new CloudSessionStore(file)
    const now = base.startedAt + 3600_000
    store.record({ ...base, number: 43, sessionId: "session_01B", startedAt: base.startedAt + 1 })
    store.record({ ...base, number: 44, sessionId: "session_01C", agentId: "other", startedAt: base.startedAt + 2 })
    expect(store.launchesToday("coder", now)).toBe(2)
    expect(store.launchesToday("other", now)).toBe(1)
    expect(store.launchesToday("coder", now + 2 * 24 * 3600_000)).toBe(0)
    store.touch("session_01B", now)
    expect(store.all().find((s) => s.sessionId === "session_01B")?.lastMessageAt).toBe(now)
    expect(store.close("example-org/example-repo", 43)).toBe(true)
    expect(store.close("example-org/example-repo", 43)).toBe(false)
    expect(store.open("example-org/example-repo", 43, 24, now)).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it("starts empty on a missing or broken file", () => {
    const broken = mkdtempSync(join(tmpdir(), "agentx-cloud-"))
    expect(new CloudSessionStore(join(broken, "missing.json")).all()).toEqual([])
    rmSync(broken, { recursive: true, force: true })
  })
})

describe("dispatchCloudSession", () => {
  const cloudRoute: CloudRoute = { route: "cloud", repo: "example-org/example-repo", kind: "issue", number: 42, cwd: REPO_DIR }
  function deps(route: CloudRoute, launch: (opts: { cwd: string; prompt: string; sessionId?: string }) => Promise<CloudLaunchResult>) {
    const log: string[] = []
    const trace: any[] = []
    const store = { record: vi.fn(), touch: vi.fn() }
    return {
      deps: { route, agentId: "coder", message: "Fix the login redirect", settings: { ...CLOUD_SESSIONS_DEFAULTS, enabled: true }, store, launch, log: (l: string) => log.push(l), trace: (s: any) => trace.push(s), traceId: "01TRACE", now: () => 1_700_000_000_000 },
      log, trace, store,
    }
  }

  it("launches, records the session, and answers with its id and URL for the issue comment", async () => {
    const launch = vi.fn(async () => ({ ok: true as const, sessionId: "session_01NEW", url: "https://claude.ai/code/session_01NEW", output: "" }))
    const d = deps(cloudRoute, launch)
    const result = await dispatchCloudSession(d.deps)
    expect(result).toMatchObject({ cloudSession: { id: "session_01NEW", url: "https://claude.ai/code/session_01NEW" } })
    expect(result!.content).toContain("session_01NEW")
    expect(result!.content).toContain("https://claude.ai/code/session_01NEW")
    expect(result!.content).toContain("pull request")
    expect(launch).toHaveBeenCalledWith({ cwd: REPO_DIR, prompt: expect.stringContaining("Fix the login redirect") })
    expect(d.store.record).toHaveBeenCalledWith(expect.objectContaining({ repo: "example-org/example-repo", number: 42, sessionId: "session_01NEW", agentId: "coder", traceId: "01TRACE", startedAt: 1_700_000_000_000 }))
    // On the trace: the id and URL.
    expect(d.trace).toEqual([{ action: "launched", status: "ok", summary: expect.stringContaining("session_01NEW") }])
    expect(JSON.parse(d.trace[0].summary)).toMatchObject({ sessionId: "session_01NEW", url: "https://claude.ai/code/session_01NEW", number: 42 })
  })

  it("falls back to a local run when the launch fails, and logs the reason", async () => {
    const d = deps(cloudRoute, async () => ({ ok: false as const, reason: "claude --cloud exited with code 1: Not logged in", output: "" }))
    const result = await dispatchCloudSession(d.deps)
    expect(result).toBeNull()
    expect(d.store.record).not.toHaveBeenCalled()
    expect(d.log.join("\n")).toContain("running locally: claude --cloud exited with code 1: Not logged in")
    expect(d.trace).toEqual([{ action: "fallback", status: "error", summary: "claude --cloud exited with code 1: Not logged in" }])
  })

  it("runs locally and records why when the route is local", async () => {
    const launch = vi.fn()
    const d = deps({ route: "local", reason: "daily cap of 1 cloud launches reached" }, launch)
    expect(await dispatchCloudSession(d.deps)).toBeNull()
    expect(launch).not.toHaveBeenCalled()
    expect(d.trace).toEqual([{ action: "skipped", status: "ok", summary: "daily cap of 1 cloud launches reached" }])
  })

  it("forwards a comment to the open session instead of a second run", async () => {
    const session: OpenCloudSession = { repo: "example-org/example-repo", number: 42, kind: "issue", sessionId: "session_01OPEN", url: "https://claude.ai/code/session_01OPEN", agentId: "coder", startedAt: 1 }
    const launch = vi.fn(async () => ({ ok: true as const, sessionId: "session_01OPEN", url: "", output: "" }))
    const d = deps({ route: "follow-up", session }, launch)
    const result = await dispatchCloudSession(d.deps)
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Fix the login redirect", sessionId: "session_01OPEN" }))
    expect(result).toMatchObject({ cloudSession: { id: "session_01OPEN", url: session.url, followUp: true } })
    expect(result!.content).toContain("session_01OPEN")
    expect(d.store.touch).toHaveBeenCalledWith("session_01OPEN", 1_700_000_000_000)
  })

  it("never starts a local run while the session is open, even when forwarding fails", async () => {
    const session: OpenCloudSession = { repo: "example-org/example-repo", number: 42, kind: "issue", sessionId: "session_01OPEN", url: "https://claude.ai/code/session_01OPEN", agentId: "coder", startedAt: 1 }
    const d = deps({ route: "follow-up", session }, async () => ({ ok: false as const, reason: "claude -p --cloud exited with code 1", output: "" }))
    const result = await dispatchCloudSession(d.deps)
    expect(result).not.toBeNull()
    expect(result!.error).toContain("session_01OPEN")
    expect(result!.error).toContain("No local run starts while the session is open")
    expect(d.trace).toEqual([{ action: "follow-up", status: "error", summary: "claude -p --cloud exited with code 1" }])
  })
})

describe("config", () => {
  it("defaults cloud sessions to off for agents and for the GitHub channel", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "N" }, agents: { coder: { name: "Coder", workspace: "/srv/agents/coder" } } })
    expect(cfg.agents.coder.cloudSessions).toEqual({ enabled: false, maxPerDay: 0, openHours: 24, launchTimeoutSeconds: 120 })
    expect(cfg.channels.github.cloudSessions).toBe(false)
  })

  it("accepts the settings and rejects nonsense", () => {
    const cfg = daemonConfigSchema.parse({
      node: { id: "n", name: "N" },
      agents: { coder: { name: "Coder", workspace: "/srv/agents/coder", cloudSessions: { enabled: true, maxPerDay: 5, openHours: 48, launchTimeoutSeconds: 60 } } },
      channels: { github: { enabled: true, cloudSessions: true } },
    })
    expect(cfg.agents.coder.cloudSessions).toEqual({ enabled: true, maxPerDay: 5, openHours: 48, launchTimeoutSeconds: 60 })
    expect(cfg.channels.github.cloudSessions).toBe(true)
    for (const bad of [{ maxPerDay: -1 }, { openHours: 0 }, { launchTimeoutSeconds: 5 }, { enabled: "yes" }]) {
      expect(daemonConfigSchema.safeParse({ node: { id: "n", name: "N" }, agents: { coder: { name: "Coder", workspace: "/x", cloudSessions: bad } } }).success, JSON.stringify(bad)).toBe(false)
    }
  })
})
