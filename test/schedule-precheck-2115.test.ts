import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { CronScheduler } from "../src/crons/scheduler"
import { daemonConfigSchema } from "../src/daemon/config"
import { PRECHECK_FOUND_MAX, splitCommand, runPrecheck } from "../src/crons/precheck"
import { clearCronRunHistoryCache, readCronRunHistory } from "../src/crons/run-history"
import { failStreak } from "../src/daemon/routines"

// #2115: a cheap precheck before a scheduled prompt job wakes its agent.
// Exit 0 runs, exit 1 skips with no model call, anything else runs anyway
// (fail open). What the check printed goes into the prompt. A fired run
// and a retry skip the check.

let dir: string
let ws: string
const prevCwd = process.cwd()

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agentx-precheck-")))
  ws = join(dir, "ws")
  mkdirSync(ws)
  process.chdir(dir)
  clearCronRunHistoryCache()
})
afterEach(() => {
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

function job(precheck: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
  return {
    enabled: true, schedule: "0 3 * * *", timezone: "UTC", agent: "ops",
    prompt: "Read the inbox.", timeout: 30, onError: ["log"], precheck, ...extra,
  }
}

function setup(precheck: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
  const registry = {
    execute: vi.fn(async (_task: any) => ({ content: "done", duration: 1 })),
    getAgent: (id: string) => (id === "ops" ? { workspace: ws } : undefined),
  }
  const logs: string[] = []
  const s: any = new CronScheduler(
    { crons: { j: job(precheck, extra) }, agents: {}, notifications: {} } as any,
    registry as any,
    undefined,
    (...a: unknown[]) => { logs.push(a.join(" ")) },
  )
  s.running = true
  s.scheduleNext = vi.fn()
  s.scheduleRetry = vi.fn()
  s.recordCronDecisionInLedger = vi.fn(() => undefined)
  return { s, registry, logs }
}

function runRecords(): any[] {
  const d = join(dir, ".agentx/cron/runs/j")
  if (!existsSync(d)) return []
  return readdirSync(d).map((f) => JSON.parse(readFileSync(join(d, f), "utf-8")))
}

describe("precheck command", () => {
  it("exit 0 runs the job, and its stdout reaches the prompt", async () => {
    const { s, registry } = setup({ command: `sh -c "echo '  3 new mails  '; exit 0"` })
    await s.executeJob("j")
    expect(registry.execute).toHaveBeenCalledTimes(1)
    const msg: string = registry.execute.mock.calls[0][0].message
    expect(msg).toContain("Precheck found:\n3 new mails\n\nRead the inbox.")
    expect(s.scheduleNext).toHaveBeenCalledWith("j")
  })

  it("exit 1 skips: no dispatch, a halted ledger row, a skipped run record, the next run scheduled", async () => {
    const { s, registry, logs } = setup({ command: `sh -c "exit 1"` })
    await s.executeJob("j")
    expect(registry.execute).not.toHaveBeenCalled()
    expect(s.scheduleNext).toHaveBeenCalledWith("j")
    expect(s.recordCronDecisionInLedger).toHaveBeenCalledTimes(1)
    expect(s.recordCronDecisionInLedger.mock.calls[0][3]).toEqual({ agentId: null, outcome: "halted", reason: "precheck: nothing to do" })
    const recs = runRecords()
    expect(recs).toHaveLength(1)
    expect(recs[0].skipped).toBe("precheck")
    const job = s.jobs.get("j")
    expect(job.totalRuns).toBe(0)
    expect(logs.some((l) => l.includes("Executing job"))).toBe(false)
  })

  it("another exit code fails open: the job runs and a warning is logged", async () => {
    const { s, registry, logs } = setup({ command: `sh -c "echo oops >&2; exit 2"` })
    await s.executeJob("j")
    expect(registry.execute).toHaveBeenCalledTimes(1)
    expect(registry.execute.mock.calls[0][0].message).not.toContain("Precheck found")
    expect(logs.some((l) => /precheck failed \(exit 2: oops\); running the job anyway/.test(l))).toBe(true)
  })

  it("exit 1 with stderr is a crashed check: the job runs and a warning is logged", async () => {
    const { s, registry, logs } = setup({ command: `sh -c "echo 'Traceback: boom' >&2; exit 1"` })
    await s.executeJob("j")
    expect(registry.execute).toHaveBeenCalledTimes(1)
    expect(runRecords().some((r) => r.skipped === "precheck")).toBe(false)
    expect(logs.some((l) => /precheck failed \(exit 1: Traceback: boom\); running the job anyway/.test(l))).toBe(true)
  })

  it("a crashing node check is an error, not a skip", async () => {
    const out = await runPrecheck({ command: `${process.execPath} -e "throw new Error('broken check')"` })
    expect(out.verdict).toBe("error")
    expect(out.verdict === "error" && out.detail).toMatch(/^exit 1: /)
  })

  it("output over the buffer is an error named as such, not a timeout", async () => {
    const out = await runPrecheck({ command: `sh -c "yes | head -c 2000000"` })
    expect(out).toEqual({ verdict: "error", detail: "output over 1 MB" })
  })

  it("a timeout fails open", async () => {
    const { s, registry, logs } = setup({ command: "sleep 5", timeoutSec: 1 })
    const t0 = Date.now()
    await s.executeJob("j")
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(registry.execute).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => /precheck failed \(timed out after 1s\)/.test(l))).toBe(true)
  })

  it("a missing program fails open", async () => {
    const { s, registry } = setup({ command: "./no-such-check.sh" })
    await s.executeJob("j")
    expect(registry.execute).toHaveBeenCalledTimes(1)
  })

  it("runs in the agent's workspace, without a shell", async () => {
    const { s, registry } = setup({ command: "pwd" })
    await s.executeJob("j")
    expect(registry.execute.mock.calls[0][0].message).toContain(`Precheck found:\n${ws}\n`)
    // `$HOME;` is passed as a literal argument, not expanded or split.
    const out = await runPrecheck({ command: "echo $HOME; exit 1" })
    expect(out).toEqual({ verdict: "run", found: "$HOME; exit 1" })
  })

  it("caps what reaches the prompt at 2 KB", async () => {
    const out = await runPrecheck({ command: `sh -c "head -c 5000 /dev/zero | tr '\\\\0' x"` })
    expect(out.verdict).toBe("run")
    expect((out as any).found.length).toBeLessThanOrEqual(PRECHECK_FOUND_MAX + 1)
  })
})

