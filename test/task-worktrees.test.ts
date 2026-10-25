import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  TASK_WORKTREE_DEFAULTS, pickCheckout, prepareTaskWorktree, pruneTaskWorktrees, remotePath, worktreeBranch, worktreeInstructions,
  worktreeRoot, worktreeTarget,
} from "../src/agents/task-worktrees"
import { execProcess } from "../src/agents/spec-tests"
import { daemonConfigSchema } from "../src/daemon/config"

// A worktree per coder task (#1292): an issue's tasks run on their own
// branch in their own folder, and the shared checkout is never touched.

describe("worktreeTarget", () => {
  it("takes GitHub, GitLab and tracker issues", () => {
    expect(worktreeTarget("github", "example-org/api:issue:12")).toEqual({ source: "github", repo: "example-org/api", id: "12" })
    expect(worktreeTarget("gitlab", "group/sub/api:issue:7")).toEqual({ source: "gitlab", repo: "group/sub/api", id: "7" })
    expect(worktreeTarget("linear", "linear:ENG-12")).toEqual({ source: "linear", id: "ENG-12" })
    expect(worktreeTarget("jira", "jira:proj-4")).toEqual({ source: "jira", id: "PROJ-4" })
  })

  it("leaves pull requests, merge requests and chats alone", () => {
    expect(worktreeTarget("github", "example-org/api:pull:12")).toBeNull()
    expect(worktreeTarget("gitlab", "group/api:merge_request:3")).toBeNull()
    expect(worktreeTarget("telegram", "12345")).toBeNull()
    expect(worktreeTarget("github", undefined)).toBeNull()
  })
})

describe("names and paths", () => {
  it("names the branch after the issue", () => {
    expect(worktreeBranch({ source: "github", repo: "o/r", id: "12" })).toBe("agentx/issue-12")
    expect(worktreeBranch({ source: "linear", id: "ENG-12" })).toBe("agentx/eng-12")
  })

  it("reads the project path from any remote", () => {
    expect(remotePath("https://github.com/example-org/api.git")).toBe("example-org/api")
    expect(remotePath("git@gitlab.example.com:group/sub/api.git")).toBe("group/sub/api")
    expect(remotePath("ssh://git@gitlab.example.com:2222/group/api")).toBe("group/api")
    expect(remotePath("/srv/repos/api")).toBeUndefined()
  })

  it("picks the checkout whose origin is the issue's repository", () => {
    const remotes: Record<string, string> = { "/a": "https://github.com/other/x.git", "/b": "git@github.com:example-org/API.git" }
    const remoteOf = (d: string) => remotes[d]
    expect(pickCheckout({ source: "github", repo: "example-org/api", id: "1" }, ["/a", "/b"], remoteOf)).toEqual({ dir: "/b" })
    expect(pickCheckout({ source: "github", repo: "example-org/web", id: "1" }, ["/a", "/b"], remoteOf)).toHaveProperty("reason")
    // A tracker issue names no repository: any git checkout will do.
    expect(pickCheckout({ source: "jira", id: "PROJ-1" }, ["/none", "/a"], remoteOf)).toEqual({ dir: "/a" })
  })

  it("puts worktrees beside the checkout unless a root is set", () => {
    expect(worktreeRoot("/srv/code/api", {})).toBe("/srv/code/.agentx-worktrees/api")
    expect(worktreeRoot("/srv/code/api", { root: "/var/wt" })).toBe("/var/wt")
  })

  it("is off by default in the agent config", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "n" }, agents: { coder: { name: "Coder", tier: "claude-code", workspace: "/tmp/x" } } })
    expect(cfg.agents.coder.worktrees).toEqual({ enabled: false, maxAgeDays: 14 })
  })
})

