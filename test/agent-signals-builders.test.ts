import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFile, execFileSync } from "child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { BUILDER_SAVE_MS, builderLines, saveWip, windDownBuilders, wipBranchName } from "../src/agents/signals/builders"
import { DEFAULT_SIGNAL_SETTINGS } from "../src/agents/signals/policy"
import { SignalService, type RunningRef } from "../src/agents/signals/service"
import { StoppedTaskStore, summarizeStopped } from "../src/agents/signals/store"

// #1328 step 2: background builders stop with their task. Their unsaved
// work must be saved on a WIP branch, without touching the checkout, and
// named in the plan and the resume note.

let tmp: string
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "agentx-builders-")) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "pipe" }).toString()

/** A clone on `feature/lanes` with a staged edit, an unstaged edit, a new
 *  file and an ignored file. */
function dirtyClone(name = "app"): string {
  const dir = path.join(tmp, name)
  mkdirSync(dir)
  git(dir, "init", "-q", "-b", "main")
  writeFileSync(path.join(dir, "a.ts"), "a1")
  writeFileSync(path.join(dir, "b.ts"), "b1")
  writeFileSync(path.join(dir, ".gitignore"), "*.log\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  git(dir, "checkout", "-qb", "feature/lanes")
  writeFileSync(path.join(dir, "a.ts"), "a2")
  git(dir, "add", "a.ts")
  writeFileSync(path.join(dir, "b.ts"), "b2")
  writeFileSync(path.join(dir, "new.ts"), "n")
  writeFileSync(path.join(dir, "debug.log"), "noise")
  return dir
}

const builderCall = (description: string) => ({
  action: "Agent",
  inputSummary: JSON.stringify({ description, prompt: "build it", run_in_background: true }),
})
const bash = (command: string) => ({ action: "Bash", inputSummary: JSON.stringify({ command }) })

describe("saveWip", () => {
  it("commits every change to a new branch and leaves the checkout as it was", async () => {
    const dir = dirtyClone()
    const before = { status: git(dir, "status", "--porcelain"), head: git(dir, "rev-parse", "HEAD"), branch: git(dir, "branch", "--show-current"), staged: git(dir, "diff", "--cached", "--name-only") }
    const saved = await saveWip(dir, wipBranchName("run-1"), "WIP")
    expect(saved.branch).toBe("agentx/wip/run-1")
    expect(git(dir, "status", "--porcelain")).toBe(before.status)
    expect(git(dir, "rev-parse", "HEAD")).toBe(before.head)
    expect(git(dir, "branch", "--show-current")).toBe(before.branch)
    expect(git(dir, "diff", "--cached", "--name-only")).toBe(before.staged)
    // The WIP commit holds both edits and the new file, not the ignored one.
    expect(git(dir, "show", `${saved.branch}:a.ts`)).toBe("a2")
    expect(git(dir, "show", `${saved.branch}:b.ts`)).toBe("b2")
    expect(git(dir, "show", `${saved.branch}:new.ts`)).toBe("n")
    expect(git(dir, "ls-tree", "--name-only", saved.branch)).not.toMatch(/debug\.log/)
    expect(git(dir, "rev-parse", `${saved.branch}^`)).toBe(before.head)
    expect(readFileSync(path.join(dir, "b.ts"), "utf-8")).toBe("b2")
  })

  it("never overwrites a branch an earlier stop left", async () => {
    const dir = dirtyClone()
    const first = await saveWip(dir, "agentx/wip/run-1", "WIP")
    writeFileSync(path.join(dir, "b.ts"), "b3")
    const second = await saveWip(dir, "agentx/wip/run-1", "WIP")
    expect(second.branch).toBe("agentx/wip/run-1-2")
    expect(git(dir, "show", `${first.branch}:b.ts`)).toBe("b2")
    expect(git(dir, "show", `${second.branch}:b.ts`)).toBe("b3")
  })

  // #1341: a conflict no suffix can fix fails at once, and a failure that
  // is not a name clash keeps git's own words.
  const counting = () => {
    const calls: string[][] = []
    const run = (cwd: string, args: string[], env?: Record<string, string>) => {
      calls.push(args)
      return new Promise<string>((resolve, reject) => {
        execFile("git", ["-C", cwd, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) =>
          err ? reject(Object.assign(err, { stderr })) : resolve(stdout))
      })
    }
    return { run, updates: () => calls.filter((a) => a[0] === "update-ref").length }
  }

  it("fails at once, naming it, when a branch named agentx/wip exists", async () => {
    const dir = dirtyClone()
    git(dir, "branch", "agentx/wip")
    const g = counting()
    await expect(saveWip(dir, "agentx/wip/run-1", "WIP", g.run)).rejects.toThrow("couldn't create branch agentx/wip/run-1: a branch named agentx/wip exists")
    expect(g.updates()).toBe(0)
  })

  it("fails at once, naming it, when a branch named agentx exists", async () => {
    const dir = dirtyClone()
    git(dir, "branch", "agentx")
    await expect(saveWip(dir, "agentx/wip/run-1", "WIP")).rejects.toThrow("a branch named agentx exists")
  })

  it("keeps git's error for a locked ref and tries no other name", async () => {
    const dir = dirtyClone()
    mkdirSync(path.join(dir, ".git", "refs", "heads", "agentx", "wip"), { recursive: true })
    writeFileSync(path.join(dir, ".git", "refs", "heads", "agentx", "wip", "run-1.lock"), "")
    const g = counting()
    const err = await saveWip(dir, "agentx/wip/run-1", "WIP", g.run).catch((e) => e)
    expect(err.message).toMatch(/^couldn't create branch agentx\/wip\/run-1: fatal: .*run-1\.lock/)
    expect(err.message).not.toContain("\n")
    expect(g.updates()).toBe(1)
  })

  it("makes a branch name git accepts from any task id", () => {
    expect(wipBranchName("abc:12/..x y.lock")).toBe("agentx/wip/abc-12-.x-y.lock-x")
    expect(() => execFileSync("git", ["check-ref-format", "--branch", wipBranchName("abc:12/..x y.lock")])).not.toThrow()
    expect(wipBranchName("...")).toBe("agentx/wip/task")
  })
})

describe("windDownBuilders", () => {
  it("does nothing for a task that started no builder", async () => {
    const dir = dirtyClone()
    expect(await windDownBuilders({ taskId: "t1", toolCalls: [bash(`cd ${dir} && ls`)], reason: "stop" })).toBeUndefined()
    expect(git(dir, "branch", "--list", "agentx/*")).toBe("")
  })

  it("saves each folder the builders left changes in, and lists commits not pushed", async () => {
    const dir = dirtyClone()
    const clean = path.join(tmp, "clean")
    mkdirSync(clean)
    git(clean, "init", "-q")
    writeFileSync(path.join(clean, "x"), "x")
    git(clean, "add", ".")
    git(clean, "commit", "-qm", "x")
    const b = await windDownBuilders({
      taskId: "t1", reason: "owner stopped the task",
      toolCalls: [builderCall("Build the lanes view"), bash(`cd ${dir} && pnpm test`), bash(`cd ${clean} && ls`)],
    })
    expect(b?.helpers).toEqual(["Build the lanes view"])
    expect(b?.folders).toHaveLength(1)
    expect(b?.folders[0]).toMatchObject({ path: dir, branch: "feature/lanes", changedFiles: 3, wipBranch: "agentx/wip/t1" })
    expect(git(dir, "log", "-1", "--format=%an %s", "agentx/wip/t1").trim()).toBe("AgentX WIP: saved by AgentX when owner stopped the task")
  })

  it("says why a folder could not be saved", async () => {
    const b = await windDownBuilders({
      taskId: "t1", reason: "stop", toolCalls: [builderCall("Build")],
      findLeftWork: async () => [{ path: "/nowhere/app", branch: "main", changedFiles: 2, unpushedCommits: 0 }],
      git: async () => { throw new Error("fatal: not a git repository") },
    })
    expect(b?.folders[0].error).toMatch(/not a git repository/)
    expect(builderLines(b, "resume").join("\n")).toMatch(/NOT saved \(fatal: not a git repository\), still in the folder/)
  })

  it("stops saving folders once its time is up, and says so", async () => {
    let t = 0
    const saved: string[] = []
    const b = await windDownBuilders({
      taskId: "t1", reason: "stop", toolCalls: [builderCall("Build")],
      findLeftWork: async () => ["/a", "/b"].map((p) => ({ path: p, branch: "main", changedFiles: 1, unpushedCommits: 0 })),
      // Each folder's save takes the whole budget.
      git: async (cwd, args) => {
        if (args.some((a) => a.startsWith("refs/heads/")) && args[0] === "rev-parse") throw new Error("no such ref")
        if (args[0] === "update-ref") { saved.push(cwd); t += BUILDER_SAVE_MS }
        return "x"
      },
      now: () => t,
    })
    expect(saved).toEqual(["/a"])
    expect(b?.folders[0].wipBranch).toBe("agentx/wip/t1")
    expect(b?.folders[1].error).toMatch(/not saved: the stop's 60s for saving builders ran out/)
  })
})

describe("a stop winds the builders down before the plan", () => {
  it("names the WIP branch in the wind-down turn, the record and the resume note", async () => {
    const dir = dirtyClone()
    const calls = [builderCall("Build the lanes view"), bash(`cd ${dir} && pnpm build`)]
    const run: RunningRef = {
      taskId: "run-1", traceId: "trace-1", agentId: "dev", channel: "telegram", chatId: "1", rootId: "root-1",
      originalMessage: "Ship lanes", origin: { kind: "router", adapter: "telegram", message: { id: "m1" } },
    }
    let running = [run]
    let windDownMessage = ""
    const notes: string[] = []
    const service = new SignalService({
      settings: () => DEFAULT_SIGNAL_SETTINGS,
      store: new StoppedTaskStore(path.join(tmp, "stopped")),
      findRunning: (by) => running.find((r) => r.taskId === by.taskId) ?? null,
      listRunning: () => [...running],
      stopRun: (id) => { running = running.filter((r) => r.taskId !== id); return true },
      whenRunEnds: async () => {},
      toolCalls: () => calls,
      windDownBuilders: (input) => windDownBuilders(input),
      windDown: async ({ message }) => { windDownMessage = message; return { content: "Done: half.\nLeft: lanes.\nNext action: restart the builder from agentx/wip/run-1.\nHalf-applied: nothing" } },
      resume: async ({ note }) => { notes.push(note) },
      publish: () => {},
      log: () => {},
    })
    const r = await service.stopAll({ kind: "owner" }, "update")
    if (!r.ok) throw new Error(r.error)
    const [entry] = await r.done
    expect(entry.builders).toEqual({ count: 1, saved: 1, notSaved: 0 })
    expect(windDownMessage).toMatch(/stopped the 1 background builder\(s\)/)
    expect(windDownMessage).toContain("saved on branch agentx/wip/run-1")
    const record = service.get("run-1")!
    expect(record.builders?.folders[0].wipBranch).toBe("agentx/wip/run-1")
    expect(summarizeStopped(record).builders).toMatchObject({ helpers: 1, folders: [{ path: dir, wipBranch: "agentx/wip/run-1" }] })

    const [outcome] = await service.resumeStopAll()
    expect(outcome).toMatchObject({ decision: "resumed", builders: 1, wip: ["agentx/wip/run-1"], orderId: r.orderId })
    expect(notes[0]).toMatch(/Start each builder again from its saved branch/)
    expect(notes[0]).toContain("agentx/wip/run-1")
  })
})