describe("precheck bypasses and order", () => {
  it("fireNow does not run the precheck", async () => {
    const { s, registry } = setup({ command: `sh -c "exit 1"` })
    expect(s.fireNow("j", {}).ok).toBe(true)
    await vi.waitFor(() => expect(registry.execute).toHaveBeenCalledTimes(1))
    expect(registry.execute.mock.calls[0][0].message).not.toContain("Precheck found")
  })

  it("a retry does not run the precheck", async () => {
    const { s, registry } = setup({ command: `sh -c "exit 1"` })
    await s.executeJob("j", 1)
    expect(registry.execute).toHaveBeenCalledTimes(1)
  })

  it("a closed goal skips first: the precheck never runs", async () => {
    const { s, registry } = setup({ command: "touch precheck-ran" })
    s.goalHold = async () => ({ skip: true, brief: "", why: "goal g done" })
    await s.executeJob("j")
    expect(existsSync(join(ws, "precheck-ran"))).toBe(false)
    expect(registry.execute).not.toHaveBeenCalled()
    expect(s.recordCronDecisionInLedger.mock.calls[0][3].reason).toBe("goal g done")
  })

  it("the missed-run catch-up goes through the precheck too", async () => {
    const { s, registry } = setup({ command: `sh -c "exit 1"` })
    await s.executeMissedRuns([{ jobId: "j", missedAt: new Date("2026-11-26T03:00:00Z") }])
    expect(registry.execute).not.toHaveBeenCalled()
    expect(runRecords()[0].skipped).toBe("precheck")
  })

  it("a job without a precheck runs as before", async () => {
    const { s, registry } = setup(undefined)
    await s.executeJob("j")
    expect(registry.execute).toHaveBeenCalledTimes(1)
    expect(registry.execute.mock.calls[0][0].message).not.toContain("Precheck found")
  })
})