describe("prepareTaskWorktree (real git)", () => {
  let base: string
  let origin: string
  let checkout: string
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim()
  const settings = { ...TASK_WORKTREE_DEFAULTS, enabled: true }
  const target = { source: "github" as const, repo: "example-org/api", id: "12" }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "agentx-wt-"))
    origin = join(base, "origin.git")
    checkout = join(base, "api")
    execFileSync("git", ["init", "--bare", "-b", "main", origin])
    execFileSync("git", ["clone", "-q", origin, checkout])
    writeFileSync(join(checkout, "README.md"), "hello\n")
    git(checkout, "add", ".")
    git(checkout, "commit", "-q", "-m", "init")
    git(checkout, "push", "-q", "origin", "HEAD:main")
    git(checkout, "remote", "set-head", "origin", "main")
    git(checkout, "checkout", "-q", "-b", "someone-elses-branch")
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it("creates the issue's branch from the default branch and leaves the checkout as it was", async () => {
    const wt = await prepareTaskWorktree(target, checkout, settings, { exec: execProcess })
    if ("error" in wt) throw new Error(wt.error)
    expect(wt).toMatchObject({ branch: "agentx/issue-12", reused: false, dir: join(base, ".agentx-worktrees", "api", "issue-12") })
    expect(git(wt.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agentx/issue-12")
    expect(existsSync(join(wt.dir, "README.md"))).toBe(true)
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("someone-elses-branch")
    // Not tracking main: a plain `git push` must not land on the default branch.
    expect(() => git(wt.dir, "rev-parse", "--abbrev-ref", "@{upstream}")).toThrow()
  })

  it("reuses the worktree on the next task for the same issue", async () => {
    const first = await prepareTaskWorktree(target, checkout, settings, { exec: execProcess })
    if ("error" in first) throw new Error(first.error)
    writeFileSync(join(first.dir, "wip.txt"), "in progress\n")
    const second = await prepareTaskWorktree(target, checkout, settings, { exec: execProcess })
    expect(second).toMatchObject({ dir: first.dir, reused: true })
    expect(existsSync(join(first.dir, "wip.txt"))).toBe(true)
  })

  it("picks up a branch an earlier task pushed", async () => {
    git(checkout, "checkout", "-q", "-b", "agentx/issue-12", "origin/main")
    writeFileSync(join(checkout, "fix.txt"), "fix\n")
    git(checkout, "add", ".")
    git(checkout, "commit", "-q", "-m", "fix")
    git(checkout, "push", "-q", "origin", "agentx/issue-12")
    git(checkout, "checkout", "-q", "someone-elses-branch")
    git(checkout, "branch", "-q", "-D", "agentx/issue-12")
    const wt = await prepareTaskWorktree(target, checkout, settings, { exec: execProcess })
    if ("error" in wt) throw new Error(wt.error)
    expect(existsSync(join(wt.dir, "fix.txt"))).toBe(true)
  })

  it("reports a branch checked out in the checkout itself instead of switching it", async () => {
    git(checkout, "checkout", "-q", "-b", "agentx/issue-12")
    const wt = await prepareTaskWorktree(target, checkout, settings, { exec: execProcess })
    expect(wt).toHaveProperty("error")
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agentx/issue-12")
  })

  it("prunes old clean worktrees, keeps dirty ones and the branches", async () => {
    const clean = await prepareTaskWorktree(target, checkout, settings, { exec: execProcess })
    const dirty = await prepareTaskWorktree({ ...target, id: "13" }, checkout, settings, { exec: execProcess })
    if ("error" in clean || "error" in dirty) throw new Error("setup")
    writeFileSync(join(dirty.dir, "wip.txt"), "x\n")
    const old = new Date(Date.now() - 30 * 86_400_000)
    utimesSync(clean.dir, old, old)
    utimesSync(dirty.dir, old, old)
    const removed = await pruneTaskWorktrees(checkout, settings, { exec: execProcess })
    expect(removed).toEqual([clean.dir])
    expect(existsSync(dirty.dir)).toBe(true)
    expect(git(checkout, "branch", "--list", "agentx/issue-12")).toContain("agentx/issue-12")
  })

  it("tells the agent where it works", async () => {
    const wt = await prepareTaskWorktree(target, checkout, settings, { exec: execProcess })
    if ("error" in wt) throw new Error(wt.error)
    const text = worktreeInstructions(wt)
    expect(text).toContain(wt.dir)
    expect(text).toContain("`agentx/issue-12`")
    expect(text).toContain(checkout)
  })
})
