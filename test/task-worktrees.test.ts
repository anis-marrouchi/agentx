import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  TASK_WORKTREE_DEFAULTS, changeSourceOf, pickCheckout, prepareChangeWorktree, prepareTaskWorktree, pruneTaskWorktrees, remotePath,
  worktreeBranch, worktreeHolding, worktreeInstructions, worktreeRoot, worktreeTarget,
} from "../src/agents/task-worktrees"
import { execProcess } from "../src/agents/spec-tests"
import { daemonConfigSchema } from "../src/daemon/config"
import { AgentRegistry } from "../src/agents/registry"

// A worktree per coder task (#1292): an issue's tasks run on their own
// branch in their own folder, and the shared checkout is never touched.

describe("worktreeTarget", () => {
  it("takes GitHub, GitLab and tracker issues", () => {
    expect(worktreeTarget("github", "example-org/api:issue:12")).toEqual({ source: "github", repo: "example-org/api", id: "12" })
    expect(worktreeTarget("gitlab", "group/sub/api:issue:7")).toEqual({ source: "gitlab", repo: "group/sub/api", id: "7" })
    expect(worktreeTarget("linear", "linear:ENG-12")).toEqual({ source: "linear", id: "ENG-12" })
    expect(worktreeTarget("jira", "jira:proj-4")).toEqual({ source: "jira", id: "PROJ-4" })
  })

  it("takes GitHub pull requests and GitLab merge requests as changes (#2102)", () => {
    expect(worktreeTarget("github", "example-org/api:pull:12")).toEqual({ source: "github", repo: "example-org/api", id: "12", kind: "change" })
    expect(worktreeTarget("gitlab", "group/api:merge_request:3")).toEqual({ source: "gitlab", repo: "group/api", id: "3", kind: "change" })
  })

  it("leaves chats alone", () => {
    expect(worktreeTarget("telegram", "12345")).toBeNull()
    expect(worktreeTarget("github", undefined)).toBeNull()
  })
})

