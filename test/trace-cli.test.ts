import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { execFileSync } from "child_process"
import { closeDb, openDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceEnd, recordTraceStep } from "../src/storage/traces"

let tmp: string
const projectRoot = path.resolve(__dirname, "..")
const cliPath = path.resolve(projectRoot, "src/cli.ts")

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-trace-cli-"))
})

afterEach(() => {
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

function seedDb() {
  const db = openDb({ path: path.join(tmp, ".agentx", "db.sqlite") })!
  const t1 = recordTraceStart(db, { agentId: "atlas", channel: "telegram", chatId: "c1", messagePreview: "hello world" })
  recordTraceStep(db, t1, { name: "tool_use", action: "Bash", inputSummary: '{"command":"ls"}', status: "in-flight" })
  recordTraceStep(db, t1, { name: "tool_result", outputSummary: "file1\nfile2", status: "ok" })
  recordTraceEnd(db, t1, { status: "ok", inputTokens: 100, outputTokens: 50 })

  const t2 = recordTraceStart(db, { agentId: "worker", workflowRunId: "wf-1", chatId: "workflow:wf-1" })
  recordTraceEnd(db, t2, { status: "error", error: "boom" })
  closeDb()
  return { t1, t2 }
}

function runCli(args: string[]): { stdout: string; status: number } {
  // tsx must run from the project root so its `@/` path resolution finds
  // tsconfig.json. The trace subcommand's --cwd flag retargets the db
  // lookup at the temp dir.
  try {
    const stdout = execFileSync(
      "npx",
      ["tsx", cliPath, ...args, "--cwd", tmp],
      { cwd: projectRoot, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] },
    )
    return { stdout, status: 0 }
  } catch (e: any) {
    return { stdout: (e.stdout?.toString?.() ?? "") + (e.stderr?.toString?.() ?? ""), status: e.status ?? 1 }
  }
}

describe("agentx trace CLI", () => {
  it("list --json returns all traces", () => {
    seedDb()
    const r = runCli(["trace", "list", "--json"])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    const agentIds = parsed.map((t: { agentId: string }) => t.agentId).sort()
    expect(agentIds).toEqual(["atlas", "worker"])
  })

  it("list --status error filters", () => {
    seedDb()
    const r = runCli(["trace", "list", "--status", "error", "--json"])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].status).toBe("error")
  })

  it("list --workflow wf-1 filters", () => {
    seedDb()
    const r = runCli(["trace", "list", "--workflow", "wf-1", "--json"])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.map((t: { taskId: string }) => t.workflowRunId)).toEqual(["wf-1"])
  })

  it("show <taskId> --json returns the full trace + steps", () => {
    const { t1 } = seedDb()
    const r = runCli(["trace", "show", t1, "--json"])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.task.taskId).toBe(t1)
    expect(parsed.steps).toHaveLength(2)
    expect(parsed.steps[0]).toMatchObject({ seq: 0, name: "tool_use", action: "Bash" })
  })

  it("show with unknown id exits non-zero", () => {
    seedDb()
    const r = runCli(["trace", "show", "01XX_DOES_NOT_EXIST"])
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain("No trace at")
  })

  it("list against a missing db exits non-zero with a friendly message", () => {
    // do NOT seed — empty cwd
    const r = runCli(["trace", "list"])
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain("No db at")
  })
})
