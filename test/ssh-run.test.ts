import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync, spawn, spawnSync } from "child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"

// Run an issue on an SSH server (#2104 PR 2): the box's worktree and
// pre-push hook (real git, the remote scripts run with a local `sh`), the
// prompt on stdin, the registry's refusal and run, and the Hub's choices
// and move checks.

const run = vi.hoisted(() => ({ calls: 0 }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, executeTask: () => { run.calls++; return Promise.resolve({ content: "ran here", duration: 1 }) } }
})

import { SSH_LIMIT_GRACE_MS, claudeCommand, parseState, prePushHook, prepareScript, runOverSsh, shq, sshArgs, sshLockFile, sshIssueWorktreeState, sshServerOf, sshWorktreeDir, stateScript, type SshServer, type SshSpawn } from "../src/agents/ssh-run"
import { placedRefusalText } from "../src/agents/mesh-safety"
import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { moveRunOn, runOnChoices, type IssueState, type RunOnDeps } from "../src/daemon/issue-run-on"
import { RequestStore, type Placement } from "../src/requests/store"
import { getEventBus } from "../src/events/bus"

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim()
const commit = (dir: string, file: string, msg: string) => { writeFileSync(join(dir, file), msg + "\n"); git(dir, "add", "."); git(dir, "commit", "-q", "-m", msg) }
const server = (over: Partial<SshServer> = {}): SshServer => ({ name: "box", host: "box.example", checkouts: { "acme/app": "/srv/app" }, claudeCommand: "claude", pushLimit: "github ruleset 1", ...over })
const at = (node: string): Placement => ({ node, setBy: "owner", setAt: 1 })

