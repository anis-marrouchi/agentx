import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { closeDb, openDb } from "../src/storage/sqlite"
import { recordTraceStart, takeInterruptedRuns, type InterruptedRun } from "../src/storage/traces"
import { DEFAULT_RESUME_SETTINGS } from "../src/agents/resume/policy"
import { buildResumeNote } from "../src/agents/resume/note"
import { serializeOrigin, type RunOrigin } from "../src/agents/resume/origin"
import { ResumeCoordinator } from "../src/agents/resume/coordinator"
import { backgroundHelpers, findLeftWork, pathsInToolCalls } from "../src/agents/resume/work-left"

// #1256: background builders die with their run; their clones must not be
// forgotten.

let tmp: string
beforeEach(() => { closeDb(); tmp = mkdtempSync(path.join(tmpdir(), "agentx-left-")) })
afterEach(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }) })

const NOW = Date.parse("2026-10-25T00:53:42.000Z")
const origin: RunOrigin = {
  kind: "router", adapter: "telegram",
  message: { id: "m1", channel: "telegram", accountId: "bot", sender: { id: "42", name: "Sam" }, text: "build lanes", timestamp: "2026-10-25T00:40:00.000Z", resolvedAgent: "dev-agent" },
}

function run(toolCalls: InterruptedRun["toolCalls"], over: Partial<InterruptedRun> = {}): InterruptedRun {
  return {
    taskId: "t1", agentId: "dev-agent", channel: "telegram", chatId: "42", workflowRunId: null,
    startedAt: NOW - 10 * 60_000, originalMessage: "build lanes",
    resumeOrigin: serializeOrigin(origin), resumeAttempt: 0, toolCalls, ...over,
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "pipe" }).toString()

/** A remote, plus a clone of it on `branch` with `dirty` uncommitted files. */
function clone(name: string, branch: string, dirty: number): string {
  const remote = path.join(tmp, `${name}.git`)
  mkdirSync(remote)
  git(remote, "init", "--bare", "-q")
  const dir = path.join(tmp, name)
  mkdirSync(dir)
  git(dir, "init", "-q")
  writeFileSync(path.join(dir, "README.md"), "x")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  git(dir, "remote", "add", "origin", remote)
  git(dir, "push", "-q", "origin", "HEAD:refs/heads/main")
  git(dir, "checkout", "-qb", branch)
  for (let i = 0; i < dirty; i++) writeFileSync(path.join(dir, `f${i}.ts`), String(i))
  return dir
}

const agentCall = (description: string) => ({
  action: "Agent",
  inputSummary: JSON.stringify({ description, prompt: "build it", subagent_type: "general-purpose", run_in_background: true }),
})
const bash = (command: string) => ({ action: "Bash", inputSummary: JSON.stringify({ command }) })

