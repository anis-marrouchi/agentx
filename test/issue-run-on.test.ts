import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import Database from "better-sqlite3"
import { execProcess } from "../src/agents/spec-tests"
import { TASK_WORKTREE_DEFAULTS, issueWorktreeState, prepareTaskWorktree, remotePath } from "../src/agents/task-worktrees"
import { issueHomeOf, issueState, moveRefusal, moveRunOn, nodeNumbersOf, runOnChoices, type IssueState, type RunOnDeps } from "../src/daemon/issue-run-on"
import { RequestStore } from "../src/requests/store"
import { handleWallAction, isWallActionPath, isWallWrite, WALL_RUN_ON_PATH } from "../src/daemon/wall-actions"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { runOnChoiceText, runOnStaleText, WALL_RUN_ON_SCRIPT } from "../src/daemon/ui/pages/wall-run-on.client"

// Run an issue on another machine (#2104): the move checks (B3), the
// worktree a moved issue starts from, and the Hub's read and move.

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim()
const settings = { ...TASK_WORKTREE_DEFAULTS, enabled: true }

describe("the issue's state on a node (real git)", () => {
  let base: string
  let origin: string
  let checkout: string
  let repo: string
  let url: string
  // GitLab chat ids: the test origin is a local folder, whose "repo" is its path.
  const chat = () => `${repo}:issue:12`
  const target = () => ({ source: "gitlab" as const, repo, id: "12" })
  const deps = (open = false) => ({ runOpen: (c: string) => open && c === chat(), agents: () => [{ workspace: checkout, worktrees: { enabled: true } }], ruleDirs: () => [], exec: execProcess })

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "agentx-issue-state-"))
    origin = join(base, "origin.git")
    checkout = join(base, "api")
    // A host in the URL so remotePath() reads a project path pickCheckout can match.
    url = `file://localhost${origin}`
    repo = remotePath(url)!
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin])
    execFileSync("git", ["clone", "-q", url, checkout])
    writeFileSync(join(checkout, "README.md"), "hello\n")
    git(checkout, "add", ".")
    git(checkout, "commit", "-q", "-m", "init")
    git(checkout, "push", "-q", "origin", "HEAD:main")
    git(checkout, "remote", "set-head", "origin", "main")
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it("no worktree yet: nothing to move but an open run", async () => {
    expect(await issueState(chat(), "gitlab", deps())).toEqual({ runOpen: false, worktree: null })
    expect((await issueState(chat(), "gitlab", deps(true))).runOpen).toBe(true)
  })

  it("reads dirty and ahead, and clean once pushed", async () => {
    const wt = await prepareTaskWorktree(target(), checkout, settings, { exec: execProcess })
    if ("error" in wt) throw new Error(wt.error)
    expect((await issueState(chat(), "gitlab", deps())).worktree).toEqual({ branch: "agentx/issue-12", dirty: false, ahead: 0 })
    writeFileSync(join(wt.dir, "fix.txt"), "fix\n")
    expect((await issueState(chat(), "gitlab", deps())).worktree).toMatchObject({ dirty: true, ahead: 0 })
    git(wt.dir, "add", ".")
    git(wt.dir, "commit", "-q", "-m", "fix")
    expect((await issueState(chat(), undefined, deps())).worktree).toEqual({ branch: "agentx/issue-12", dirty: false, ahead: 1 })
    git(wt.dir, "push", "-q", "-u", "origin", "agentx/issue-12")
    expect((await issueState(chat(), "gitlab", deps())).worktree).toEqual({ branch: "agentx/issue-12", dirty: false, ahead: 0 })
    writeFileSync(join(wt.dir, "more.txt"), "more\n")
    git(wt.dir, "add", ".")
    git(wt.dir, "commit", "-q", "-m", "more")
    expect((await issueWorktreeState(wt.dir, execProcess))!.ahead).toBe(1)
  })

  it("on the new node, the issue's worktree starts from origin/agentx/issue-<n>, tracking it", async () => {
    // The Mac pushed its work on the issue.
    const mac = await prepareTaskWorktree(target(), checkout, settings, { exec: execProcess })
    if ("error" in mac) throw new Error(mac.error)
    writeFileSync(join(mac.dir, "fix.txt"), "from the mac\n")
    git(mac.dir, "add", ".")
    git(mac.dir, "commit", "-q", "-m", "fix on mac")
    git(mac.dir, "push", "-q", "origin", "agentx/issue-12")
    // Another node has its own checkout of the same repository.
    const other = join(base, "other", "api")
    execFileSync("git", ["clone", "-q", url, other])
    git(other, "remote", "set-head", "origin", "main")
    const wt = await prepareTaskWorktree(target(), other, settings, { exec: execProcess })
    if ("error" in wt) throw new Error(wt.error)
    expect(existsSync(join(wt.dir, "fix.txt"))).toBe(true)
    expect(git(wt.dir, "log", "-1", "--format=%s")).toBe("fix on mac")
    expect(git(wt.dir, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/agentx/issue-12")
    expect(await issueWorktreeState(wt.dir, execProcess)).toEqual({ branch: "agentx/issue-12", dirty: false, ahead: 0 })
  })
})

