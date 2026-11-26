import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  TASK_WORKTREE_DEFAULTS, badBranchName, changeSourceOf, hasTargetWorktree, pickCheckout, prepareChangeWorktree, prepareTaskWorktree, pruneTaskWorktrees, remotePath,
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

  it("is off by default in the agent config, on per agent (#2102 review B4)", () => {
    const cfg = daemonConfigSchema.parse({ node: { id: "n", name: "n" }, agents: { coder: { name: "Coder", tier: "claude-code", workspace: "/tmp/x" } } })
    expect(cfg.agents.coder.worktrees).toEqual({ enabled: false, maxAgeDays: 14 })
    expect(TASK_WORKTREE_DEFAULTS.enabled).toBe(false)
    const on = daemonConfigSchema.parse({ node: { id: "n", name: "n" }, agents: { coder: { name: "Coder", tier: "claude-code", workspace: "/tmp/x", worktrees: { enabled: true } } } })
    expect(on.agents.coder.worktrees.enabled).toBe(true)
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
    // The marker is in every agent's system prompt instead (#2102 review).
    expect(text).not.toContain("agentx:")
  })
})

describe("pull and merge request worktrees (real git, #2102)", () => {
  let base: string
  let origin: string
  let checkout: string
  let repo: string
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim()
  const settings = { ...TASK_WORKTREE_DEFAULTS, enabled: true }
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

  it("works in the checkout itself when it is on the source branch", async () => {
    git(checkout, "checkout", "-q", "-b", "feat/login", "origin/feat/login")
    const wt = await prepareChangeWorktree({ source: "github", repo, id: "9", kind: "change" }, "feat/login", checkout, settings, { exec: execProcess })
    if ("error" in wt) throw new Error(wt.error)
    expect(wt).toMatchObject({ dir: checkout, branch: "feat/login", reused: true, inCheckout: true })
    expect(existsSync(join(base, ".agentx-worktrees", "api", "pr-9"))).toBe(false)
    const text = worktreeInstructions(wt)
    expect(text).toContain("checked out")
    expect(text).not.toContain("do not edit")
  })

  // #2130: branch names checked, `--` before paths and refs.
  const recording = () => {
    const calls: string[][] = []
    const exec: typeof execProcess = (cmd, args, opts) => { calls.push(args); return execProcess(cmd, args, opts) }
    return { calls, exec }
  }

  it("refuses a branch name git would read as an option or not take (#2130)", async () => {
    expect(await badBranchName("feat/login", checkout, execProcess)).toBeNull()
    expect(await badBranchName("--upload-pack=touch x", checkout, execProcess)).toContain("starts with \"-\"")
    expect(await badBranchName("a..b", checkout, execProcess)).toContain("refused the branch name")
    expect(await badBranchName("@{-1}", checkout, execProcess)).toContain("refused the branch name")
    const { calls, exec } = recording()
    const wt = await prepareChangeWorktree({ source: "github", repo, id: "9", kind: "change" }, "-b", checkout, settings, { exec })
    expect(wt).toEqual({ error: expect.stringContaining("refused the branch name \"-b\"") })
    expect(calls.some((a) => a[0] === "fetch" || a[0] === "worktree")).toBe(false)
  })

  it("puts -- before the branch and the folder in fetch and worktree add (#2130)", async () => {
    const { calls, exec } = recording()
    const wt = await prepareChangeWorktree({ source: "github", repo, id: "9", kind: "change" }, "feat/login", checkout, settings, { exec })
    if ("error" in wt) throw new Error(wt.error)
    expect(calls).toContainEqual(["fetch", "origin", "--", "feat/login"])
    expect(calls).toContainEqual(["worktree", "add", "--track", "-b", "feat/login", "--", wt.dir, "origin/feat/login"])
    const issue = recording()
    const iw = await prepareTaskWorktree({ source: "github", repo, id: "12" }, checkout, settings, { exec: issue.exec })
    if ("error" in iw) throw new Error(iw.error)
    expect(issue.calls).toContainEqual(["worktree", "add", "-b", "agentx/issue-12", "--", iw.dir, "origin/main"])
  })

  it("runs an issue task in the pull request worktree that has its branch, brought up to origin (#2130)", async () => {
    // The issue branch pushed, then checked out only in a pr-<n> worktree.
    git(checkout, "branch", "-q", "--no-track", "agentx/issue-12", "origin/main")
    git(checkout, "push", "-q", "origin", "agentx/issue-12")
    git(checkout, "branch", "-q", "-D", "agentx/issue-12")
    const pr = await prepareChangeWorktree({ source: "github", repo, id: "40", kind: "change" }, "agentx/issue-12", checkout, settings, { exec: execProcess })
    if ("error" in pr) throw new Error(pr.error)
    expect(pr.dir).toBe(join(base, ".agentx-worktrees", "api", "pr-40"))
    // Someone pushes to the branch from elsewhere.
    const other = join(base, "other")
    execFileSync("git", ["clone", "-q", "-b", "agentx/issue-12", origin, other])
    writeFileSync(join(other, "theirs.txt"), "theirs\n")
    git(other, "add", ".")
    git(other, "commit", "-q", "-m", "theirs")
    git(other, "push", "-q", "origin", "agentx/issue-12")
    const issueTarget = { source: "github" as const, repo, id: "12" }
    expect(await hasTargetWorktree(issueTarget, undefined, checkout, settings, execProcess)).toBe(true)
    const wt = await prepareTaskWorktree(issueTarget, checkout, settings, { exec: execProcess })
    if ("error" in wt) throw new Error(wt.error)
    expect(wt).toMatchObject({ branch: "agentx/issue-12", reused: true, adopted: true })
    expect(realpathSync(wt.dir)).toBe(realpathSync(pr.dir))
    expect(existsSync(join(base, ".agentx-worktrees", "api", "issue-12"))).toBe(false)
    expect(existsSync(join(wt.dir, "theirs.txt"))).toBe(true)
  })

  it("prunes an old pull request worktree and its pushed local branch, keeps a branch with unpushed work (#2130)", async () => {
    const pushed = await prepareChangeWorktree({ source: "github", repo, id: "9", kind: "change" }, "feat/login", checkout, settings, { exec: execProcess })
    git(checkout, "branch", "-q", "--no-track", "feat/wip", "origin/main")
    git(checkout, "push", "-q", "origin", "feat/wip")
    const wip = await prepareChangeWorktree({ source: "gitlab", repo, id: "3", kind: "change" }, "feat/wip", checkout, settings, { exec: execProcess })
    if ("error" in pushed || "error" in wip) throw new Error("setup")
    writeFileSync(join(wip.dir, "wip.txt"), "x\n")
    git(wip.dir, "add", ".")
    git(wip.dir, "commit", "-q", "-m", "not pushed")
    const old = new Date(Date.now() - 30 * 86_400_000)
    utimesSync(pushed.dir, old, old)
    utimesSync(wip.dir, old, old)
    const lines: string[] = []
    const removed = await pruneTaskWorktrees(checkout, settings, { exec: execProcess, log: (l) => lines.push(l) })
    expect(removed.sort()).toEqual([wip.dir, pushed.dir].sort())
    expect(git(checkout, "branch", "--list", "feat/login")).toBe("")
    expect(git(checkout, "branch", "--list", "feat/wip")).toContain("feat/wip")
    expect(lines.join("\n")).toContain("kept the branch feat/wip")
    expect(lines.join("\n")).toContain("1 commit(s) not on origin")
  })

  describe("in the registry", () => {
    const run = async (chatId: string, context: Record<string, unknown>, worktrees: Record<string, unknown> = { enabled: true }, opts: { sessionKept?: boolean; openRequest?: (p: string, project: string, n: number) => boolean } = {}) => {
      const lines: string[] = []
      const config = daemonConfigSchema.parse({ jobState: { enabled: false }, node: { id: "t", name: "t" }, agents: { coder: { name: "Coder", tier: "claude-code", workspace: checkout } } })
      const r = new AgentRegistry(config, (...a: unknown[]) => lines.push(a.join(" ")))
      if (opts.openRequest) r.setOpenRequestOnIssue(opts.openRequest)
      const def = { ...config.agents.coder, worktrees: { ...config.agents.coder.worktrees, ...worktrees } }
      const task = { agentId: "coder", message: "hi", context: { channel: "gitlab", chatId, ...context } }
      const out = await (r as any).inTaskWorktree(def, task, { sessionKept: opts.sessionKept })
      return { out, task, lines }
    }

    // #2130: one pending worktree per branch, not per agent.
    const twoAgents = () => {
      const lines: string[] = []
      const ws = { tier: "claude-code", workspace: checkout, worktrees: { enabled: true } }
      const config = daemonConfigSchema.parse({ jobState: { enabled: false }, node: { id: "t", name: "t" }, agents: { coder: { name: "Coder", ...ws }, reviewer: { name: "Reviewer", ...ws } } })
      const r = new AgentRegistry(config, (...a: unknown[]) => lines.push(a.join(" ")))
      r.setOpenRequestOnIssue(() => false)
      const go = (agentId: "coder" | "reviewer", chatId: string, context: Record<string, unknown> = {}) =>
        (r as any).inTaskWorktree(config.agents[agentId], { agentId, message: "hi", context: { channel: "gitlab", chatId, ...context } }, {})
      return { go, lines }
    }

    it("gives two agents on one issue at once the same worktree (#2130)", async () => {
      const { go, lines } = twoAgents()
      const [a, b] = await Promise.all([go("coder", `${repo}:issue:3`), go("reviewer", `${repo}:issue:3`)])
      const dir = join(base, ".agentx-worktrees", "api", "issue-3")
      expect(a.task.cwd).toBe(dir)
      expect(b.task.cwd).toBe(dir)
      expect(lines.join("\n")).not.toContain("running in the workspace")
    })

    it("lets an issue and its merge request on the same branch arrive together (#2130)", async () => {
      git(checkout, "branch", "-q", "--no-track", "agentx/issue-3", "origin/main")
      git(checkout, "push", "-q", "origin", "agentx/issue-3")
      git(checkout, "branch", "-q", "-D", "agentx/issue-3")
      const { go, lines } = twoAgents()
      const [issue, mr] = await Promise.all([
        go("coder", `${repo}:issue:3`),
        go("reviewer", `${repo}:merge_request:8`, { sourceBranch: "agentx/issue-3", sourceFork: false }),
      ])
      expect(issue.task.cwd).toBe(join(base, ".agentx-worktrees", "api", "issue-3"))
      expect(realpathSync(mr.task.cwd)).toBe(realpathSync(issue.task.cwd))
      expect(mr.task.systemPromptAppend).toContain("merge request")
      expect(lines.join("\n")).not.toContain("running in the workspace")
    })

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

    it("makes no worktree by default (#2102 review B4)", async () => {
      const { out, task } = await run(`${repo}:issue:3`, {}, {})
      expect(out.task).toBe(task)
      expect(existsSync(join(base, ".agentx-worktrees"))).toBe(false)
    })

    it("gives a new issue a worktree", async () => {
      const { out, lines } = await run(`${repo}:issue:3`, {}, { enabled: true }, { openRequest: () => false })
      expect(out.task.cwd).toBe(join(base, ".agentx-worktrees", "api", "issue-3"))
      expect(out.fresh).toBe(true)
      expect(out.task.systemPromptAppend).toContain(out.task.cwd)
      expect(out.task.systemPromptAppend).not.toContain("agentx:coder")
      expect(lines.join("\n")).toMatch(/\[worktrees\] coder .*: created .* on agentx\/issue-3/)
    })

    it("keeps an issue with a kept session and no worktree yet in the checkout (#2102 review B5)", async () => {
      const { out, task, lines } = await run(`${repo}:issue:3`, {}, { enabled: true }, { sessionKept: true })
      expect(out.task).toBe(task)
      expect(out.fresh).toBeUndefined()
      expect(existsSync(join(base, ".agentx-worktrees"))).toBe(false)
      expect(lines.join("\n")).toContain("running in the workspace: in progress before worktrees (session)")
    })

    it("keeps an issue with an open request in the checkout", async () => {
      const asked: unknown[] = []
      const { out, task, lines } = await run(`${repo}:issue:3`, {}, { enabled: true }, { openRequest: (...a) => { asked.push(a); return true } })
      expect(out.task).toBe(task)
      expect(asked).toEqual([["gitlab", repo, 3, "coder"]])
      expect(lines.join("\n")).toContain("in progress before worktrees (open request)")
    })

    it("keeps an issue in the checkout when the open request lookup throws", async () => {
      const { out, task, lines } = await run(`${repo}:issue:3`, {}, { enabled: true }, { openRequest: () => { throw new Error("db locked") } })
      expect(out.task).toBe(task)
      expect(existsSync(join(base, ".agentx-worktrees"))).toBe(false)
      expect(lines.join("\n")).toContain("open request lookup failed, keeping the issue in the checkout: db locked")
      expect(lines.join("\n")).toContain("in progress before worktrees (open request)")
    })

    it("still reuses an existing worktree when the chat has a session", async () => {
      const first = await run(`${repo}:issue:3`, {})
      expect(first.out.task.cwd).toBe(join(base, ".agentx-worktrees", "api", "issue-3"))
      const { out, lines } = await run(`${repo}:issue:3`, {}, { enabled: true }, { sessionKept: true, openRequest: () => true })
      expect(out.task.cwd).toBe(join(base, ".agentx-worktrees", "api", "issue-3"))
      expect(out.fresh).toBe(false)
      expect(lines.join("\n")).toContain("reusing")
    })

    it("runs a merge request whose branch the checkout has checked out in the checkout", async () => {
      git(checkout, "checkout", "-q", "-b", "feat/login", "origin/feat/login")
      const { out, lines } = await run(`${repo}:merge_request:5`, { sourceBranch: "feat/login", sourceFork: false }, { enabled: true }, { sessionKept: true })
      expect(out.task.cwd).toBe(checkout)
      expect(out.fresh).toBe(false)
      expect(existsSync(join(base, ".agentx-worktrees", "api", "mr-5"))).toBe(false)
      expect(lines.join("\n")).toContain("reusing")
    })
  })
})