describe("changeSourceOf", () => {
  it("reads the GitHub pull request head and spots a fork", () => {
    const pr = (head: string | null) => ({ repository: { full_name: "o/r" }, pull_request: { head: { ref: "feat", repo: head ? { full_name: head } : null }, base: { repo: { full_name: "o/r" } } } })
    expect(changeSourceOf(pr("o/r"))).toEqual({ sourceBranch: "feat", sourceFork: false })
    expect(changeSourceOf(pr("someone/r"))).toEqual({ sourceBranch: "feat", sourceFork: true })
    expect(changeSourceOf(pr(null))).toEqual({ sourceBranch: "feat", sourceFork: true })
  })

  it("reads GitLab merge request events and notes, and spots a fork", () => {
    expect(changeSourceOf({ object_kind: "merge_request", object_attributes: { source_branch: "fix", source_project_id: 1, target_project_id: 1 } })).toEqual({ sourceBranch: "fix", sourceFork: false })
    expect(changeSourceOf({ object_kind: "note", merge_request: { source_branch: "fix", source_project_id: 2, target_project_id: 1 } })).toEqual({ sourceBranch: "fix", sourceFork: true })
  })

  it("reads a GitHub workflow run and a GitLab MR pipeline (CI fix loop)", () => {
    const run = (head: string) => ({ repository: { full_name: "o/r" }, workflow_run: { head_branch: "feat", head_repository: { full_name: head } } })
    expect(changeSourceOf(run("o/r"))).toEqual({ sourceBranch: "feat", sourceFork: false })
    expect(changeSourceOf(run("someone/r"))).toEqual({ sourceBranch: "feat", sourceFork: true })
    expect(changeSourceOf({ object_kind: "pipeline", merge_request: { source_branch: "fix", source_project_id: 1, target_project_id: 1 } })).toEqual({ sourceBranch: "fix", sourceFork: false })
  })

  it("is undefined for anything else", () => {
    expect(changeSourceOf({ issue: { number: 1 } })).toBeUndefined()
    expect(changeSourceOf(undefined)).toBeUndefined()
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

  it("is on by default in the agent config (#2102)", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "n" }, agents: { coder: { name: "Coder", tier: "claude-code", workspace: "/tmp/x" } } })
    expect(cfg.agents.coder.worktrees).toEqual({ enabled: true, maxAgeDays: 14 })
    expect(TASK_WORKTREE_DEFAULTS.enabled).toBe(true)
    const off = daemonConfigSchema.parse({ node: { id: "n", name: "n" }, agents: { coder: { name: "Coder", tier: "claude-code", workspace: "/tmp/x", worktrees: { enabled: false } } } })
    expect(off.agents.coder.worktrees.enabled).toBe(false)
  })

  it("finds the worktree holding a branch", () => {
    const porcelain = "worktree /srv/api\nHEAD abc\nbranch refs/heads/main\n\nworktree /srv/wt/issue-12\nHEAD def\nbranch refs/heads/agentx/issue-12\n\nworktree /srv/wt/old\nHEAD 123\ndetached\n"
    expect(worktreeHolding(porcelain, "agentx/issue-12")).toBe("/srv/wt/issue-12")
    expect(worktreeHolding(porcelain, "main")).toBe("/srv/api")
    expect(worktreeHolding(porcelain, "agentx/issue-1")).toBeUndefined()
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

describe("pull and merge request worktrees (real git, #2102)", () => {
  let base: string
  let origin: string
  let checkout: string
  let repo: string
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim()
  const settings = { ...TASK_WORKTREE_DEFAULTS }
  const prevCwd = process.cwd()

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "agentx-wt-change-"))
    origin = join(base, "origin.git")
    checkout = join(base, "api")
    // A host in the URL so remotePath() reads a project path pickCheckout can match.
    const url = `file://localhost${origin}`
    repo = remotePath(url)!
    execFileSync("git", ["init", "--bare", "-b", "main", origin])
    execFileSync("git", ["clone", "-q", url, checkout])
    writeFileSync(join(checkout, "README.md"), "hello\n")
    git(checkout, "add", ".")
    git(checkout, "commit", "-q", "-m", "init")
    git(checkout, "push", "-q", "origin", "HEAD:main")
    git(checkout, "remote", "set-head", "origin", "main")
    // Someone else's change branch, on origin only.
    git(checkout, "checkout", "-q", "-b", "feat/login")
    writeFileSync(join(checkout, "login.txt"), "login\n")
    git(checkout, "add", ".")
    git(checkout, "commit", "-q", "-m", "login")
    git(checkout, "push", "-q", "origin", "feat/login")
    git(checkout, "checkout", "-q", "main")
    git(checkout, "branch", "-q", "-D", "feat/login")
    process.chdir(base)
  })
  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(base, { recursive: true, force: true })
  })

  it("reuses the issue worktree that has the branch checked out", async () => {
    const issue = await prepareTaskWorktree({ source: "github", repo, id: "12" }, checkout, settings, { exec: execProcess })
    if ("error" in issue) throw new Error(issue.error)
    git(issue.dir, "push", "-q", "origin", "agentx/issue-12")
    const wt = await prepareChangeWorktree({ source: "github", repo, id: "40", kind: "change" }, "agentx/issue-12", checkout, settings, { exec: execProcess })
    expect(wt).toMatchObject({ branch: "agentx/issue-12", reused: true, adopted: true, change: "pull request" })
    if ("error" in wt) throw new Error(wt.error)
    expect(realpathSync(wt.dir)).toBe(realpathSync(issue.dir))
    expect(existsSync(join(base, ".agentx-worktrees", "api", "pr-40"))).toBe(false)
    const text = worktreeInstructions(wt)
    expect(text).toContain("pull request")
    expect(text).toContain("push to that branch")
  })

  it("adds a worktree tracking origin/<branch> when none has it", async () => {
    const wt = await prepareChangeWorktree({ source: "gitlab", repo, id: "7", kind: "change" }, "feat/login", checkout, settings, { exec: execProcess })
    if ("error" in wt) throw new Error(wt.error)
    expect(wt).toMatchObject({ dir: join(base, ".agentx-worktrees", "api", "mr-7"), branch: "feat/login", reused: false, change: "merge request" })
    expect(git(wt.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/login")
    expect(git(wt.dir, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feat/login")
    expect(existsSync(join(wt.dir, "login.txt"))).toBe(true)
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
    // The next task finds it in place, not a second checkout of the branch.
    const again = await prepareChangeWorktree({ source: "gitlab", repo, id: "7", kind: "change" }, "feat/login", checkout, settings, { exec: execProcess })
    expect(again).toMatchObject({ dir: wt.dir, reused: true })
    expect(again).not.toHaveProperty("adopted")
  })

  it("adds a worktree on an existing local branch that is not checked out", async () => {
    git(checkout, "branch", "-q", "feat/login", "origin/feat/login")
    const wt = await prepareChangeWorktree({ source: "github", repo, id: "9", kind: "change" }, "feat/login", checkout, settings, { exec: execProcess })
    if ("error" in wt) throw new Error(wt.error)
    expect(wt).toMatchObject({ dir: join(base, ".agentx-worktrees", "api", "pr-9"), reused: false })
    expect(git(wt.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/login")
  })

  it("will not check out the branch the checkout itself is on", async () => {
    git(checkout, "checkout", "-q", "-b", "feat/login", "origin/feat/login")
    const wt = await prepareChangeWorktree({ source: "github", repo, id: "9", kind: "change" }, "feat/login", checkout, settings, { exec: execProcess })
    expect(wt).toHaveProperty("error")
  })

  describe("in the registry", () => {
    const run = async (chatId: string, context: Record<string, unknown>, worktrees?: Record<string, unknown>) => {
      const lines: string[] = []
      const config = daemonConfigSchema.parse({ jobState: { enabled: false }, node: { id: "t", name: "t" }, agents: { coder: { name: "Coder", tier: "claude-code", workspace: checkout } } })
      const r = new AgentRegistry(config, (...a: unknown[]) => lines.push(a.join(" ")))
      const def = { ...config.agents.coder, ...(worktrees ? { worktrees: { ...config.agents.coder.worktrees, ...worktrees } } : {}) }
      const task = { agentId: "coder", message: "hi", context: { channel: "gitlab", chatId, ...context } }
      const out = await (r as any).inTaskWorktree(def, task)
      return { out, task, lines }
    }

    // GitLab chat ids: a GitHub one needs an owner/name repository, and the
    // test origin is a local folder.
    it("runs a merge request task on its source branch", async () => {
      const { out } = await run(`${repo}:merge_request:5`, { sourceBranch: "feat/login", sourceFork: false })
      expect(out.task.cwd).toBe(join(base, ".agentx-worktrees", "api", "mr-5"))
      expect(out.fresh).toBe(true)
    })

    it("runs a fork's change in the checkout", async () => {
      const { out, task, lines } = await run(`${repo}:merge_request:5`, { sourceBranch: "feat/login", sourceFork: true })
      expect(out.task).toBe(task)
      expect(lines.join("\n")).toContain("fork")
    })

    it("runs a change with no known source branch in the checkout", async () => {
      const { out, task, lines } = await run(`${repo}:merge_request:5`, {})
      expect(out.task).toBe(task)
      expect(lines.join("\n")).toContain("source branch unknown")
    })

    it("still runs issue tasks in the issue's worktree", async () => {
      const { out } = await run(`${repo}:issue:3`, {})
      expect(out.task.cwd).toBe(join(base, ".agentx-worktrees", "api", "issue-3"))
    })

    it("makes no worktree with enabled: false", async () => {
      const { out, task } = await run(`${repo}:merge_request:5`, { sourceBranch: "feat/login" }, { enabled: false })
      expect(out.task).toBe(task)
      expect(existsSync(join(base, ".agentx-worktrees"))).toBe(false)
    })
  })
})