describe("the move check", () => {
  const clean: IssueState = { runOpen: false, worktree: { branch: "agentx/issue-7", dirty: false, ahead: 0 } }
  it("refuses for each reason, with it", () => {
    expect(moveRefusal("clawd", { ...clean, runOpen: true })).toContain("A run is open")
    expect(moveRefusal("clawd", { runOpen: false, worktree: { branch: "b", dirty: true, ahead: 0 } })).toContain("uncommitted")
    expect(moveRefusal("clawd", { runOpen: false, worktree: { branch: "b", dirty: false, ahead: 2 } })).toContain("2 commit(s) not pushed")
    expect(moveRefusal("clawd", clean)).toBeNull()
    expect(moveRefusal("clawd", { runOpen: false, worktree: null })).toBeNull()
  })
})

describe("GET and POST /issue-run-on", () => {
  let tmp: string
  let db: Database.Database
  let store: RequestStore
  let peers: any[]
  let states: Record<string, IssueState | Error>
  let asked: string[]
  const ISSUE = "https://github.com/acme/app/issues/7"

  const deps = (): RunOnDeps => ({
    store: () => store,
    directory: () => peers,
    localHostsAgent: (id) => id === "coder",
    localCheckouts: () => ["acme/app"],
    localNumbers: async () => ({ swapUsedPct: 40, load1: 3.2 }),
    peerNumbers: async (p) => (p === "clawd" ? { swapUsedPct: 5, load1: 0.4 } : null),
    localIssueState: async () => { asked.push("local"); const s = states.local; if (s instanceof Error) throw s; return s ?? { runOpen: false, worktree: null } },
    peerIssueState: async (p) => { asked.push(p); const s = states[p]; if (s instanceof Error) throw s; return s ?? { runOpen: false, worktree: null } },
    now: () => 1000,
  })

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agentx-runon-api-"))
    db = new Database(join(tmp, "db.sqlite"))
    store = new RequestStore(db)
    store.addPromise({ id: "wp-1", channel: "dashboard", chatId: "wall", agentId: "coder", text: "fix", owedTo: "owner", home: { kind: "issue", link: ISSUE }, now: 1 })
    store.addPromise({ id: "wp-2", channel: "dashboard", chatId: "wall", agentId: "coder", text: "idea", owedTo: "owner", home: { kind: "idea", link: "ideas/x.md" }, now: 1 })
    peers = [
      { peer: "clawd", peerUrl: "http://c", healthy: true, skills: [{ id: "coder" }], checkouts: ["Acme/App"] },
      { peer: "nas", peerUrl: "http://n", healthy: true, skills: [{ id: "atlas" }], checkouts: ["acme/app"] },
      { peer: "box", peerUrl: "http://b", healthy: true, skills: [{ id: "coder" }], checkouts: ["acme/other"] },
      { peer: "old", peerUrl: "http://o", healthy: false, skills: [{ id: "coder" }], checkouts: ["acme/app"], lastCheck: new Date(5000) },
    ]
    states = {}
    asked = []
  })
  afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }) })

  it("reads the issue of a post's home", () => {
    expect(issueHomeOf({ home: { kind: "issue", link: ISSUE }, channel: "dashboard" })).toMatchObject({ provider: "github", project: "acme/app", number: 7, chatId: "acme/app:issue:7" })
    expect(issueHomeOf({ home: { kind: "issue", link: "g/sub/p#3" }, channel: "dashboard" })).toMatchObject({ provider: "gitlab", project: "g/sub/p" })
    expect(issueHomeOf({ home: { kind: "issue", link: "g/p#3" }, channel: "gitlab" })).toMatchObject({ provider: "gitlab" })
    expect(issueHomeOf({ home: { kind: "issue", link: "https://github.com/acme/app/pull/3" }, channel: "x" })).toBeNull()
    expect(issueHomeOf({ home: { kind: "idea", link: "ideas/x.md" }, channel: "x" })).toBeNull()
  })

  it("GET offers this Mac and the peers that host the agent and have the repo, with their numbers", async () => {
    const r = await runOnChoices("wp-1", deps())
    expect(r.status).toBe(200)
    const b = r.body as any
    expect(b).toMatchObject({ current: "local", stale: false, issue: "acme/app#7", agentId: "coder" })
    expect(b.choices).toEqual([
      { node: "local", label: "This Mac", healthy: true, hostsAgent: true, hasCheckout: true, swapUsedPct: 40, load1: 3.2 },
      { node: "clawd", label: "clawd", healthy: true, hostsAgent: true, hasCheckout: true, swapUsedPct: 5, load1: 0.4 },
      { node: "old", label: "old", healthy: false, hostsAgent: true, hasCheckout: true },
    ])
  })

  it("GET shows a placement on an offline node as stale", async () => {
    store.setRunOn("wp-1", { node: "old", setBy: "owner", setAt: 1 }, 2)
    const b = (await runOnChoices("wp-1", deps())).body as any
    expect(b).toMatchObject({ current: "old", stale: true, staleSince: new Date(5000).toISOString() })
  })

  it("refuses a post without an issue home, and an unknown post", async () => {
    expect((await runOnChoices("wp-2", deps())).status).toBe(409)
    expect((await moveRunOn({ id: "wp-2", node: "clawd" }, deps())).status).toBe(409)
    expect((await moveRunOn({ id: "nope", node: "clawd" }, deps())).status).toBe(404)
    expect((await moveRunOn({ id: "wp-1" }, deps())).status).toBe(400)
  })

  it("refuses an unknown or unfit node", async () => {
    expect((await moveRunOn({ id: "wp-1", node: "ghost" }, deps())).status).toBe(404)
    expect(((await moveRunOn({ id: "wp-1", node: "nas" }, deps())).body as any).error).toContain("does not host coder")
    expect(((await moveRunOn({ id: "wp-1", node: "box" }, deps())).body as any).error).toContain("no checkout of acme/app")
    expect(((await moveRunOn({ id: "wp-1", node: "old" }, deps())).body as any).error).toContain("offline")
    expect(store.get("wp-1")!.runOn).toBeNull()
  })

  it("refuses a move the holder's check fails, for each reason", async () => {
    for (const s of [{ runOpen: true, worktree: null }, { runOpen: false, worktree: { branch: "agentx/issue-7", dirty: true, ahead: 0 } }, { runOpen: false, worktree: { branch: "agentx/issue-7", dirty: false, ahead: 1 } }]) {
      states.local = s
      const r = await moveRunOn({ id: "wp-1", node: "clawd" }, deps())
      expect(r.status).toBe(409)
      expect(store.get("wp-1")!.runOn).toBeNull()
    }
    expect(asked).toEqual(["local", "local", "local"])
  })

  it("moves when clean, asks the node that holds it next time, and node local clears", async () => {
    states.local = { runOpen: false, worktree: { branch: "agentx/issue-7", dirty: false, ahead: 0 } }
    const r = await moveRunOn({ id: "wp-1", node: "clawd", by: "owner" }, deps())
    expect(r.status).toBe(200)
    expect(store.get("wp-1")!.runOn).toEqual({ node: "clawd", setBy: "owner", setAt: 1000 })
    expect(store.runOnForIssue("github", "acme/app", 7)?.node).toBe("clawd")
    // Back to this Mac: clawd, which holds it now, is asked.
    states.clawd = { runOpen: true, worktree: null }
    expect((await moveRunOn({ id: "wp-1", node: "local" }, deps())).status).toBe(409)
    states.clawd = new Error("timed out")
    expect(((await moveRunOn({ id: "wp-1", node: "local" }, deps())).body as any).error).toContain("Could not ask clawd")
    states.clawd = { runOpen: false, worktree: null }
    const back = await moveRunOn({ id: "wp-1", node: "local" }, deps())
    expect(back.status).toBe(200)
    expect((back.body as any).message).toContain("Back to this Mac")
    expect(store.get("wp-1")!.runOn).toBeNull()
    expect(asked).toEqual(["local", "clawd", "clawd", "clawd"])
  })

  it("brings an issue back from an offline node without asking it", async () => {
    store.setRunOn("wp-1", { node: "old", setBy: "owner", setAt: 1 }, 2)
    expect(((await moveRunOn({ id: "wp-1", node: "clawd" }, deps())).body as any).error).toContain("Bring it back to this Mac first")
    const back = await moveRunOn({ id: "wp-1", node: "local" }, deps())
    expect(back.status).toBe(200)
    expect(asked).toEqual([])
    expect(store.get("wp-1")!.runOn).toBeNull()
  })

  it("reads /api/node numbers", () => {
    expect(nodeNumbersOf({ host: { live: { swapTotalMB: 2048, swapUsedMB: 512, load1: 1.25 } } })).toEqual({ swapUsedPct: 25, load1: 1.25 })
    expect(nodeNumbersOf({ host: { live: { swapTotalMB: 0, swapUsedMB: 0, load1: 0.5 } } })).toEqual({ load1: 0.5 })
    expect(nodeNumbersOf(null)).toBeNull()
  })
})