/** Runs the remote script with a local `sh`, as the box would. */
const localSh: SshSpawn = async (args, input) => {
  const remote = args[args.length - 1]
  if (remote !== "sh -s") throw new Error(`not a script: ${remote}`)
  const r = spawnSync("sh", ["-s"], { input, encoding: "utf8", env: gitEnv })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

describe("the pieces", () => {
  it("quotes, builds ssh arguments, finds servers and the worktree path", () => {
    expect(shq("a'b c")).toBe(`'a'\\''b c'`)
    expect(sshArgs(server({ user: "dev", port: 2222, identityFile: "/k/id" }), "true")).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", "2222", "-i", "/k/id", "--", "dev@box.example", "true"])
    expect(sshServerOf("ssh:box", [server()])?.host).toBe("box.example")
    expect(sshServerOf("box", [server()])).toBeUndefined()
    expect(sshWorktreeDir("/srv/app/", 7)).toBe("/srv/.agentx-worktrees/app/issue-7")
    expect(parseState("STATE agentx/issue-7 1 2\n")).toEqual({ branch: "agentx/issue-7", dirty: true, ahead: 2 })
    expect(parseState("NONE")).toBeNull()
    expect(parseState("garbage")).toBeUndefined()
  })

  it("the config takes sshServers and refuses a bad name or a duplicate", () => {
    expect(daemonConfigSchema.parse({ node: { id: "mac", name: "mac" }, sshServers: [{ name: "box", host: "box.example", checkouts: { "acme/app": "/srv/app" } }] }).sshServers[0].claudeCommand).toBe("claude")
    expect(() => daemonConfigSchema.parse({ node: { id: "mac", name: "mac" }, sshServers: [{ name: "b ox", host: "h" }] })).toThrow()
    expect(() => daemonConfigSchema.parse({ node: { id: "mac", name: "mac" }, sshServers: [{ name: "box", host: "h; rm -rf /" }] })).toThrow()
    expect(() => daemonConfigSchema.parse({ node: { id: "mac", name: "mac" }, sshServers: [{ name: "box", host: "h" }, { name: "box", host: "g" }] })).toThrow(/twice/)
  })

  it("the command line runs claude in the worktree, with no part of the task in it", () => {
    const cmd = claudeCommand(server(), "/srv/.agentx-worktrees/app/issue-7", "opus", 600)
    expect(cmd).toBe(`cd '/srv/.agentx-worktrees/app/issue-7' && echo $$ > '/srv/.agentx-worktrees/app/issue-7.lock' && exec timeout -k 30 600 'claude' -p --output-format json --strict-mcp-config --allowedTools 'Bash,Read,Edit,MultiEdit,Write,Glob,Grep,TodoWrite' --model 'opus'`)
  })
})

describe("runOverSsh (fake ssh)", () => {
  it("prepares, then sends the prompt on stdin only, and reads the State line", async () => {
    const calls: Array<{ args: string[]; input: string; timeoutMs: number }> = []
    const fake: SshSpawn = async (args, input, timeoutMs) => {
      calls.push({ args, input, timeoutMs })
      if (calls.length === 1) return { code: 0, stdout: "READY /srv/.agentx-worktrees/app/issue-7\n", stderr: "" }
      return { code: 0, stdout: JSON.stringify({ result: "Fixed it.\n\nState: done — PR #9", session_id: "s1" }), stderr: "" }
    }
    const prompt = "SECRET-PROMPT fix the 'thing' $(rm -rf /)"
    const out = await runOverSsh({ server: server(), repo: "Acme/App", issue: 7, prompt, timeoutMs: 600_000 }, fake)
    expect(out).toMatchObject({ ok: true, content: "Fixed it.\n\nState: done — PR #9", sessionId: "s1", jobState: { state: "done", proof: "PR #9" } })
    expect(calls[1].input).toBe(prompt)
    expect(calls[1].timeoutMs).toBe(600_000 + SSH_LIMIT_GRACE_MS)
    expect(calls[1].args.at(-1)).toContain("exec timeout -k 30 600 ")
    for (const c of calls) expect(c.args.join(" ")).not.toContain("SECRET-PROMPT")
    expect(calls[0].input).toContain("agentx/issue-7")
  })

  it("names both commits when diverged, says offline when ssh fails, refuses a repo with no checkout", async () => {
    const diverged: SshSpawn = async () => ({ code: 0, stdout: "DIVERGED aaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbb\n", stderr: "" })
    const d = await runOverSsh({ server: server(), repo: "acme/app", issue: 7, prompt: "x", timeoutMs: 1 }, diverged)
    expect(d.ok).toBe(false)
    expect((d as any).error).toContain("aaaaaaaaaaaa")
    expect((d as any).error).toContain("bbbbbbbbbbbb")
    const down: SshSpawn = async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host box.example port 22: Connection refused" })
    expect(await runOverSsh({ server: server(), repo: "acme/app", issue: 7, prompt: "x", timeoutMs: 1 }, down)).toMatchObject({ ok: false, offline: true })
    expect(await runOverSsh({ server: server(), repo: "acme/other", issue: 7, prompt: "x", timeoutMs: 1 }, down)).toMatchObject({ ok: false, error: expect.stringContaining("no checkout of acme/other") })
  })

  it("B1: a server with no pushLimit is refused before any ssh call", async () => {
    const calls: string[][] = []
    const fake: SshSpawn = async (args) => { calls.push(args); return { code: 0, stdout: "READY /x\n", stderr: "" } }
    const out = await runOverSsh({ server: server({ pushLimit: undefined }), repo: "acme/app", issue: 7, prompt: "x", timeoutMs: 1 }, fake)
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("no pushLimit") })
    expect(calls).toEqual([])
  })

  it("B2: an earlier run still alive on the box refuses the run; the box's timeout counts as the time limit", async () => {
    let n = 0
    const busy: SshSpawn = async () => { n++; return { code: 0, stdout: "BUSY 4242\n", stderr: "" } }
    expect(await runOverSsh({ server: server(), repo: "acme/app", issue: 7, prompt: "x", timeoutMs: 1000 }, busy)).toMatchObject({ ok: false, error: expect.stringContaining("still going on ssh:box (pid 4242)") })
    expect(n).toBe(1)
    let m = 0
    const timedOut: SshSpawn = async () => (++m === 1 ? { code: 0, stdout: "READY /w\n", stderr: "" } : { code: 124, stdout: "", stderr: "" })
    expect(await runOverSsh({ server: server(), repo: "acme/app", issue: 7, prompt: "x", timeoutMs: 1000 }, timedOut)).toMatchObject({ ok: false, error: expect.stringContaining("passed its time limit") })
  })
})