describe("what a cut-off run left behind", () => {
  it("names its background helpers, not foreground ones", () => {
    const r = run([agentCall("Build lane A"), { action: "Agent", inputSummary: JSON.stringify({ description: "look up", prompt: "p" }) }])
    expect(backgroundHelpers(r)).toEqual(["Build lane A"])
  })

  it("finds absolute paths in tool inputs, without system folders", () => {
    const r = run([bash("git clone https://example.com/r.git /tmp/app-1 && cd /tmp/app-1 && ls /usr/bin"), { action: "Read", inputSummary: JSON.stringify({ file_path: "/tmp/app-2/src/a.ts" }) }])
    expect(pathsInToolCalls(r)).toEqual(["/tmp/app-1", "/tmp/app-2/src/a.ts"])
  })

  it("lists clones with uncommitted or unpushed work, and leaves clean ones out", async () => {
    const dirty = clone("app-1183", "1183-lane", 3)
    const clean = clone("app-1184", "1184-lane", 0)
    const ahead = clone("app-1188", "1188-lane", 0)
    writeFileSync(path.join(ahead, "b.ts"), "b")
    git(ahead, "add", ".")
    git(ahead, "commit", "-qm", "wip")
    const r = run([
      agentCall("Build 1183"),
      bash(`cd ${dirty} && pnpm test`),
      bash(`cd ${clean}`),
      { action: "Edit", inputSummary: JSON.stringify({ file_path: path.join(ahead, "src/not-yet.ts") }) },
      bash(`ls ${path.join(tmp, "missing")}`),
    ])
    const left = await findLeftWork(r)
    expect(left).toEqual([
      { path: dirty, branch: "1183-lane", changedFiles: 3, unpushedCommits: 0 },
      { path: ahead, branch: "1188-lane", changedFiles: 0, unpushedCommits: 1 },
    ])
    const note = buildResumeNote(r, left)
    expect(note).toContain("stopped the 1 background helper(s)")
    expect(note).toContain("1. Build 1183")
    expect(note).toContain(`${dirty} (branch 1183-lane): 3 changed files not committed`)
    expect(note).toContain(`${ahead} (branch 1188-lane): 1 commit not pushed`)
  })

  it("still finds a clone named after many file paths", async () => {
    const repo = clone("workspace", "main-work", 0)
    const dirty = clone("app-1190", "1190-lane", 2)
    const reads = Array.from({ length: 120 }, (_, i) => ({ action: "Read", inputSummary: JSON.stringify({ file_path: path.join(repo, "src", `file${i}.ts`) }) }))
    const left = await findLeftWork(run([...reads, bash(`cd ${dirty}`)]))
    expect(left).toEqual([{ path: dirty, branch: "1190-lane", changedFiles: 2, unpushedCommits: 0 }])
  })

  it("reports a clone by the path the run named, not git's real path", async () => {
    // Like /tmp -> /private/tmp on macOS.
    const real = clone("real-1191", "1191-lane", 1)
    const link = path.join(tmp, "link-1191")
    symlinkSync(real, link)
    const left = await findLeftWork(run([bash(`cd ${path.join(link, "src")} && ls`)]))
    expect(left).toEqual([{ path: link, branch: "1191-lane", changedFiles: 1, unpushedCommits: 0 }])
  })

  it("asks the resumed run to check the work is its own", () => {
    const note = buildResumeNote(run([]), [{ path: "/tmp/app-1", branch: "b", changedFiles: 1, unpushedCommits: 0 }])
    expect(note).toContain("check whether the work is yours")
  })

  it("says nothing extra when the run started no helpers and left nothing", () => {
    const note = buildResumeNote(run([bash("ls")]))
    expect(note).not.toContain("background helper")
    expect(note).not.toContain("unsaved")
  })
})

describe("ResumeCoordinator and left work", () => {
  const base = { settings: DEFAULT_RESUME_SETTINGS, now: NOW, boots: [NOW], log: () => {} }
  const left = [{ path: "/tmp/app-1183", branch: "1183-lane", changedFiles: 3, unpushedCommits: 0 }]

  function setup(runs: InterruptedRun[]) {
    const db = openDb({ path: path.join(tmp, "db.sqlite") })!
    for (const r of runs) recordTraceStart(db, { agentId: r.agentId }, r.taskId)
    takeInterruptedRuns(db, NOW)
    return db
  }

  it("puts the folders in the note of a resumed run, not in an operator notice", async () => {
    const r = run([agentCall("Build 1183")])
    const db = setup([r])
    let note = ""
    const c = new ResumeCoordinator()
    c.register("router", { resume: async (i) => { note = i.note }, tell: async () => {} })
    const notify = vi.fn(async () => {})
    await c.run({ ...base, db, runs: [r], notifyOperator: notify, findLeftWork: async () => left })
    expect(note).toContain("/tmp/app-1183 (branch 1183-lane): 3 changed files not committed")
    expect(notify).not.toHaveBeenCalled()
  })

  it("lists the folders to the operator when the run is not resumed", async () => {
    const r = run([agentCall("Build 1183")], { startedAt: NOW - 90 * 60_000 })
    const db = setup([r])
    const c = new ResumeCoordinator()
    c.register("router", { resume: async () => {}, tell: async () => {} })
    const notify = vi.fn(async (_t: string) => {})
    const out = await c.run({ ...base, db, runs: [r], notifyOperator: notify, findLeftWork: async () => left })
    expect(out[0].decision).toBe("reported")
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain("dev-agent: /tmp/app-1183 (branch 1183-lane)")
  })

  it("still resumes when checking the folders fails", async () => {
    const r = run([])
    const db = setup([r])
    const c = new ResumeCoordinator()
    c.register("router", { resume: async () => {}, tell: async () => {} })
    const out = await c.run({ ...base, db, runs: [r], findLeftWork: async () => { throw new Error("git gone") } })
    expect(out[0].decision).toBe("resumed")
  })
})