describe("the Wall's run-on route", () => {
  it("is a Wall action and a guarded write; its daemon routes need the mesh token", () => {
    expect(isWallActionPath(WALL_RUN_ON_PATH)).toBe(true)
    expect(isWallWrite("POST", WALL_RUN_ON_PATH)).toBe(true)
    expect(isWallWrite("GET", WALL_RUN_ON_PATH)).toBe(false)
    expect(isMeshGatedPath("/issue-run-on")).toBe(true)
    expect(isMeshGatedPath("/mesh/issue-state")).toBe(true)
  })

  it("passes the read and the move to the daemon", async () => {
    const daemon = vi.fn(async () => ({ status: 200, body: { ok: true } }))
    const deps = { inbox: { root: "/nowhere" }, daemon } as any
    expect((await handleWallAction("GET", WALL_RUN_ON_PATH, { id: "wp 1" }, deps))!.status).toBe(200)
    expect(daemon).toHaveBeenLastCalledWith("GET", "/issue-run-on?id=wp%201")
    await handleWallAction("POST", WALL_RUN_ON_PATH, { id: "wp-1", node: "local" }, deps)
    expect(daemon).toHaveBeenLastCalledWith("POST", "/issue-run-on", { id: "wp-1", node: "local", by: "owner" })
    expect((await handleWallAction("POST", WALL_RUN_ON_PATH, { id: "wp-1" }, deps))!.status).toBe(400)
    expect((await handleWallAction("POST", WALL_RUN_ON_PATH, { id: "wp-1", node: "a b" }, deps))!.status).toBe(400)
    expect((await handleWallAction("GET", WALL_RUN_ON_PATH, {}, deps))!.status).toBe(400)
    expect(daemon).toHaveBeenCalledTimes(2)
  })
})

describe("the Run on client", () => {
  it("parses, inside the page script too", () => {
    expect(() => new Function(WALL_RUN_ON_SCRIPT)).not.toThrow()
    expect(() => new Function(WALL_PAGE_SCRIPT)).not.toThrow()
    expect(WALL_PAGE_SCRIPT).toContain("runOnHtml(p)")
    expect(WALL_PAGE_SCRIPT).toContain("Back to this Mac")
  })

  it("words a choice with its swap and load, and a stale placement", () => {
    expect(runOnChoiceText({ node: "clawd", label: "clawd", healthy: true, swapUsedPct: 12, load1: 0.8 })).toBe("clawd — swap 12%, load 0.8")
    expect(runOnChoiceText({ node: "local", label: "This Mac", healthy: true })).toBe("This Mac")
    expect(runOnChoiceText({ node: "old", healthy: false })).toBe("old (offline)")
    expect(runOnStaleText({ current: "clawd", stale: true })).toBe("clawd offline: this issue's runs wait for it.")
    expect(runOnStaleText({ current: "clawd", stale: false })).toBe("")
  })
})