describe("the box's worktree and hook (real git, local sh)", () => {
  let tmp: string
  let remote: string
  let checkout: string
  let other: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agentx-ssh-"))
    remote = join(tmp, "remote.git")
    git(tmp, "init", "-q", "--bare", "-b", "main", remote)
    checkout = join(tmp, "app")
    git(tmp, "clone", "-q", remote, checkout)
    commit(checkout, "README.md", "init")
    git(checkout, "push", "-q", "origin", "HEAD:main")
    git(checkout, "remote", "set-head", "origin", "main")
    other = join(tmp, "other")
    git(tmp, "clone", "-q", remote, other)
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  const prepare = async () => (await localSh(["sh -s"], prepareScript(checkout, 7), 60_000)).stdout.trim().split("\n").pop()!

  it("a new worktree tracks origin; its hook pushes the issue's branch only", async () => {
    const said = await prepare()
    const wt = sshWorktreeDir(checkout, 7)
    expect(said).toBe(`READY ${wt}`)
    expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agentx/issue-7")
    expect(readFileSync(join(`${wt}.hooks`, "pre-push"), "utf8")).toBe(prePushHook(7))
    expect(git(wt, "config", "core.hooksPath")).toBe(`${wt}.hooks`)
    expect(git(wt, "config", "branch.agentx/issue-7.merge")).toBe("refs/heads/agentx/issue-7")
    // The checkout keeps its own hooks.
    expect(spawnSync("git", ["config", "core.hooksPath"], { cwd: checkout }).status).not.toBe(0)
    commit(wt, "a.txt", "work")
    expect(spawnSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: wt, env: gitEnv, encoding: "utf8" }).stderr).toContain("may push only refs/heads/agentx/issue-7")
    expect(spawnSync("git", ["push", "-q", "origin", "HEAD:agentx/issue-7"], { cwd: wt, env: gitEnv }).status).toBe(0)
  })

  it("a reused worktree fast-forwards to the pushed branch; a diverged one is refused", async () => {
    await prepare()
    const wt = sshWorktreeDir(checkout, 7)
    commit(wt, "a.txt", "on box")
    git(wt, "push", "-q", "-u", "origin", "agentx/issue-7")
    git(other, "fetch", "-q", "origin")
    git(other, "checkout", "-q", "-b", "agentx/issue-7", "origin/agentx/issue-7")
    commit(other, "b.txt", "on mac")
    git(other, "push", "-q", "origin", "agentx/issue-7")
    expect(await prepare()).toBe(`READY ${wt}`)
    expect(git(wt, "log", "-1", "--format=%s")).toBe("on mac")
    commit(wt, "c.txt", "box only")
    commit(other, "d.txt", "mac only")
    git(other, "push", "-q", "origin", "agentx/issue-7")
    expect(await prepare()).toMatch(/^DIVERGED [0-9a-f]{40} [0-9a-f]{40}$/)
  })

  it("starts from origin's pushed branch when the box has none yet", async () => {
    git(other, "checkout", "-q", "-b", "agentx/issue-7")
    commit(other, "e.txt", "pushed elsewhere")
    git(other, "push", "-q", "origin", "agentx/issue-7")
    await prepare()
    expect(git(sshWorktreeDir(checkout, 7), "log", "-1", "--format=%s")).toBe("pushed elsewhere")
  })

  it("B2: prepare refuses while the lock's run is alive, and goes on once it ended", async () => {
    expect(await prepare()).toMatch(/^READY /)
    const lock = sshLockFile(checkout, 7)
    const live = spawn("timeout", ["30", "sleep", "30"], { stdio: "ignore" })
    try {
      writeFileSync(lock, `${live.pid}\n`)
      expect(await prepare()).toBe(`BUSY ${live.pid}`)
    } finally { live.kill() }
    const dead = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim()
    writeFileSync(lock, `${dead}\n`)
    expect(await prepare()).toMatch(/^READY /)
    // A pid reused by another program (here this test's node) is stale.
    writeFileSync(lock, `${process.pid}\n`)
    expect(await prepare()).toMatch(/^READY /)
  })

  it("B2: the run command writes its pid to the lock and the box's timeout ends it (exit 124)", async () => {
    expect(await prepare()).toMatch(/^READY /)
    const wt = sshWorktreeDir(checkout, 7)
    const fakeClaude = join(tmp, "fake-claude")
    writeFileSync(fakeClaude, "#!/bin/sh\ncat >/dev/null\nsleep 20\n")
    chmodSync(fakeClaude, 0o755)
    const started = Date.now()
    const r = spawnSync("sh", ["-c", claudeCommand(server({ claudeCommand: fakeClaude }), wt, undefined, 1)], { input: "prompt", encoding: "utf8", env: gitEnv })
    expect(r.status).toBe(124)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(readFileSync(sshLockFile(checkout, 7), "utf8").trim()).toMatch(/^\d+$/)
  })

  it("the state script reads none, dirty and not pushed", async () => {
    const box = server({ checkouts: { "acme/app": checkout } })
    expect(await sshIssueWorktreeState(box, "acme/app", 7, localSh)).toBeNull()
    await prepare()
    const wt = sshWorktreeDir(checkout, 7)
    expect(await sshIssueWorktreeState(box, "acme/app", 7, localSh)).toEqual({ branch: "agentx/issue-7", dirty: false, ahead: 0 })
    commit(wt, "a.txt", "work")
    writeFileSync(join(wt, "b.txt"), "x")
    expect(await sshIssueWorktreeState(box, "acme/app", 7, localSh)).toEqual({ branch: "agentx/issue-7", dirty: true, ahead: 1 })
    expect(stateScript(checkout, 7)).toContain(shq(wt))
  })

  it("the hook alone refuses another ref (as git calls it)", () => {
    const hook = join(tmp, "pre-push")
    writeFileSync(hook, prePushHook(7))
    chmodSync(hook, 0o755)
    const call = (ref: string) => spawnSync(hook, ["origin", "url"], { input: `refs/heads/x 1111 ${ref} 0000\n` }).status
    expect(call("refs/heads/agentx/issue-7")).toBe(0)
    expect(call("refs/heads/main")).toBe(1)
    expect(call("refs/heads/agentx/issue-70")).toBe(1)
    expect(existsSync(hook)).toBe(true)
  })
})