describe("precheck url", () => {
  const answer = (status: number, body: string | null) => vi.fn(async () => new Response(body, { status }))

  it("2xx with a body runs, with the body in the prompt", async () => {
    const { s, registry } = setup({ url: "https://example.com/pending" })
    s.precheckFetch = answer(200, "2 pending")
    await s.executeJob("j")
    expect(registry.execute.mock.calls[0][0].message).toContain("Precheck found:\n2 pending")
  })

  it("204 skips", async () => {
    const { s, registry } = setup({ url: "https://example.com/pending" })
    s.precheckFetch = answer(204, null)
    await s.executeJob("j")
    expect(registry.execute).not.toHaveBeenCalled()
    expect(s.scheduleNext).toHaveBeenCalledWith("j")
  })

  it("500 and a fetch error fail open", async () => {
    const a = setup({ url: "https://example.com/pending" })
    a.s.precheckFetch = answer(500, "down")
    await a.s.executeJob("j")
    expect(a.registry.execute).toHaveBeenCalledTimes(1)

    const b = setup({ url: "https://example.com/pending" })
    b.s.precheckFetch = vi.fn(async () => { throw new Error("ECONNREFUSED") })
    await b.s.executeJob("j")
    expect(b.registry.execute).toHaveBeenCalledTimes(1)
  })

  it("without allowPrivate a loopback url is refused by the fetch guard, and the job runs anyway", async () => {
    const out = await runPrecheck({ url: "http://127.0.0.1:9/pending", timeoutSec: 2 })
    expect(out.verdict).toBe("error")
    expect((out as any).detail).toMatch(/refused/)
  })
})

describe("precheck schema", () => {
  const parse = (precheck: unknown, extra: Record<string, unknown> = {}) => daemonConfigSchema.safeParse({
    node: { id: "t", name: "t" },
    crons: { j: { schedule: "0 3 * * *", agent: "ops", prompt: "p", precheck, ...extra } },
  })

  it("accepts a command or a url", () => {
    expect(parse({ command: "scripts/has-new-mail.sh" }).success).toBe(true)
    expect(parse({ url: "https://example.com/x", timeoutSec: 60 }).success).toBe(true)
  })

  it("rejects both command and url, and neither", () => {
    const both = parse({ command: "a", url: "https://example.com/x" })
    expect(both.success).toBe(false)
    expect(JSON.stringify((both as any).error.issues)).toContain("exactly one of command or url")
    expect(parse({}).success).toBe(false)
  })

  it("rejects a timeout over 60 s and a precheck on a command cron", () => {
    expect(parse({ command: "a", timeoutSec: 61 }).success).toBe(false)
    expect(parse({ command: "a" }, { command: "echo hi" }).success).toBe(false)
  })
})

describe("precheck helpers", () => {
  it("splits a command line on spaces, quotes grouping", () => {
    expect(splitCommand(`scripts/check.sh --since "1 hour" 'a b' ""`)).toEqual(["scripts/check.sh", "--since", "1 hour", "a b", ""])
    expect(() => splitCommand(`a "b`)).toThrow(/unclosed quote/)
  })

  it("a skipped run reads as skipped in the run history and does not count toward a fail streak", async () => {
    const { s } = setup({ command: `sh -c "exit 1"` })
    await s.executeJob("j")
    const day = new Date().toISOString().slice(0, 10)
    const runs = await readCronRunHistory({ date: day, jobId: "j" })
    expect(runs.map((r) => r.status)).toEqual(["skipped"])
    expect(failStreak([{ status: "skipped" }, { status: "failed" }, { status: "success" }])).toBe(1)
  })
})
