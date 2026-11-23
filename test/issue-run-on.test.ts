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
import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { handleWallAction, isWallActionPath, isWallWrite, WALL_RUN_ON_PATH } from "../src/daemon/wall-actions"
import { isMeshGatedPath, isOwnerOnlyPost, ownerPostAllowed } from "../src/daemon/mesh-auth"
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

  it("C3: a placed task finds its checkout among this node's own (not the sender's runbookPath)", async () => {
    const config = daemonConfigSchema.parse({ jobState: { enabled: false }, node: { id: "clawd", name: "clawd" }, agents: { coder: { name: "Coder", tier: "claude-code", workspace: join(base, "elsewhere") } } })
    const r = new AgentRegistry(config, () => {})
    r.setCheckoutDirs(() => [checkout])
    const def = { ...config.agents.coder, worktrees: { ...config.agents.coder.worktrees, enabled: true } }
    const task = { agentId: "coder", message: "hi", context: { channel: "gitlab", chatId: chat(), placed: true, runbookPath: "/Users/someone/on/the/mac" } }
    const out = await (r as any).inTaskWorktree(def, task, {})
    expect(out.refused).toBeUndefined()
    expect(out.task.cwd).toBe(join(base, ".agentx-worktrees", "api", "issue-12"))
    // The same task not placed looks only at its own runbookPath and workspace.
    const plain = await (r as any).inTaskWorktree(def, { ...task, context: { channel: "gitlab", chatId: chat() } }, {})
    expect(plain.task.cwd).toBeUndefined()
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

describe("B3: a reused worktree or branch is brought up to the pushed one (real git)", () => {
  let base: string
  let origin: string
  let url: string
  let repo: string
  let mac: string
  let other: string
  const target = () => ({ source: "gitlab" as const, repo, id: "12" })
  const commit = (dir: string, file: string, msg: string) => { writeFileSync(join(dir, file), msg + "\n"); git(dir, "add", "."); git(dir, "commit", "-q", "-m", msg) }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "agentx-sync-"))
    origin = join(base, "origin.git")
    url = `file://localhost${origin}`
    repo = remotePath(url)!
    mac = join(base, "mac", "api")
    other = join(base, "clawd", "api")
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin])
    execFileSync("git", ["clone", "-q", url, mac])
    commit(mac, "README.md", "init")
    git(mac, "push", "-q", "origin", "HEAD:main")
    git(mac, "remote", "set-head", "origin", "main")
    execFileSync("git", ["clone", "-q", url, other])
    git(other, "remote", "set-head", "origin", "main")
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it("a new branch tracks origin/<branch>; never pushed with commits is not pushed", async () => {
    const wt = await prepareTaskWorktree(target(), mac, settings, { exec: execProcess })
    if ("error" in wt) throw new Error(wt.error)
    expect(git(wt.dir, "config", "branch.agentx/issue-12.merge")).toBe("refs/heads/agentx/issue-12")
    expect(await issueWorktreeState(wt.dir, execProcess)).toEqual({ branch: "agentx/issue-12", dirty: false, ahead: 0 })
    commit(wt.dir, "a.txt", "work")
    expect((await issueWorktreeState(wt.dir, execProcess))!.ahead).toBe(1)
    expect(moveRefusal("this Mac", { runOpen: false, worktree: (await issueWorktreeState(wt.dir, execProcess))! })).toContain("not pushed")
    // A plain push goes to the issue's branch, not main.
    git(wt.dir, "push", "-q", "origin", "HEAD")
    expect(git(mac, "ls-remote", "origin", "refs/heads/agentx/issue-12")).toContain("agentx/issue-12")
    git(mac, "fetch", "-q", "origin")
    expect((await issueWorktreeState(wt.dir, execProcess))!.ahead).toBe(0)
  })

  it("Mac to clawd and back: the Mac's old worktree fast-forwards before it is reused", async () => {
    const first = await prepareTaskWorktree(target(), mac, settings, { exec: execProcess })
    if ("error" in first) throw new Error(first.error)
    commit(first.dir, "a.txt", "on mac")
    git(first.dir, "push", "-q", "origin", "agentx/issue-12")
    const there = await prepareTaskWorktree(target(), other, settings, { exec: execProcess })
    if ("error" in there) throw new Error(there.error)
    commit(there.dir, "b.txt", "on clawd")
    git(there.dir, "push", "-q", "origin", "agentx/issue-12")
    const back = await prepareTaskWorktree(target(), mac, settings, { exec: execProcess })
    if ("error" in back) throw new Error(back.error)
    expect(back.reused).toBe(true)
    expect(git(back.dir, "log", "-1", "--format=%s")).toBe("on clawd")
    expect(existsSync(join(back.dir, "b.txt"))).toBe(true)
  })

  it("an existing local branch (no worktree) is fast-forwarded too", async () => {
    git(mac, "branch", "-q", "--no-track", "agentx/issue-12", "origin/main")
    commit(other, "c.txt", "pushed elsewhere")
    git(other, "push", "-q", "origin", "HEAD:agentx/issue-12")
    const wt = await prepareTaskWorktree(target(), mac, settings, { exec: execProcess })
    if ("error" in wt) throw new Error(wt.error)
    expect(git(wt.dir, "log", "-1", "--format=%s")).toBe("pushed elsewhere")
  })

  it("diverged: refused, with both commits named", async () => {
    const first = await prepareTaskWorktree(target(), mac, settings, { exec: execProcess })
    if ("error" in first) throw new Error(first.error)
    commit(first.dir, "a.txt", "local only")
    const ours = git(first.dir, "rev-parse", "HEAD")
    commit(other, "b.txt", "pushed elsewhere")
    git(other, "push", "-q", "origin", "HEAD:agentx/issue-12")
    const theirs = git(other, "rev-parse", "HEAD")
    const again = await prepareTaskWorktree(target(), mac, settings, { exec: execProcess })
    expect(again).toMatchObject({ refuse: true })
    const err = (again as any).error as string
    expect(err).toContain("diverged")
    expect(err).toContain(ours.slice(0, 12))
    expect(err).toContain(theirs.slice(0, 12))
    expect(git(first.dir, "rev-parse", "HEAD")).toBe(ours)
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
  let states: Record<string, IssueState | Error | Array<IssueState | Error>>
  let asked: string[]
  const ISSUE = "https://github.com/acme/app/issues/7"
  const placed = () => store.placement("github", "acme/app:issue:7")
  const stateOf = (k: string): IssueState => {
    let s = states[k]
    if (Array.isArray(s)) s = s.length > 1 ? s.shift()! : s[0]
    if (s instanceof Error) throw s
    return s ?? { runOpen: false, worktree: null }
  }

  const deps = (): RunOnDeps => ({
    store: () => store,
    directory: () => peers,
    localHostsAgent: (id) => id === "coder",
    localCheckouts: () => ["acme/app"],
    localNumbers: async () => ({ swapUsedPct: 40, load1: 3.2 }),
    peerNumbers: async (p) => (p === "clawd" ? { swapUsedPct: 5, load1: 0.4 } : null),
    localIssueState: async () => { asked.push("local"); return stateOf("local") },
    peerIssueState: async (p) => { asked.push(p); return stateOf(p) },
    now: () => 1000,
  })

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agentx-runon-api-"))
    db = new Database(join(tmp, "db.sqlite"))
    store = new RequestStore(db)
    store.addPromise({ id: "wp-1", channel: "dashboard", chatId: "wall", agentId: "coder", text: "fix", owedTo: "owner", home: { kind: "issue", link: ISSUE }, now: 1 })
    store.addPromise({ id: "wp-2", channel: "dashboard", chatId: "wall", agentId: "coder", text: "idea", owedTo: "owner", home: { kind: "idea", link: "ideas/x.md" }, now: 1 })
    peers = [
      { peer: "clawd", peerUrl: "http://c", healthy: true, skills: [{ id: "coder" }], checkouts: ["Acme/App"], placement: 1 },
      { peer: "nas", peerUrl: "http://n", healthy: true, skills: [{ id: "atlas" }], checkouts: ["acme/app"], placement: 1 },
      { peer: "box", peerUrl: "http://b", healthy: true, skills: [{ id: "coder" }], checkouts: ["acme/other"], placement: 1 },
      { peer: "older", peerUrl: "http://x", healthy: true, skills: [{ id: "coder" }], checkouts: ["acme/app"] },
      { peer: "old", peerUrl: "http://o", healthy: false, skills: [{ id: "coder" }], checkouts: ["acme/app"], placement: 1, lastCheck: new Date(5000) },
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

  it("GET offers this Mac and the peers that host the agent, have the repo and placement: 1 (C2)", async () => {
    const r = await runOnChoices("wp-1", deps())
    expect(r.status).toBe(200)
    const b = r.body as any
    expect(b).toMatchObject({ current: "local", placement: null, stale: false, issue: "acme/app#7", agentId: "coder" })
    expect(b.choices).toEqual([
      { node: "local", label: "This Mac", healthy: true, hostsAgent: true, hasCheckout: true, swapUsedPct: 40, load1: 3.2 },
      { node: "clawd", label: "clawd", healthy: true, hostsAgent: true, hasCheckout: true, swapUsedPct: 5, load1: 0.4 },
      { node: "old", label: "old", healthy: false, hostsAgent: true, hasCheckout: true },
    ])
  })

  it("GET shows a placement on an offline node as stale", async () => {
    store.setPlacement("github", "acme/app:issue:7", { node: "old", setBy: "owner", setAt: 1 })
    const b = (await runOnChoices("wp-1", deps())).body as any
    expect(b).toMatchObject({ current: "old", stale: true, staleSince: new Date(5000).toISOString() })
  })

  it("refuses a post without an issue home, and an unknown post", async () => {
    expect((await runOnChoices("wp-2", deps())).status).toBe(409)
    expect((await moveRunOn({ id: "wp-2", node: "clawd" }, deps())).status).toBe(409)
    expect((await moveRunOn({ id: "nope", node: "clawd" }, deps())).status).toBe(404)
    expect((await moveRunOn({ id: "wp-1" }, deps())).status).toBe(400)
  })

  it("refuses an unknown or unfit node, and one without placement (C2)", async () => {
    expect((await moveRunOn({ id: "wp-1", node: "ghost" }, deps())).status).toBe(404)
    expect(((await moveRunOn({ id: "wp-1", node: "nas" }, deps())).body as any).error).toContain("does not host coder")
    expect(((await moveRunOn({ id: "wp-1", node: "box" }, deps())).body as any).error).toContain("no checkout of acme/app")
    expect(((await moveRunOn({ id: "wp-1", node: "older" }, deps())).body as any).error).toContain("cannot run a placed issue")
    expect(((await moveRunOn({ id: "wp-1", node: "old" }, deps())).body as any).error).toContain("offline")
    expect(placed()).toBeNull()
  })

  it("refuses a move the holder's check fails, for each reason", async () => {
    for (const s of [{ runOpen: true, worktree: null }, { runOpen: false, worktree: { branch: "agentx/issue-7", dirty: true, ahead: 0 } }, { runOpen: false, worktree: { branch: "agentx/issue-7", dirty: false, ahead: 1 } }]) {
      states.local = s
      const r = await moveRunOn({ id: "wp-1", node: "clawd" }, deps())
      expect(r.status).toBe(409)
      expect(placed()).toBeNull()
    }
    expect(asked).toEqual(["local", "local", "local"])
  })

  it("moves when clean (checked before and after the write), and local is written, not deleted", async () => {
    states.local = { runOpen: false, worktree: { branch: "agentx/issue-7", dirty: false, ahead: 0 } }
    const r = await moveRunOn({ id: "wp-1", node: "clawd", by: "owner" }, deps())
    expect(r.status).toBe(200)
    expect(placed()).toEqual({ node: "clawd", setBy: "owner", setAt: 1000 })
    expect(asked).toEqual(["local", "local"])
    // Back to this Mac: clawd, which holds it now, is asked.
    asked = []
    states.clawd = { runOpen: true, worktree: null }
    expect((await moveRunOn({ id: "wp-1", node: "local" }, deps())).status).toBe(409)
    states.clawd = new Error("timed out")
    expect(((await moveRunOn({ id: "wp-1", node: "local" }, deps())).body as any).error).toContain("Could not ask clawd")
    states.clawd = { runOpen: false, worktree: null }
    const back = await moveRunOn({ id: "wp-1", node: "local" }, deps())
    expect(back.status).toBe(200)
    expect((back.body as any).message).toContain("Back to this Mac")
    expect(placed()?.node).toBe("local")
    expect(asked).toEqual(["clawd", "clawd", "clawd", "clawd"])
  })

  it("a run that opens during the move puts the old placement back and refuses", async () => {
    store.setPlacement("github", "acme/app:issue:7", { node: "clawd", setBy: "owner", setAt: 5 })
    states.clawd = [{ runOpen: false, worktree: null }, { runOpen: true, worktree: null }]
    const r = await moveRunOn({ id: "wp-1", node: "local" }, deps())
    expect(r.status).toBe(409)
    expect((r.body as any).error).toContain("opened")
    expect(placed()).toEqual({ node: "clawd", setBy: "owner", setAt: 5 })
    // With no placement before, the undo leaves none.
    store.restorePlacement("github", "acme/app:issue:7", null)
    states.local = [{ runOpen: false, worktree: null }, { runOpen: true, worktree: null }]
    expect((await moveRunOn({ id: "wp-1", node: "clawd" }, deps())).status).toBe(409)
    expect(placed()).toBeNull()
  })

  it("an offline holder refuses every move, Back to this Mac included", async () => {
    store.setPlacement("github", "acme/app:issue:7", { node: "old", setBy: "owner", setAt: 1 })
    expect(((await moveRunOn({ id: "wp-1", node: "clawd" }, deps())).body as any).error).toContain("old is offline")
    const back = await moveRunOn({ id: "wp-1", node: "local" }, deps())
    expect(back.status).toBe(409)
    expect(asked).toEqual([])
    expect(placed()?.node).toBe("old")
    // The refusal says the owner may force it.
    expect((back.body as any).forcible).toBe(true)
  })

  it("C-c: Use the agent's default deletes the row, after the same checks", async () => {
    expect(((await moveRunOn({ id: "wp-1", node: "default" }, deps())).body as any).message).toContain("already uses")
    store.setPlacement("github", "acme/app:issue:7", { node: "clawd", setBy: "owner", setAt: 5 })
    states.clawd = { runOpen: true, worktree: null }
    expect((await moveRunOn({ id: "wp-1", node: "default" }, deps())).status).toBe(409)
    expect(placed()?.node).toBe("clawd")
    states.clawd = { runOpen: false, worktree: null }
    const r = await moveRunOn({ id: "wp-1", node: "default" }, deps())
    expect(r.status).toBe(200)
    expect((r.body as any).message).toContain("agent's default")
    expect(placed()).toBeNull()
    expect(asked).toEqual(["clawd", "clawd", "clawd"])
    // A run that opens meanwhile puts the row back.
    store.setPlacement("github", "acme/app:issue:7", { node: "clawd", setBy: "owner", setAt: 5 })
    states.clawd = [{ runOpen: false, worktree: null }, { runOpen: true, worktree: null }]
    expect((await moveRunOn({ id: "wp-1", node: "default" }, deps())).status).toBe(409)
    expect(placed()).toEqual({ node: "clawd", setBy: "owner", setAt: 5 })
  })

  it("Q4: a forced move off an offline holder needs its name, notes the issue, and keeps the issue off that node until cleared", async () => {
    store.setPlacement("github", "acme/app:issue:7", { node: "old", setBy: "owner", setAt: 1 })
    const notes: Array<[string, string, string]> = []
    const shas: string[] = []
    const d: RunOnDeps = {
      ...deps(),
      pushedSha: async (_p, project, branch) => { shas.push(`${project} ${branch}`); return "abcdef1234567890" },
      noteOnIssue: async (p, chat, text) => { notes.push([p, chat, text]) },
    }
    // No confirm, or the wrong name: refused, nothing written.
    for (const confirm of [undefined, "clawd"]) {
      const r = await moveRunOn({ id: "wp-1", node: "local", force: true, confirm }, d)
      expect(r.status).toBe(409)
      expect((r.body as any).error).toContain("confirm with the name of the offline node, old")
    }
    expect(placed()?.node).toBe("old")
    expect(notes).toEqual([])
    // With it: moved, the holder never asked, one note with who, when, node and sha.
    const r = await moveRunOn({ id: "wp-1", node: "local", force: true, confirm: "old", by: "owner" }, d)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ forced: true, noted: true, current: "local", pushedSha: "abcdef1234567890" })
    expect(placed()?.node).toBe("local")
    expect(asked).toEqual([])
    expect(shas).toEqual(["acme/app agentx/issue-7"])
    expect(notes).toHaveLength(1)
    expect(notes[0][0]).toBe("github")
    expect(notes[0][1]).toBe("acme/app:issue:7")
    expect(notes[0][2]).toContain("Moved by owner at 1970-01-01T00:00:01.000Z")
    expect(notes[0][2]).toContain("no longer runs on old")
    expect(notes[0][2]).toContain("origin/agentx/issue-7 at abcdef123456")
    expect(store.leftBehind("github", "acme/app:issue:7")).toEqual([{ node: "old", pushedSha: "abcdef1234567890", setBy: "owner", setAt: 1000 }])
    // old is back online: the issue is not placed there until the owner clears it.
    peers.find((p) => p.peer === "old").healthy = true
    states.local = { runOpen: false, worktree: null }
    const again = await moveRunOn({ id: "wp-1", node: "old" }, d)
    expect(again.status).toBe(409)
    expect((again.body as any).error).toContain("left behind")
    expect((await runOnChoices("wp-1", d)).body).toMatchObject({ leftBehind: [{ node: "old" }] })
    // Cleared: it can go there again.
    expect((await moveRunOn({ id: "wp-1", dropLeftBehind: "old" }, d)).status).toBe(200)
    expect((await moveRunOn({ id: "wp-1", dropLeftBehind: "old" }, d)).status).toBe(404)
    expect((await moveRunOn({ id: "wp-1", node: "old" }, d)).status).toBe(200)
    expect(placed()?.node).toBe("old")
  })

  it("C-d: Use the agent's default is refused when the default is a node keeping left-behind work, forced or not", async () => {
    // Forced off old, whose mapping is the agent's default: refused, nothing written.
    store.setPlacement("github", "acme/app:issue:7", { node: "old", setBy: "owner", setAt: 1 })
    const d: RunOnDeps = { ...deps(), defaultNode: (p, a) => (p === "github" && a === "coder" ? "old" : undefined), noteOnIssue: async () => {} }
    const forced = await moveRunOn({ id: "wp-1", node: "default", force: true, confirm: "old" }, d)
    expect(forced.status).toBe(409)
    expect((forced.body as any).error).toContain("The agent's default for acme/app#7 is old")
    expect(placed()?.node).toBe("old")
    expect(store.leftBehind("github", "acme/app:issue:7")).toEqual([])
    // Forced to this Mac instead: old keeps the work; default is refused while it does.
    expect((await moveRunOn({ id: "wp-1", node: "local", force: true, confirm: "old" }, d)).status).toBe(200)
    peers.find((p) => p.peer === "old").healthy = true
    states.local = { runOpen: false, worktree: null }
    const later = await moveRunOn({ id: "wp-1", node: "default" }, d)
    expect(later.status).toBe(409)
    expect(placed()?.node).toBe("local")
    // Another default, or the record cleared: it moves.
    expect((await moveRunOn({ id: "wp-1", dropLeftBehind: "old" }, d)).status).toBe(200)
    expect((await moveRunOn({ id: "wp-1", node: "default" }, d)).status).toBe(200)
    expect(placed()).toBeNull()
  })

  it("Q4: force on a holder that is online changes nothing: the normal checks run", async () => {
    store.setPlacement("github", "acme/app:issue:7", { node: "clawd", setBy: "owner", setAt: 1 })
    states.clawd = { runOpen: false, worktree: { branch: "agentx/issue-7", dirty: true, ahead: 0 } }
    const r = await moveRunOn({ id: "wp-1", node: "local", force: true, confirm: "clawd" }, deps())
    expect(r.status).toBe(409)
    expect(placed()?.node).toBe("clawd")
    expect(store.leftBehind("github", "acme/app:issue:7")).toEqual([])
  })

  it("Q4: the move stands when the note fails, and says so", async () => {
    store.setPlacement("github", "acme/app:issue:7", { node: "old", setBy: "owner", setAt: 1 })
    const d: RunOnDeps = { ...deps(), pushedSha: async () => null, noteOnIssue: async () => { throw new Error("forge down") } }
    const r = await moveRunOn({ id: "wp-1", node: "clawd", force: true, confirm: "old" }, d)
    expect(r.status).toBe(200)
    expect((r.body as any).message).toContain("The note on the issue failed: forge down")
    expect(placed()?.node).toBe("clawd")
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

  it("C-a: the move is the owner's: loopback or the operator key, never the mesh token alone", () => {
    expect(isOwnerOnlyPost("/issue-run-on")).toBe(true)
    expect(isOwnerOnlyPost("/mesh/issue-state")).toBe(false)
    expect(ownerPostAllowed("127.0.0.1", false)).toBe(true)
    expect(ownerPostAllowed("::1", false)).toBe(true)
    expect(ownerPostAllowed("100.64.0.7", true)).toBe(true)
    // A peer with a valid mesh token but no operator key.
    expect(ownerPostAllowed("100.64.0.7", false)).toBe(false)
  })

  it("passes a forced move, the default and a clear to the daemon", async () => {
    const daemon = vi.fn(async () => ({ status: 200, body: { ok: true } }))
    const deps = { inbox: { root: "/nowhere" }, daemon } as any
    await handleWallAction("POST", WALL_RUN_ON_PATH, { id: "wp-1", node: "local", force: true, confirm: "old" }, deps)
    expect(daemon).toHaveBeenLastCalledWith("POST", "/issue-run-on", { id: "wp-1", node: "local", by: "owner", force: true, confirm: "old" })
    await handleWallAction("POST", WALL_RUN_ON_PATH, { id: "wp-1", node: "default" }, deps)
    expect(daemon).toHaveBeenLastCalledWith("POST", "/issue-run-on", { id: "wp-1", node: "default", by: "owner" })
    await handleWallAction("POST", WALL_RUN_ON_PATH, { id: "wp-1", dropLeftBehind: "old" }, deps)
    expect(daemon).toHaveBeenLastCalledWith("POST", "/issue-run-on", { id: "wp-1", dropLeftBehind: "old", by: "owner" })
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