describe("AgentRegistry: an issue placed on an SSH server", () => {
  let dir: string
  let registry: AgentRegistry
  let calls: Array<{ args: string[]; input: string }>
  const prevCwd = process.cwd()
  const people = [{ id: "sara", name: "Sara", role: "member", identities: ["github:sara-b"], agents: [], deny: { tools: ["Bash"], skills: [] } }]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-ssh-reg-"))
    process.chdir(dir)
    getEventBus().removeAllListeners()
    run.calls = 0
    registry = new AgentRegistry(daemonConfigSchema.parse({
      node: { id: "mac", name: "mac" }, jobState: { enabled: false }, people,
      sshServers: [{ name: "box", host: "box.example", checkouts: { "acme/app": "/srv/app" }, pushLimit: "github ruleset 1" }, { name: "open", host: "open.example", checkouts: { "acme/app": "/srv/app" } }],
      agents: { coder: { name: "Coder", tier: "claude-code", workspace: dir, maxExecutionMinutes: 45 } },
    }), () => {})
    calls = []
    registry.setSshSpawn(async (args, input) => {
      calls.push({ args, input })
      return calls.length === 1 ? { code: 0, stdout: "READY /srv/.agentx-worktrees/app/issue-7\n", stderr: "" } : { code: 0, stdout: JSON.stringify({ result: "done on box\nState: done — pushed abc" }), stderr: "" }
    })
    registry.setPlacements({ placement: (c, id) => (c === "github" && id === "acme/app:issue:7" ? at("ssh:box") : null) })
  })
  afterEach(() => { process.chdir(prevCwd); rmSync(dir, { recursive: true, force: true }) })

  it("runs it over SSH from here: the answer, its job state, nothing run locally", async () => {
    const res = await registry.execute({ agentId: "coder", message: "fix it", context: { channel: "github", chatId: "acme/app:issue:7" } as any })
    expect(res.content).toBe("done on box\nState: done — pushed abc")
    expect(res.viaMesh).toBe("ssh:box")
    expect(res.jobState).toEqual({ state: "done", proof: "pushed abc" })
    expect(run.calls).toBe(0)
    expect(calls[1].input).toBe("fix it")
  })

  it("refuses restricted autonomy and a person's limits, and runs nothing", async () => {
    const auto = await registry.execute({ agentId: "coder", message: "x", autonomy: "report", context: { channel: "cron", chatId: "c", home: "acme/app#7" } } as any)
    expect(auto.content).toBe(placedRefusalText("ssh:box"))
    const limited = await registry.execute({ agentId: "coder", message: "x", context: { channel: "github", chatId: "acme/app:issue:7", sender: "sara-b", senderUsername: "sara-b" } as any })
    expect(limited.content).toBe(placedRefusalText("ssh:box"))
    expect(calls).toEqual([])
    expect(run.calls).toBe(0)
  })

  it("refuses a second run of the same issue while the first is going, and runs again after", async () => {
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    registry.setSshSpawn(async (args, input) => {
      calls.push({ args, input })
      if (calls.length === 1) { await held; return { code: 0, stdout: "READY /srv/.agentx-worktrees/app/issue-7\n", stderr: "" } }
      return calls.length === 3 ? { code: 0, stdout: "READY /srv/.agentx-worktrees/app/issue-7\n", stderr: "" } : { code: 0, stdout: JSON.stringify({ result: "ok" }), stderr: "" }
    })
    const ctx = { channel: "github", chatId: "acme/app:issue:7" } as any
    const first = registry.execute({ agentId: "coder", message: "a", context: ctx })
    await new Promise((r) => setTimeout(r, 10))
    const second = await registry.execute({ agentId: "coder", message: "b", context: ctx })
    expect(second.error).toContain("still going on ssh:box")
    expect(calls.length).toBe(1)
    release()
    expect((await first).content).toBe("ok")
    expect((await registry.execute({ agentId: "coder", message: "c", context: ctx })).content).toBe("ok")
  })

  it("B1: a server with no pushLimit fails the run and calls no ssh", async () => {
    registry.setPlacements({ placement: () => at("ssh:open") })
    const res = await registry.execute({ agentId: "coder", message: "x", context: { channel: "github", chatId: "acme/app:issue:7" } as any })
    expect(res.error).toContain("no pushLimit")
    expect(calls).toEqual([])
    expect(run.calls).toBe(0)
  })

  it("an SSH server that is not configured fails the run with the reason", async () => {
    registry.setPlacements({ placement: () => at("ssh:gone") })
    const res = await registry.execute({ agentId: "coder", message: "x", context: { channel: "github", chatId: "acme/app:issue:7" } as any })
    expect(res.error).toContain("not in sshServers")
    expect(calls).toEqual([])
  })
})

describe("the Hub: SSH servers in Run on", () => {
  let tmp: string
  let db: Database.Database
  let store: RequestStore
  let up: Record<string, boolean>
  let sshStates: Record<string, IssueState | Error>
  const ISSUE = "https://github.com/acme/app/issues/7"
  const placed = () => store.placement("github", "acme/app:issue:7")
  const deps = (): RunOnDeps => ({
    store: () => store,
    directory: () => [],
    localHostsAgent: (id) => id === "coder",
    localCheckouts: () => ["acme/app"],
    localNumbers: async () => null,
    peerNumbers: async () => null,
    localIssueState: async () => ({ runOpen: false, worktree: null }),
    peerIssueState: async () => { throw new Error("no peers") },
    sshServers: () => [server(), server({ name: "elsewhere", checkouts: { "acme/other": "/srv/o" } })],
    sshHealthy: async (s) => !!up[s.name],
    sshIssueState: async (node) => { const s = sshStates[node]; if (s instanceof Error) throw s; return s ?? { runOpen: false, worktree: null } },
    now: () => 1000,
  })
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agentx-ssh-hub-"))
    db = new Database(join(tmp, "db.sqlite"))
    store = new RequestStore(db)
    store.addPromise({ id: "wp-1", channel: "dashboard", chatId: "wall", agentId: "coder", text: "fix", owedTo: "owner", home: { kind: "issue", link: ISSUE }, now: 1 })
    up = { box: true }
    sshStates = {}
  })
  afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }) })

  it("lists the servers with a checkout of the repo, labelled SSH", async () => {
    const b = (await runOnChoices("wp-1", deps())).body as any
    expect(b.choices.map((c: any) => c.node)).toEqual(["local", "ssh:box"])
    expect(b.choices[1]).toMatchObject({ label: "box (SSH)", kind: "ssh", healthy: true })
  })

  it("moves to a server that answers, refuses one that does not", async () => {
    up.box = false
    expect(((await moveRunOn({ id: "wp-1", node: "ssh:box" }, deps())).body as any).error).toContain("does not answer over SSH")
    expect(((await moveRunOn({ id: "wp-1", node: "ssh:elsewhere" }, deps())).body as any).error).toContain("no checkout of acme/app")
    expect(((await moveRunOn({ id: "wp-1", node: "ssh:ghost" }, deps())).body as any).error).toContain("not in sshServers")
    // B1: no pushLimit, no Move.
    const open = { ...deps(), sshServers: () => [server({ pushLimit: undefined })] }
    expect(((await moveRunOn({ id: "wp-1", node: "ssh:box" }, open)).body as any).error).toContain("no pushLimit")
    expect(placed()?.node ?? "local").toBe("local")
    up.box = true
    const r = await moveRunOn({ id: "wp-1", node: "ssh:box" }, deps())
    expect(r.status).toBe(200)
    expect(placed()?.node).toBe("ssh:box")
  })

  it("moving off a server checks its worktree; an offline one is stale and can be forced", async () => {
    store.setPlacement("github", "acme/app:issue:7", at("ssh:box"))
    sshStates["ssh:box"] = { runOpen: false, worktree: { branch: "agentx/issue-7", dirty: false, ahead: 2 } }
    expect(((await moveRunOn({ id: "wp-1", node: "local" }, deps())).body as any).error).toContain("2 commit(s) not pushed")
    sshStates["ssh:box"] = { runOpen: false, worktree: { branch: "agentx/issue-7", dirty: false, ahead: 0 } }
    expect((await moveRunOn({ id: "wp-1", node: "local" }, deps())).status).toBe(200)
    store.setPlacement("github", "acme/app:issue:7", at("ssh:box"))
    up.box = false
    expect(((await runOnChoices("wp-1", deps())).body as any).stale).toBe(true)
    const refused = await moveRunOn({ id: "wp-1", node: "local" }, deps())
    expect(refused.body).toMatchObject({ forcible: true, holder: "ssh:box" })
    const forced = await moveRunOn({ id: "wp-1", node: "local", force: true, confirm: "ssh:box" }, deps())
    expect(forced.body).toMatchObject({ ok: true, forced: true })
    expect(store.leftBehind("github", "acme/app:issue:7").map((l) => l.node)).toEqual(["ssh:box"])
  })
})
